/**
 * Structural + discrimination proof: /workflow authority boundaries
 * (WORK-004, static class — "exactly one business workflow authority",
 * "bypassing the workflow transition service must fail structural checks").
 *
 * Proves:
 * - the REAL tree passes all workflow-boundary checks (static);
 * - the real /workflow module implements and exports its public contract
 *   and the migration pins the canonical status enumeration + the
 *   transition-boundary extension of migration 0002;
 * - synthetic MUTATED trees are rejected with the exact violation codes
 *   (discrimination): a transition export in another module, a status
 *   UPDATE outside /workflow, /workflow importing /zeck or /verticals,
 *   a policy/authorization/AI export in /workflow, and an internal
 *   cross-module import from /workflow.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { checkWorkflowBoundaries } from '../src/platform/governance/workflow-boundary-checks.js';
import { checkWorkBoundaries } from '../src/platform/governance/work-boundary-checks.js';
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

function runCheck(files: Record<string, string>): { code: string; detail: string; file?: string }[] {
  const { root, cleanup } = makeTempTree(files);
  try {
    return checkWorkflowBoundaries({ srcRoot: resolve(root, 'src') });
  } finally {
    cleanup();
  }
}

function runWorkCheck(files: Record<string, string>): { code: string; detail: string; file?: string }[] {
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

test('the real tree passes the workflow-boundary checks (static)', () => {
  const violations = checkWorkflowBoundaries({ srcRoot: REAL_SRC_ROOT });
  assert.deepEqual(violations, []);
});

test('the real /workflow module implements its public contract (static)', () => {
  const workflowSource = readFileSync(resolve(REAL_SRC_ROOT, 'modules/workflow/index.ts'), 'utf8');
  assert.ok(/export function createWorkflowModule/.test(workflowSource));
  assert.ok(/export interface WorkflowModule/.test(workflowSource));
  assert.ok(/export class WorkflowError/.test(workflowSource));
  assert.ok(/export default defineModule\(\{\s*name: 'workflow'/.test(workflowSource));
  // The store port and SQL store exist as the module's persistence contract.
  assert.ok(/export interface WorkflowStore/.test(readFileSync(resolve(REAL_SRC_ROOT, 'modules/workflow/store.ts'), 'utf8')));
  assert.ok(/export function createSqlWorkflowStore/.test(readFileSync(resolve(REAL_SRC_ROOT, 'modules/workflow/sql-store.ts'), 'utf8')));
  // The frozen canonical table is code, not data.
  assert.ok(/export const CANONICAL_TRANSITIONS/.test(readFileSync(resolve(REAL_SRC_ROOT, 'modules/workflow/transitions.ts'), 'utf8')));
});

test('the real migration extends the work-status enumeration through the /workflow authority (static)', () => {
  const migration = readFileSync(resolve(REAL_MIGRATIONS, '0004_business_workflow.sql'), 'utf8');
  // The extension of migration 0002's closed one-value enumeration.
  assert.ok(/ALTER TABLE work_service_works/.test(migration));
  assert.ok(/ADD CONSTRAINT work_service_works_status_check/.test(migration));
  for (const state of ['draft', 'ready', 'accepted', 'in_progress', 'waiting_information', 'waiting_approval', 'blocked', 'verifying', 'completed', 'cancelled', 'failed', 'expired']) {
    assert.ok(new RegExp(`'${state}'`).test(migration), `the enumeration includes ${state}`);
  }
  // The append-only ledger + SLA hook tables with their durable identities.
  assert.ok(/CREATE TABLE workflow_transitions/.test(migration));
  assert.ok(/CREATE TABLE workflow_sla_deadlines/.test(migration));
  assert.ok(/CREATE UNIQUE INDEX workflow_transitions_tenant_idempotency_key/.test(migration));
  assert.ok(/UNIQUE \(work_id, seq\)/.test(migration));
  // No Zeck-owned column or table exists anywhere in the schema.
  const stripped = migration
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(/zeck/i.test(stripped), false);
});

test('the real SQL store is the only status writer (static)', () => {
  const sqlStore = readFileSync(resolve(REAL_SRC_ROOT, 'modules/workflow/sql-store.ts'), 'utf8');
  assert.ok(/UPDATE work_service_works SET status/.test(sqlStore));
  // The write happens inside the same serialized unit as the ledger insert.
  assert.ok(/FOR UPDATE/.test(sqlStore));
  assert.ok(/INSERT INTO workflow_transitions/.test(sqlStore));
  // The dependency gate serializes on /work's per-tenant advisory lock.
  assert.ok(/pg_advisory_xact_lock\(hashtext\(\$1\)\)/.test(sqlStore));
});

// ---------------------------------------------------------------------------
// Discrimination: mutated trees are rejected with exact codes
// ---------------------------------------------------------------------------

test('a transition export in another module is a duplicate workflow engine (rejected)', () => {
  const files = conformingTree();
  files['src/modules/interactions/index.ts'] = moduleFile(
    'interactions',
    `\nexport function submitTransition(): void {}\n`,
  );
  const violations = runCheck(files);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.code, 'workflow-engine-duplicate');
  assert.match(violations[0]?.detail ?? '', /interactions exports "submitTransition"/);
});

test('the reserved-name list covers the authority surface (listLegalTransitions etc.)', () => {
  const files = conformingTree();
  files['src/modules/entities/index.ts'] = moduleFile(
    'entities',
    `\nexport function listLegalTransitions(): void {}\n`,
  );
  const violations = runCheck(files);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.code, 'workflow-engine-duplicate');
  assert.match(violations[0]?.detail ?? '', /entities exports "listLegalTransitions"/);
});

test('an UPDATE of work status outside /workflow is rejected', () => {
  const files = conformingTree();
  files['src/modules/entities/index.ts'] = moduleFile(
    'entities',
    `\nexport async function applyOutcome(): Promise<void> {\n  await exec.query('UPDATE work_service_works SET status = $1 WHERE id = $2', []);\n}\n`,
  );
  const violations = runCheck(files);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.code, 'work-status-mutation-outside-workflow');
  assert.match(violations[0]?.detail ?? '', /status column is written only by the \/workflow transition authority/);
});

test('/workflow importing /zeck is rejected (Zeck results are inputs, never a dependency)', () => {
  const files = conformingTree();
  files['src/modules/workflow/index.ts'] = moduleFile(
    'workflow',
    `\nimport type { Something } from '../zeck/index.js';\nexport type ZeckRef = Something;\n`,
  );
  const violations = runCheck(files);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.code, 'workflow-import-direction');
  assert.match(violations[0]?.detail ?? '', /imports \/zeck/);
});

test('/workflow importing /verticals is rejected (vertical-specific semantics)', () => {
  const files = conformingTree();
  files['src/modules/workflow/index.ts'] = moduleFile(
    'workflow',
    `\nimport { verticalRules } from '../verticals/index.js';\nexport type R = typeof verticalRules;\n`,
  );
  const violations = runCheck(files);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.code, 'workflow-import-direction');
  assert.match(violations[0]?.detail ?? '', /imports \/verticals/);
});

test('a policy-engine export in /workflow is rejected (duplicate policy engine)', () => {
  const files = conformingTree();
  files['src/modules/workflow/index.ts'] = moduleFile(
    'workflow',
    `\nexport function evaluatePolicy(): void {}\n`,
  );
  const violations = runCheck(files);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.code, 'policy-engine-in-workflow');
});

test('an authorization export in /workflow is rejected (authorization replacement)', () => {
  const files = conformingTree();
  files['src/modules/workflow/index.ts'] = moduleFile(
    'workflow',
    `\nexport function authorize(): void {}\n`,
  );
  const violations = runCheck(files);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.code, 'authorization-in-workflow');
});

test('an AI-planning export in /workflow is rejected (AI planning/routing)', () => {
  const files = conformingTree();
  files['src/modules/workflow/index.ts'] = moduleFile(
    'workflow',
    `\nexport function aiPlanner(): void {}\n`,
  );
  const violations = runCheck(files);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.code, 'ai-engine-in-workflow');
});

test('an internal cross-module import from /workflow is rejected (public interfaces only)', () => {
  const files = conformingTree();
  files['src/modules/workflow/index.ts'] = moduleFile(
    'workflow',
    `\nimport type { WorkStatus } from '../work/store.js';\nexport type S = WorkStatus;\n`,
  );
  const violations = runCheck(files);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.code, 'workflow-internal-import');
  assert.match(violations[0]?.detail ?? '', /internal file "..\/work\/store\.js"/);
});

test('public-interface imports from /workflow are allowed (conforming tree passes)', () => {
  const files = conformingTree();
  files['src/modules/workflow/index.ts'] = moduleFile(
    'workflow',
    `\nimport type { WorkStatus } from '../work/index.js';\nimport type { PolicyDecisionRecord } from '../policies/index.js';\nexport type S = WorkStatus;\nexport type D = PolicyDecisionRecord;\n`,
  );
  const violations = runCheck(files);
  assert.deepEqual(violations, []);
});

test('the workflow_ migration table prefix is allowed; unknown prefixes are rejected', () => {
  // The allowlist extension owned by WORK-004.
  const files = conformingTree();
  files['db/migrations/0004_business_workflow.sql'] =
    'CREATE TABLE workflow_transitions (id UUID);\nCREATE TABLE workflow_sla_deadlines (id UUID);';
  const violations = runWorkCheck(files);
  assert.deepEqual(violations, []);

  // An off-prefix table is still rejected (the discipline holds).
  const bad = conformingTree();
  bad['db/migrations/0004_business_workflow.sql'] = 'CREATE TABLE rogue_table (id UUID);';
  const badViolations = runWorkCheck(bad);
  assert.equal(badViolations.length, 1);
  assert.equal(badViolations[0]?.code, 'unknown-migration-table-prefix');
});

test('the conforming synthetic tree passes cleanly (no false positives)', () => {
  const violations = runCheck(conformingTree());
  assert.deepEqual(violations, []);
});
