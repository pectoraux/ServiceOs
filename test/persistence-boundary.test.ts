/**
 * Behavioral proof: the PostgreSQL persistence boundary (WORK-001).
 *
 * Proves the boundary is fail-closed and truthful:
 * - without a configured DSN nothing connects and `pool()` throws a typed
 *   PersistenceNotConfiguredError (no fabricated empty results, no silent
 *   second authority);
 * - with a configured DSN the pool is a lazy singleton and readiness reports
 *   both success and failure honestly;
 * - transaction semantics (BEGIN/COMMIT/ROLLBACK) hold, including rollback
 *   failure wrapping;
 * - stop() drains the pool exactly once.
 *
 * No live PostgreSQL is required: executors are injected fakes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPersistence,
  withTransactionOn,
  PersistenceNotConfiguredError,
  TransactionRollbackError,
} from '../src/platform/persistence/index.js';
import { FakePool, sqlOf } from './helpers/tree.js';

test('unconfigured boundary fails closed on pool access', () => {
  const boundary = createPersistence({ databaseUrl: null });
  assert.equal(boundary.isConfigured(), false);
  assert.throws(() => boundary.pool(), PersistenceNotConfiguredError);
});

test('unconfigured boundary reports truthful (not-ok) readiness', async () => {
  const boundary = createPersistence({ databaseUrl: null });
  const probe = await boundary.ready();
  assert.equal(probe.ok, false);
  assert.match(probe.detail ?? '', /not configured/);
});

test('configured boundary reports ok readiness when SELECT 1 succeeds', async () => {
  const pool = new FakePool({ answers: [{ match: /^SELECT 1$/, rows: [{ '?column?': 1 }] }] });
  const boundary = createPersistence({ databaseUrl: 'postgres://localhost/serviceos', pooledExecutor: pool });
  const probe = await boundary.ready();
  assert.equal(probe.ok, true);
  assert.equal(boundary.isConfigured(), true);
});

test('configured boundary reports not-ok readiness when SELECT 1 fails (discrimination)', async () => {
  const pool = new FakePool({ failOn: /^SELECT 1$/ });
  const boundary = createPersistence({ databaseUrl: 'postgres://localhost/serviceos', pooledExecutor: pool });
  const probe = await boundary.ready();
  assert.equal(probe.ok, false);
  assert.match(probe.detail ?? '', /scripted failure/);
});

test('pool is a lazy singleton per boundary instance', () => {
  const pool = new FakePool();
  const boundary = createPersistence({ databaseUrl: 'postgres://localhost/serviceos', pooledExecutor: pool });
  assert.strictEqual(boundary.pool(), boundary.pool());
  assert.strictEqual(boundary.pool(), pool);
});

test('stop() drains the pool exactly once', async () => {
  const pool = new FakePool();
  const boundary = createPersistence({ databaseUrl: 'postgres://localhost/serviceos', pooledExecutor: pool });
  boundary.pool();
  await boundary.stop();
  assert.equal(pool.endCalls, 1);
  await boundary.stop();
  assert.equal(pool.endCalls, 1);
});

test('stop() before pool creation is a no-op', async () => {
  const boundary = createPersistence({ databaseUrl: null });
  await boundary.stop();
});

// ---------------------------------------------------------------------------
// Transaction semantics
// ---------------------------------------------------------------------------

test('withTransactionOn: success commits after the work', async () => {
  const executor = new FakePool();
  const result = await withTransactionOn(executor, async (tx) => {
    await tx.query('INSERT INTO demo (id) VALUES ($1)', [1]);
    return 'done';
  });
  assert.equal(result, 'done');
  assert.deepEqual(sqlOf(executor.statements), [
    'BEGIN',
    'INSERT INTO demo (id) VALUES ($1)',
    'COMMIT',
  ]);
});

test('withTransactionOn: failure rolls back and rethrows the original error', async () => {
  const executor = new FakePool();
  await assert.rejects(
    withTransactionOn(executor, async (tx) => {
      await tx.query('UPDATE demo SET broken = true');
      throw new Error('business rule violated');
    }),
    /business rule violated/,
  );
  assert.deepEqual(sqlOf(executor.statements), [
    'BEGIN',
    'UPDATE demo SET broken = true',
    'ROLLBACK',
  ]);
});

test('withTransactionOn: rollback failure is wrapped, not swallowed', async () => {
  const executor = new FakePool({ failOn: /^ROLLBACK$/ });
  await assert.rejects(
    withTransactionOn(executor, async () => {
      throw new Error('original failure');
    }),
    (error: unknown) => {
      assert.ok(error instanceof TransactionRollbackError);
      assert.match(error.message, /rollback failed/);
      return true;
    },
  );
});

test('withTransactionOn: commit failure propagates', async () => {
  const executor = new FakePool({ failOn: /^COMMIT$/ });
  await assert.rejects(
    withTransactionOn(executor, async () => 'x'),
    /scripted failure on: COMMIT/,
  );
});

test('boundary.withTransaction delegates to the pool with the same semantics', async () => {
  const pool = new FakePool();
  const boundary = createPersistence({ databaseUrl: 'postgres://localhost/serviceos', pooledExecutor: pool });
  await assert.rejects(
    boundary.withTransaction(async () => {
      throw new Error('nope');
    }),
    /nope/,
  );
  assert.deepEqual(sqlOf(pool.statements), ['BEGIN', 'ROLLBACK']);
});

test('boundary.migrate delegates to the migration runner', async () => {
  const pool = new FakePool();
  const boundary = createPersistence({ databaseUrl: 'postgres://localhost/serviceos', pooledExecutor: pool });
  const report = await boundary.migrate([
    { version: 1, name: 'smoke', sql: 'CREATE TABLE smoke (id INT)' },
  ]);
  assert.deepEqual(report.applied, [{ version: 1, name: 'smoke' }]);
  // Second run is idempotent against the same scripted history (empty SELECT by default → re-applies).
  // The dedicated migrations tests cover history-based idempotency precisely.
});
