/**
 * ServiceOS migration CLI (WORK-001 persistence boundary).
 *
 * Applies pending SQL migrations from `db/migrations/NNNN_name.sql` through the
 * guarded, idempotent migration runner. This is an explicit operator action:
 * the server never auto-initializes durable state, so concurrent runtime
 * processes never race schema initialization. Migrations serialize across
 * concurrent invocations via the advisory-lock-guarded transaction.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../platform/config/index.js';
import { createLogger } from '../platform/logging/index.js';
import { createPersistence, type Migration } from '../platform/persistence/index.js';
import { parseMigrationFileName } from '../platform/persistence/migrations.js';

function loadMigrationFiles(dir: string): Migration[] {
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((name) => name.endsWith('.sql')).sort();
  } catch {
    console.error(`no migrations directory found at ${dir}; nothing to apply`);
    return [];
  }
  const migrations: Migration[] = [];
  for (const entry of entries) {
    const parsed = parseMigrationFileName(entry);
    if (parsed === null) {
      console.error(`FAIL: migration file ${entry} does not match the NNNN_name.sql convention`);
      process.exit(1);
    }
    const sql = readFileSync(resolve(dir, entry), 'utf8');
    migrations.push({ version: parsed.version, name: parsed.name, sql });
  }
  return migrations;
}

async function run(): Promise<void> {
  const config = loadConfig(process.env, { requireDatabase: true });
  const logger = createLogger(config.logLevel, { component: 'migrate' });

  const migrationsDir = resolve(process.cwd(), 'db/migrations');
  const migrations = loadMigrationFiles(migrationsDir);

  const persistence = createPersistence({ databaseUrl: config.databaseUrl });
  try {
    const report = await persistence.migrate(migrations);
    if (migrations.length === 0) {
      logger.info('no migration files present; nothing to apply');
    }
    for (const applied of report.applied) {
      logger.info('migration applied', { version: applied.version, name: applied.name });
    }
    logger.info('migrations complete', {
      applied: report.applied.length,
      skipped: report.skipped,
    });
  } finally {
    await persistence.stop();
  }
}

run().catch((error: unknown) => {
  console.error(`FAIL: ${(error as Error).message}`);
  process.exit(1);
});
