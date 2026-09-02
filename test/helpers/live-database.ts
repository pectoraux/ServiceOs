/**
 * Test helper: disposable live PostgreSQL database per integration test
 * (WORK-002).
 *
 * `node --test` executes test FILES concurrently, and every integration file
 * previously shared one database — including the GLOBAL
 * `serviceos_schema_history` table. Two files using overlapping migration
 * version numbers then collided through the runner's history check (one
 * file's version-1 row made the other file skip its own version-1 DDL and
 * fail on version-2's DML with 42P01). The runner's single-history contract
 * is correct for production (one migration chain under `db/migrations`);
 * integration tests therefore each get their OWN database.
 *
 * Requires the CI/runtime user to be allowed CREATE DATABASE (the provisioned
 * `postgres:17` service user is the instance superuser).
 */
import pg from 'pg';

export interface LiveDatabase {
  readonly dsn: string;
  drop(): Promise<void>;
}

export function liveDatabaseRequested(): boolean {
  return process.env.SERVICEOS_TEST_DATABASE_URL !== undefined;
}

/**
 * A test pg pool with idle-client-error tolerance. `DROP DATABASE ...
 * WITH (FORCE)` (this helper's `drop()`, or any sibling test's teardown
 * under CI's concurrent test files) terminates idle pooled clients;
 * pg then emits a pool-level `'error'` event which — with no listener —
 * surfaces as an UNCAUGHT EXCEPTION attributed to whatever test happens
 * to be running (the documented CI flake class; see the drain comment in
 * test/service-work.integration.test.ts). A no-op listener keeps such
 * teardown noise non-fatal: real query failures still reject their query
 * promises and are asserted by the tests.
 */
/** The pool configuration every test pool passes (pg's own constructor input). */
export type TestPoolConfig = NonNullable<ConstructorParameters<typeof pg.Pool>[0]>;

export function createTestPool(config: TestPoolConfig): pg.Pool {
  const pool = new pg.Pool(config);
  pool.on('error', () => undefined);
  return pool;
}

/** Create a uniquely-named disposable database for one integration test. */
export async function createLiveTestDatabase(): Promise<LiveDatabase> {
  const baseUrl = process.env.SERVICEOS_TEST_DATABASE_URL;
  if (baseUrl === undefined) {
    throw new Error('createLiveTestDatabase requires SERVICEOS_TEST_DATABASE_URL');
  }
  const dbName = `serviceos_it_${Date.now().toString(36)}_${process.pid.toString(36)}`;
  const maintenance = new pg.Client({ connectionString: baseUrl });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE ${dbName}`);
  } catch (error) {
    await maintenance.end().catch(() => undefined);
    throw error;
  }
  await maintenance.end();
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  return {
    dsn: url.toString(),
    drop: async () => {
      const dropper = new pg.Client({ connectionString: baseUrl });
      await dropper.connect();
      try {
        // FORCE disconnects any leaked pool clients from failed assertions.
        await dropper.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      } finally {
        await dropper.end();
      }
    },
  };
}
