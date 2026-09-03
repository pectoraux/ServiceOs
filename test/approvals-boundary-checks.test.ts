/**
 * Structural + discrimination proofs for the /approvals authority
 * (WORK-008, required classes `static` + `discrimination`).
 *
 * Proves:
 * - the REAL tree passes all approvals boundary checks (static);
 * - the real /approvals module implements and exports its public
 *   contract (the request surface, the human decision surface, the
 *   store port, the frozen enumerations, the typed error surface) and
 *   migration 0010 pins the durable invariants (the closed
 *   status/verdict enumerations, the ONE-terminal-decision unique
 *   backstop, the keyed identities, and NO AI/agent/model/provider/
 *   credential columns anywhere);
 * - synthetic MUTATED trees are rejected with the exact violation codes
 *   (discrimination): another module exporting the approval
 *   request/decision entry points, /approvals importing a forbidden
 *   authority (zeck, workflow, evidence, services, verticals,
 *   billing), /approvals importing an internal file, another module
 *   importing /approvals at this frontier, an AI/agent approver export
 *   in /approvals (the "auto-approve" agent surface), an approval_
 *   table declaring a typed AI-execution/model column, an approval_
 *   table declaring a credential column, a planted model-router import
 *   (the AI implementation prohibition), and a planted LLM SDK import;
 * - the migration table-prefix discipline accepts `approval_` (owned
 *   by WORK-008) and still rejects off-prefix tables;
 * - the check CLI runs the approvals boundary checks end-to-end.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  checkApprovalsBoundaries,
  RESERVED_APPROVAL_AUTHORITY_EXPORTS,
  RESERVED_AI_APPROVAL_EXPORTS,
  APPROVALS_ALLOWED_IMPORTS,
  APPROVALS_IMPORTERS,
  APPROVALS_SCHEMA_COLUMN_DENYLIST,
} from '../src/platform/governance/approvals-boundary-checks.js';
import {
  checkWorkBoundaries,
  ALLOWED_MIGRATION_TABLE_PREFIXES,
} from '../src/platform/governance/work-boundary-checks.js';
import { checkArchitecture, FORBIDDEN_AI_PATH_SEGMENTS } from '../src/platform/governance/architecture-checks.js';
import { makeTempTree, moduleFile } from './helpers/tree.js';
import {
  APPROVAL_DECISIONS,
  APPROVAL_REQUEST_STATUSES,
  validateDecideApprovalInput,
  validateRequestApprovalInput,
} from '../src/modules/approvals/index.js';

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

function runApprovalsCheck(files: Record<string, string>): { code: string; detail: string; file?: string }[] {
  const { root, cleanup } = makeTempTree(files);
  try {
    return checkApprovalsBoundaries({ srcRoot: resolve(root, 'src'), migrationsDir: resolve(root, 'db/migrations') });
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

/** A conforming tree PLUS the platform stubs the architecture checker resolves. */
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

test('the real tree passes the approvals boundary checks (static)', () => {
  assert.deepEqual(checkApprovalsBoundaries({ srcRoot: REAL_SRC_ROOT, migrationsDir: REAL_MIGRATIONS }), []);
});

test('the real tree passes the work-boundary checks with the WORK-008 prefix extension (static)', () => {
  assert.deepEqual(checkWorkBoundaries({ srcRoot: REAL_SRC_ROOT, migrationsDir: REAL_MIGRATIONS }), []);
  assert.ok(ALLOWED_MIGRATION_TABLE_PREFIXES.includes('approval_'));
});

test('the real /approvals module exports its public contract (request, decide, store port, enumerations)', () => {
  const source = readFileSync(resolve(REAL_SRC_ROOT, 'modules/approvals/index.ts'), 'utf8');
  for (const name of [
    'createApprovalsModule',
    'requestApproval',
    'decideApproval',
    'getApprovalRequest',
    'listApprovalRequests',
    'getApprovalDecision',
    'listApprovalDecisions',
    'getTerminalApprovalDecision',
    'ApprovalError',
    'validateRequestApprovalInput',
    'validateDecideApprovalInput',
    'createSqlApprovalStore',
    'computeApprovalRequestContentHash',
    'computeApprovalDecisionRecordHash',
  ]) {
    assert.ok(source.includes(name), `the /approvals public interface must surface "${name}"`);
  }
  // The frozen lifecycle enumerations.
  assert.deepEqual([...APPROVAL_REQUEST_STATUSES], ['pending', 'approved', 'rejected']);
  assert.deepEqual([...APPROVAL_DECISIONS], ['approve', 'reject']);
  // The validation surface fails closed on the enumerations.
  assert.throws(
    () =>
      validateDecideApprovalInput({
        tenantId: '00000000-0000-4000-8000-000000000000',
        requestId: '00000000-0000-4000-8000-000000000000',
        decision: 'auto-approve' as never,
        idempotencyKey: 'k',
      }),
    /decision must be one of/,
  );
  assert.throws(
    () =>
      validateRequestApprovalInput({
        tenantId: '00000000-0000-4000-8000-000000000000',
        serviceWorkId: '00000000-0000-4000-8000-000000000000',
        policyKey: 'x',
        subject: undefined,
        idempotencyKey: 'k',
      } as never),
    /subject is required/,
  );
  // A validated request requires the policy binding (AC-1).
  const validated = validateRequestApprovalInput({
    tenantId: '00000000-0000-4000-8000-000000000000',
    serviceWorkId: '00000000-0000-4000-8000-000000000000',
    policyKey: 'approval.guard',
    subject: { note: 'n' },
    idempotencyKey: 'k',
  });
  assert.equal(validated.policyKey, 'approval.guard');
});

test('migration 0010 pins the durable invariants of the approval ledgers', () => {
  const sql = readFileSync(resolve(REAL_MIGRATIONS, '0010_business_approvals.sql'), 'utf8');
  // The durable identities: keyed request convergence, keyed decision
  // convergence, and THE one-terminal-decision backstop.
  assert.ok(sql.includes('approval_requests_tenant_idempotency_key'));
  assert.ok(sql.includes('approval_decisions_tenant_idempotency_key'));
  assert.ok(sql.includes('approval_decisions_request_terminal'));
  // The closed authority-state and verdict enumerations are schema-level.
  assert.ok(/status\s+TEXT NOT NULL CHECK \(status IN \('pending', 'approved', 'rejected'\)\)/.test(sql));
  assert.ok(/decision\s+TEXT NOT NULL CHECK \(decision IN \('approve', 'reject'\)\)/.test(sql));
  // The human decider is a referenced auth identity.
  assert.ok(/decided_by\s+UUID NOT NULL REFERENCES auth_users \(id\)/.test(sql));
  // No AI/agent/model/provider/credential columns anywhere.
  for (const column of APPROVALS_SCHEMA_COLUMN_DENYLIST) {
    assert.ok(
      !new RegExp(`^\\s*${column}\\s+(TEXT|UUID|INTEGER|TIMESTAMPTZ|JSONB)`, 'im').test(sql),
      `the approvals durable surface must not declare column "${column}"`,
    );
  }
  // No credential surface.
  for (const token of ['apiKey', 'api_key', 'apiToken', 'secret_key', 'password']) {
    assert.ok(!sql.includes(token), `the approvals durable surface must not carry credential token "${token}"`);
  }
});

// ---------------------------------------------------------------------------
// Discrimination: mutated trees are rejected with exact codes
// ---------------------------------------------------------------------------

test('another module exporting the approval authority entry points is rejected (one approval authority)', () => {
  for (const name of RESERVED_APPROVAL_AUTHORITY_EXPORTS) {
    const files = conformingTree();
    files['src/modules/billing/index.ts'] = moduleFile('billing', `\nexport function ${name}(): void {}\n`);
    const violations = runApprovalsCheck(files);
    assert.equal(violations.length, 1, `export "${name}" is rejected`);
    assert.equal(violations[0]?.code, 'approvals-authority-duplicate');
  }
  // The legitimate owner is not flagged.
  const owned = conformingTree();
  owned['src/modules/approvals/index.ts'] = moduleFile(
    'approvals',
    `\nexport function requestApproval(): void {}\nexport function decideApproval(): void {}\n`,
  );
  assert.deepEqual(runApprovalsCheck(owned), []);
});

test('/approvals importing a forbidden authority is rejected (imports its authorities, never redefines)', () => {
  for (const forbidden of ['zeck', 'workflow', 'evidence', 'billing', 'services', 'verticals', 'entities', 'interactions']) {
    const files = conformingTree();
    files['src/modules/approvals/index.ts'] = `import { something } from '../${forbidden}/index.js';\n${moduleFile('approvals')}`;
    const violations = runApprovalsCheck(files);
    assert.equal(violations.length, 1, `importing /${forbidden} from /approvals is rejected`);
    assert.equal(violations[0]?.code, 'approvals-import-direction');
  }
  // The allowed authorities are exactly the frozen frontier (the /zeck
  // prohibition is the Work Order forbidden surface: Zeck's optional
  // AI human-escalation primitive is never replaced).
  assert.deepEqual(APPROVALS_ALLOWED_IMPORTS, ['auth', 'organizations', 'work', 'policies']);
});

test('cross-module internal imports from /approvals are rejected', () => {
  const files = conformingTree();
  files['src/modules/approvals/index.ts'] = `import { something } from '../work/store.js';\n${moduleFile('approvals')}`;
  const violations = runApprovalsCheck(files);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.code, 'approvals-internal-import');
});

test('another module importing /approvals at this frontier is rejected', () => {
  const files = conformingTree();
  files['src/modules/workflow/index.ts'] = `import { approvals } from '../approvals/index.js';\n${moduleFile('workflow')}`;
  const violations = runApprovalsCheck(files);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.code, 'approvals-importer-frontier');
  // WORK-010 extends the frontier: /entities (the construction flow)
  // consumes the approval surface.
  assert.deepEqual(APPROVALS_IMPORTERS, ['entities']);
});

test('an AI/agent approver export in /approvals is rejected (AI or agent output is never approval)', () => {
  for (const name of RESERVED_AI_APPROVAL_EXPORTS) {
    const files = conformingTree();
    files['src/modules/approvals/index.ts'] = moduleFile('approvals', `\nexport function ${name}(): void {}\n`);
    const violations = runApprovalsCheck(files);
    assert.equal(violations.length, 1, `export "${name}" is rejected`);
    assert.equal(violations[0]?.code, 'ai-approval-surface');
  }
});

test('an approval_ table declaring a typed AI-execution/model column is rejected (no AI decider surface)', () => {
  for (const column of ['zeck_execution_id', 'execution_id', 'model', 'provider', 'ai_verdict', 'agent_approval']) {
    const files = conformingTree();
    files['db/migrations/0010_approval_leak.sql'] =
      `CREATE TABLE approval_ai_decider (\n  id UUID,\n  ${column} TEXT\n);\n`;
    const violations = runApprovalsCheck(files);
    assert.equal(violations.length, 1, `AI decider column "${column}" is rejected`);
    assert.equal(violations[0]?.code, 'approvals-ai-decider-schema');
  }
});

test('an approval_ table declaring a credential column is rejected (no credential surface)', () => {
  for (const column of ['api_key', 'secret', 'token', 'credential']) {
    const files = conformingTree();
    files['db/migrations/0010_approval_leak.sql'] =
      `CREATE TABLE approval_credentials (\n  id UUID,\n  ${column} TEXT\n);\n`;
    const violations = runApprovalsCheck(files);
    assert.equal(violations.length, 1, `credential column "${column}" is rejected`);
    assert.equal(violations[0]?.code, 'approvals-ai-decider-schema');
  }
});

test('the legitimate authority-state column of approval_requests is not flagged (the state authority)', () => {
  // Unlike the immutable /evidence ledgers, the request row's OWN
  // authority state is the closed status enumeration — pinned by the
  // migration CHECK, not denied by the column denylist.
  const owned = conformingTree();
  owned['db/migrations/0010_business_approvals.sql'] =
    'CREATE TABLE approval_requests (\n  id UUID,\n  status TEXT,\n  decision_id UUID\n);\nCREATE TABLE approval_decisions (\n  id UUID,\n  decision TEXT,\n  decided_by UUID\n);\n';
  assert.deepEqual(runApprovalsCheck(owned), []);
});

test('the migration prefix discipline accepts approval_ and still rejects off-prefix tables', () => {
  const accepted = conformingTree();
  accepted['db/migrations/0010_business_approvals.sql'] =
    'CREATE TABLE approval_requests (\n  id UUID,\n  status TEXT\n);\n';
  assert.deepEqual(runWorkCheck(accepted), []);
  const rejected = conformingTree();
  rejected['db/migrations/0010_off_prefix.sql'] =
    'CREATE TABLE signoff_documents (\n  id UUID,\n  payload JSONB\n);\n';
  const violations = runWorkCheck(rejected);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.code, 'unknown-migration-table-prefix');
});

test('a planted model-router import fails the architecture checks (AI implementation prohibition)', () => {
  assert.ok(FORBIDDEN_AI_PATH_SEGMENTS.includes('model-router'));
  const violations = runArchitectureCheck(
    architectureTree({
      'src/modules/approvals/model-router.ts': "export function pickModel(): string {\n  return 'gpt-best';\n}\n",
    }),
  );
  assert.deepEqual(
    violations.map((violation) => violation.code),
    ['forbidden-ai-path'],
  );
});

test('a planted LLM SDK import in /approvals fails the architecture checks', () => {
  const violations = runArchitectureCheck(
    architectureTree({
      'src/modules/approvals/index.ts':
        "import { generate } from 'openai';\n" +
        moduleFile('approvals', `\nexport function useLlm(): void { void generate; }\n`),
    }),
  );
  assert.ok(violations.some((violation) => violation.code === 'forbidden-ai-import'));
});

test('the check CLI runs the approvals boundary checks end-to-end', () => {
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
  assert.ok(result.stdout.includes('approvals: single business/human approval authority'));
});
