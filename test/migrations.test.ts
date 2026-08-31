/**
 * Behavioral proof: migration runner semantics (WORK-001 persistence boundary).
 *
 * Proves with a scripted executor:
 * - advisory lock + history table bootstrap precede any migration SQL;
 * - pending migrations apply in order and are recorded with (version, name);
 * - re-running against recorded history is a no-op (idempotency);
 * - duplicate / non-monotonic / missing-after-applied versions fail closed
 *   (history tamper guard);
 * - a failing migration rolls the whole batch back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyMigrations,
  MigrationError,
  MIGRATION_LOCK_KEY,
  parseMigrationFileName,
  type Migration,
} from '../src/platform/persistence/migrations.js';
import { FakePool, sqlOf } from './helpers/tree.js';

const MIGRATIONS: Migration[] = [
  { version: 1, name: 'one', sql: 'CREATE TABLE one (id INT)' },
  { version: 2, name: 'two', sql: 'CREATE TABLE two (id INT)' },
];

function historyAnswer(versions: number[]): {
  match: RegExp;
  rows: Record<string, unknown>[];
} {
  return {
    match: /FROM serviceos_schema_history/,
    rows: versions.map((version) => ({ version, name: `recorded-${version}` })),
  };
}

test('fresh database: advisory lock first, then history table, then migrations in order', async () => {
  const executor = new FakePool({ answers: [historyAnswer([])] });
  const report = await applyMigrations(executor, MIGRATIONS);

  assert.deepEqual(report.applied, [
    { version: 1, name: 'one' },
    { version: 2, name: 'two' },
  ]);
  assert.equal(report.skipped, 0);

  const trace = sqlOf(executor.statements);
  assert.equal(trace[0], 'BEGIN');
  assert.equal(trace[1], `SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`);
  assert.match(trace[2] as string, /CREATE TABLE IF NOT EXISTS serviceos_schema_history/);
  assert.match(trace[3] as string, /FROM serviceos_schema_history/);
  assert.equal(trace[4], 'CREATE TABLE one (id INT)');
  assert.match(trace[5] as string, /INSERT INTO serviceos_schema_history/);
  assert.equal(trace[6], 'CREATE TABLE two (id INT)');
  assert.match(trace[7] as string, /INSERT INTO serviceos_schema_history/);
  assert.equal(trace[8], 'COMMIT');

  const insertOne = executor.statements[5];
  assert.deepEqual(insertOne?.params, [1, 'one']);
  const insertTwo = executor.statements[7];
  assert.deepEqual(insertTwo?.params, [2, 'two']);
});

test('already-applied history: re-running is a no-op (idempotency)', async () => {
  const executor = new FakePool({ answers: [historyAnswer([1, 2])] });
  const report = await applyMigrations(executor, MIGRATIONS);

  assert.deepEqual(report.applied, []);
  assert.equal(report.skipped, 2);
  const trace = sqlOf(executor.statements);
  assert.equal(trace[0], 'BEGIN');
  assert.equal(trace[trace.length - 1], 'COMMIT');
  assert.ok(!trace.includes('CREATE TABLE one (id INT)'));
  assert.ok(!trace.includes('CREATE TABLE two (id INT)'));
});

test('partially applied: only pending migrations run', async () => {
  const executor = new FakePool({ answers: [historyAnswer([1])] });
  const report = await applyMigrations(executor, MIGRATIONS);
  assert.deepEqual(report.applied, [{ version: 2, name: 'two' }]);
  assert.equal(report.skipped, 1);
});

test('duplicate migration versions fail closed', async () => {
  const executor = new FakePool({ answers: [historyAnswer([])] });
  await assert.rejects(
    applyMigrations(executor, [
      { version: 1, name: 'one', sql: 'SELECT 1' },
      { version: 1, name: 'one-again', sql: 'SELECT 2' },
    ]),
    MigrationError,
  );
});

test('non-monotonic migration versions fail closed', async () => {
  const executor = new FakePool({ answers: [historyAnswer([])] });
  await assert.rejects(
    applyMigrations(executor, [
      { version: 2, name: 'two', sql: 'SELECT 1' },
      { version: 1, name: 'one', sql: 'SELECT 2' },
    ]),
    MigrationError,
  );
});

test('removed-but-applied migration fails closed (history tamper guard)', async () => {
  const executor = new FakePool({ answers: [historyAnswer([1, 2])] });
  await assert.rejects(
    applyMigrations(executor, [
      { version: 2, name: 'two', sql: 'SELECT 1' },
      { version: 3, name: 'three', sql: 'SELECT 3' },
    ]),
    (error: unknown) => {
      assert.ok(error instanceof MigrationError);
      assert.match(error.message, /version 1 is recorded in history but missing/);
      return true;
    },
  );
});

test('inconsistent history (gap below high-water mark) fails closed', async () => {
  const executor = new FakePool({ answers: [historyAnswer([2])] });
  await assert.rejects(
    applyMigrations(executor, [
      { version: 1, name: 'one', sql: 'SELECT 1' },
      { version: 2, name: 'two', sql: 'SELECT 2' },
      { version: 3, name: 'three', sql: 'SELECT 3' },
    ]),
    (error: unknown) => {
      assert.ok(error instanceof MigrationError);
      assert.match(error.message, /inconsistent/);
      return true;
    },
  );
});

test('a failing migration rolls the whole batch back', async () => {
  const executor = new FakePool({
    answers: [historyAnswer([])],
    failOn: /CREATE TABLE two/,
  });
  await assert.rejects(
    applyMigrations(executor, MIGRATIONS),
    /scripted failure on: CREATE TABLE two/,
  );
  const trace = sqlOf(executor.statements);
  assert.equal(trace[trace.length - 1], 'ROLLBACK');
  assert.ok(!trace.includes('COMMIT'));
});

test('empty migration set is a valid no-op', async () => {
  const executor = new FakePool({ answers: [historyAnswer([])] });
  const report = await applyMigrations(executor, []);
  assert.deepEqual(report.applied, []);
  assert.equal(report.skipped, 0);
});

test('malformed migration input fails closed', async () => {
  const executor = new FakePool({ answers: [historyAnswer([])] });
  await assert.rejects(
    applyMigrations(executor, [{ version: 0, name: 'zero', sql: 'SELECT 1' }]),
    MigrationError,
  );
  await assert.rejects(
    applyMigrations(executor, [{ version: 1, name: 'blank', sql: '' }]),
    MigrationError,
  );
});

test('migration file names parse to (version, name)', () => {
  assert.deepEqual(parseMigrationFileName('0001_platform_baseline.sql'), {
    version: 1,
    name: 'platform-baseline',
  });
  assert.deepEqual(parseMigrationFileName('0042_tenant_tables.sql'), {
    version: 42,
    name: 'tenant-tables',
  });
  assert.equal(parseMigrationFileName('README.md'), null);
  assert.equal(parseMigrationFileName('bad-name.sql'), null);
});
