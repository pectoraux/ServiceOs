/**
 * Structural + discrimination proof: /work authority boundaries
 * (WORK-003, static class — "no workflow engine in /work", "no Zeck state
 * machine in ServiceOS", migration table-prefix discipline).
 *
 * Proves:
 * - the REAL tree passes all work-boundary checks (static);
 * - the real /work module implements and exports its public contract and
 *   the structural tripwires (the /work public interface owns the module
 *   factory and store port; the schema's closed work-status enumeration is
 *   pinned by the migration text);
 * - synthetic MUTATED trees are rejected with the exact violation codes
 *   (discrimination): a transition export in /work, an UPDATE of work
 *   status in /work, /work importing /workflow, a Zeck-lifecycle export in
 *   any module, a Zeck-named export in /work, a zeck table in a migration,
 *   and an off-prefix migration table.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkWorkBoundaries, extractCreatedTables } from '../src/platform/governance/work-boundary-checks.js';
import { checkZeckBoundaries } from '../src/platform/governance/zeck-boundary-checks.js';
import { makeTempTree, moduleFile } from './helpers/tree.js';

const REAL_SRC_ROOT = resolve(process.cwd(), 'src');
const REAL_MIGRATIONS = resolve(process.cwd(), 'db/migrations');

const BASE_MODULES = [
  'auth',
  'organizations',
  'services',
  'verticals',
  'entities',
  'work',
  'workflow',
  'policies',
  'approvals',
  'interactions',
  'zeck',
  'evidence',
  'billing',
  'audit',
  'integrations',
  'notifications',
];

/** A minimal conforming module tree plus an empty migrations directory. */
function conformingTree(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of BASE_MODULES) {
    files[`src/modules/${name}/index.ts`] = moduleFile(name);
  }
  files['db/migrations/0001_identity_tenancy.sql'] = 'CREATE TABLE org_organizations (id UUID);';
  files['db/migrations/0002_service_work.sql'] = 'CREATE TABLE work_service_works (id UUID);';
  return files;
}

function runCheck(files: Record<string, string>): { code: string; detail: string; file?: string }[] {
  const { root, cleanup } = makeTempTree(files);
  try {
    return checkWorkBoundaries({
      srcRoot: resolve(root, 'src'),
      migrationsDir: resolve(root, 'db/migrations'),
    });
  } finally {
    cleanup();
  }
}

/** The WORK-005 Zeck boundary checks over the same synthetic trees. */
function runZeckCheck(files: Record<string, string>): { code: string; detail: string; file?: string }[] {
  const { root, cleanup } = makeTempTree(files);
  try {
    return checkZeckBoundaries({
      srcRoot: resolve(root, 'src'),
      migrationsDir: resolve(root, 'db/migrations'),
    });
  } finally {
    cleanup();
  }
}

test('the real tree passes the work-boundary checks (static)', () => {
  const violations = checkWorkBoundaries({ srcRoot: REAL_SRC_ROOT, migrationsDir: REAL_MIGRATIONS });
  assert.deepEqual(violations, []);
});

test('the real /work module implements its public contract (static)', () => {
  const workSource = readFileSync(resolve(REAL_SRC_ROOT, 'modules/work/index.ts'), 'utf8');
  assert.ok(/export function createWorkModule/.test(workSource));
  assert.ok(/export interface WorkModule/.test(workSource));
  assert.ok(/export class WorkError/.test(workSource));
  assert.ok(/export default defineModule\(\{\s*name: 'work'/.test(workSource));
  // The store port and SQL store exist as the module's persistence contract.
  assert.ok(/export interface WorkStore/.test(readFileSync(resolve(REAL_SRC_ROOT, 'modules/work/store.ts'), 'utf8')));
  assert.ok(/export function createSqlWorkStore/.test(readFileSync(resolve(REAL_SRC_ROOT, 'modules/work/sql-store.ts'), 'utf8')));
});

test('the real migration pins the closed work-status enumeration (static)', () => {
  const sql = readFileSync(resolve(REAL_MIGRATIONS, '0002_service_work.sql'), 'utf8');
  // /work can only ever write 'draft': the schema physically refuses any
  // other work status until /workflow's own migration extends it.
  assert.ok(/CHECK \(status IN \('draft'\)\)/.test(sql));
  // Durable idempotency primitives exist as partial unique indexes.
  assert.ok(/CREATE UNIQUE INDEX work_service_works_tenant_idempotency_key/.test(sql));
  assert.ok(/CREATE UNIQUE INDEX work_attempts_one_live_per_work/.test(sql));
  assert.ok(/CREATE UNIQUE INDEX work_attempts_live_idempotency_key/.test(sql));
  // No Zeck-owned column or table exists anywhere in the schema.
  assert.equal(extractCreatedTables(sql).filter((table) => /zeck/i.test(table)).length, 0);
  assert.deepEqual(
    extractCreatedTables(sql).sort(),
    ['work_attempts', 'work_dependencies', 'work_service_works'],
  );
});

test('a conforming synthetic tree passes (no false positives)', () => {
  assert.deepEqual(runCheck(conformingTree()), []);
});

test('a transition-engine export in /work is rejected (discrimination)', () => {
  const files = conformingTree();
  files['src/modules/work/transition.ts'] = `export function applyTransition(): boolean { return true; }\n`;
  const violations = runCheck(files);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.code, 'workflow-engine-in-work');
  assert.ok(violations[0]?.file?.includes('transition.ts'));
});

test('a state-machine export in /work is rejected (discrimination)', () => {
  const files = conformingTree();
  files['src/modules/work/index.ts'] = moduleFile('work', `\nexport const stateMachine = { draft: ['ready'] };\n`);
  const violations = runCheck(files);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.code, 'workflow-engine-in-work');
});

test('a work-status UPDATE in /work is rejected (discrimination)', () => {
  const files = conformingTree();
  files['src/modules/work/sql-store.ts'] = `export const NOTHING = 1;\nexport async function transitionDraft() {\n  await exec.query(\`UPDATE work_service_works SET status = 'ready' WHERE id = $1\`, []);\n}\n`;
  const violations = runCheck(files);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.code, 'workflow-engine-in-work');
  assert.ok(violations[0]?.detail.includes('mutates ServiceWork state'));
});

test('/work importing /workflow is rejected (discrimination)', () => {
  const files = conformingTree();
  files['src/modules/work/index.ts'] = `import { defineModule } from '../../platform/module-registry/index.js';\nimport { submitTransition } from '../workflow/index.js';\n\nvoid submitTransition;\n\nexport default defineModule({ name: 'work', version: '0.1.0', description: 'synthetic work' });\n`;
  const violations = runCheck(files);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.code, 'workflow-engine-in-work');
  assert.ok(violations[0]?.detail.includes('imports /workflow'));
});

test('/work importing /zeck is rejected (discrimination)', () => {
  const files = conformingTree();
  files['src/modules/work/index.ts'] = `import { defineModule } from '../../platform/module-registry/index.js';\nimport { anything } from '../zeck/index.js';\n\nvoid anything;\n\nexport default defineModule({ name: 'work', version: '0.1.0', description: 'synthetic work' });\n`;
  const violations = runCheck(files);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.code, 'workflow-engine-in-work');
  assert.ok(violations[0]?.detail.includes('imports /zeck'));
});

test('a Zeck execution lifecycle export in any module is rejected (discrimination)', () => {
  const files = conformingTree();
  files['src/modules/evidence/index.ts'] = moduleFile('evidence', `\nexport function zeckExecutionStatus(): string { return 'running'; }\n`);
  const violations = runCheck(files);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.code, 'zeck-state-machine');
});

test('a Zeck-lifecycle export in the /zeck module itself is rejected (lock #19)', () => {
  const files = conformingTree();
  files['src/modules/zeck/index.ts'] = moduleFile('zeck', `\nexport const zeckExecutionStateMachine = { pending: ['running'] };\n`);
  const violations = runCheck(files);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.code, 'zeck-state-machine');
});

test('a Zeck-named export in /work is rejected (AC-2 separation)', () => {
  const files = conformingTree();
  files['src/modules/work/index.ts'] = moduleFile('work', `\nexport type ZeckExecutionRef = { id: string };\n`);
  const violations = runCheck(files);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.code, 'zeck-state-in-work');
});

test('a zeck lifecycle table in a migration is rejected (discrimination, refined by WORK-005)', () => {
  // WORK-005 owns the `zeck_` table prefix (the reference/observation
  // surface of migration 0008), so the OLD off-prefix tripwire no longer
  // fires for `zeck_`-prefixed tables. The shadow-lifecycle prohibition
  // is now enforced PRECISELY: a `zeck_`-prefixed table declaring an
  // execution-lifecycle column is rejected by checkZeckBoundaries
  // (zeck-lifecycle-schema-in-serviceos) — a stronger discrimination
  // than the old blanket zeck-string rule, which would have rejected
  // the legitimate reference surface too.
  const files = conformingTree();
  files['db/migrations/0003_zeck_executions.sql'] =
    'CREATE TABLE zeck_executions (\n  id UUID,\n  status TEXT\n);\n';
  const violations = runZeckCheck(files);
  assert.deepEqual(
    violations.map((violation) => violation.code).sort(),
    ['zeck-lifecycle-schema-in-serviceos'],
  );
  const zeckViolation = violations.find((violation) => violation.code === 'zeck-lifecycle-schema-in-serviceos');
  assert.ok(zeckViolation?.file?.includes('0003_zeck_executions.sql'));
  // The prefix discipline still accepts `zeck_` (owned by WORK-005) and
  // the blanket rule accepts the /zeck-owned migration shape: the same
  // plant must NOT trip the work-boundary migration tripwires anymore.
  assert.deepEqual(runCheck(files), []);
});

test('zeck references outside the /zeck-owned migration are rejected (discrimination, WORK-005)', () => {
  // A zeck reference in a migration that is NOT the `zeck`-named,
  // all-`zeck_`-tables reference migration is a boundary leak and fails
  // closed exactly as before (architecture-lock #19).
  const files = conformingTree();
  files['db/migrations/0009_side_channel.sql'] = 'CREATE TABLE side_channel_events (id UUID, zeck_execution_id TEXT);\n';
  const violations = runCheck(files);
  assert.deepEqual(
    violations.map((violation) => violation.code).sort(),
    ['unknown-migration-table-prefix', 'zeck-schema-in-serviceos'],
  );
});

test('an off-prefix migration table is rejected (discrimination)', () => {
  const files = conformingTree();
  files['db/migrations/0003_side_channel.sql'] = 'CREATE TABLE side_channel_events (id UUID);\n';
  const violations = runCheck(files);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.code, 'unknown-migration-table-prefix');
});

test('zeck references inside migration comments do not trip the schema check (no false positives)', () => {
  const files = conformingTree();
  files['db/migrations/0003_notes.sql'] = `-- This migration deliberately mentions zeck only in prose.\nCREATE TABLE work_notes (id UUID);\n`;
  assert.deepEqual(runCheck(files), []);
});

test('a missing module tree fails closed instead of passing vacuously', () => {
  const { root, cleanup } = makeTempTree({ 'other/file.txt': 'not a module tree' });
  try {
    assert.throws(
      () =>
        checkWorkBoundaries({
          srcRoot: resolve(root, 'src'),
          migrationsDir: resolve(root, 'db/migrations'),
        }),
      /cannot scan module tree/,
    );
  } finally {
    cleanup();
  }
});

test('check CLI wiring: the real repository passes end-to-end (static)', () => {
  // The check CLI (npm run check) composes checkWorkBoundaries with the
  // architecture and identity checks; running it here proves the wiring
  // end-to-end. It exits non-zero on any violation. (Minimal env, mirroring
  // the WORK-001 check-CLI proof; era-relative branch from program state.)
  const program = JSON.parse(
    readFileSync(join(process.cwd(), 'spec/development-state/program-state.json'), 'utf8'),
  ) as { workOrders: { id: string; status: string; branch: string }[] };
  const live = program.workOrders.find((entry) => entry.status === 'in_flight');
  assert.ok(live, 'expected an in-flight Work Order in canonical state');
  const result = spawnSync(process.execPath, [resolve(process.cwd(), 'dist/src/cli/check.js')], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      EXPECT_BRANCH: live.branch,
    },
  });
  assert.equal(result.status, 0, `stdout:\n${result.stdout ?? ''}\nstderr:\n${result.stderr ?? ''}`);
  assert.match(result.stdout ?? '', /work: no transition engine in \/work, no Zeck state machine/);
  assert.match(result.stdout ?? '', /PASS: ServiceOS build, architecture, configuration and governance checks/);
});
