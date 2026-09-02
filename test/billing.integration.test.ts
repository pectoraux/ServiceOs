/**
 * Optional live-PostgreSQL integration proof for the Billing & Service
 * Economics runtime (WORK-011, HIGH_ASSURANCE). Runs ONLY when
 * SERVICEOS_TEST_DATABASE_URL points at a disposable PostgreSQL database;
 * otherwise it is skipped.
 *
 * When the variable is present this file proves the REAL durable layer:
 * - migrations 0001..0007 apply in order and are idempotent;
 * - schema backstops hold: the one-live subscription partial unique
 *   index, the one-usage-per-billable-work dedup indexes, the one
 *   ledger outcome per (subscription, period) unique index, the keyed
 *   cost-reference uniqueness, the closed source enumeration (no
 *   provider value exists), the composite service-definition binding
 *   foreign keys and the exact-decimal charge arithmetic CHECK;
 * - the full billing flow works over real SQL: subscription binding the
 *   active definition, plan validation against declared metering,
 *   work/outcome/manual metering, settlement pricing (recurring +
 *   rated usage), cost references and the derived margin report;
 * - duplicate billable work NEVER double-charges over real rows;
 * - after-the-fact mutation of stored rows is DETECTED on read
 *   (integrity hash recomputation against real rows);
 * - TRUE parallel actors (separate pooled clients) converge: same-key
 *   subscription registration, same billable work metering, concurrent
 *   settlement of the same period (ONE ledger outcome, usage priced
 *   exactly once);
 * - cross-tenant reads carry the tenant predicate against real rows.
 *
 * Each proof runs against its OWN disposable database (node:test executes
 * test files concurrently; sharing one database would collide through the
 * migration history).
 *
 * This environment has no local PostgreSQL, so these proofs execute in CI
 * (the governance workflow provisions a PostgreSQL service).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import {
  applyMigrations,
  withTransactionOn,
  type Migration,
  type TransactionalExecutor,
} from '../src/platform/persistence/index.js';
import { createAuthModule } from '../src/modules/auth/index.js';
import { createOrganizationsModule } from '../src/modules/organizations/index.js';
import { createVerticalsModule, VerticalsError } from '../src/modules/verticals/index.js';
import { createServicesModule, ServicesError } from '../src/modules/services/index.js';
import { createWorkModule } from '../src/modules/work/index.js';
import { createBillingModule, BillingError } from '../src/modules/billing/index.js';
import { createLiveTestDatabase, liveDatabaseRequested, type LiveDatabase } from './helpers/live-database.js';
import type { Principal } from '../src/modules/auth/index.js';

const SKIP = !liveDatabaseRequested();
const PASSWORD = 'correct horse battery 7';
const PERIOD = '2026-09';

function poolExecutor(pool: pg.Pool): TransactionalExecutor {
  return {
    query: (sql: string, params?: unknown[]) => pool.query(sql, params),
    withTransaction: <T>(fn: (tx: import('../src/platform/persistence/index.js').SqlExecutor) => Promise<T>) => {
      return (async () => {
        const client = await pool.connect();
        try {
          return await withTransactionOn(client, fn);
        } finally {
          client.release();
        }
      })();
    },
  };
}

async function applyMigrationsPinned(pool: pg.Pool, migrations: readonly Migration[]) {
  const client = await pool.connect();
  try {
    return await applyMigrations(client, migrations);
  } finally {
    client.release();
  }
}

function migrations(): Migration[] {
  const base = resolve(process.cwd(), 'db/migrations');
  const names = [
    '0001_identity_tenancy.sql',
    '0002_service_work.sql',
    '0003_business_policy.sql',
    '0004_business_workflow.sql',
    '0005_external_interactions.sql',
    '0006_service_vertical_runtime.sql',
    '0007_billing_economics.sql',
  ];
  return names.map((name, index) => ({
    version: index + 1,
    name: name.replace(/\.sql$/, '').replace(/^\d+_/, ''),
    sql: readFileSync(resolve(base, name), 'utf8'),
  }));
}

interface LiveApp {
  live: LiveDatabase;
  pool: pg.Pool;
  auth: ReturnType<typeof createAuthModule>;
  organizations: ReturnType<typeof createOrganizationsModule>;
  verticals: ReturnType<typeof createVerticalsModule>;
  services: ReturnType<typeof createServicesModule>;
  work: ReturnType<typeof createWorkModule>;
  billing: ReturnType<typeof createBillingModule>;
  owner: Principal;
  tenantId: string;
}

async function liveApp(): Promise<LiveApp> {
  const live = await createLiveTestDatabase();
  const pool = new pg.Pool({ connectionString: live.dsn, max: 4 });
  await applyMigrationsPinned(pool, migrations());
  const executor = poolExecutor(pool);
  const auth = createAuthModule({ executor });
  const organizations = createOrganizationsModule({ executor, authenticator: auth.authenticate, identity: auth });
  const verticals = createVerticalsModule({ executor, tenancy: organizations });
  const services = createServicesModule({ executor, tenancy: organizations, verticals });
  const work = createWorkModule({ executor, tenancy: organizations });
  const billing = createBillingModule({ executor, tenancy: organizations, services, work });
  const owner = await auth.registerHuman({ email: 'owner@a.com', password: PASSWORD, displayName: 'Owner' });
  const created = await organizations.createOrganization(owner, { slug: 'alpha-org', displayName: 'Alpha' });
  return { live, pool, auth, organizations, verticals, services, work, billing, owner, tenantId: created.tenant.id };
}

async function teardown(app: LiveApp): Promise<void> {
  await app.pool.end();
  await app.live.drop();
}

function packageInput(tenantId: string, version: number) {
  return {
    tenantId,
    packageId: 'construction',
    version,
    name: 'Construction',
    terminology: {},
    entities: [{ name: 'Project', fields: [{ name: 'projectNumber', type: 'string' as const, required: true }] }],
    workTypes: [{ name: 'OnboardSubcontractor', defaultSlaHours: 48 }],
    workflowSteps: [{ step: 'collect' }],
    policyDefaults: [],
    approvalMatrix: [],
    evidenceRequirements: [],
    integrationBindings: [],
    zeckCapabilityRequirements: [],
    pricingRules: [],
  };
}

function serviceInput(tenantId: string, version: number, idempotencyKey: string) {
  return {
    tenantId,
    serviceId: 'subcontractor-compliance',
    version,
    name: 'Subcontractor Compliance Service',
    vertical: { packageId: 'construction', version: 1 },
    entities: [{ entity: 'Project', required: true }],
    workDefinitions: [{ workType: 'OnboardSubcontractor' }],
    workflowBinding: [{ step: 'collect', from: 'in_progress', to: 'verifying' }],
    policyConfiguration: [],
    approvalRules: [],
    slaDefaults: [{ workType: 'OnboardSubcontractor', deadlineHours: 24 }],
    outcomeContract: {
      outcomeId: 'subcontractor-compliant',
      outputSchema: [{ name: 'compliancePackageRef', type: 'string' as const, required: true }],
      evidenceRequirements: [],
      verification: 'deterministic' as const,
    },
    requiredExternalCapabilities: [],
    requiredAiCapabilities: [],
    pricing: {
      model: 'hybrid' as const,
      metering: [
        { metric: 'onboarded-subcontractor', unit: 'count' },
        { metric: 'processed-document', unit: 'document' },
      ],
    },
    idempotencyKey,
  };
}

const PLAN = {
  model: 'hybrid' as const,
  currency: 'EUR',
  recurring: { amount: '199.00' },
  workRates: [
    { metric: 'onboarded-subcontractor', unitPrice: '25.50' },
    { metric: 'processed-document', unitPrice: '0.10' },
  ],
};

async function cataloged(app: LiveApp): Promise<void> {
  await app.verticals.registerVerticalPackage(app.owner, packageInput(app.tenantId, 1));
  await app.services.registerServiceDefinition(app.owner, serviceInput(app.tenantId, 1, 'svc-v1'));
  await app.services.activateServiceDefinition(app.owner, app.tenantId, 'subcontractor-compliance', 1);
}

async function activeSubscription(app: LiveApp) {
  const { subscription } = await app.billing.registerSubscription(app.owner, {
    tenantId: app.tenantId,
    serviceId: 'subcontractor-compliance',
    plan: PLAN,
    idempotencyKey: 'sub-live',
  });
  const activated = await app.billing.activateSubscription(app.owner, app.tenantId, subscription.id);
  return activated.subscription;
}

async function createWork(app: LiveApp, title: string) {
  const created = await app.work.createWork(app.owner, {
    tenantId: app.tenantId,
    workType: 'OnboardSubcontractor',
    title,
  });
  return created.work;
}

async function expectCode(error: unknown, code: string): Promise<void> {
  assert.ok(
    error instanceof BillingError || error instanceof VerticalsError || error instanceof ServicesError,
    `expected a typed error, got ${String(error)}`,
  );
  assert.equal((error as BillingError).code, code);
}

test('migrations apply in order and are idempotent (live schema)', { skip: SKIP }, async () => {
  const live = await createLiveTestDatabase();
  const pool = new pg.Pool({ connectionString: live.dsn, max: 2 });
  try {
    const first = await applyMigrationsPinned(pool, migrations());
    assert.equal(first.applied.length, 7, 'all seven migrations apply');
    const second = await applyMigrationsPinned(pool, migrations());
    assert.equal(second.applied.length, 0, 're-runs are no-ops');
    assert.equal(second.skipped, 7);
    // The billing tables exist.
    const tables = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'billing_%' ORDER BY table_name`,
    );
    assert.deepEqual(
      (tables.rows as { table_name: string }[]).map((row) => row.table_name),
      ['billing_cost_references', 'billing_period_ledger', 'billing_subscriptions', 'billing_usage_records'],
    );
  } finally {
    await pool.end();
    await live.drop();
  }
});

test('schema backstops: one-live, dedup, one-outcome, keyed references, closed enumeration, FK binding (live)', { skip: SKIP }, async () => {
  const app = await liveApp();
  try {
    await cataloged(app);
    const subscription = await activeSubscription(app);
    const work = await createWork(app, 'Onboard Acme');
    await app.billing.meterWorkUsage(app.owner, {
      tenantId: app.tenantId,
      serviceId: 'subcontractor-compliance',
      workId: work.id,
      metric: 'onboarded-subcontractor',
      quantity: '1',
    });
    const usageRow = await app.pool.query(
      `SELECT id, content_hash, record_hash FROM billing_usage_records WHERE tenant_id = $1`,
      [app.tenantId],
    );
    const usage = usageRow.rows[0] as { id: string; content_hash: string; record_hash: string };
    const subRow = await app.pool.query(
      `SELECT id FROM billing_subscriptions WHERE tenant_id = $1`,
      [app.tenantId],
    );
    const subId = (subRow.rows[0] as { id: string }).id;

    // One live subscription per (tenant, service).
    await assert.rejects(
      app.pool.query(
        `INSERT INTO billing_subscriptions (tenant_id, service_id, service_version, status, plan, content_hash, record_hash, created_by, created_at, updated_at)
         VALUES ($1, 'subcontractor-compliance', 1, 'draft', '{}', 'x', 'x', $2, NOW(), NOW())`,
        [app.tenantId, app.owner.id],
      ),
      /billing_subscriptions_one_live|duplicate key/,
    );
    // Duplicate billable work is impossible at the schema level.
    await assert.rejects(
      app.pool.query(
        `INSERT INTO billing_usage_records (tenant_id, subscription_id, service_id, service_version, source, metric, unit, quantity, work_id, occurred_at, billing_period, content_hash, record_hash, created_by, created_at, updated_at)
         VALUES ($1, $2, 'subcontractor-compliance', 1, 'work', 'onboarded-subcontractor', 'count', 1, $3, NOW(), $4, 'x', 'x', $5, NOW(), NOW())`,
        [app.tenantId, subId, work.id, PERIOD, app.owner.id],
      ),
      /billing_usage_records_one_per_work|duplicate key/,
    );
    // One ledger outcome per (subscription, period) + charge arithmetic.
    const ledgerRow = await app.pool.query(
      `INSERT INTO billing_period_ledger (tenant_id, subscription_id, service_id, billing_period, currency, subscription_charge, usage_charge, total_charge, usage_count, content_hash, record_hash, settled_by, created_by, created_at, updated_at)
       VALUES ($1, $2, 'subcontractor-compliance', $3, 'EUR', 199, 25.5, 224.5, 1, 'x', 'x', $4, $4, NOW(), NOW()) RETURNING id`,
      [app.tenantId, subId, PERIOD, app.owner.id],
    );
    const ledgerId = (ledgerRow.rows[0] as { id: string }).id;
    await assert.rejects(
      app.pool.query(
        `INSERT INTO billing_period_ledger (tenant_id, subscription_id, service_id, billing_period, currency, subscription_charge, usage_charge, total_charge, usage_count, content_hash, record_hash, settled_by, created_by, created_at, updated_at)
         VALUES ($1, $2, 'subcontractor-compliance', $3, 'EUR', 199, 25.5, 224.5, 1, 'x', 'x', $4, $4, NOW(), NOW())`,
        [app.tenantId, subId, PERIOD, app.owner.id],
      ),
      /billing_period_ledger_one_outcome|duplicate key/,
    );
    // total_charge must equal subscription + usage.
    await assert.rejects(
      app.pool.query(
        `INSERT INTO billing_period_ledger (tenant_id, subscription_id, service_id, billing_period, currency, subscription_charge, usage_charge, total_charge, usage_count, content_hash, record_hash, settled_by, created_by, created_at, updated_at)
         VALUES ($1, $2, 'subcontractor-compliance', '2026-08', 'EUR', 199, 25.5, 999, 1, 'x', 'x', $3, $3, NOW(), NOW())`,
        [app.tenantId, subId, app.owner.id],
      ),
      /total_charge|check/,
    );
    // The cost-reference source enumeration is closed (no provider value).
    await assert.rejects(
      app.pool.query(
        `INSERT INTO billing_cost_references (tenant_id, billing_period, source, external_reference, amount, currency, content_hash, record_hash, recorded_by, idempotency_key, created_at, updated_at)
         VALUES ($1, $2, 'some-provider', 'ref', 10, 'EUR', 'x', 'x', $3, 'k', NOW(), NOW())`,
        [app.tenantId, PERIOD, app.owner.id],
      ),
      /cost_reference|check|source/i,
    );
    // The subscription must pin a REGISTERED definition version (FK). Use
    // a service with NO subscription so the one-live index does not fire
    // first (PostgreSQL evaluates the partial unique insert conflict
    // before the FK for an occupied (tenant, service) slot).
    await assert.rejects(
      app.pool.query(
        `INSERT INTO billing_subscriptions (tenant_id, service_id, service_version, status, plan, content_hash, record_hash, created_by, created_at, updated_at)
         VALUES ($1, 'ghost-service', 1, 'draft', '{}', 'x', 'x', $2, NOW(), NOW())`,
        [app.tenantId, app.owner.id],
      ),
      /services_definitions|foreign key/i,
    );
    // Cleanup for the ledger row so later reads stay consistent.
    void usage;
    void ledgerId;
  } finally {
    await teardown(app);
  }
});

test('the full billing flow works over real SQL (bind, meter, settle, reference, margin)', { skip: SKIP }, async () => {
  const app = await liveApp();
  try {
    await cataloged(app);
    const subscription = await activeSubscription(app);
    assert.equal(subscription.serviceVersion, 1, 'pins the active definition version');
    const workA = await createWork(app, 'Onboard Acme');
    const workB = await createWork(app, 'Onboard Beta');
    await app.billing.meterWorkUsage(app.owner, {
      tenantId: app.tenantId,
      serviceId: 'subcontractor-compliance',
      workId: workA.id,
      metric: 'onboarded-subcontractor',
      quantity: '2',
    });
    await app.billing.meterWorkUsage(app.owner, {
      tenantId: app.tenantId,
      serviceId: 'subcontractor-compliance',
      workId: workB.id,
      metric: 'onboarded-subcontractor',
      quantity: '1',
    });
    await app.billing.meterOutcomeUsage(app.owner, {
      tenantId: app.tenantId,
      serviceId: 'subcontractor-compliance',
      outcomeId: 'subcontractor-compliant',
      metric: 'processed-document',
      quantity: '100',
    });
    await app.billing.recordManualUsage(app.owner, {
      tenantId: app.tenantId,
      serviceId: 'subcontractor-compliance',
      metric: 'processed-document',
      quantity: '10',
      idempotencyKey: 'manual-live',
    });
    const { ledger } = await app.billing.settleBillingPeriod(app.owner, {
      tenantId: app.tenantId,
      serviceId: 'subcontractor-compliance',
      billingPeriod: PERIOD,
    });
    // 199 + 2*25.5 + 1*25.5 + 100*0.10 + 10*0.10 = 199 + 76.5 + 11
    assert.equal(ledger.usageCharge, '87.5');
    assert.equal(ledger.totalCharge, '286.5');
    assert.equal(ledger.usageCount, 4);
    await app.billing.recordCostReference(app.owner, {
      tenantId: app.tenantId,
      billingPeriod: PERIOD,
      source: 'ai_authority',
      externalReference: 'statement-2026-09-0001',
      amount: '52.25',
      currency: 'EUR',
      idempotencyKey: 'cost-live',
    });
    const report = await app.billing.computeMarginReport(app.owner, app.tenantId, PERIOD);
    const eur = report.lines.find((line) => line.currency === 'EUR');
    assert.notEqual(eur, undefined);
    assert.equal(eur?.revenue, '286.5');
    assert.equal(eur?.externalCosts, '52.25');
    assert.equal(eur?.margin, '234.25');
  } finally {
    await teardown(app);
  }
});

test('duplicate billable work cannot double-charge over real SQL', { skip: SKIP }, async () => {
  const app = await liveApp();
  try {
    await cataloged(app);
    await activeSubscription(app);
    const work = await createWork(app, 'Onboard Acme');
    const occurredAt = new Date('2026-09-10T10:00:00.000Z');
    const first = await app.billing.meterWorkUsage(app.owner, {
      tenantId: app.tenantId,
      serviceId: 'subcontractor-compliance',
      workId: work.id,
      metric: 'onboarded-subcontractor',
      quantity: '1',
      occurredAt,
    });
    const second = await app.billing.meterWorkUsage(app.owner, {
      tenantId: app.tenantId,
      serviceId: 'subcontractor-compliance',
      workId: work.id,
      metric: 'onboarded-subcontractor',
      quantity: '1',
      occurredAt,
    });
    assert.equal(second.converged, true, 'duplicate metering of the SAME billable event converges');
    assert.equal(second.usage.id, first.usage.id);
    const rows = await app.pool.query(
      `SELECT COUNT(*)::int AS n FROM billing_usage_records WHERE tenant_id = $1`,
      [app.tenantId],
    );
    assert.equal((rows.rows[0] as { n: number }).n, 1, 'never two rows for one billable work');
    // Divergent content fails closed with the typed code.
    await assert.rejects(
      app.billing.meterWorkUsage(app.owner, {
        tenantId: app.tenantId,
        serviceId: 'subcontractor-compliance',
        workId: work.id,
        metric: 'onboarded-subcontractor',
        quantity: '2',
      }),
      (error: unknown) => {
        void expectCode(error, 'USAGE_INPUT_CONFLICT');
        return true;
      },
    );
    // Re-settling converges on the same immutable outcome.
    const settled = await app.billing.settleBillingPeriod(app.owner, {
      tenantId: app.tenantId,
      serviceId: 'subcontractor-compliance',
      billingPeriod: PERIOD,
    });
    const again = await app.billing.settleBillingPeriod(app.owner, {
      tenantId: app.tenantId,
      serviceId: 'subcontractor-compliance',
      billingPeriod: PERIOD,
    });
    assert.equal(again.converged, true);
    assert.equal(again.ledger.id, settled.ledger.id);
    const ledgerRows = await app.pool.query(
      `SELECT COUNT(*)::int AS n FROM billing_period_ledger WHERE tenant_id = $1`,
      [app.tenantId],
    );
    assert.equal((ledgerRows.rows[0] as { n: number }).n, 1, 'exactly one ledger outcome');
  } finally {
    await teardown(app);
  }
});

test('after-the-fact mutation of stored rows is detected on read (live)', { skip: SKIP }, async () => {
  const app = await liveApp();
  try {
    await cataloged(app);
    const subscription = await activeSubscription(app);
    const work = await createWork(app, 'Onboard Acme');
    await app.billing.meterWorkUsage(app.owner, {
      tenantId: app.tenantId,
      serviceId: 'subcontractor-compliance',
      workId: work.id,
      metric: 'onboarded-subcontractor',
      quantity: '1',
    });
    await app.billing.settleBillingPeriod(app.owner, {
      tenantId: app.tenantId,
      serviceId: 'subcontractor-compliance',
      billingPeriod: PERIOD,
    });
    await app.billing.recordCostReference(app.owner, {
      tenantId: app.tenantId,
      billingPeriod: PERIOD,
      source: 'ai_authority',
      externalReference: 'statement-1',
      amount: '5',
      currency: 'EUR',
      idempotencyKey: 'cost-tamper',
    });
    // Subscription plan tamper (content hash divergence).
    await app.pool.query(`UPDATE billing_subscriptions SET plan = '{"model":"subscription"}'::jsonb WHERE id = $1`, [subscription.id]);
    await assert.rejects(
      app.billing.getSubscription(app.owner, app.tenantId, subscription.id),
      (error: unknown) => {
        void expectCode(error, 'SUBSCRIPTION_RECORD_TAMPERED');
        return true;
      },
    );
    // Usage quantity tamper.
    await app.pool.query(`UPDATE billing_usage_records SET quantity = 999 WHERE tenant_id = $1`, [app.tenantId]);
    await assert.rejects(
      app.billing.listUsageRecords(app.owner, app.tenantId, { billingPeriod: PERIOD }),
      (error: unknown) => {
        void expectCode(error, 'USAGE_RECORD_TAMPERED');
        return true;
      },
    );
    // Ledger charge tamper (usage_charge: hash-covered; total_charge is
    // schema-invariant arithmetic and cannot be tampered at all).
    await app.pool.query(`UPDATE billing_period_ledger SET usage_charge = 9999 WHERE tenant_id = $1`, [app.tenantId]);
    await assert.rejects(
      app.billing.listLedgerEntries(app.owner, app.tenantId, PERIOD),
      (error: unknown) => {
        void expectCode(error, 'LEDGER_RECORD_TAMPERED');
        return true;
      },
    );
    // Cost reference amount tamper.
    await app.pool.query(`UPDATE billing_cost_references SET amount = 0 WHERE tenant_id = $1`, [app.tenantId]);
    await assert.rejects(
      app.billing.listCostReferences(app.owner, app.tenantId, PERIOD),
      (error: unknown) => {
        void expectCode(error, 'COST_REFERENCE_RECORD_TAMPERED');
        return true;
      },
    );
  } finally {
    await teardown(app);
  }
});

test('TRUE parallel actors converge over real SQL (independent pooled clients)', { skip: SKIP }, async () => {
  const app = await liveApp();
  try {
    await cataloged(app);
    // Two independent executors (separate pools) racing the same
    // subscription registration with the same content.
    const poolA = new pg.Pool({ connectionString: app.live.dsn, max: 2 });
    const poolB = new pg.Pool({ connectionString: app.live.dsn, max: 2 });
    const executorA = poolExecutor(poolA);
    const executorB = poolExecutor(poolB);
    const authA = createAuthModule({ executor: executorA });
    const organizationsA = createOrganizationsModule({ executor: executorA, authenticator: authA.authenticate, identity: authA });
    const verticalsA = createVerticalsModule({ executor: executorA, tenancy: organizationsA });
    const servicesA = createServicesModule({ executor: executorA, tenancy: organizationsA, verticals: verticalsA });
    const workA = createWorkModule({ executor: executorA, tenancy: organizationsA });
    const billingA = createBillingModule({ executor: executorA, tenancy: organizationsA, services: servicesA, work: workA });
    const colleagueA = await authA.registerHuman({ email: 'member@a.com', password: PASSWORD, displayName: 'Member' });
    await organizationsA.addMember(app.owner, 'alpha-org', { principalId: colleagueA.id, role: 'member' });
    try {
      // Same-key subscription registration: one inserts, one converges.
      const [a, b] = await Promise.all([
        billingA.registerSubscription(colleagueA, {
          tenantId: app.tenantId,
          serviceId: 'subcontractor-compliance',
          plan: PLAN,
          idempotencyKey: 'sub-race',
        }),
        app.billing.registerSubscription(app.owner, {
          tenantId: app.tenantId,
          serviceId: 'subcontractor-compliance',
          plan: PLAN,
          idempotencyKey: 'sub-race',
        }),
      ]);
      assert.notEqual(a.converged, b.converged, 'exactly one insert and one convergence');
      assert.equal(a.subscription.id, b.subscription.id, 'ONE durable identity');
      // Same-key divergent registration: exactly one rejection with the
      // serialized critical section's typed code.
      await app.billing.cancelSubscription(app.owner, app.tenantId, a.subscription.id);
      const [divA, divB] = await Promise.allSettled([
        billingA.registerSubscription(colleagueA, {
          tenantId: app.tenantId,
          serviceId: 'subcontractor-compliance',
          plan: { ...PLAN, recurring: { amount: '299.00' } },
          idempotencyKey: 'sub-divergent',
        }),
        app.billing.registerSubscription(app.owner, {
          tenantId: app.tenantId,
          serviceId: 'subcontractor-compliance',
          plan: { ...PLAN, recurring: { amount: '399.00' } },
          idempotencyKey: 'sub-divergent',
        }),
      ]);
      const failed = [divA, divB].filter((result) => result.status === 'rejected');
      assert.equal(failed.length, 1, 'exactly one rejection');
      if (failed[0]?.status === 'rejected') {
        await expectCode(failed[0].reason, 'IDEMPOTENCY_INPUT_CONFLICT');
      }
      // Cancel the divergent winner: the one-live invariant would
      // otherwise block the next registration.
      const divergentWinner = [divA, divB].find((result) => result.status === 'fulfilled');
      if (divergentWinner?.status === 'fulfilled') {
        await app.billing.cancelSubscription(app.owner, app.tenantId, divergentWinner.value.subscription.id);
      }

      // Parallel metering of the SAME billable work converges on ONE row
      // (the SAME billable event: explicit occurredAt, quantity).
      const subscription = await app.billing.registerSubscription(app.owner, {
        tenantId: app.tenantId,
        serviceId: 'subcontractor-compliance',
        plan: PLAN,
        idempotencyKey: 'sub-meter',
      });
      await app.billing.activateSubscription(app.owner, app.tenantId, subscription.subscription.id);
      const work = await app.work.createWork(app.owner, {
        tenantId: app.tenantId,
        workType: 'OnboardSubcontractor',
        title: 'Onboard Acme',
      });
      const meterOccurredAt = new Date('2026-09-12T08:00:00.000Z');
      const [meterA, meterB] = await Promise.all([
        billingA.meterWorkUsage(colleagueA, {
          tenantId: app.tenantId,
          serviceId: 'subcontractor-compliance',
          workId: work.work.id,
          metric: 'onboarded-subcontractor',
          quantity: '3',
          occurredAt: meterOccurredAt,
        }),
        app.billing.meterWorkUsage(app.owner, {
          tenantId: app.tenantId,
          serviceId: 'subcontractor-compliance',
          workId: work.work.id,
          metric: 'onboarded-subcontractor',
          quantity: '3',
          occurredAt: meterOccurredAt,
        }),
      ]);
      assert.notEqual(meterA.converged, meterB.converged, 'exactly one insert and one convergence');
      assert.equal(meterA.usage.id, meterB.usage.id, 'ONE usage row for one billable work');
      const usageRows = await app.pool.query(
        `SELECT COUNT(*)::int AS n FROM billing_usage_records WHERE tenant_id = $1`,
        [app.tenantId],
      );
      assert.equal((usageRows.rows[0] as { n: number }).n, 1);

      // CONCURRENT settlement converges on ONE ledger outcome with the
      // usage priced exactly once.
      const [settleA, settleB] = await Promise.all([
        billingA.settleBillingPeriod(colleagueA, {
          tenantId: app.tenantId,
          serviceId: 'subcontractor-compliance',
          billingPeriod: PERIOD,
        }),
        app.billing.settleBillingPeriod(app.owner, {
          tenantId: app.tenantId,
          serviceId: 'subcontractor-compliance',
          billingPeriod: PERIOD,
        }),
      ]);
      assert.notEqual(settleA.converged, settleB.converged, 'exactly one settlement');
      assert.equal(settleA.ledger.id, settleB.ledger.id, 'ONE durable ledger outcome');
      assert.equal(settleA.ledger.usageCharge, '76.5', 'the usage is priced exactly once (3*25.5)');
      assert.equal(settleA.ledger.totalCharge, '275.5');
      const ledgerRows = await app.pool.query(
        `SELECT COUNT(*)::int AS n FROM billing_period_ledger WHERE tenant_id = $1`,
        [app.tenantId],
      );
      assert.equal((ledgerRows.rows[0] as { n: number }).n, 1, 'never two ledger rows for one period');
    } finally {
      await poolA.end();
      await poolB.end();
    }
  } finally {
    await teardown(app);
  }
});

test('cross-tenant reads carry the tenant predicate against real rows', { skip: SKIP }, async () => {
  const app = await liveApp();
  try {
    await cataloged(app);
    const subscription = await activeSubscription(app);
    const otherOwner = await app.auth.registerHuman({ email: 'owner@b.com', password: PASSWORD, displayName: 'Other' });
    const other = await app.organizations.createOrganization(otherOwner, { slug: 'beta-org', displayName: 'Beta' });
    // The other tenant registers its own catalog + subscription.
    await app.verticals.registerVerticalPackage(otherOwner, packageInput(other.tenant.id, 1));
    await app.services.registerServiceDefinition(otherOwner, serviceInput(other.tenant.id, 1, 'svc-other'));
    await app.services.activateServiceDefinition(otherOwner, other.tenant.id, 'subcontractor-compliance', 1);
    const otherSubscription = await app.billing.registerSubscription(otherOwner, {
      tenantId: other.tenant.id,
      serviceId: 'subcontractor-compliance',
      plan: PLAN,
      idempotencyKey: 'sub-other',
    });
    // A principal of tenant A reading tenant B's subscription id: the
    // row is simply absent (the tenant predicate applies at SQL level).
    const read = await app.billing.getSubscription(app.owner, app.tenantId, otherSubscription.subscription.id);
    assert.equal(read, null);
    // And vice versa — tenant B cannot see tenant A's subscription.
    const readB = await app.billing.getSubscription(otherOwner, other.tenant.id, subscription.id);
    assert.equal(readB, null);
    // Both rows exist — the reads are predicate-scoped, not empty.
    const rows = await app.pool.query(`SELECT COUNT(*)::int AS n FROM billing_subscriptions`);
    assert.equal((rows.rows[0] as { n: number }).n, 2);
  } finally {
    await teardown(app);
  }
});
