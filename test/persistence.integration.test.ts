/**
 * Optional live-PostgreSQL integration proof for the persistence boundary
 * (WORK-001). Runs ONLY when SERVICEOS_TEST_DATABASE_URL points at a
 * disposable PostgreSQL database; otherwise it is skipped.
 *
 * WORK-002 notes:
 * - These proofs were previously skipped everywhere (no PostgreSQL service in
 *   CI). When WORK-002's CI provisioned PostgreSQL they executed for the
 *   first time and empirically confirmed the pool-pinning defect documented
 *   in WORK-002's evidence: `pg.Pool.query` checks out a client per
 *   statement, so BEGIN/work/COMMIT through a bare pool are not reliably
 *   serialized (the seed INSERT ran in a session that could not see the
 *   CREATE TABLE). The migration proofs now drive the runner through pinned
 *   executors exactly as production does (`npm run migrate` uses the
 *   persistence boundary's client-pinned path).
 * - Each proof runs against its OWN disposable database: `node --test` runs
 *   test files concurrently and the migration history table is global per
 *   database, so sharing one would make unrelated migration sets collide
 *   through the version-history check.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createPersistence } from '../src/platform/persistence/index.js';
import { applyMigrations, type Migration } from '../src/platform/persistence/migrations.js';
import { createLiveTestDatabase, liveDatabaseRequested, type LiveDatabase } from './helpers/live-database.js';

const SKIP = !liveDatabaseRequested();

test('live: migrations apply once, converge on re-run and under parallel runners', { skip: SKIP }, async () => {
  const live = await createLiveTestDatabase();
  try {
    // Production composition: the boundary pins every migration batch to ONE
    // acquired PostgreSQL client (client-pinned transaction + advisory lock).
    const boundary = createPersistence({ databaseUrl: live.dsn });

    const smokeTable = `serviceos_integration_smoke_${Date.now()}`;
    const migrations: Migration[] = [
      { version: 1, name: 'baseline', sql: `CREATE TABLE IF NOT EXISTS ${smokeTable} (id INT PRIMARY KEY, tag TEXT NOT NULL)` },
      { version: 2, name: 'seed', sql: `INSERT INTO ${smokeTable} (id, tag) VALUES (1, 'seed') ON CONFLICT (id) DO NOTHING` },
    ];

    // First run applies both.
    const first = await boundary.migrate(migrations);
    assert.equal(first.applied.length, 2);

    // Re-run converges to a no-op.
    const second = await boundary.migrate(migrations);
    assert.equal(second.applied.length, 0);
    assert.equal(second.skipped, 2);

    // Parallel runners converge: exactly one seed row exists afterwards.
    await Promise.all([boundary.migrate(migrations), boundary.migrate(migrations), boundary.migrate(migrations)]);
    const rows = await boundary.pool().query(`SELECT COUNT(*)::int AS count FROM ${smokeTable}`);
    assert.equal((rows.rows[0] as { count: number }).count, 1);

    await boundary.stop();
  } finally {
    await live.drop();
  }
});

test('live: direct-pool migration batches are applied through a pinned client (defect regression)', { skip: SKIP }, async () => {
  const live = await createLiveTestDatabase();
  const pool = new pg.Pool({ connectionString: live.dsn });
  const smokeTable = `serviceos_integration_pinned_${Date.now()}`;
  const migrations: Migration[] = [
    { version: 1, name: 'baseline', sql: `CREATE TABLE IF NOT EXISTS ${smokeTable} (id INT PRIMARY KEY, tag TEXT NOT NULL)` },
    { version: 2, name: 'seed', sql: `INSERT INTO ${smokeTable} (id, tag) VALUES (1, 'seed') ON CONFLICT (id) DO NOTHING` },
  ];
  const client = await pool.connect();
  try {
    // applyMigrations is executor-generic: a raw pg.Pool is NOT a valid
    // pinned executor (per-statement client checkout — see WORK-002's
    // evidence). A hand-acquired client pins the batch to one session.
    const first = await applyMigrations(client, migrations);
    assert.equal(first.applied.length, 2);
    const second = await applyMigrations(client, migrations);
    assert.equal(second.applied.length, 0);
    assert.equal(second.skipped, 2);
    const rows = await client.query(`SELECT COUNT(*)::int AS count FROM ${smokeTable}`);
    assert.equal((rows.rows[0] as { count: number }).count, 1);
  } finally {
    client.release();
    await pool.end();
    await live.drop();
  }
});

test('live: boundary readiness probes a real database', { skip: SKIP }, async () => {
  let live: LiveDatabase | null = null;
  try {
    live = await createLiveTestDatabase();
    const boundary = createPersistence({ databaseUrl: live.dsn });
    try {
      const probe = await boundary.ready();
      assert.equal(probe.ok, true);
    } finally {
      await boundary.stop();
    }
  } finally {
    await live?.drop();
  }
});
