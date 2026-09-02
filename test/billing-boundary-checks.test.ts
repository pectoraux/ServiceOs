/**
 * Structural + discrimination proof: /billing authority boundaries
 * (WORK-011, static class — "no provider-specific AI cost authority").
 *
 * Proves:
 * - the REAL tree passes all billing boundary checks (static);
 * - the real /billing module implements and exports its public contract
 *   (module factory, store port, the frozen cost-reference forbidden-key
 *   list) and migration 0007 pins the durable invariants (one-live
 *   subscription, one-usage-per-billable-work, one ledger outcome per
 *   period, keyed cost references, the composite service-definition
 *   binding FKs, exact-decimal charge arithmetic);
 * - synthetic MUTATED trees are rejected with the exact violation codes
 *   (discrimination): a second module exporting billing authority entry
 *   points, ANY module exporting a provider-level AI usage/cost entry
 *   point, /billing importing /zeck, /billing importing a forbidden
 *   authority, another module importing /billing at this frontier,
 *   cross-module internal imports, a migration creating an AI usage/
 *   cost table, and the cost-reference table growing provider/model
 *   columns;
 * - the check CLI end-to-end runs the billing boundary checks on the
 *   real repository (wired into `npm run check`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  checkBillingBoundaries,
  BILLING_ALLOWED_IMPORTS,
  BILLING_IMPORTERS,
  RESERVED_AI_COST_AUTHORITY_EXPORTS,
} from '../src/platform/governance/billing-boundary-checks.js';
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

function runBillingCheck(files: Record<string, string>): { code: string; detail: string; file?: string }[] {
  const { root, cleanup } = makeTempTree(files);
  try {
    return checkBillingBoundaries({ srcRoot: resolve(root, 'src'), migrationsDir: resolve(root, 'db/migrations') });
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

test('the real tree passes the billing boundary checks (static)', () => {
  const violations = checkBillingBoundaries({ srcRoot: REAL_SRC_ROOT, migrationsDir: REAL_MIGRATIONS });
  assert.deepEqual(violations, []);
});

test('the real /billing module implements its public contract', async () => {
  const billing = await import('../src/modules/billing/index.js');
  assert.equal(typeof billing.createBillingModule, 'function');
  assert.equal(typeof billing.createSqlBillingStore, 'function');
  assert.equal(typeof billing.BillingError, 'function');
  assert.ok(Array.isArray(billing.COST_REFERENCE_FORBIDDEN_KEYS));
  // The frozen forbidden-key set pins the AC-3 boundary.
  for (const key of ['provider', 'model', 'tokens', 'usage', 'prompt']) {
    assert.ok(billing.COST_REFERENCE_FORBIDDEN_KEYS.includes(key), `"${key}" is forbidden in cost references`);
  }
  assert.equal(billing.default.manifest.name, 'billing');
  assert.equal(billing.default.manifest.version, '0.1.0');
});

test('migration 0007 pins the durable invariants (prefixes, FKs, one-live, dedup, one-outcome, keyed references)', () => {
  const sql = readFileSync(resolve(REAL_MIGRATIONS, '0007_billing_economics.sql'), 'utf8');
  assert.ok(ALLOWED_MIGRATION_TABLE_PREFIXES.includes('billing_'), 'billing_ is an allowed table prefix');
  for (const table of ['billing_subscriptions', 'billing_usage_records', 'billing_period_ledger', 'billing_cost_references']) {
    assert.ok(new RegExp(`CREATE TABLE ${table}`).test(sql), `${table} is created`);
  }
  // The subscription pins the ACTIVE service version through the catalog FK.
  assert.ok(/FOREIGN KEY \(tenant_id, service_id, service_version\)\s*\n?\s*REFERENCES services_definitions \(tenant_id, service_id, version\)/.test(sql));
  // One live subscription per (tenant, service).
  assert.ok(/CREATE UNIQUE INDEX billing_subscriptions_one_live[\s\S]*WHERE status <> 'cancelled'/.test(sql));
  // ONE usage row per billable work / outcome (duplicate billable work
  // can never double-charge — durable backstop).
  assert.ok(/CREATE UNIQUE INDEX billing_usage_records_one_per_work[\s\S]*WHERE work_id IS NOT NULL/.test(sql));
  assert.ok(/CREATE UNIQUE INDEX billing_usage_records_one_per_outcome[\s\S]*WHERE outcome_id IS NOT NULL/.test(sql));
  // ONE authoritative ledger outcome per (tenant, subscription, period).
  assert.ok(/CREATE UNIQUE INDEX billing_period_ledger_one_outcome[\s\S]*ON billing_period_ledger \(tenant_id, subscription_id, billing_period\)/.test(sql));
  // Exact-decimal charge arithmetic is a schema invariant.
  assert.ok(/total_charge = subscription_charge \+ usage_charge/.test(sql));
  // The cost-reference source is the closed authority-domain enumeration
  // (never a provider name).
  assert.ok(/CHECK \(source IN \('ai_authority'\)\)/.test(sql));
  // The real migration passes the work-boundary scan (prefixes + no
  // forbidden strings in executable SQL) and the billing migration scan.
  const violations = checkWorkBoundaries({ srcRoot: REAL_SRC_ROOT, migrationsDir: REAL_MIGRATIONS });
  assert.deepEqual(violations.filter((violation) => violation.file?.includes('0007')), []);
  const billingViolations = checkBillingBoundaries({ srcRoot: REAL_SRC_ROOT, migrationsDir: REAL_MIGRATIONS });
  assert.deepEqual(billingViolations, []);
});

test('a second module exporting billing authority entry points is rejected', () => {
  const files = conformingTree();
  files['src/modules/audit/index.ts'] = moduleFile(
    'audit',
    `\nexport function registerSubscription(): void {}\n`,
  );
  const violations = runBillingCheck(files);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.code, 'billing-authority-duplicate');
});

test('ANY module exporting a provider-level AI usage/cost entry point is rejected', () => {
  for (const name of ['aiUsageLedger', 'providerCostLedger', 'modelCostRates', 'recordTokenUsage']) {
    const files = conformingTree();
    files['src/modules/entities/index.ts'] = moduleFile(
      'entities',
      `\nexport function ${name}(): void {}\n`,
    );
    const violations = runBillingCheck(files);
    assert.equal(violations.length, 1, `${name} is rejected`);
    assert.equal(violations[0]?.code, 'ai-cost-authority-in-serviceos');
  }
  // The same holds when /billing itself tries to grow the authority.
  const files = conformingTree();
  files['src/modules/billing/index.ts'] = moduleFile(
    'billing',
    `\nexport function aiUsageLedger(): void {}\n`,
  );
  const violations = runBillingCheck(files);
  assert.ok(violations.some((violation) => violation.code === 'ai-cost-authority-in-serviceos'));
});

test('/billing importing /zeck is rejected (AC-3: references, never the authority code)', () => {
  const files = conformingTree();
  files['src/modules/billing/index.ts'] = `import { something } from '../zeck/index.js';\n${moduleFile('billing')}`;
  const violations = runBillingCheck(files);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.code, 'ai-import-in-billing');
});

test('/billing importing a forbidden authority is rejected (billing binds, never redefines)', () => {
  const files = conformingTree();
  files['src/modules/billing/index.ts'] = `import { something } from '../policies/index.js';\n${moduleFile('billing')}`;
  const violations = runBillingCheck(files);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.code, 'billing-import-direction');
  assert.ok(violations[0]?.detail.includes('billing-import-direction') === false);
  assert.ok(BILLING_ALLOWED_IMPORTS.includes('services'));
  assert.ok(BILLING_ALLOWED_IMPORTS.includes('work'));
  assert.ok(BILLING_ALLOWED_IMPORTS.includes('organizations'));
});

test('another module importing /billing at this frontier is rejected', () => {
  const files = conformingTree();
  files['src/modules/audit/index.ts'] = `import { billing } from '../billing/index.js';\n${moduleFile('audit')}`;
  const violations = runBillingCheck(files);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.code, 'billing-import-direction');
  assert.deepEqual(BILLING_IMPORTERS, []);
});

test('cross-module internal imports from /billing are rejected', () => {
  const files = conformingTree();
  files['src/modules/billing/index.ts'] = `import { something } from '../work/store.js';\n${moduleFile('billing')}`;
  const violations = runBillingCheck(files);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.code, 'billing-internal-import');
});

test('a migration creating an AI usage/cost table is rejected', () => {
  for (const table of ['ai_usage_records', 'provider_cost_ledger', 'model_rates', 'token_usage']) {
    const files = conformingTree();
    files['db/migrations/0002_ai_economics.sql'] = `CREATE TABLE ${table} (id UUID);`;
    const violations = runBillingCheck(files);
    assert.equal(violations.length, 1, `table ${table} is rejected`);
    assert.equal(violations[0]?.code, 'ai-cost-table-in-migration');
  }
});

test('the cost-reference table growing provider/model columns is rejected', () => {
  const files = conformingTree();
  files['db/migrations/0002_billing_extra.sql'] = `CREATE TABLE billing_cost_references (\n  id UUID,\n  provider TEXT,\n  tokens INTEGER\n);`;
  const violations = runBillingCheck(files);
  assert.equal(violations.length, 2);
  assert.ok(violations.every((violation) => violation.code === 'ai-cost-columns-in-billing'));
});

test('the check CLI runs the billing boundary checks end-to-end', () => {
  // The real repository passes the full CLI check (incl. the billing
  // checks and the governance state) on this branch.
  const result = spawnSync(process.execPath, ['dist/src/cli/check.js'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, SERVICEOS_DATABASE_URL: 'postgres://placeholder', EXPECT_BRANCH: 'feat/WORK-011-billing-economics' },
  });
  assert.equal(result.status, 0, `check CLI failed:\n${result.stdout}\n${result.stderr}`);
  assert.ok(result.stdout.includes('billing: single customer-economics authority'));
});
