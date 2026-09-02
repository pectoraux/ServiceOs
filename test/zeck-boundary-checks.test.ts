/**
 * Structural + discrimination proofs for the /zeck integration boundary
 * (WORK-005, required classes `static` + `discrimination`).
 *
 * Proves:
 * - the REAL tree passes all Zeck boundary checks (static);
 * - the real /zeck module implements and exports its public contract
 *   (the one provider-neutral port, the AIExecutionIntent validation
 *   surface, the store port, the typed error surface, the gateway
 *   doubles) and migration 0008 pins the durable invariants (keyed
 *   identity, one intent per attempt, one intent per foreign execution
 *   reference, one delivery row per event identity, the
 *   reference/submission pairing CHECK, the disposition/rejection
 *   pairing CHECK, and NO lifecycle/credential columns anywhere);
 * - synthetic MUTATED trees are rejected with the exact violation codes
 *   (discrimination): another module exporting the submission/translation
 *   entry points, /zeck importing a forbidden authority (workflow,
 *   billing, policies), /zeck importing an internal file, another module
 *   importing /zeck at this frontier, a credential-shaped token in /zeck
 *   sources, a `zeck_` table declaring an execution-lifecycle column, a
 *   `zeck_` table declaring a credential column, a planted model-router
 *   import (the AI implementation prohibition), and a Zeck lifecycle
 *   export anywhere (lock #19);
 * - the migration table-prefix discipline accepts `zeck_` (owned by
 *   WORK-005) and still rejects off-prefix tables.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  checkZeckBoundaries,
  RESERVED_ZECK_AUTHORITY_EXPORTS,
  ZECK_ALLOWED_IMPORTS,
  ZECK_IMPORTERS,
  ZECK_LIFECYCLE_COLUMN_DENYLIST,
  ZECK_CREDENTIAL_TOKENS,
} from '../src/platform/governance/zeck-boundary-checks.js';
import {
  checkWorkBoundaries,
  ALLOWED_MIGRATION_TABLE_PREFIXES,
} from '../src/platform/governance/work-boundary-checks.js';
import { checkArchitecture } from '../src/platform/governance/architecture-checks.js';
import { makeTempTree, moduleFile } from './helpers/tree.js';
import {
  ZECK_CALLBACK_EVENT_TYPES,
  isZeckCallbackEventType,
  validateExecutionIntentInput,
  createInMemoryZeckGateway,
} from '../src/modules/zeck/index.js';

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

/** A minimal conforming module tree. */
function conformingTree(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of BASE_MODULES) {
    files[`src/modules/${name}/index.ts`] = moduleFile(name);
  }
  files['db/migrations/0001_identity_tenancy.sql'] = 'CREATE TABLE org_organizations (id UUID);';
  files['db/migrations/0002_service_work.sql'] = 'CREATE TABLE work_service_works (id UUID);';
  return files;
}

function runZeckCheck(files: Record<string, string>): { code: string; detail: string; file?: string }[] {
  const { root, cleanup } = makeTempTree(files);
  try {
    return checkZeckBoundaries({ srcRoot: resolve(root, 'src'), migrationsDir: resolve(root, 'db/migrations') });
  } finally {
    cleanup();
  }
}

function runWorkCheck(files: Record<string, string>): { code: string; detail: string; file?: string }[] {
  const { root, cleanup } = makeTempTree(files);
  try {
    return checkWorkBoundaries({ srcRoot: resolve(root, 'src'), migrationsDir: resolve(root, 'db/migrations') });
  } finally {
    cleanup();
  }
}

function runArchitectureCheck(files: Record<string, string>): { code: string; detail: string; file?: string }[] {
  const { root, cleanup } = makeTempTree(files);
  try {
    return checkArchitecture({ srcRoot: resolve(root, 'src'), repoRoot: root, expectedModules: BASE_MODULES });
  } finally {
    cleanup();
  }
}

/** A conforming tree PLUS the platform stubs the architecture checker
 * resolves (mirrors the architecture-checks test helper). */
function architectureTree(extra: Record<string, string> = {}): Record<string, string> {
  const base = conformingTree();
  for (const name of BASE_MODULES) {
    base[`src/modules/${name}/index.ts`] = moduleFile(name);
  }
  base['src/main.ts'] =
    "import auth from './modules/auth/index.js';\nimport work from './modules/work/index.js';\nimport { defineModule } from './platform/module-registry/index.js';\nexport default defineModule({ name: 'root', version: '0.0.0', description: 'synthetic' });\nvoid auth; void work;\n";
  base['src/platform/module-registry/index.ts'] =
    "export function defineModule(m: { name: string; version: string; description: string }) { return { manifest: m }; }\n";
  base['src/platform/persistence/index.ts'] = "export function boundary(): null { return null; }\n";
  base['src/platform/http/index.ts'] = "export function compose(): null { return null; }\n";
  return { ...base, ...extra };
}

// ---------------------------------------------------------------------------
// Static: the real tree conforms
// ---------------------------------------------------------------------------

test('the real tree passes the Zeck boundary checks (static)', () => {
  assert.deepEqual(checkZeckBoundaries({ srcRoot: REAL_SRC_ROOT, migrationsDir: REAL_MIGRATIONS }), []);
});

test('the real tree passes the work-boundary checks with the WORK-005 prefix extension (static)', () => {
  assert.deepEqual(checkWorkBoundaries({ srcRoot: REAL_SRC_ROOT, migrationsDir: REAL_MIGRATIONS }), []);
  assert.ok(ALLOWED_MIGRATION_TABLE_PREFIXES.includes('zeck_'));
});

test('the real /zeck module exports its public contract (the one port, validation, store, doubles)', () => {
  const source = readFileSync(resolve(REAL_SRC_ROOT, 'modules/zeck/index.ts'), 'utf8');
  for (const name of [
    'createZeckModule',
    'submitExecutionIntent',
    'ingestCallback',
    'ZeckError',
    'validateExecutionIntentInput',
    'createSqlZeckStore',
    'createInMemoryZeckGateway',
  ]) {
    assert.ok(source.includes(name), `the /zeck public interface must surface "${name}"`);
  }
  // The one port contract and the frozen translation enumeration.
  assert.ok(source.includes('ZeckGateway'));
  assert.ok(source.includes('ZeckExecutionRequest'));
  assert.deepEqual([...ZECK_CALLBACK_EVENT_TYPES], ['execution.completed', 'execution.failed']);
  assert.equal(isZeckCallbackEventType('execution.completed'), true);
  assert.equal(isZeckCallbackEventType('execution.progress'), false);
  // A conformant gateway double exists and carries NO credential or
  // selection surface (AC-4).
  const double = createInMemoryZeckGateway();
  assert.equal(double.connectionName, 'zeck-double');
  assert.throws(
    () => validateExecutionIntentInput(null as never),
    /the execution-intent input must be an object/,
  );
});

test('migration 0008 pins the durable invariants of the reference/observation surface', () => {
  const sql = readFileSync(resolve(REAL_MIGRATIONS, '0008_zeck_integration_boundary.sql'), 'utf8');
  // The durable identities: keyed intent, one intent per attempt, one
  // intent per foreign execution reference, one delivery per event.
  assert.ok(sql.includes('zeck_execution_intents_tenant_idempotency_key'));
  assert.ok(sql.includes('zeck_execution_intents_tenant_attempt'));
  assert.ok(sql.includes('zeck_execution_intents_tenant_execution_ref'));
  assert.ok(sql.includes('zeck_callback_events_tenant_event_id'));
  // The reference/submission pairing and the disposition/rejection
  // pairing are schema-level.
  assert.ok(/CHECK\s*\(\s*\(zeck_execution_id IS NULL AND submitted_by IS NULL AND submitted_at IS NULL\)/.test(sql));
  assert.ok(/CHECK\s*\(\s*\(disposition = 'accepted' AND rejection_code IS NULL\)/.test(sql));
  // No execution-lifecycle columns and no credential columns anywhere.
  for (const column of ZECK_LIFECYCLE_COLUMN_DENYLIST) {
    assert.ok(
      !new RegExp(`^\\s*${column}\\s+(TEXT|UUID|INTEGER|TIMESTAMPTZ|JSONB)`, 'im').test(sql),
      `the zeck durable surface must not declare lifecycle column "${column}"`,
    );
  }
  for (const token of ZECK_CREDENTIAL_TOKENS) {
    assert.ok(!sql.includes(token), `the zeck durable surface must not declare credential column "${token}"`);
  }
});

// ---------------------------------------------------------------------------
// Discrimination: mutated trees are rejected with exact codes
// ---------------------------------------------------------------------------

test('another module exporting the AI boundary entry points is rejected (one boundary authority)', () => {
  for (const name of RESERVED_ZECK_AUTHORITY_EXPORTS) {
    const files = conformingTree();
    files['src/modules/evidence/index.ts'] = moduleFile('evidence', `\nexport function ${name}(): void {}\n`);
    const violations = runZeckCheck(files);
    assert.equal(violations.length, 1, `export "${name}" is rejected`);
    assert.equal(violations[0]?.code, 'zeck-authority-duplicate');
  }
  // The legitimate owner is not flagged.
  const owned = conformingTree();
  owned['src/modules/zeck/index.ts'] = moduleFile('zeck', `\nexport function submitExecutionIntent(): void {}\n`);
  assert.deepEqual(runZeckCheck(owned), []);
});

test('/zeck importing a forbidden authority is rejected (imports its authorities, never redefines)', () => {
  for (const forbidden of ['workflow', 'policies', 'billing', 'evidence', 'entities']) {
    const files = conformingTree();
    files['src/modules/zeck/index.ts'] = `import { something } from '../${forbidden}/index.js';\n${moduleFile('zeck')}`;
    const violations = runZeckCheck(files);
    assert.equal(violations.length, 1, `importing /${forbidden} from /zeck is rejected`);
    assert.equal(violations[0]?.code, 'zeck-import-direction');
  }
  // The allowed authorities are exactly the frozen frontier.
  assert.deepEqual(ZECK_ALLOWED_IMPORTS, ['auth', 'organizations', 'work', 'verticals']);
});

test('cross-module internal imports from /zeck are rejected', () => {
  const files = conformingTree();
  files['src/modules/zeck/index.ts'] = `import { something } from '../work/store.js';\n${moduleFile('zeck')}`;
  const violations = runZeckCheck(files);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.code, 'zeck-internal-import');
});

test('another module importing /zeck at this frontier is rejected', () => {
  const files = conformingTree();
  files['src/modules/workflow/index.ts'] = `import { zeck } from '../zeck/index.js';\n${moduleFile('workflow')}`;
  const violations = runZeckCheck(files);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.code, 'zeck-importer-frontier');
  assert.deepEqual(ZECK_IMPORTERS, []);
});

test('a credential-shaped token in /zeck sources is rejected (AC-4: no credentials)', () => {
  for (const token of ['apiKey', 'secret_key', 'accessToken', 'password']) {
    const files = conformingTree();
    files['src/modules/zeck/index.ts'] = moduleFile('zeck', `\nexport const ${token === 'password' ? 'password' : token} = 'x';\n`);
    const violations = runZeckCheck(files);
    assert.equal(violations.length, 1, `token "${token}" is rejected`);
    assert.equal(violations[0]?.code, 'zeck-credential-surface');
  }
});

test('a zeck_ table declaring an execution-lifecycle column is rejected (no shadow lifecycle)', () => {
  for (const column of ZECK_LIFECYCLE_COLUMN_DENYLIST) {
    const files = conformingTree();
    files['db/migrations/0008_zeck_leak.sql'] =
      `CREATE TABLE zeck_leaked_state (\n  id UUID,\n  ${column} TEXT\n);\n`;
    const violations = runZeckCheck(files);
    assert.equal(violations.length, 1, `lifecycle column "${column}" is rejected`);
    assert.equal(violations[0]?.code, 'zeck-lifecycle-schema-in-serviceos');
  }
  // The legitimate reference/observation columns are not flagged.
  const owned = conformingTree();
  owned['db/migrations/0008_zeck_integration_boundary.sql'] =
    'CREATE TABLE zeck_execution_intents (\n  id UUID,\n  disposition_placeholder TEXT\n);\n';
  assert.deepEqual(runZeckCheck(owned), []);
});

test('a zeck_ table declaring a credential column is rejected', () => {
  const files = conformingTree();
  files['db/migrations/0008_zeck_leak.sql'] =
    'CREATE TABLE zeck_connections (\n  id UUID,\n  api_key TEXT\n);\n';
  const violations = runZeckCheck(files);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.code, 'zeck-credential-surface');
});

test('a planted model-router import fails the architecture checks (AI implementation prohibition)', () => {
  // The Work Order's structural verification requirement: a planted
  // model-router surface must fail the architecture checks.
  const violations = runArchitectureCheck(
    architectureTree({
      'src/modules/zeck/model-router.ts':
        "export function pickModel(): string {\n  return 'gpt-best';\n}\n",
    }),
  );
  assert.deepEqual(
    violations.map((violation) => violation.code),
    ['forbidden-ai-path'],
  );
});

test('a planted LLM SDK import in a business module fails the architecture checks', () => {
  const violations = runArchitectureCheck(
    architectureTree({
      'src/modules/evidence/index.ts':
        "import { generate } from 'openai';\n" + moduleFile('evidence', `\nexport function useLlm(): void { void generate; }\n`),
    }),
  );
  assert.ok(violations.some((violation) => violation.code === 'forbidden-ai-import'));
});

test('a Zeck lifecycle export anywhere is still rejected by the work-boundary tripwires (lock #19)', () => {
  for (const [module, name] of [
    ['zeck', 'zeckLifecycle'],
    ['evidence', 'updateZeckExecutionStatus'],
    ['billing', 'recordZeckResult'],
  ]) {
    const files = conformingTree();
    files[`src/modules/${module}/index.ts`] = moduleFile(module, `\nexport function ${name}(): void {}\n`);
    const violations = runWorkCheck(files);
    assert.equal(violations.length, 1, `export "${name}" in /${module} is rejected`);
    assert.equal(violations[0]?.code, 'zeck-state-machine');
  }
});

test('the check CLI runs the Zeck boundary checks end-to-end', () => {
  // Era-independent: derive the expected in-flight branch from the
  // repository's own governance state (the pinned branch moves with each
  // activation frontier; a hard-coded past frontier would fail after the
  // next activation).
  const state = JSON.parse(readFileSync(resolve(process.cwd(), 'spec/development-state/checkpoint-state.json'), 'utf8'));
  const active = state.active as { branch: string }[];
  assert.ok(active.length <= 1, 'at most one Work Order is active');
  let expectBranch: string | undefined;
  if (active.length === 1) {
    expectBranch = active[0]?.branch;
  }
  const result = spawnSync(process.execPath, ['dist/src/cli/check.js'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      SERVICEOS_DATABASE_URL: 'postgres://placeholder',
      ...(expectBranch !== undefined ? { EXPECT_BRANCH: expectBranch } : {}),
    },
  });
  assert.equal(result.status, 0, `check CLI failed:\n${result.stdout}\n${result.stderr}`);
  assert.ok(result.stdout.includes('zeck: single AI execution integration boundary'));
});
