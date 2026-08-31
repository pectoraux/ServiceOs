/**
 * Optional live-PostgreSQL integration proof for the persistence boundary
 * (WORK-001). Runs ONLY when SERVICEOS_TEST_DATABASE_URL points at a
 * disposable PostgreSQL database; otherwise it is skipped.
 *
 * WORK-002 note: these proofs were previously skipped everywhere (no
 * PostgreSQL service in CI). When WORK-002's CI provisioned PostgreSQL they
 * executed for the first time and empirically confirmed the pool-pinning
 * defect documented in WORK-002's evidence: `pg.Pool.query` checks out a
 * client per statement, so BEGIN/work/COMMIT through a bare pool are not
 * reliably serialized (the seed INSERT ran in a session that could not see
 * the CREATE TABLE). The migration proofs therefore drive the runner through
 * pinned executors exactly as production does (`npm run migrate` uses the
 * persistence boundary's client-pinned path).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createPersistence } from '../src/platform/persistence/index.js';
import { applyMigrations, type Migration } from '../src/platform/persistence/migrations.js';

const DATABASE_URL = process.env.SERVICEOS_TEST_DATABASE_URL;

test('live: migrations apply once, converge on re-run and under parallel runners', { skip: DATABASE_URL === undefined }, async () => {
  // Production composition: the boundary pins every migration batch to ONE
  // acquired PostgreSQL client (client-pinned transaction + advisory lock).
  const boundary = createPersistence({ databaseUrl: DATABASE_URL as string });

  const smokeTable = `serviceos_integration_smoke_${Date.now()}`;
  const migrations: Migration[] = [
    { version: 1, name: 'baseline', sql: `CREATE TABLE IF NOT EXISTS ${smokeTable} (id INT PRIMARY KEY, tag TEXT NOT NULL)` },
    { version: 2, name: 'seed', sql: `INSERT INTO ${smokeTable} (id, tag) VALUES (1, 'seed') ON CONFLICT (id) DO NOTHING` },
  ];

  try {
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

    // Cleanup (integration database is disposable).
    await boundary.pool().query(`DROP TABLE IF EXISTS ${smokeTable}`);
  } finally {
    await boundary.stop();
  }
});

test('live: direct-pool migration batches are applied through a pinned client (defect regression)', { skip: DATABASE_URL === undefined }, async () => {
  // applyMigrations is executor-generic: a raw pg.Pool is NOT a valid pinned
  // executor (per-statement client checkout). This proof pins a client by
  // hand and shows the runner's full semantics hold on that single session.
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const smokeTable = `serviceos_integration_pinned_${Date.now()}`;
  const migrations: Migration[] = [
    { version: 1, name: 'baseline', sql: `CREATE TABLE IF NOT EXISTS ${smokeTable} (id INT PRIMARY KEY, tag TEXT NOT NULL)` },
    { version: 2, name: 'seed', sql: `INSERT INTO ${smokeTable} (id, tag) VALUES (1, 'seed') ON CONFLICT (id) DO NOTHING` },
  ];
  const client = await pool.connect();
  try {
    const first = await applyMigrations(client, migrations);
    assert.equal(first.applied.length, 2);
    const second = await applyMigrations(client, migrations);
    assert.equal(second.applied.length, 0);
    assert.equal(second.skipped, 2);
    const rows = await client.query(`SELECT COUNT(*)::int AS count FROM ${smokeTable}`);
    assert.equal((rows.rows[0] as { count: number }).count, 1);
    await client.query(`DROP TABLE IF EXISTS ${smokeTable}`);
  } finally {
    client.release();
    await pool.end();
  }
});

test('live: boundary readiness probes a real database', { skip: DATABASE_URL === undefined }, async () => {
  const boundary = createPersistence({ databaseUrl: DATABASE_URL as string });
  try {
    const probe = await boundary.ready();
    assert.equal(probe.ok, true);
  } finally {
    await boundary.stop();
  }
});
