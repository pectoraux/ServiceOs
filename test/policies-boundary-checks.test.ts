/**
 * Structural + discrimination proof: /policies authority boundaries
 * (WORK-014, static class — "exactly one policy authority", "no AI/provider
 * imports", "no authorization/workflow state machine in /policies").
 *
 * Proves:
 * - the REAL tree passes all policies-boundary checks (static);
 * - the real /policies module implements and exports its public contract
 *   (module factory, store port, deterministic evaluation engine) and the
 *   migration pins the closed enumerations, the one-active partial unique
 *   index and the decision idempotency index;
 * - synthetic MUTATED trees are rejected with the exact violation codes
 *   (discrimination): a second module exporting policy-engine entry points,
 *   /policies exporting an authorization/credential/guard/transition/AI
 *   entry point, /policies importing /workflow or /zeck, and a migration
 *   creating an off-prefix table;
 * - the check CLI end-to-end runs the policies boundary checks on the real
 *   repository (wired into `npm run check`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkPoliciesBoundaries } from '../src/platform/governance/policies-boundary-checks.js';
import { checkWorkBoundaries, extractCreatedTables, ALLOWED_MIGRATION_TABLE_PREFIXES } from '../src/platform/governance/work-boundary-checks.js';
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
  return files;
}

function runPoliciesCheck(files: Record<string, string>): { code: string; detail: string; file?: string }[] {
  const { root, cleanup } = makeTempTree(files);
  try {
    return checkPoliciesBoundaries({ srcRoot: resolve(root, 'src') });
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

test('the real tree passes the policies-boundary checks (static)', () => {
  const violations = checkPoliciesBoundaries({ srcRoot: REAL_SRC_ROOT });
  assert.deepEqual(violations, []);
});

test('the real /policies module implements its public contract (static)', () => {
  const policiesSource = readFileSync(resolve(REAL_SRC_ROOT, 'modules/policies/index.ts'), 'utf8');
  assert.ok(/export function createPoliciesModule/.test(policiesSource));
  assert.ok(/export interface PoliciesModule/.test(policiesSource));
  assert.ok(/export class PolicyError/.test(policiesSource));
  assert.ok(/export default defineModule\(\{\s*name: 'policies'/.test(policiesSource));
  // The store port, SQL store and deterministic evaluator exist as the
  // module's persistence/evaluation contracts.
  assert.ok(/export interface PolicyStore/.test(readFileSync(resolve(REAL_SRC_ROOT, 'modules/policies/store.ts'), 'utf8')));
  assert.ok(/export function createSqlPolicyStore/.test(readFileSync(resolve(REAL_SRC_ROOT, 'modules/policies/sql-store.ts'), 'utf8')));
  const evaluationSource = readFileSync(resolve(REAL_SRC_ROOT, 'modules/policies/evaluation.ts'), 'utf8');
  assert.ok(/export function evaluateLayer/.test(evaluationSource));
  assert.ok(/export function composeDecision/.test(evaluationSource));
  assert.ok(/export const FROZEN_POLICY_REVISION/.test(evaluationSource));
  assert.ok(/export function evaluateFrozenFloor/.test(evaluationSource));
  // The public policy hooks future authorities consume (AC-4).
  assert.ok(/resolvePolicy\(/.test(policiesSource));
  assert.ok(/evaluatePolicy\(/.test(policiesSource));
});

test('the real migration pins the policy authority boundaries (static)', () => {
  const sql = readFileSync(resolve(REAL_MIGRATIONS, '0003_business_policy.sql'), 'utf8');
  // Closed enumerations: scope, status, default_effect, outcome,
  // deciding_layer — the schema refuses out-of-enumeration values.
  assert.ok(/CHECK \(scope IN \('base', 'customer'\)\)/.test(sql));
  assert.ok(/CHECK \(status IN \('draft', 'active', 'retired'\)\)/.test(sql));
  assert.ok(/CHECK \(default_effect IN \('allow', 'deny'\)\)/.test(sql));
  assert.ok(/CHECK \(outcome IN \('allow', 'deny'\)\)/.test(sql));
  assert.ok(/CHECK \(deciding_layer IN \('frozen', 'customer', 'base', 'default'\)\)/.test(sql));
  // One active version per (tenant, policy key, scope): the partial unique
  // index behind forward-only activation.
  assert.ok(/CREATE UNIQUE INDEX policy_contracts_one_active/.test(sql));
  // Durable idempotency primitives: version creation + decision records.
  assert.ok(/CREATE UNIQUE INDEX policy_contracts_tenant_idempotency_key/.test(sql));
  assert.ok(/CREATE UNIQUE INDEX policy_decisions_tenant_idempotency_key/.test(sql));
  // No AI/provider/Zeck surface anywhere in the executable schema text
  // (comments may legitimately discuss the boundary).
  const stripped = sql.replace(/--[^\n]*/g, '');
  assert.equal(/zeck|model|provider|agent|llm/i.test(stripped), false);
  assert.equal(extractCreatedTables(sql).filter((table) => /zeck|ai/i.test(table)).length, 0);
  assert.deepEqual(extractCreatedTables(sql).sort(), ['policy_contracts', 'policy_decisions']);
  // The policy table prefix is now part of the allowlist (WORK-014 owns it).
  assert.ok(ALLOWED_MIGRATION_TABLE_PREFIXES.includes('policy_'));
  // The real migration passes the prefix discipline.
  const violations = checkWorkBoundaries({ srcRoot: REAL_SRC_ROOT, migrationsDir: REAL_MIGRATIONS });
  assert.deepEqual(violations, []);
});

test('a second module exporting policy-engine entry points is rejected (policy-engine-duplicate)', () => {
  for (const [module, code] of [
    ['workflow', 'export function evaluatePolicy() { return null; }'],
    ['verticals', 'export const resolvePolicy = null;'],
    ['work', 'export function evaluateBusinessPolicy() { return null; }'],
    ['entities', 'export const policyEngine = null;'],
  ] as const) {
    const files = conformingTree();
    files[`src/modules/${module}/index.ts`] = moduleFile(module, `\n${code}\n`);
    const violations = runPoliciesCheck(files);
    assert.equal(violations.length, 1, `expected one violation for /${module}`);
    assert.equal(violations[0]?.code, 'policy-engine-duplicate');
    assert.match(violations[0]?.detail ?? '', new RegExp(module));
  }
});

test('/policies exporting an authorization entry point is rejected (authorization-in-policies)', () => {
  for (const code of [
    'export function authorize(principal: string): boolean { return true; }',
    'export const hasPermission = false;',
  ]) {
    const files = conformingTree();
    files['src/modules/policies/index.ts'] = moduleFile('policies', `\n${code}\n`);
    const violations = runPoliciesCheck(files);
    assert.ok(violations.some((v) => v.code === 'authorization-in-policies'), JSON.stringify(violations));
  }
});

test('/policies exporting a credential or guard factory entry point is rejected', () => {
  const files = conformingTree();
  files['src/modules/policies/index.ts'] = moduleFile(
    'policies',
    '\nexport function verifyToken(token: string): boolean { return true; }\nexport function createPolicyGuard(): void {}\n',
  );
  const violations = runPoliciesCheck(files);
  assert.ok(violations.some((v) => v.code === 'identity-engine-in-policies'), JSON.stringify(violations));
  assert.ok(violations.some((v) => v.code === 'route-guard-in-policies'), JSON.stringify(violations));
});

test('/policies exporting a workflow transition entry point is rejected (workflow-engine-in-policies)', () => {
  for (const code of [
    'export function transition(workId: string): void {}',
    'export const stateMachine = null;',
  ]) {
    const files = conformingTree();
    files['src/modules/policies/index.ts'] = moduleFile('policies', `\n${code}\n`);
    const violations = runPoliciesCheck(files);
    assert.ok(violations.some((v) => v.code === 'workflow-engine-in-policies'), JSON.stringify(violations));
  }
});

test('/policies exporting an AI/provider policy engine is rejected (ai-policy-engine-in-policies)', () => {
  for (const code of [
    'export function evaluateWithModel(model: string): boolean { return true; }',
    'export const aiPolicyEngine = null;',
    'export function routePolicyModel(): void {}',
  ]) {
    const files = conformingTree();
    files['src/modules/policies/index.ts'] = moduleFile('policies', `\n${code}\n`);
    const violations = runPoliciesCheck(files);
    assert.ok(violations.some((v) => v.code === 'ai-policy-engine-in-policies'), JSON.stringify(violations));
  }
});

test('/policies importing /workflow or /zeck is rejected (policy-import-direction)', () => {
  for (const target of ['workflow', 'zeck']) {
    const files = conformingTree();
    files['src/modules/policies/index.ts'] = `import type { Never } from '../${target}/index.js';\n${moduleFile('policies')}`;
    const violations = runPoliciesCheck(files);
    assert.equal(violations.length, 1, `expected one violation for import of /${target}`);
    assert.equal(violations[0]?.code, 'policy-import-direction');
  }
});

test('an off-prefix migration table is still rejected; policy_ tables are allowed', () => {
  const files = conformingTree();
  files['db/migrations/0003_business_policy.sql'] = 'CREATE TABLE policy_contracts (id UUID);';
  assert.deepEqual(runWorkCheck(files), []);

  const bad = conformingTree();
  bad['db/migrations/0003_business_policy.sql'] = 'CREATE TABLE marketing_contracts (id UUID);';
  const violations = runWorkCheck(bad);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.code, 'unknown-migration-table-prefix');
  assert.match(violations[0]?.detail ?? '', /marketing_contracts/);
});

test('a conforming synthetic tree passes with no violations (static)', () => {
  assert.deepEqual(runPoliciesCheck(conformingTree()), []);
});

test('the check CLI runs the policies boundary checks end-to-end on the real tree', () => {
  // The real CLI (dist) must include the policies check in its output and
  // pass on the real repository. Controlled minimal environment — same
  // contract as test/check-cli.test.ts (era-relative frontier).
  const result = spawnSync(process.execPath, [resolve('dist/src/cli/check.js')], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
  });
  assert.equal(
    result.status,
    0,
    `expected exit 0\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.match(result.stdout, /policies: single policy authority, no AI\/authorization\/workflow engine in \/policies \(no violations\)/);
});
