/**
 * ServiceOS PostgreSQL persistence boundary (WORK-001).
 *
 * Architecture role (architecture.md §2.10, §20; architecture-lock.md #18):
 * PostgreSQL is the authoritative ServiceOS persistence layer, and this module
 * is the single place where the `pg` driver may be imported. Business modules
 * never open their own connections or create a second persistence authority.
 *
 * The boundary is deliberately lazy and fail-closed:
 * - without a configured DSN nothing connects and `pool()` throws a typed error;
 * - the server never auto-initializes durable state; schema changes are applied
 *   explicitly through the migration CLI (see `cli/migrate.ts`);
 * - `ready()` reports the truth (including "not configured") instead of
 *   fabricating readiness.
 *
 * Transaction and migration logic are exposed as executor-generic functions
 * (`withTransactionOn`, `applyMigrations`) so their semantics can be proven
 * with in-memory executors without a live PostgreSQL instance.
 */
import pg from 'pg';
import { applyMigrations, type Migration, type MigrationReport } from './migrations.js';

export { applyMigrations, type Migration } from './migrations.js';

export interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number | null;
}

/**
 * The narrow SQL surface the platform exposes internally. Everything that
 * needs SQL goes through an executor; there is no second query authority.
 */
export interface SqlExecutor {
  query(sql: string, params?: unknown[]): Promise<QueryResult>;
}

/** A pooled executor can be drained on shutdown. */
export interface PooledExecutor extends SqlExecutor {
  end(): Promise<void>;
}

/**
 * An executor that can run a unit of work inside a client-pinned transaction.
 *
 * WORK-002 addition: `pg.Pool.query` checks out a client per statement, so
 * BEGIN/work/COMMIT issued through a bare pool are only coincidentally
 * serialized (same-client reuse in single-actor flows) and racy under
 * concurrency. A `TransactionalExecutor` guarantees the whole transaction
 * runs on ONE acquired client. Business modules receive this — never a raw
 * pool — so multi-statement invariants (tenant integrity rules) hold.
 */
export interface TransactionalExecutor extends SqlExecutor {
  withTransaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}

export class PersistenceError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'PersistenceError';
  }
}

export class PersistenceNotConfiguredError extends PersistenceError {
  constructor() {
    super(
      'ServiceOS persistence is not configured: SERVICEOS_DATABASE_URL is required before any database access',
    );
    this.name = 'PersistenceNotConfiguredError';
  }
}

export class TransactionRollbackError extends PersistenceError {
  constructor(cause: unknown) {
    super('transaction rollback failed after an in-transaction failure', cause);
    this.name = 'TransactionRollbackError';
  }
}

export interface ReadinessResult {
  ok: boolean;
  detail?: string;
}

const READINESS_TIMEOUT_MS = 2500;

/** Executor-generic transaction semantics: BEGIN / work / COMMIT, ROLLBACK on failure. */
export async function withTransactionOn<T>(
  executor: SqlExecutor,
  fn: (tx: SqlExecutor) => Promise<T>,
): Promise<T> {
  await executor.query('BEGIN');
  try {
    const result = await fn(executor);
    await executor.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await executor.query('ROLLBACK');
    } catch (rollbackError) {
      throw new TransactionRollbackError(rollbackError);
    }
    throw error;
  }
}

export interface PersistenceBoundary {
  /** True when a DSN is configured. Does not imply the database is reachable. */
  isConfigured(): boolean;
  /**
   * The lazily created singleton pool. Throws `PersistenceNotConfiguredError`
   * when no DSN is configured. Only the persistence boundary may create pools.
   */
  pool(): PooledExecutor;
  /**
   * Run a unit of work inside a transaction with rollback-on-error semantics.
   * The transaction is pinned to a single acquired client (see
   * `TransactionalExecutor`), so it is atomic under real concurrency.
   */
  withTransaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  /**
   * A transaction-capable executor for business modules: single statements
   * run on the pool, `withTransaction` runs client-pinned.
   */
  transactional(): TransactionalExecutor;
  /** Truthful readiness probe used by the server's `/readyz` endpoint. */
  ready(): Promise<ReadinessResult>;
  /** Apply pending schema migrations (explicit operator action, never automatic). */
  migrate(migrations: readonly Migration[]): Promise<MigrationReport>;
  /** Drain the pool on shutdown. */
  stop(): Promise<void>;
}

export interface CreatePersistenceOptions {
  databaseUrl: string | null;
  /**
   * Test seam: inject a pooled executor instead of a real `pg.Pool`.
   * Production code never passes this.
   */
  pooledExecutor?: PooledExecutor;
}

export function createPersistence(options: CreatePersistenceOptions): PersistenceBoundary {
  const { databaseUrl } = options;
  let pool: PooledExecutor | null = null;
  /** Client acquisition for the real `pg.Pool` (null for injected test doubles). */
  let acquireClient: (() => Promise<SqlExecutor & { release(): void }>) | null = null;

  function getPool(): PooledExecutor {
    if (pool === null) {
      if (databaseUrl === null) {
        throw new PersistenceNotConfiguredError();
      }
      if (options.pooledExecutor !== undefined) {
        pool = options.pooledExecutor;
        acquireClient = null; // test doubles are single-connection by construction
      } else {
        const realPool = new pg.Pool({
          connectionString: databaseUrl,
          // Fail fast instead of hanging when PostgreSQL is unreachable.
          connectionTimeoutMillis: 5000,
          max: 10,
        });
        pool = realPool;
        acquireClient = async () => {
          const client = await realPool.connect();
          return client as unknown as SqlExecutor & { release(): void };
        };
      }
    }
    return pool;
  }

  /**
   * Run `fn` on exactly one acquired client (real pool) or on the injected
   * executor (test double — a fake is inherently single-connection).
   */
  async function withPinnedClient<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    if (acquireClient !== null) {
      const client = await acquireClient();
      try {
        return await fn(client);
      } finally {
        client.release();
      }
    }
    return fn(getPool());
  }

  async function ready(): Promise<ReadinessResult> {
    if (databaseUrl === null) {
      return { ok: false, detail: 'persistence is not configured (SERVICEOS_DATABASE_URL missing)' };
    }
    try {
      const probe = await Promise.race([
        getPool().query('SELECT 1'),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`readiness probe timed out after ${READINESS_TIMEOUT_MS}ms`)), READINESS_TIMEOUT_MS),
        ),
      ]);
      void probe;
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: (error as Error).message };
    }
  }

  return {
    isConfigured: () => databaseUrl !== null,
    pool: getPool,
    withTransaction: <T>(fn: (tx: SqlExecutor) => Promise<T>) =>
      withPinnedClient((client) => withTransactionOn(client, fn)),
    transactional: () => ({
      query: (sql: string, params?: unknown[]) => getPool().query(sql, params),
      withTransaction: <T>(fn: (tx: SqlExecutor) => Promise<T>) =>
        withPinnedClient((client) => withTransactionOn(client, fn)),
    }),
    ready,
    migrate: (migrations) =>
      withPinnedClient((client) => applyMigrations(client, migrations)),
    stop: async () => {
      if (pool !== null) {
        await pool.end();
        pool = null;
        acquireClient = null;
      }
    },
  };
}
