/**
 * Optional live-PostgreSQL integration proof for the Business Policy
 * Authority (WORK-014, CRITICAL assurance). Runs ONLY when
 * SERVICEOS_TEST_DATABASE_URL points at a disposable PostgreSQL database;
 * otherwise it is skipped.
 *
 * When the variable is present this file proves the REAL durable layer:
 * - migrations 0001 + 0002 + 0003 apply in order and are idempotent;
 * - schema backstops hold: closed scope/status/effect/outcome/deciding-layer
 *   enumerations, one active version per (tenant, policy key, scope), the
 *   tenant-scoped idempotency partial unique indexes for versions and
 *   decisions;
 * - the full policy lifecycle works over real SQL (create → activate →
 *   resolve → evaluate → verify) with revision-bound provenance;
 * - determinism over the real store: the same input produces the same
 *   decision and input hash;
 * - the frozen floor denies frozen-denied capabilities even when every
 *   data layer allows (override cannot weaken);
 * - after-the-fact mutation of a recorded decision is DETECTED on read
 *   (integrity hash recomputation against real rows);
 * - TRUE parallel actors (separate pooled clients) converge: same-key
 *   version creation, same-key decision evaluation, same-version
 *   activation — one durable record each;
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
import { applyMigrations, withTransactionOn, type Migration, type TransactionalExecutor } from '../src/platform/persistence/index.js';
import { createAuthModule } from '../src/modules/auth/index.js';
import { createOrganizationsModule } from '../src/modules/organizations/index.js';
import { createPoliciesModule, PolicyError } from '../src/modules/policies/index.js';
import { createLiveTestDatabase, liveDatabaseRequested, type LiveDatabase } from './helpers/live-database.js';
import type { Principal } from '../src/modules/auth/index.js';

const SKIP = !liveDatabaseRequested();
const PASSWORD = 'correct horse battery 7';

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
  return [
    {
      version: 1,
      name: 'identity-tenancy',
      sql: readFileSync(resolve(base, '0001_identity_tenancy.sql'), 'utf8'),
    },
    {
      version: 2,
      name: 'service-work',
      sql: readFileSync(resolve(base, '0002_service_work.sql'), 'utf8'),
    },
    {
      version: 3,
      name: 'business-policy',
      sql: readFileSync(resolve(base, '0003_business_policy.sql'), 'utf8'),
    },
  ];
}

interface LiveApp {
  live: LiveDatabase;
  pool: pg.Pool;
  auth: ReturnType<typeof createAuthModule>;
  organizations: ReturnType<typeof createOrganizationsModule>;
  policies: ReturnType<typeof createPoliciesModule>;
  owner: Principal;
  colleague: Principal;
  tenantId: string;
}

/** Fresh pool + composed modules over a disposable migrated database. */
async function preparedLive(): Promise<LiveApp> {
  const live = await createLiveTestDatabase();
  const pool = new pg.Pool({ connectionString: live.dsn, max: 8 });
  await applyMigrationsPinned(pool, migrations());
  const executor = poolExecutor(pool);
  const auth = createAuthModule({ executor });
  const organizations = createOrganizationsModule({
    executor,
    authenticator: auth.authenticate,
    identity: auth,
  });
  const policies = createPoliciesModule({ executor, tenancy: organizations });
  const owner = await auth.registerHuman({ email: 'owner@a.com', password: PASSWORD, displayName: 'Owner' });
  const colleague = await auth.registerHuman({ email: 'member@a.com', password: PASSWORD, displayName: 'Member' });
  const created = await organizations.createOrganization(owner, { slug: 'alpha-org', displayName: 'Alpha' });
  await organizations.addMember(owner, 'alpha-org', { principalId: colleague.id, role: 'member' });
  return { live, pool, auth, organizations, policies, owner, colleague, tenantId: created.tenant.id };
}

function policiesOverOwnPool(app: LiveApp): { module: ReturnType<typeof createPoliciesModule>; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString: app.live.dsn, max: 4 });
  const module = createPoliciesModule({ executor: poolExecutor(pool), tenancy: app.organizations });
  return { module, pool };
}

function refundRules() {
  return [
    { id: 'deny-large', when: { kind: 'attribute' as const, name: 'amount', operator: 'gt' as const, value: 500 }, effect: 'deny' as const },
    { id: 'allow-web', when: { kind: 'attribute' as const, name: 'channel', operator: 'eq' as const, value: 'web' }, effect: 'allow' as const },
  ];
}

async function seedActivePolicies(app: LiveApp) {
  const base = await app.policies.createPolicyVersion(app.owner, {
    tenantId: app.tenantId,
    policyKey: 'billing.refund',
    scope: 'base',
    rules: refundRules(),
    defaultEffect: 'deny',
  });
  await app.policies.activatePolicyVersion(app.owner, app.tenantId, base.contract.id);
  return base.contract;
}

function isPolicyError(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof PolicyError && error.code === code;
}

test('live: migrations 0001+0002+0003 apply once and re-runs are no-ops', { skip: SKIP }, async () => {
  const live = await createLiveTestDatabase();
  const pool = new pg.Pool({ connectionString: live.dsn });
  try {
    const first = await applyMigrationsPinned(pool, migrations());
    assert.equal(first.applied.length, 3);
    const second = await applyMigrationsPinned(pool, migrations());
    assert.equal(second.applied.length, 0);
    assert.equal(second.skipped, 3);
    const tables = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('policy_contracts','policy_decisions')
       ORDER BY table_name`,
    );
    assert.deepEqual(
      tables.rows.map((r) => (r as { table_name: string }).table_name),
      ['policy_contracts', 'policy_decisions'],
    );
  } finally {
    await pool.end();
    await live.drop();
  }
});

test('live: schema backstops hold (closed enumerations, one active, idempotency indexes)', { skip: SKIP }, async () => {
  const app = await preparedLive();
  try {
    const { pool } = app;
    // Minimal FK chain for raw probe rows: organization -> tenant -> user.
    const orgRow = await pool.query(
      `INSERT INTO org_organizations (slug, display_name) VALUES ('probe-org', 'Probe') RETURNING id`,
    );
    const probeOrg = (orgRow.rows[0] as { id: string }).id;
    const tenantRow = await pool.query(
      `INSERT INTO org_service_tenants (organization_id, slug, display_name) VALUES ($1, 'probe-tenant', 'Probe Tenant') RETURNING id`,
      [probeOrg],
    );
    const probeTenant = (tenantRow.rows[0] as { id: string }).id;
    const userRow = await pool.query(
      `INSERT INTO auth_users (email, kind, display_name) VALUES ('probe@x.com', 'human', 'Probe') RETURNING id`,
    );
    const probeUser = (userRow.rows[0] as { id: string }).id;
    const contractRow = await pool.query(
      `INSERT INTO policy_contracts (tenant_id, policy_key, scope, version, status, rules, default_effect, created_by)
       VALUES ($1, 'probe.key', 'base', 1, 'draft', '[]'::jsonb, 'deny', $2) RETURNING id`,
      [probeTenant, probeUser],
    );
    const contractId = (contractRow.rows[0] as { id: string }).id;
    await pool.query(
      `UPDATE policy_contracts SET status = 'active' WHERE id = $1`,
      [contractId],
    );

    // Closed enumerations reject out-of-enumeration values.
    await assert.rejects(
      pool.query(`UPDATE policy_contracts SET status = 'published' WHERE id = $1`, [contractId]),
      /check/i,
    );
    await assert.rejects(
      pool.query(`UPDATE policy_contracts SET scope = 'vertical' WHERE id = $1`, [contractId]),
      /check/i,
    );
    await assert.rejects(
      pool.query(`UPDATE policy_contracts SET default_effect = 'maybe' WHERE id = $1`, [contractId]),
      /check/i,
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO policy_decisions (tenant_id, policy_key, outcome, deciding_layer, frozen_revision, layers, input, input_hash, record_hash, decided_by)
         VALUES ($1, 'probe.key', 'perhaps', 'frozen', 'frozen-v1.0', '[]'::jsonb, '{}'::jsonb, 'h', 'h', $2)`,
        [probeTenant, probeUser],
      ),
      /check/i,
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO policy_decisions (tenant_id, policy_key, outcome, deciding_layer, frozen_revision, layers, input, input_hash, record_hash, decided_by)
         VALUES ($1, 'probe.key', 'allow', 'policy', 'frozen-v1.0', '[]'::jsonb, '{}'::jsonb, 'h', 'h', $2)`,
        [probeTenant, probeUser],
      ),
      /check/i,
    );

    // ONE active version per (tenant, policy key, scope).
    await assert.rejects(
      pool.query(
        `INSERT INTO policy_contracts (tenant_id, policy_key, scope, version, status, rules, default_effect, created_by)
         VALUES ($1, 'probe.key', 'base', 2, 'active', '[]'::jsonb, 'deny', $2)`,
        [probeTenant, probeUser],
      ),
      /policy_contracts_one_active/i,
    );

    // Version numbers are unique per identity.
    await assert.rejects(
      pool.query(
        `INSERT INTO policy_contracts (tenant_id, policy_key, scope, version, status, rules, default_effect, created_by)
         VALUES ($1, 'probe.key', 'base', 1, 'draft', '[]'::jsonb, 'deny', $2)`,
        [probeTenant, probeUser],
      ),
      /policy_contracts_tenant_id_policy_key_scope_version_key|policy_contracts_pkey/i,
    );

    // Idempotency partial unique indexes: same (tenant, key) twice fails.
    await pool.query(
      `INSERT INTO policy_contracts (tenant_id, policy_key, scope, version, status, rules, default_effect, created_by, idempotency_key)
       VALUES ($1, 'probe.key2', 'base', 1, 'draft', '[]'::jsonb, 'deny', $2, 'idem-1')`,
      [probeTenant, probeUser],
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO policy_contracts (tenant_id, policy_key, scope, version, status, rules, default_effect, created_by, idempotency_key)
         VALUES ($1, 'probe.key2', 'base', 2, 'draft', '[]'::jsonb, 'deny', $2, 'idem-1')`,
        [probeTenant, probeUser],
      ),
      /policy_contracts_tenant_idempotency_key/i,
    );
    await pool.query(
      `INSERT INTO policy_decisions (tenant_id, policy_key, outcome, deciding_layer, frozen_revision, layers, input, input_hash, record_hash, decided_by, idempotency_key)
       VALUES ($1, 'probe.key', 'allow', 'base', 'frozen-v1.0', '[]'::jsonb, '{}'::jsonb, 'h1', 'h2', $2, 'dec-1')`,
      [probeTenant, probeUser],
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO policy_decisions (tenant_id, policy_key, outcome, deciding_layer, frozen_revision, layers, input, input_hash, record_hash, decided_by, idempotency_key)
         VALUES ($1, 'probe.key', 'deny', 'base', 'frozen-v1.0', '[]'::jsonb, '{}'::jsonb, 'h1', 'h2', $2, 'dec-1')`,
        [probeTenant, probeUser],
      ),
      /policy_decisions_tenant_idempotency_key/i,
    );
  } finally {
    await app.pool.end();
    await app.live.drop();
  }
});

test('live: full policy lifecycle over real SQL with revision-bound provenance', { skip: SKIP }, async () => {
  const app = await preparedLive();
  try {
    const { policies, owner, tenantId } = app;
    const base = await seedActivePolicies(app);

    // Base-only resolution and evaluation first.
    const resolvedBaseOnly = await policies.resolvePolicy(owner, tenantId, 'billing.refund');
    assert.equal(resolvedBaseOnly.base?.id, base.id);
    assert.equal(resolvedBaseOnly.customer, null);
    assert.equal(resolvedBaseOnly.frozenRevision, 'frozen-v1.0');

    // Allow through the base (web, small).
    const web = await policies.evaluatePolicy(owner, {
      tenantId,
      policyKey: 'billing.refund',
      action: 'side-effect:refund.issue',
      attributes: { amount: 120, channel: 'web' },
    });
    assert.equal(web.decision.outcome, 'allow');
    assert.equal(web.decision.decidingLayer, 'base');
    assert.equal(web.decision.decidingRuleId, 'allow-web');

    // A tightening customer override: deny partner-channel refunds. Its
    // default effect is 'allow' ("follow the base for anything my rules do
    // not cover") — the tightening-only posture.
    const customer = await policies.createPolicyVersion(owner, {
      tenantId,
      policyKey: 'billing.refund',
      scope: 'customer',
      rules: [{ id: 'deny-partner', when: { kind: 'attribute', name: 'channel', operator: 'eq', value: 'partner' }, effect: 'deny' }],
      defaultEffect: 'allow',
    });
    await policies.activatePolicyVersion(owner, tenantId, customer.contract.id);

    const resolved = await policies.resolvePolicy(owner, tenantId, 'billing.refund');
    assert.equal(resolved.base?.id, base.id);
    assert.equal(resolved.customer?.id, customer.contract.id);

    // Tightening: partner channel denied by the customer override.
    const partner = await policies.evaluatePolicy(owner, {
      tenantId,
      policyKey: 'billing.refund',
      action: 'side-effect:refund.issue',
      attributes: { amount: 10, channel: 'partner' },
    });
    assert.equal(partner.decision.outcome, 'deny');
    assert.equal(partner.decision.decidingLayer, 'customer');
    assert.equal(partner.decision.decidingRuleId, 'deny-partner');

    // Provenance pins each consulted version (AC-5).
    const baseLayer = web.decision.layers.find((l) => l.layer === 'base');
    const customerLayer = web.decision.layers.find((l) => l.layer === 'customer');
    assert.equal(baseLayer?.policyId, base.id);
    assert.equal(baseLayer?.version, base.version);
    assert.equal(customerLayer?.policyId, null, 'the base-only decision consulted no customer version');
    assert.equal(web.decision.decidedBy, owner.id);

    // Idempotent decision convergence + replay verification over real SQL.
    const first = await policies.evaluatePolicy(owner, {
      tenantId,
      policyKey: 'billing.refund',
      action: 'side-effect:refund.issue',
      attributes: { amount: 120, channel: 'web' },
      idempotencyKey: 'intent-live-1',
    });
    assert.equal(first.converged, false);
    const again = await policies.evaluatePolicy(owner, {
      tenantId,
      policyKey: 'billing.refund',
      action: 'side-effect:refund.issue',
      attributes: { amount: 120, channel: 'web' },
      idempotencyKey: 'intent-live-1',
    });
    assert.equal(again.converged, true);
    assert.equal(again.decision.id, first.decision.id);
    const verified = await policies.verifyDecision(owner, tenantId, again.decision.id);
    assert.equal(verified.outcome, 'allow');
  } finally {
    await app.pool.end();
    await app.live.drop();
  }
});

test('live: determinism over the real store (same input, same decision)', { skip: SKIP }, async () => {
  const app = await preparedLive();
  try {
    const { policies, owner, tenantId } = app;
    await seedActivePolicies(app);
    const input = {
      tenantId,
      policyKey: 'billing.refund',
      action: 'side-effect:refund.issue',
      attributes: { amount: 120, channel: 'web' },
    };
    const first = await policies.evaluatePolicy(owner, input);
    const second = await policies.evaluatePolicy(owner, { ...input, attributes: { channel: 'web', amount: 120 } });
    assert.equal(first.decision.outcome, second.decision.outcome);
    assert.equal(first.decision.decidingLayer, second.decision.decidingLayer);
    assert.equal(first.decision.decidingRuleId, second.decision.decidingRuleId);
    assert.equal(first.decision.inputHash, second.decision.inputHash, 'attribute order does not change the input revision');
    assert.notEqual(first.decision.id, second.decision.id);
  } finally {
    await app.pool.end();
    await app.live.drop();
  }
});

test('live: frozen floor denies frozen capabilities over real SQL (override cannot weaken)', { skip: SKIP }, async () => {
  const app = await preparedLive();
  try {
    const { policies, owner, tenantId } = app;
    // Everything allows, including an override that explicitly tries to
    // grant the frozen capability.
    const base = await policies.createPolicyVersion(owner, {
      tenantId,
      policyKey: 'billing.refund',
      scope: 'base',
      rules: [{ id: 'allow-all', when: { kind: 'always' }, effect: 'allow' }],
      defaultEffect: 'allow',
    });
    await policies.activatePolicyVersion(owner, tenantId, base.contract.id);
    const customer = await policies.createPolicyVersion(owner, {
      tenantId,
      policyKey: 'billing.refund',
      scope: 'customer',
      rules: [{ id: 'grant-bypass', when: { kind: 'attribute', name: 'capability', operator: 'eq', value: 'authorization-bypass' }, effect: 'allow' }],
      defaultEffect: 'allow',
    });
    await policies.activatePolicyVersion(owner, tenantId, customer.contract.id);

    const decision = await policies.evaluatePolicy(owner, {
      tenantId,
      policyKey: 'billing.refund',
      action: 'side-effect:refund.issue',
      attributes: { capability: 'authorization-bypass' },
    });
    assert.equal(decision.decision.outcome, 'deny');
    assert.equal(decision.decision.decidingLayer, 'frozen');
    assert.match(decision.decision.decidingRuleId ?? '', /^frozen:denied-capability:/);
  } finally {
    await app.pool.end();
    await app.live.drop();
  }
});

test('live: mutating a recorded decision is detected on read (integrity hash)', { skip: SKIP }, async () => {
  const app = await preparedLive();
  try {
    const { policies, owner, tenantId, pool } = app;
    await seedActivePolicies(app);
    const allowed = await policies.evaluatePolicy(owner, {
      tenantId,
      policyKey: 'billing.refund',
      action: 'side-effect:refund.issue',
      attributes: { amount: 120, channel: 'web' },
    });
    assert.equal(allowed.decision.outcome, 'allow');

    // Out-of-band mutation of the recorded result (raw SQL UPDATE).
    await pool.query(`UPDATE policy_decisions SET outcome = 'deny' WHERE id = $1`, [allowed.decision.id]);
    await assert.rejects(policies.getDecision(owner, tenantId, allowed.decision.id), isPolicyError('DECISION_RECORD_TAMPERED'));
    await assert.rejects(policies.verifyDecision(owner, tenantId, allowed.decision.id), isPolicyError('DECISION_RECORD_TAMPERED'));

    // Restore, then mutate the input snapshot (input hash must catch it).
    await pool.query(`UPDATE policy_decisions SET outcome = 'allow' WHERE id = $1`, [allowed.decision.id]);
    await pool.query(
      `UPDATE policy_decisions SET input = jsonb_set(input, '{attributes,amount}', '9999'::jsonb) WHERE id = $1`,
      [allowed.decision.id],
    );
    await assert.rejects(policies.getDecision(owner, tenantId, allowed.decision.id), isPolicyError('DECISION_RECORD_TAMPERED'));

    // Restore honestly: reads verify again.
    await pool.query(
      `UPDATE policy_decisions SET input = jsonb_set(input, '{attributes,amount}', '120'::jsonb) WHERE id = $1`,
      [allowed.decision.id],
    );
    const honest = await policies.getDecision(owner, tenantId, allowed.decision.id);
    assert.equal(honest.outcome, 'allow');
  } finally {
    await app.pool.end();
    await app.live.drop();
  }
});

test('live: two parallel actors converge on one durable policy version', { skip: SKIP }, async () => {
  const app = await preparedLive();
  const extraPools: pg.Pool[] = [];
  try {
    const { owner, colleague, tenantId, pool } = app;
    const actorA = policiesOverOwnPool(app);
    const actorB = policiesOverOwnPool(app);
    extraPools.push(actorA.pool, actorB.pool);

    const key = `catalog-${Date.now()}`;
    const [a, b] = await Promise.all([
      actorA.module.createPolicyVersion(owner, {
        tenantId,
        policyKey: 'billing.refund',
        scope: 'base',
        rules: refundRules(),
        defaultEffect: 'deny',
        idempotencyKey: key,
      }),
      actorB.module.createPolicyVersion(colleague, {
        tenantId,
        policyKey: 'billing.refund',
        scope: 'base',
        rules: refundRules(),
        defaultEffect: 'deny',
        idempotencyKey: key,
      }),
    ]);
    assert.equal(a.contract.id, b.contract.id);
    assert.equal((a.converged ? 1 : 0) + (b.converged ? 1 : 0), 1);
    const rows = await pool.query('SELECT COUNT(*)::int AS n FROM policy_contracts WHERE tenant_id = $1 AND idempotency_key = $2', [tenantId, key]);
    assert.equal((rows.rows[0] as { n: number }).n, 1);
  } finally {
    // Drain the actor pools BEFORE the drop.
    await Promise.allSettled(extraPools.map((pool) => pool.end()));
    await app.pool.end();
    await app.live.drop();
  }
});

test('live: parallel evaluations of one gated decision converge on one record', { skip: SKIP }, async () => {
  const app = await preparedLive();
  const extraPools: pg.Pool[] = [];
  try {
    const { owner, colleague, tenantId, pool } = app;
    await seedActivePolicies(app);
    const actorA = policiesOverOwnPool(app);
    const actorB = policiesOverOwnPool(app);
    extraPools.push(actorA.pool, actorB.pool);

    const input = {
      tenantId,
      policyKey: 'billing.refund',
      action: 'side-effect:refund.issue',
      attributes: { amount: 120, channel: 'web' },
      idempotencyKey: 'intent-live-parallel',
    };
    const [a, b] = await Promise.all([
      actorA.module.evaluatePolicy(owner, input),
      actorB.module.evaluatePolicy(colleague, input),
    ]);
    assert.equal(a.decision.id, b.decision.id);
    assert.equal(a.decision.outcome, b.decision.outcome);
    assert.equal((a.converged ? 1 : 0) + (b.converged ? 1 : 0), 1);
    const rows = await pool.query('SELECT COUNT(*)::int AS n FROM policy_decisions WHERE tenant_id = $1 AND idempotency_key = $2', [tenantId, 'intent-live-parallel']);
    assert.equal((rows.rows[0] as { n: number }).n, 1);
  } finally {
    await Promise.allSettled(extraPools.map((pool) => pool.end()));
    await app.pool.end();
    await app.live.drop();
  }
});

test('live: parallel activations of the same version converge (one active at rest)', { skip: SKIP }, async () => {
  const app = await preparedLive();
  const extraPools: pg.Pool[] = [];
  try {
    const { owner, colleague, tenantId, pool } = app;
    const created = await app.policies.createPolicyVersion(owner, {
      tenantId,
      policyKey: 'billing.refund',
      scope: 'base',
      rules: refundRules(),
      defaultEffect: 'deny',
    });
    const actorA = policiesOverOwnPool(app);
    const actorB = policiesOverOwnPool(app);
    extraPools.push(actorA.pool, actorB.pool);

    const [a, b] = await Promise.all([
      actorA.module.activatePolicyVersion(owner, tenantId, created.contract.id),
      actorB.module.activatePolicyVersion(colleague, tenantId, created.contract.id),
    ]);
    assert.equal(a.contract.id, created.contract.id);
    assert.equal(b.contract.id, created.contract.id);
    assert.equal(a.contract.status, 'active');
    assert.equal(b.contract.status, 'active');
    assert.equal((a.converged ? 1 : 0) + (b.converged ? 1 : 0), 1);
    const rows = await pool.query(
      `SELECT COUNT(*)::int AS n FROM policy_contracts WHERE tenant_id = $1 AND policy_key = 'billing.refund' AND scope = 'base' AND status = 'active'`,
      [tenantId],
    );
    assert.equal((rows.rows[0] as { n: number }).n, 1);
  } finally {
    await Promise.allSettled(extraPools.map((pool) => pool.end()));
    await app.pool.end();
    await app.live.drop();
  }
});

test('live: cross-tenant policy reads are invisible (SQL tenant predicates)', { skip: SKIP }, async () => {
  const app = await preparedLive();
  try {
    const { policies, owner, tenantId, pool } = app;
    const base = await seedActivePolicies(app);
    const decision = await policies.evaluatePolicy(owner, {
      tenantId,
      policyKey: 'billing.refund',
      action: 'side-effect:refund.issue',
      attributes: { amount: 120, channel: 'web' },
    });

    // A second tenant in the same database: rows exist, predicated reads
    // through the other tenant's scope return nothing.
    const executor = poolExecutor(pool);
    const auth2 = createAuthModule({ executor });
    const orgs2 = createOrganizationsModule({ executor, authenticator: auth2.authenticate, identity: auth2 });
    const policies2 = createPoliciesModule({ executor, tenancy: orgs2 });
    const mallory = await auth2.registerHuman({ email: 'mallory@b.com', password: PASSWORD, displayName: 'Mallory' });
    const org2 = await orgs2.createOrganization(mallory, { slug: 'beta-org', displayName: 'Beta' });
    const tenantB = org2.tenant.id;

    // The raw rows exist...
    const raw = await pool.query('SELECT COUNT(*)::int AS n FROM policy_contracts WHERE id = $1', [base.id]);
    assert.equal((raw.rows[0] as { n: number }).n, 1);
    // ...but tenant-B lookups see nothing.
    await assert.rejects(policies2.getPolicyVersion(mallory, tenantB, base.id), isPolicyError('POLICY_VERSION_NOT_FOUND'));
    await assert.rejects(policies2.getDecision(mallory, tenantB, decision.decision.id), isPolicyError('DECISION_NOT_FOUND'));
    const resolved = await policies2.resolvePolicy(mallory, tenantB, 'billing.refund');
    assert.equal(resolved.base, null);
    assert.deepEqual(await policies2.listPolicyVersions(mallory, tenantB, 'billing.refund'), []);
  } finally {
    await app.pool.end();
    await app.live.drop();
  }
});

test('live: a divergent input on one decision key fails closed (input conflict)', { skip: SKIP }, async () => {
  const app = await preparedLive();
  try {
    const { policies, owner, tenantId } = app;
    await seedActivePolicies(app);
    await policies.evaluatePolicy(owner, {
      tenantId,
      policyKey: 'billing.refund',
      action: 'side-effect:refund.issue',
      attributes: { amount: 120, channel: 'web' },
      idempotencyKey: 'intent-live-conflict',
    });
    await assert.rejects(
      policies.evaluatePolicy(owner, {
        tenantId,
        policyKey: 'billing.refund',
        action: 'side-effect:refund.issue',
        attributes: { amount: 999, channel: 'web' },
        idempotencyKey: 'intent-live-conflict',
      }),
      isPolicyError('DECISION_INPUT_CONFLICT'),
    );
  } finally {
    await app.pool.end();
    await app.live.drop();
  }
});
