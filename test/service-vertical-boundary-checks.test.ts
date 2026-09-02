/**
 * Structural + discrimination proof: /services + /verticals authority
 * boundaries (WORK-009, static class — "vertical package does not import
 * AI provider infrastructure"; "verticals may not weaken horizontal
 * authorities or select AI providers/models").
 *
 * Proves:
 * - the REAL tree passes all service/vertical boundary checks (static);
 * - the real /verticals and /services modules implement and export their
 *   public contracts (module factories, store ports, the shared Zeck
 *   capability-requirement declaration contract, the frozen forbidden
 *   selection-key list) and the migration 0006 pins the closed
 *   enumerations, the composite vertical binding FK, the one-active
 *   partial unique indexes and the tenant idempotency indexes;
 * - synthetic MUTATED trees are rejected with the exact violation codes
 *   (discrimination): a second module exporting vertical-registration or
 *   service-authority entry points, /services or /verticals exporting an
 *   AI-runtime entry point, /verticals or /services importing /zeck,
 *   /verticals importing a horizontal authority, /services importing a
 *   forbidden authority, /work importing /verticals at this frontier,
 *   cross-module internal imports, and a migration creating an
 *   off-prefix table;
 * - the check CLI end-to-end runs the service/vertical boundary checks
 *   on the real repository (wired into `npm run check`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  checkServiceVerticalBoundaries,
  RESERVED_AI_SERVICE_RUNTIME_EXPORTS,
  SERVICES_ALLOWED_IMPORTS,
  VERTICALS_ALLOWED_IMPORTS,
} from '../src/platform/governance/service-vertical-boundary-checks.js';
import { checkWorkBoundaries, ALLOWED_MIGRATION_TABLE_PREFIXES } from '../src/platform/governance/work-boundary-checks.js';
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

/** A minimal conforming module tree. */
function conformingTree(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of BASE_MODULES) {
    files[`src/modules/${name}/index.ts`] = moduleFile(name);
  }
  files['db/migrations/0001_identity_tenancy.sql'] = 'CREATE TABLE org_organizations (id UUID);';
  return files;
}

function runServiceVerticalCheck(files: Record<string, string>): { code: string; detail: string; file?: string }[] {
  const { root, cleanup } = makeTempTree(files);
  try {
    return checkServiceVerticalBoundaries({ srcRoot: resolve(root, 'src') });
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

test('the real tree passes the service/vertical boundary checks (static)', () => {
  const violations = checkServiceVerticalBoundaries({ srcRoot: REAL_SRC_ROOT });
  assert.deepEqual(violations, []);
});

test('the real /verticals and /services modules implement their public contracts', async () => {
  const verticals = await import('../src/modules/verticals/index.js');
  const services = await import('../src/modules/services/index.js');
  assert.equal(typeof verticals.createVerticalsModule, 'function');
  assert.equal(typeof verticals.createSqlVerticalsStore, 'function');
  assert.equal(typeof verticals.validateZeckCapabilityRequirements, 'function');
  assert.ok(Array.isArray(verticals.FORBIDDEN_SELECTION_KEYS));
  assert.ok(verticals.FORBIDDEN_SELECTION_KEYS.includes('model'));
  assert.ok(verticals.FORBIDDEN_SELECTION_KEYS.includes('provider'));
  assert.equal(typeof services.createServicesModule, 'function');
  assert.equal(typeof services.createSqlServicesStore, 'function');
  assert.equal(typeof services.computeDefinitionRecordHash, 'function');
  assert.equal(verticals.default.manifest.name, 'verticals');
  assert.equal(verticals.default.manifest.version, '1.0.0');
  assert.equal(services.default.manifest.name, 'services');
  assert.equal(services.default.manifest.version, '1.0.0');
});

test('migration 0006 pins the durable invariants (prefixes, FKs, one-active, idempotency)', () => {
  const sql = readFileSync(resolve(REAL_MIGRATIONS, '0006_service_vertical_runtime.sql'), 'utf8');
  for (const prefix of ['verticals_', 'services_']) {
    assert.ok(ALLOWED_MIGRATION_TABLE_PREFIXES.includes(prefix), `${prefix} is an allowed table prefix`);
  }
  for (const table of ['verticals_packages', 'services_definitions', 'services_configurations']) {
    assert.ok(new RegExp(`CREATE TABLE ${table}`).test(sql), `${table} is created`);
  }
  // Tenant + composite vertical binding FK + configuration pin FK.
  assert.ok(/FOREIGN KEY \(tenant_id, vertical_package_id, vertical_package_version\)\s*\n?\s*REFERENCES verticals_packages \(tenant_id, package_id, version\)/.test(sql));
  assert.ok(/FOREIGN KEY \(tenant_id, service_id, service_version\)\s*\n?\s*REFERENCES services_definitions \(tenant_id, service_id, version\)/.test(sql));
  // Closed enumerations.
  assert.ok(/CHECK \(status IN \('draft', 'active', 'retired'\)\)/.test(sql));
  // One-active partial unique indexes.
  assert.ok(/CREATE UNIQUE INDEX services_definitions_one_active[\s\S]*WHERE status = 'active'/.test(sql));
  assert.ok(/CREATE UNIQUE INDEX services_configurations_one_active[\s\S]*WHERE status = 'active'/.test(sql));
  // Tenant idempotency partial unique indexes.
  assert.ok(/CREATE UNIQUE INDEX verticals_packages_tenant_idempotency_key[\s\S]*WHERE idempotency_key IS NOT NULL/.test(sql));
  assert.ok(/CREATE UNIQUE INDEX services_definitions_tenant_idempotency_key[\s\S]*WHERE idempotency_key IS NOT NULL/.test(sql));
  assert.ok(/CREATE UNIQUE INDEX services_configurations_tenant_idempotency_key[\s\S]*WHERE idempotency_key IS NOT NULL/.test(sql));
  // The real migration passes the work-boundary scan (prefixes + no
  // forbidden strings in executable SQL).
  const violations = checkWorkBoundaries({ srcRoot: REAL_SRC_ROOT, migrationsDir: REAL_MIGRATIONS });
  assert.deepEqual(violations.filter((violation) => violation.file?.includes('0006')), []);
});

test('a second module exporting vertical-registration entry points is rejected', () => {
  const files = conformingTree();
  files['src/modules/entities/index.ts'] = moduleFile('entities', 'export function registerVerticalPackage(): void {}\n');
  const violations = runServiceVerticalCheck(files);
  assert.ok(violations.some((violation) => violation.code === 'vertical-registry-duplicate'));
});

test('a second module exporting service-authority entry points is rejected', () => {
  const files = conformingTree();
  files['src/modules/entities/index.ts'] = moduleFile('entities', 'export function registerServiceDefinition(): void {}\n');
  const violations = runServiceVerticalCheck(files);
  assert.ok(violations.some((violation) => violation.code === 'service-authority-duplicate'));
});

test('AI-runtime entry points in /services or /verticals are rejected', () => {
  for (const moduleName of ['services', 'verticals']) {
    for (const forbidden of ['modelRegistry', 'selectProvider', 'agentRuntime', 'planAiExecution']) {
      assert.ok(RESERVED_AI_SERVICE_RUNTIME_EXPORTS.includes(forbidden), `${forbidden} is a reserved AI runtime export`);
      const files = conformingTree();
      files[`src/modules/${moduleName}/index.ts`] = moduleFile(moduleName, `export function ${forbidden}(): void {}\n`);
      const violations = runServiceVerticalCheck(files);
      assert.ok(
        violations.some((violation) => violation.code === 'ai-runtime-in-service-catalog'),
        `${moduleName} exporting ${forbidden} is rejected`,
      );
    }
  }
});

test('/verticals or /services importing /zeck is rejected (AC-4 boundary)', () => {
  for (const moduleName of ['services', 'verticals']) {
    const files = conformingTree();
    files[`src/modules/${moduleName}/index.ts`] = moduleFile(moduleName, `import { something } from '../zeck/index.js';\n`);
    const violations = runServiceVerticalCheck(files);
    assert.ok(
      violations.some((violation) => violation.code === 'ai-import-in-service-runtime'),
      `${moduleName} importing /zeck is rejected`,
    );
  }
});

test('/verticals importing a horizontal authority is rejected (verticals stay pure)', () => {
  for (const forbidden of ['workflow', 'work', 'policies', 'entities', 'interactions', 'integrations', 'services']) {
    const files = conformingTree();
    files['src/modules/verticals/index.ts'] = moduleFile('verticals', `import { something } from '../${forbidden}/index.js';\n`);
    const violations = runServiceVerticalCheck(files);
    assert.ok(
      violations.some((violation) => violation.code === 'vertical-import-direction'),
      `/verticals importing /${forbidden} is rejected`,
    );
  }
  assert.deepEqual(VERTICALS_ALLOWED_IMPORTS, ['auth', 'organizations']);
});

test('/services importing a non-allowed authority is rejected (binding layer discipline)', () => {
  for (const forbidden of ['work', 'policies', 'approvals', 'interactions', 'integrations', 'entities', 'notifications']) {
    const files = conformingTree();
    files['src/modules/services/index.ts'] = moduleFile('services', `import { something } from '../${forbidden}/index.js';\n`);
    const violations = runServiceVerticalCheck(files);
    assert.ok(
      violations.some((violation) => violation.code === 'service-import-direction'),
      `/services importing /${forbidden} is rejected`,
    );
  }
  assert.deepEqual(SERVICES_ALLOWED_IMPORTS, ['auth', 'organizations', 'verticals', 'workflow']);
});

test('/work importing /verticals at this frontier is rejected (frontier-relative importers)', () => {
  const files = conformingTree();
  files['src/modules/work/index.ts'] = moduleFile('work', "import { x } from '../verticals/index.js';\n");
  const violations = runServiceVerticalCheck(files);
  assert.ok(violations.some((violation) => violation.code === 'vertical-import-direction'));
});

test('cross-module internal imports from /services are rejected', () => {
  const files = conformingTree();
  files['src/modules/services/index.ts'] = moduleFile('services', "import { x } from '../verticals/store.js';\n");
  const violations = runServiceVerticalCheck(files);
  assert.ok(violations.some((violation) => violation.code === 'service-catalog-internal-import'));
});

test('an off-prefix migration table is rejected by the migration scan', () => {
  const files = conformingTree();
  files['db/migrations/0002_service_vertical.sql'] = 'CREATE TABLE ai_models (id UUID);';
  const violations = runWorkCheck(files);
  assert.ok(violations.some((violation) => violation.code === 'unknown-migration-table-prefix'));
});

test('the check CLI runs the service/vertical boundary checks end-to-end', () => {
  const result = spawnSync('node', ['dist/src/cli/check.js'], {
    encoding: 'utf8',
    env: { ...process.env, SERVICEOS_DATABASE_URL: 'postgres://placeholder', EXPECT_BRANCH: 'feat/WORK-009-service-runtime' },
  });
  assert.equal(result.status, 0, `check CLI should pass:\n${result.stdout}\n${result.stderr}`);
  assert.ok(result.stdout.includes('services/verticals: single service-definition and vertical-registration authorities'));
});
