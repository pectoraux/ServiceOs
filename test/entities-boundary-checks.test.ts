/**
 * Structural + discrimination proofs for the /entities authority and the
 * Construction compliance flow (WORK-010, required classes `static` +
 * `discrimination`).
 *
 * Proves:
 * - the REAL tree passes all entities boundary checks (static);
 * - the frontier extensions hold: /entities imports exactly the pinned
 *   authority set, and /zeck, /evidence, /approvals, /interactions and
 *   /verticals admit /entities as their consumer (the check CLI runs
 *   them end to end);
 * - the real /entities module implements and exports its public contract
 *   (the entity-instance surface, the store port, the pure deterministic
 *   rules, the Construction package content, the flow factory) and
 *   migration 0012 pins the durable invariants (keyed identity,
 *   immutability, NO lifecycle/policy/provider/foreign-AI-execution
 *   columns anywhere);
 * - synthetic MUTATED trees are rejected with the exact violation codes
 *   (discrimination): another module exporting the entity-instance entry
 *   points, /entities exporting a replacement-engine entry point
 *   (transition/policy/evidence/interaction/zeck/approval surfaces),
 *   /entities exporting an AI-selection surface, /entities importing a
 *   forbidden module (services, billing, policies, integrations,
 *   notifications, audit), /entities importing an internal file, another
 *   module importing /entities at this frontier, an `entity_` table
 *   declaring a lifecycle column, and an `entity_` table declaring a
 *   typed foreign-AI-execution column;
 * - the migration table-prefix discipline accepts `entity_` (owned by
 *   WORK-010) and still rejects off-prefix tables;
 * - the architecture checker still rejects AI-infrastructure paths and
 *   provider SDK imports planted into /entities (the AI prohibition).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  checkEntitiesBoundaries,
  RESERVED_ENTITIES_AUTHORITY_EXPORTS,
  RESERVED_VERTICAL_ENGINE_EXPORTS,
  RESERVED_AI_ENTITIES_EXPORTS,
  ENTITIES_ALLOWED_IMPORTS,
  ENTITIES_IMPORTERS,
  ENTITIES_SCHEMA_COLUMN_DENYLIST,
} from '../src/platform/governance/entities-boundary-checks.js';
import {
  checkWorkBoundaries,
  ALLOWED_MIGRATION_TABLE_PREFIXES,
  stripSqlComments,
} from '../src/platform/governance/work-boundary-checks.js';
import {
  checkZeckBoundaries,
  ZECK_IMPORTERS,
} from '../src/platform/governance/zeck-boundary-checks.js';
import {
  checkEvidenceBoundaries,
  EVIDENCE_IMPORTERS,
} from '../src/platform/governance/evidence-boundary-checks.js';
import {
  checkApprovalsBoundaries,
  APPROVALS_IMPORTERS,
} from '../src/platform/governance/approvals-boundary-checks.js';
import {
  checkExternalInteractionBoundaries,
  INTERACTIONS_IMPORTERS,
} from '../src/platform/governance/interactions-boundary-checks.js';
import {
  checkServiceVerticalBoundaries,
  VERTICALS_IMPORTERS,
} from '../src/platform/governance/service-vertical-boundary-checks.js';
import { checkArchitecture, FORBIDDEN_AI_PACKAGES } from '../src/platform/governance/architecture-checks.js';
import { makeTempTree, moduleFile } from './helpers/tree.js';
import {
  constructionVerticalPackage,
  CONSTRUCTION_PACKAGE_ID,
  validateInsuranceCompliance,
} from '../src/modules/entities/index.js';

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

function withTree(files: Record<string, string>, run: (root: string) => void): void {
  const { root, cleanup } = makeTempTree(files);
  try {
    run(root);
  } finally {
    cleanup();
  }
}

function runEntitiesCheck(files: Record<string, string>): { code: string; detail: string; file?: string }[] {
  let violations: { code: string; detail: string; file?: string }[] = [];
  withTree(files, (root) => {
    violations = checkEntitiesBoundaries({ srcRoot: resolve(root, 'src'), migrationsDir: resolve(root, 'db/migrations') });
  });
  return violations;
}

// ---------------------------------------------------------------------------
// Static: the real tree conforms
// ---------------------------------------------------------------------------

test('the real tree passes the entities boundary checks (static)', () => {
  assert.deepEqual(checkEntitiesBoundaries({ srcRoot: REAL_SRC_ROOT, migrationsDir: REAL_MIGRATIONS }), []);
});

test('the frontier extensions admit /entities as the sole new consumer (static)', () => {
  assert.deepEqual([...ENTITIES_IMPORTERS], []);
  assert.deepEqual([...ZECK_IMPORTERS], ['entities']);
  assert.deepEqual([...EVIDENCE_IMPORTERS], ['entities']);
  assert.deepEqual([...APPROVALS_IMPORTERS], ['entities']);
  assert.deepEqual([...INTERACTIONS_IMPORTERS], ['notifications', 'entities']);
  assert.deepEqual([...VERTICALS_IMPORTERS], ['services', 'zeck', 'entities']);
  // The real tree still passes every extended checker end to end.
  assert.deepEqual(checkZeckBoundaries({ srcRoot: REAL_SRC_ROOT, migrationsDir: REAL_MIGRATIONS }), []);
  assert.deepEqual(checkEvidenceBoundaries({ srcRoot: REAL_SRC_ROOT, migrationsDir: REAL_MIGRATIONS }), []);
  assert.deepEqual(checkApprovalsBoundaries({ srcRoot: REAL_SRC_ROOT, migrationsDir: REAL_MIGRATIONS }), []);
  assert.deepEqual(checkExternalInteractionBoundaries({ srcRoot: REAL_SRC_ROOT }), []);
  assert.deepEqual(checkServiceVerticalBoundaries({ srcRoot: REAL_SRC_ROOT }), []);
  assert.deepEqual(
    [...ENTITIES_ALLOWED_IMPORTS].sort(),
    ['approvals', 'auth', 'evidence', 'interactions', 'organizations', 'verticals', 'work', 'workflow', 'zeck'],
  );
});

test('the real /entities module exports its public contract (instances, rules, package, flow)', () => {
  const source = readFileSync(resolve(REAL_SRC_ROOT, 'modules/entities/index.ts'), 'utf8');
  const moduleSource = readFileSync(resolve(REAL_SRC_ROOT, 'modules/entities/module.ts'), 'utf8');
  for (const name of [
    'createEntitiesModule',
    'EntitiesError',
    'ConstructionError',
    'createSqlEntitiesStore',
    'computeEntityInstanceContentHash',
    'computeEntityInstanceRecordHash',
    'computeCompliancePackageHash',
    'validateInsuranceCompliance',
    'validateLicenseCompliance',
    'validateW9Compliance',
    'complianceEvidenceRequirements',
    'constructionVerticalPackage',
    'createConstructionCompliance',
    'CONSTRUCTION_PACKAGE_ID',
  ]) {
    assert.ok(source.includes(name), `the /entities public interface must surface "${name}"`);
  }
  // The entity-instance authority surface (the module interface methods).
  for (const method of ['createEntityInstance', 'getEntityInstance', 'listEntityInstances']) {
    assert.ok(moduleSource.includes(method), `the /entities authority must declare "${method}"`);
  }
  // The Construction package content is the frozen v1 declaration.
  const pkg = constructionVerticalPackage('tenant-x');
  assert.equal(pkg.packageId, CONSTRUCTION_PACKAGE_ID);
  assert.ok(pkg.entities.some((entity) => entity.name === 'Project'));
  assert.ok(pkg.entities.some((entity) => entity.name === 'Subcontractor'));
  assert.ok(pkg.entities.some((entity) => entity.name === 'InsuranceCertificate'));
  assert.ok(pkg.entities.some((entity) => entity.name === 'License'));
  assert.ok(pkg.entities.some((entity) => entity.name === 'ComplianceRequirement'));
  assert.equal(pkg.zeckCapabilityRequirements[0]?.capability, 'document.reasoning');
  // No selection field can even be expressed in the declaration shape.
  assert.equal(pkg.zeckCapabilityRequirements.every((requirement) => !('model' in requirement)), true);
  // The pure deterministic rule stays pure (deterministic verdicts).
  const verdictA = validateInsuranceCompliance(
    { minGlPerOccurrenceUsd: 1, minUmbrellaAggregateUsd: 1, expiryLeadDays: 0, projectNamedAdditionalInsured: false, projectName: 'P' },
    { glPerOccurrenceUsd: 1, umbrellaAggregateUsd: 1, expiresAt: '2027-01-01T00:00:00.000Z', additionalInsured: null, certificateHolder: 'X' },
    new Date('2026-09-02T00:00:00.000Z'),
  );
  assert.equal(verdictA.compliant, true);
});

test('migration 0012 pins the entity durable invariants (keyed identity, immutability, no vertical state)', () => {
  const raw = readFileSync(resolve(REAL_MIGRATIONS, '0012_construction_entities.sql'), 'utf8');
  const sql = stripSqlComments(raw);
  assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS entity_instances'));
  assert.ok(sql.includes('UNIQUE INDEX IF NOT EXISTS entity_instances_tenant_idempotency_key'));
  assert.ok(/entity_instances_immutable CHECK \(updated_at = created_at\)/.test(sql));
  // No lifecycle/policy/provider/typed-AI columns anywhere.
  for (const column of ENTITIES_SCHEMA_COLUMN_DENYLIST) {
    assert.ok(
      !new RegExp(`\\b${column}\\b`).test(sql),
      `the entity schema must not declare column "${column}"`,
    );
  }
  // No compliance verdict/transition/decision column: the flow owns no state.
  assert.ok(!/compliant|verdict|transitioned|decided_by/i.test(sql.replace(/--.*$/gm, '')));
});

// ---------------------------------------------------------------------------
// Discrimination: mutated trees are rejected with the exact codes
// ---------------------------------------------------------------------------

test('another module exporting the entity-instance entry points is rejected (entities-authority-duplicate)', () => {
  const files = conformingTree();
  files['src/modules/workflow/index.ts'] = moduleFile(
    'workflow',
    `\nexport function createEntityInstance(): void {}\n`,
  );
  const violations = runEntitiesCheck(files);
  assert.ok(violations.some((violation) => violation.code === 'entities-authority-duplicate'));
  assert.ok(violations.every((violation) => violation.code === 'entities-authority-duplicate' || violation.code === 'entities-importer-frontier' || violation.code === 'evidence-importer-frontier' || violation.code === 'zeck-importer-frontier' || violation.code === 'approvals-importer-frontier' || violation.code === 'workflow-import-direction' || violation.code === 'vertical-import-direction'));
  assert.ok(
    violations.some((violation) => violation.detail.includes('/entities is the sole ServiceOS entity-instance authority')),
  );
});

test('/entities exporting a replacement engine entry point is rejected (vertical-engine-in-entities)', () => {
  for (const engine of ['submitTransition', 'attachEvidence', 'createInteraction', 'requestApproval']) {
    const files = conformingTree();
    files['src/modules/entities/index.ts'] = moduleFile(
      'entities',
      `\nexport function ${engine}(): void {}\n`,
    );
    const violations = runEntitiesCheck(files);
    assert.ok(
      violations.some((violation) => violation.code === 'vertical-engine-in-entities'),
      `exporting ${engine} from /entities must be rejected`,
    );
  }
});

test('/entities exporting an AI selection surface is rejected (ai-selection-in-entities)', () => {
  for (const aiExport of ['selectModel', 'providerRegistry', 'compilePrompt']) {
    const files = conformingTree();
    files['src/modules/entities/index.ts'] = moduleFile(
      'entities',
      `\nexport function ${aiExport}(): void {}\n`,
    );
    const violations = runEntitiesCheck(files);
    assert.ok(
      violations.some((violation) => violation.code === 'ai-selection-in-entities'),
      `exporting ${aiExport} from /entities must be rejected`,
    );
  }
});

test('/entities importing a forbidden module is rejected (entities-import-direction)', () => {
  for (const forbidden of ['services', 'billing', 'policies', 'integrations', 'notifications', 'audit']) {
    const files = conformingTree();
    files['src/modules/entities/index.ts'] = moduleFile(
      'entities',
      `\nimport type { X } from '../${forbidden}/index.js';\nvoid (null as unknown as X);\n`,
    );
    const violations = runEntitiesCheck(files);
    assert.ok(
      violations.some((violation) => violation.code === 'entities-import-direction' && violation.detail.includes(`/entities imports /${forbidden}`)),
      `importing /${forbidden} from /entities must be rejected`,
    );
  }
  // The authorized authority set passes (the composed frontier).
  const files = conformingTree();
  const imports = ['auth', 'organizations', 'verticals', 'work', 'workflow', 'evidence', 'interactions', 'zeck', 'approvals']
    .map((name) => `import type { X_${name} } from '../${name}/index.js';`)
    .join('\n');
  files['src/modules/entities/index.ts'] = moduleFile('entities', `\n${imports}\n`);
  const violations = runEntitiesCheck(files);
  assert.ok(!violations.some((violation) => violation.code === 'entities-import-direction'));
});

test('/entities importing an internal file is rejected (entities-internal-import)', () => {
  const files = conformingTree();
  files['src/modules/entities/index.ts'] = moduleFile(
    'entities',
    `\nimport type { X } from '../work/store.js';\nvoid (null as unknown as X);\n`,
  );
  const violations = runEntitiesCheck(files);
  assert.ok(violations.some((violation) => violation.code === 'entities-internal-import'));
});

test('another module importing /entities at this frontier is rejected (entities-importer-frontier)', () => {
  const files = conformingTree();
  files['src/modules/billing/index.ts'] = moduleFile(
    'billing',
    `\nimport type { Entities } from '../entities/index.js';\nvoid (null as unknown as Entities);\n`,
  );
  const violations = runEntitiesCheck(files);
  assert.ok(
    violations.some((violation) => violation.code === 'entities-importer-frontier' && violation.detail.includes('no module consumes the entity authority at this frontier')),
  );
});

test('an entity_ table declaring a lifecycle or typed AI column is rejected (entities-vertical-state-schema)', () => {
  for (const column of ['status', 'provider', 'zeck_execution_id', 'policy_key', 'verdict']) {
    const files = conformingTree();
    files['db/migrations/0012_construction_entities.sql'] = `CREATE TABLE entity_instances (\n  id UUID,\n  ${column} TEXT\n);`;
    const violations = runEntitiesCheck(files);
    assert.ok(
      violations.some((violation) => violation.code === 'entities-vertical-state-schema' && violation.detail.includes(`"${column}"`)),
      `an entity_ table declaring ${column} must be rejected`,
    );
  }
});

test('the migration prefix discipline accepts entity_ and still rejects off-prefix tables', () => {
  assert.ok(ALLOWED_MIGRATION_TABLE_PREFIXES.includes('entity_'));
  const files = conformingTree();
  files['db/migrations/0003_evil.sql'] = 'CREATE TABLE evil_vertical_state (id UUID);';
  withTree(files, (root) => {
    const violations = checkWorkBoundaries({ srcRoot: resolve(root, 'src'), migrationsDir: resolve(root, 'db/migrations') });
    assert.ok(violations.some((violation) => violation.code === 'unknown-migration-table-prefix'));
  });
});

test('the architecture checker rejects planted AI infrastructure inside /entities (AI prohibition)', () => {
  // A planted LLM SDK import.
  const sdkFiles = conformingTree();
  sdkFiles['src/modules/entities/index.ts'] = moduleFile(
    'entities',
    `\nimport { chat } from 'openai';\nvoid chat;\n`,
  );
  withTree(sdkFiles, (root) => {
    const violations = checkArchitecture({ srcRoot: resolve(root, 'src'), repoRoot: root, expectedModules: BASE_MODULES });
    assert.ok(
      violations.some((violation) => violation.code === 'forbidden-ai-import' && violation.detail.includes('openai')),
    );
  });
  // A planted model-router file (AI execution infrastructure path).
  const routerFiles = conformingTree();
  routerFiles['src/modules/entities/model-router.ts'] = 'export function routeModel(): void {}\n';
  withTree(routerFiles, (root) => {
    const violations = checkArchitecture({ srcRoot: resolve(root, 'src'), repoRoot: root, expectedModules: BASE_MODULES });
    assert.ok(violations.some((violation) => violation.code === 'forbidden-ai-path'));
  });
  // The denylist machinery is pinned (fail closed against unknown packages).
  assert.ok(FORBIDDEN_AI_PACKAGES.includes('zeck-sdk'));
});

// ---------------------------------------------------------------------------
// The check CLI runs the entities boundary checks end to end
// ---------------------------------------------------------------------------

test('the check CLI runs the entities boundary checks (end to end)', () => {
  const result = spawnSync(process.execPath, [resolve(process.cwd(), 'dist/src/cli/check.js')], {
    encoding: 'utf8',
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
  });
  assert.equal(result.status, 0, `check CLI output:\n${result.stdout}\n${result.stderr}`);
  assert.ok(result.stdout.includes('entities: single entity-instance authority and construction compliance flow'));
  assert.ok(result.stdout.includes('PASS: ServiceOS build, architecture, configuration and governance checks'));
  assert.ok(result.stdout.includes('work order: WORK-010 [in_flight]'));
});
