/**
 * Idempotent, lock-guarded schema migration runner (WORK-001 persistence boundary).
 *
 * Semantics:
 * - the whole batch runs inside one transaction guarded by a PostgreSQL
 *   advisory lock keyed to ServiceOS migrations, so concurrent runners
 *   serialize and the second one converges to "nothing pending";
 * - applied versions are recorded in `serviceos_schema_history`;
 * - re-running an applied batch is a no-op (idempotent);
 * - a migration set that has gaps or duplicates, or that no longer contains an
 *   already-applied version, fails closed as history tampering;
 * - a failing migration rolls the batch back and surfaces the error.
 *
 * WORK-001 ships no business schema: durable state is owned by later Work
 * Orders (WORK-002/WORK-003 …) which will add SQL files under `db/migrations`.
 * The runner is executor-generic so its decision logic is fully testable
 * without a live PostgreSQL.
 */
import { withTransactionOn, type SqlExecutor } from './index.js';

export interface Migration {
  /** Monotonic zero-padded ordinal, e.g. 1, 2, 3 … */
  readonly version: number;
  /** Human-readable name recorded in history. */
  readonly name: string;
  /** SQL applied verbatim inside the guarded transaction. */
  readonly sql: string;
}

export interface MigrationReport {
  applied: { version: number; name: string }[];
  skipped: number;
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

/** Single advisory-lock key for the ServiceOS migration critical section. */
export const MIGRATION_LOCK_KEY = 740021;

const HISTORY_TABLE_SQL = `CREATE TABLE IF NOT EXISTS serviceos_schema_history (
  version    BIGINT PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`;

export async function applyMigrations(
  executor: SqlExecutor,
  migrations: readonly Migration[],
): Promise<MigrationReport> {
  validateMigrationSet(migrations);

  return withTransactionOn(executor, async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`);
    await tx.query(HISTORY_TABLE_SQL);

    const history = await tx.query(
      'SELECT version, name FROM serviceos_schema_history ORDER BY version ASC',
    );
    const appliedVersions = new Set(
      history.rows.map((row) => Number((row as { version: number | string }).version)),
    );

    const maxApplied = appliedVersions.size === 0 ? 0 : Math.max(...appliedVersions);
    // Fail closed on history that no longer matches the provided migration set.
    for (const version of appliedVersions) {
      if (!migrations.some((m) => m.version === version)) {
        throw new MigrationError(
          `migration version ${version} is recorded in history but missing from the provided set; refusing to run with an incomplete migration history`,
        );
      }
    }
    for (const migration of migrations) {
      if (migration.version <= maxApplied && !appliedVersions.has(migration.version)) {
        throw new MigrationError(
          `migration version ${migration.version} is below the applied high-water mark ${maxApplied} but is not recorded in history; history is inconsistent`,
        );
      }
    }

    const applied: { version: number; name: string }[] = [];
    for (const migration of migrations) {
      if (appliedVersions.has(migration.version)) continue;
      await tx.query(migration.sql);
      await tx.query(
        'INSERT INTO serviceos_schema_history (version, name) VALUES ($1, $2)',
        [migration.version, migration.name],
      );
      applied.push({ version: migration.version, name: migration.name });
    }

    return { applied, skipped: migrations.length - applied.length };
  });
}

function validateMigrationSet(migrations: readonly Migration[]): void {
  const seen = new Set<number>();
  let previous = 0;
  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version < 1) {
      throw new MigrationError(`migration version must be a positive integer, received ${migration.version}`);
    }
    if (seen.has(migration.version)) {
      throw new MigrationError(`duplicate migration version ${migration.version}`);
    }
    if (migration.version <= previous) {
      throw new MigrationError(
        `migration versions must be strictly increasing: ${migration.version} follows ${previous}`,
      );
    }
    if (typeof migration.name !== 'string' || migration.name.trim() === '') {
      throw new MigrationError(`migration ${migration.version} must have a non-empty name`);
    }
    if (typeof migration.sql !== 'string' || migration.sql.trim() === '') {
      throw new MigrationError(`migration ${migration.version} must have non-empty SQL`);
    }
    seen.add(migration.version);
    previous = migration.version;
  }
}

/**
 * Load migrations from the conventional `db/migrations` directory.
 * Files are named `NNNN_name.sql`; NNNN is the zero-padded version ordinal.
 * The directory may legitimately be empty at this stage of the program.
 */
export function parseMigrationFileName(fileName: string): { version: number; name: string } | null {
  const match = /^(\d{4,})[_-]([a-z0-9_-]+)\.sql$/.exec(fileName);
  if (!match) return null;
  return {
    version: Number.parseInt(match[1] as string, 10),
    name: (match[2] as string).replace(/_/g, '-'),
  };
}
