/**
 * Structural + discrimination proofs for the /evidence authority
 * (WORK-007, required classes `static` + `discrimination`).
 *
 * Proves:
 * - the REAL tree passes all evidence boundary checks (static);
 * - the real /evidence module implements and exports its public
 *   contract (the evidence attachment surface, the outcome verification
 *   surface, the store port, the pure deterministic mapping, the typed
 *   error surface) and migration 0009 pins the durable invariants
 *   (keyed identity, one-row-per-fact content identity, the closed
 *   verdict/verification-mode enumerations, the provenance-shape
 *   CHECK, and NO lifecycle/foreign-AI-execution/model columns
 *   anywhere);
 * - synthetic MUTATED trees are rejected with the exact violation codes
 *   (discrimination): another module exporting the evidence
 *   attachment/verification entry points, /evidence importing a
 *   forbidden authority (zeck, workflow, policies, billing, services,
 *   verticals), /evidence importing an internal file, another module
 *   importing /evidence at this frontier, an AI-evaluator export in
 *   /evidence, an `evidence_` table declaring a lifecycle column, an
 *   `evidence_` table declaring a typed foreign-AI-execution/model
 *   column, a planted model-router import (the AI implementation
 *   prohibition), and a planted LLM SDK import;
 * - the migration table-prefix discipline accepts `evidence_` (owned by
 *   WORK-007) and still rejects off-prefix tables;
 * - the check CLI runs the evidence boundary checks end-to-end.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  checkEvidenceBoundaries,
  RESERVED_EVIDENCE_AUTHORITY_EXPORTS,
  RESERVED_AI_EVIDENCE_EXPORTS,
  EVIDENCE_ALLOWED_IMPORTS,
  EVIDENCE_IMPORTERS,
  EVIDENCE_SCHEMA_COLUMN_DENYLIST,
} from '../src/platform/governance/evidence-boundary-checks.js';
import {
  checkWorkBoundaries,
  ALLOWED_MIGRATION_TABLE_PREFIXES,
} from '../src/platform/governance/work-boundary-checks.js';
import { checkArchitecture, FORBIDDEN_AI_PATH_SEGMENTS } from '../src/platform/governance/architecture-checks.js';
import { makeTempTree, moduleFile } from './helpers/tree.js';
import {
  EVIDENCE_PROVENANCE_KINDS,
  OUTCOME_VERIFICATION_MODES,
  evaluateOutcomeContract,
  validateAttachEvidenceInput,
  validateOutcomeContract,
  type EvidenceRecord,
} from '../src/modules/evidence/index.js';

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

function runEvidenceCheck(files: Record<string, string>): { code: string; detail: string; file?: string }[] {
  const { root, cleanup } = makeTempTree(files);
  try {
    return checkEvidenceBoundaries({ srcRoot: resolve(root, 'src'), migrationsDir: resolve(root, 'db/migrations') });
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

test('the real tree passes the evidence boundary checks (static)', () => {
  assert.deepEqual(checkEvidenceBoundaries({ srcRoot: REAL_SRC_ROOT, migrationsDir: REAL_MIGRATIONS }), []);
});

test('the real tree passes the work-boundary checks with the WORK-007 prefix extension (static)', () => {
  assert.deepEqual(checkWorkBoundaries({ srcRoot: REAL_SRC_ROOT, migrationsDir: REAL_MIGRATIONS }), []);
  assert.ok(ALLOWED_MIGRATION_TABLE_PREFIXES.includes('evidence_'));
});

test('the real /evidence module exports its public contract (attach, verify, store port, pure mapping)', () => {
  const source = readFileSync(resolve(REAL_SRC_ROOT, 'modules/evidence/index.ts'), 'utf8');
  for (const name of [
    'createEvidenceModule',
    'attachEvidence',
    'verifyOutcome',
    'getLatestOutcomeVerification',
    'EvidenceError',
    'validateAttachEvidenceInput',
    'validateOutcomeContract',
    'evaluateOutcomeContract',
    'createSqlEvidenceStore',
    'computeEvidenceContentHash',
    'computeVerificationRecordHash',
  ]) {
    assert.ok(source.includes(name), `the /evidence public interface must surface "${name}"`);
  }
  // The frozen provenance and verification-mode enumerations.
  assert.deepEqual([...EVIDENCE_PROVENANCE_KINDS], [
    'operator_attestation',
    'system_observation',
    'external_record',
    'customer_approval',
    'calculation',
  ]);
  assert.deepEqual([...OUTCOME_VERIFICATION_MODES], ['deterministic', 'human_approval', 'external_record']);
  // The pure deterministic mapping (no IO, no clock, no model).
  const evaluation = evaluateOutcomeContract(
    validateOutcomeContract({
      outcomeId: 'compliance_package_complete',
      verification: 'deterministic',
      evidenceRequirements: ['a_requirement', 'b_requirement'],
    }),
    [
      {
        id: 'ev-1',
        tenantId: 't',
        serviceWorkId: 'w',
        workAttemptId: null,
        requirement: 'a_requirement',
        provenance: { kind: 'external_record', source: 's', refs: [] },
        payload: {},
        observedAt: new Date('2026-09-01T00:00:00.000Z'),
        idempotencyKey: 'k',
        contentHash: 'hash-1',
        recordHash: 'hash-2',
        attachedBy: 'u',
        attachedAt: new Date('2026-09-02T00:00:00.000Z'),
      } satisfies EvidenceRecord,
    ],
  );
  assert.equal(evaluation.verdict, 'not_satisfied');
  assert.deepEqual(
    evaluation.requirementResults.map((result) => [result.requirement, result.satisfied]),
    [['a_requirement', true], ['b_requirement', false]],
  );
  assert.deepEqual(evaluation.evidenceSnapshot, [{ id: 'ev-1', contentHash: 'hash-1' }]);
  assert.throws(() => validateAttachEvidenceInput(null as never), /the attach-evidence input must be an object/);
});

test('migration 0009 pins the durable invariants of the evidence ledgers', () => {
  const sql = readFileSync(resolve(REAL_MIGRATIONS, '0009_business_evidence.sql'), 'utf8');
  // The durable identities: keyed evidence convergence, one row per
  // evidence fact per work item, keyed decision convergence.
  assert.ok(sql.includes('evidence_records_tenant_idempotency_key'));
  assert.ok(sql.includes('evidence_records_tenant_work_content'));
  assert.ok(sql.includes('evidence_outcome_verifications_tenant_idempotency_key'));
  // The closed business enumerations are schema-level.
  assert.ok(/verification_mode\s+TEXT NOT NULL CHECK \(verification_mode IN \('deterministic', 'human_approval', 'external_record'\)\)/.test(sql));
  assert.ok(/verdict\s+TEXT NOT NULL CHECK \(verdict IN \('satisfied', 'not_satisfied'\)\)/.test(sql));
  // The provenance shape CHECK.
  assert.ok(/jsonb_typeof\(provenance\) = 'object'/.test(sql));
  // No lifecycle/foreign-AI-execution/model columns anywhere.
  for (const column of EVIDENCE_SCHEMA_COLUMN_DENYLIST) {
    assert.ok(
      !new RegExp(`^\\s*${column}\\s+(TEXT|UUID|INTEGER|TIMESTAMPTZ|JSONB)`, 'im').test(sql),
      `the evidence durable surface must not declare column "${column}"`,
    );
  }
  // No credential surface.
  for (const token of ['apiKey', 'api_key', 'apiToken', 'secret_key', 'password']) {
    assert.ok(!sql.includes(token), `the evidence durable surface must not carry credential token "${token}"`);
  }
});

// ---------------------------------------------------------------------------
// Discrimination: mutated trees are rejected with exact codes
// ---------------------------------------------------------------------------

test('another module exporting the evidence authority entry points is rejected (one evidence authority)', () => {
  for (const name of RESERVED_EVIDENCE_AUTHORITY_EXPORTS) {
    const files = conformingTree();
    files['src/modules/billing/index.ts'] = moduleFile('billing', `\nexport function ${name}(): void {}\n`);
    const violations = runEvidenceCheck(files);
    assert.equal(violations.length, 1, `export "${name}" is rejected`);
    assert.equal(violations[0]?.code, 'evidence-authority-duplicate');
  }
  // The legitimate owner is not flagged.
  const owned = conformingTree();
  owned['src/modules/evidence/index.ts'] = moduleFile('evidence', `\nexport function attachEvidence(): void {}\nexport function verifyOutcome(): void {}\n`);
  assert.deepEqual(runEvidenceCheck(owned), []);
});

test('/evidence importing a forbidden authority is rejected (imports its authorities, never redefines)', () => {
  for (const forbidden of ['zeck', 'workflow', 'policies', 'billing', 'services', 'verticals', 'entities', 'interactions']) {
    const files = conformingTree();
    files['src/modules/evidence/index.ts'] = `import { something } from '../${forbidden}/index.js';\n${moduleFile('evidence')}`;
    const violations = runEvidenceCheck(files);
    assert.equal(violations.length, 1, `importing /${forbidden} from /evidence is rejected`);
    assert.equal(violations[0]?.code, 'evidence-import-direction');
  }
  // The allowed authorities are exactly the frozen frontier (the /zeck
  // prohibition is the activation invariant 1: business evidence stays
  // distinct from foreign AI execution evidence).
  assert.deepEqual(EVIDENCE_ALLOWED_IMPORTS, ['auth', 'organizations', 'work']);
});

test('cross-module internal imports from /evidence are rejected', () => {
  const files = conformingTree();
  files['src/modules/evidence/index.ts'] = `import { something } from '../work/store.js';\n${moduleFile('evidence')}`;
  const violations = runEvidenceCheck(files);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.code, 'evidence-internal-import');
});

test('another module importing /evidence at this frontier is rejected', () => {
  const files = conformingTree();
  files['src/modules/workflow/index.ts'] = `import { evidence } from '../evidence/index.js';\n${moduleFile('workflow')}`;
  const violations = runEvidenceCheck(files);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.code, 'evidence-importer-frontier');
  assert.deepEqual(EVIDENCE_IMPORTERS, []);
});

test('an AI-evaluator export in /evidence is rejected (no AI model evaluator)', () => {
  for (const name of RESERVED_AI_EVIDENCE_EXPORTS) {
    const files = conformingTree();
    files['src/modules/evidence/index.ts'] = moduleFile('evidence', `\nexport function ${name}(): void {}\n`);
    const violations = runEvidenceCheck(files);
    assert.equal(violations.length, 1, `export "${name}" is rejected`);
    assert.equal(violations[0]?.code, 'ai-evidence-evaluator-surface');
  }
});

test('an evidence_ table declaring a lifecycle column is rejected (immutable ledgers)', () => {
  for (const column of ['status', 'state', 'phase', 'stage', 'lifecycle']) {
    const files = conformingTree();
    files['db/migrations/0009_evidence_leak.sql'] =
      `CREATE TABLE evidence_leaked_state (\n  id UUID,\n  ${column} TEXT\n);\n`;
    const violations = runEvidenceCheck(files);
    assert.equal(violations.length, 1, `lifecycle column "${column}" is rejected`);
    assert.equal(violations[0]?.code, 'evidence-parallel-ai-execution-schema');
  }
  // The legitimate ledger columns are not flagged.
  const owned = conformingTree();
  owned['db/migrations/0009_business_evidence.sql'] =
    'CREATE TABLE evidence_records (\n  id UUID,\n  requirement TEXT,\n  provenance JSONB,\n  payload JSONB,\n  verdict TEXT\n);\n';
  assert.deepEqual(runEvidenceCheck(owned), []);
});

test('an evidence_ table declaring a typed foreign-AI-execution/model column is rejected (no parallel AI evidence store)', () => {
  for (const column of ['zeck_execution_id', 'execution_id', 'execution_status', 'model', 'provider', 'prompt']) {
    const files = conformingTree();
    files['db/migrations/0009_evidence_leak.sql'] =
      `CREATE TABLE evidence_ai_execution_store (\n  id UUID,\n  ${column} TEXT\n);\n`;
    const violations = runEvidenceCheck(files);
    assert.equal(violations.length, 1, `AI execution column "${column}" is rejected`);
    assert.equal(violations[0]?.code, 'evidence-parallel-ai-execution-schema');
  }
});

test('the migration prefix discipline accepts evidence_ and still rejects off-prefix tables', () => {
  const accepted = conformingTree();
  accepted['db/migrations/0009_business_evidence.sql'] =
    'CREATE TABLE evidence_records (\n  id UUID,\n  requirement TEXT\n);\n';
  assert.deepEqual(runWorkCheck(accepted), []);
  const rejected = conformingTree();
  rejected['db/migrations/0009_off_prefix.sql'] =
    'CREATE TABLE proof_documents (\n  id UUID,\n  payload JSONB\n);\n';
  const violations = runWorkCheck(rejected);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.code, 'unknown-migration-table-prefix');
});

test('a planted model-router import fails the architecture checks (AI implementation prohibition)', () => {
  // The Work Order's forbidden surface: an AI model evaluator inside
  // /evidence must fail the architecture checks.
  assert.ok(FORBIDDEN_AI_PATH_SEGMENTS.includes('model-router'));
  const violations = runArchitectureCheck(
    architectureTree({
      'src/modules/evidence/model-router.ts':
        "export function pickModel(): string {\n  return 'gpt-best';\n}\n",
    }),
  );
  assert.deepEqual(
    violations.map((violation) => violation.code),
    ['forbidden-ai-path'],
  );
});

test('a planted LLM SDK import in /evidence fails the architecture checks', () => {
  const violations = runArchitectureCheck(
    architectureTree({
      'src/modules/evidence/index.ts':
        "import { generate } from 'openai';\n" + moduleFile('evidence', `\nexport function useLlm(): void { void generate; }\n`),
    }),
  );
  assert.ok(violations.some((violation) => violation.code === 'forbidden-ai-import'));
});

test('a Zeck lifecycle export in /evidence is still rejected by the work-boundary tripwires (lock #19)', () => {
  for (const [module, name] of [
    ['evidence', 'updateZeckExecutionStatus'],
    ['evidence', 'zeckLifecycle'],
  ] as const) {
    const files = conformingTree();
    files[`src/modules/${module}/index.ts`] = moduleFile(module, `\nexport function ${name}(): void {}\n`);
    const violations = runWorkCheck(files);
    assert.equal(violations.length, 1, `export "${name}" in /${module} is rejected`);
    assert.equal(violations[0]?.code, 'zeck-state-machine');
  }
});

test('the check CLI runs the evidence boundary checks end-to-end', () => {
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
  assert.ok(result.stdout.includes('evidence: single business evidence and outcome-verification authority'));
});
