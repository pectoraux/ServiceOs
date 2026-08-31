/**
 * Optional live-PostgreSQL integration proof for the persistence boundary
 * (WORK-001). Runs ONLY when SERVICEOS_TEST_DATABASE_URL points at a
 * disposable PostgreSQL database; otherwise it is skipped.
 *
 * This file documents that the implementation environment had no PostgreSQL
 * instance available: these proofs were therefore NOT executed locally and
 * must be exercised in an environment that provides the variable (CI can).
 * They are additional evidence, not a substitute for the required proof
 * classes (WORK-001's verification requirements list concurrency/crash proofs
 * as "not required" for this Work Order).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createPersistence } from '../src/platform/persistence/index.js';
import { applyMigrations, type Migration } from '../src/platform/persistence/migrations.js';

const DATABASE_URL = process.env.SERVICEOS_TEST_DATABASE_URL;

test('live: migrations apply once, converge on re-run and under parallel runners', { skip: DATABASE_URL === undefined }, async () => {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });

  const smokeTable = `serviceos_integration_smoke_${Date.now()}`;
  const migrations: Migration[] = [
    { version: 1, name: 'baseline', sql: `CREATE TABLE IF NOT EXISTS ${smokeTable} (id INT PRIMARY KEY, tag TEXT NOT NULL)` },
    { version: 2, name: 'seed', sql: `INSERT INTO ${smokeTable} (id, tag) VALUES (1, 'seed') ON CONFLICT (id) DO NOTHING` },
  ];

  try {
    // First run applies both.
    const first = await applyMigrations(pool, migrations);
    assert.equal(first.applied.length, 2);

    // Re-run converges to a no-op.
    const second = await applyMigrations(pool, migrations);
    assert.equal(second.applied.length, 0);
    assert.equal(second.skipped, 2);

    // Parallel runners converge: exactly one seed row exists afterwards.
    await Promise.all([applyMigrations(pool, migrations), applyMigrations(pool, migrations), applyMigrations(pool, migrations)]);
    const rows = await pool.query(`SELECT COUNT(*)::int AS count FROM ${smokeTable}`);
    assert.equal((rows.rows[0] as { count: number }).count, 1);

    // Cleanup (integration database is disposable).
    await pool.query(`DROP TABLE IF EXISTS ${smokeTable}`);
  } finally {
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
