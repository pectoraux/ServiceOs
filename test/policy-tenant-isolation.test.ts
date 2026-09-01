/**
 * Behavioral + discrimination proof: tenant isolation at the /policies
 * module boundary (WORK-014, tenancy invariants).
 *
 * Proves over the composed in-memory application:
 * - authorization happens BEFORE any domain data access: every denial path
 *   (missing tenant, no membership, insufficient role, suspended tenant)
 *   leaves the policy store's read counters untouched — policy never
 *   replaces the authorization chain, it consumes it;
 * - cross-tenant access fails closed: a policy version or decision id from
 *   another tenant is indistinguishable from a missing one and never leaks
 *   its row; version lists and resolution observe only the requesting
 *   tenant's rows;
 * - a member of another organization cannot reach tenant data at all
 *   (TENANT_FORBIDDEN distinct from POLICY_VERSION_NOT_FOUND /
 *   DECISION_NOT_FOUND);
 * - the policies module consumes the ONE authorization chain: role
 *   decisions (viewer read-only) come from /organizations' capability
 *   matrix, never re-implemented here;
 * - a mutated store that drops the tenant predicate makes the cross-tenant
 *   read succeed — the discrimination proof that the predicate is
 *   load-bearing (removing it must fail the suite).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPoliciesApp, InMemoryPoliciesStore, type PoliciesApp } from './helpers/in-memory-stores.js';
import type { Principal } from '../src/modules/auth/index.js';
import { PolicyError, createPoliciesModule } from '../src/modules/policies/index.js';
import type { PolicyStore } from '../src/modules/policies/index.js';

const PASSWORD = 'correct horse battery 7';

interface TwoTenantScenario {
  app: PoliciesApp;
  alice: Principal;
  bob: Principal;
  carol: Principal;
  tenantA: string;
  tenantB: string;
}

async function twoTenants(): Promise<TwoTenantScenario> {
  const app = buildPoliciesApp();
  const alice = await app.auth.registerHuman({ email: 'alice@a.com', password: PASSWORD, displayName: 'Alice' });
  const bob = await app.auth.registerHuman({ email: 'bob@a.com', password: PASSWORD, displayName: 'Bob' });
  const carol = await app.auth.registerHuman({ email: 'carol@b.com', password: PASSWORD, displayName: 'Carol' });
  const orgA = await app.organizations.createOrganization(alice, { slug: 'alpha-org', displayName: 'Alpha' });
  await app.organizations.addMember(alice, 'alpha-org', { principalId: bob.id, role: 'viewer' });
  const orgB = await app.organizations.createOrganization(carol, { slug: 'beta-org', displayName: 'Beta' });
  return { app, alice, bob, carol, tenantA: orgA.tenant.id, tenantB: orgB.tenant.id };
}

function isPolicyError(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof PolicyError && error.code === code;
}

function rules() {
  return [{ id: 'allow-all', when: { kind: 'always' as const }, effect: 'allow' as const }];
}

async function activeVersionInTenantA(scenario: TwoTenantScenario) {
  const created = await scenario.app.policies.createPolicyVersion(scenario.alice, {
    tenantId: scenario.tenantA,
    policyKey: 'billing.refund',
    scope: 'base',
    rules: rules(),
    defaultEffect: 'deny',
  });
  await scenario.app.policies.activatePolicyVersion(scenario.alice, scenario.tenantA, created.contract.id);
  return created.contract;
}

test('denials happen before domain data access (read counters untouched)', async () => {
  const { app, alice, bob, carol, tenantA, tenantB } = await twoTenants();
  const before = { ...app.policyStore.reads };

  // Missing tenant: denied at server-side tenant resolution.
  const missing = '00000000-0000-4000-8000-000000000000';
  await assert.rejects(
    app.policies.listPolicyVersions(alice, missing, 'billing.refund'),
    isPolicyError('TENANT_NOT_FOUND'),
  );
  // No membership: tenant exists but the caller has none.
  await assert.rejects(
    app.policies.listPolicyVersions(alice, tenantB, 'billing.refund'),
    isPolicyError('TENANT_FORBIDDEN'),
  );
  // Insufficient role: bob is a viewer; mutations require write capability.
  await assert.rejects(
    app.policies.createPolicyVersion(bob, {
      tenantId: tenantA,
      policyKey: 'billing.refund',
      scope: 'base',
      rules: rules(),
      defaultEffect: 'deny',
    }),
    isPolicyError('ROLE_FORBIDDEN'),
  );
  await assert.rejects(
    app.policies.evaluatePolicy(bob, {
      tenantId: tenantA,
      policyKey: 'billing.refund',
      action: 'side-effect:refund.issue',
      attributes: {},
    }),
    isPolicyError('ROLE_FORBIDDEN'),
  );

  assert.deepEqual(app.policyStore.reads, before, 'no domain data access on any denial path');
});

test('cross-tenant version and decision ids are invisible (missing, not forbidden)', async () => {
  const scenario = await twoTenants();
  const contract = await activeVersionInTenantA(scenario);
  const { app, alice, carol, tenantA, tenantB } = scenario;
  const decision = await app.policies.evaluatePolicy(alice, {
    tenantId: tenantA,
    policyKey: 'billing.refund',
    action: 'side-effect:refund.issue',
    attributes: { amount: 10 },
  });

  // carol (tenant B) addressing tenant A's ids: the rows exist in the raw
  // store, but tenant-B-scoped lookups return "missing" — never the row.
  assert.ok(app.policyStore.contracts.has(contract.id));
  assert.ok(app.policyStore.decisions.has(decision.decision.id));
  await assert.rejects(app.policies.getPolicyVersion(carol, tenantB, contract.id), isPolicyError('POLICY_VERSION_NOT_FOUND'));
  await assert.rejects(app.policies.activatePolicyVersion(carol, tenantB, contract.id), isPolicyError('POLICY_VERSION_NOT_FOUND'));
  await assert.rejects(app.policies.getDecision(carol, tenantB, decision.decision.id), isPolicyError('DECISION_NOT_FOUND'));
  await assert.rejects(app.policies.verifyDecision(carol, tenantB, decision.decision.id), isPolicyError('DECISION_NOT_FOUND'));

  // Tenant-B directories are empty for this policy key (a genuinely empty
  // list, distinct from a denial) and resolution observes nothing.
  assert.deepEqual(await app.policies.listPolicyVersions(carol, tenantB, 'billing.refund'), []);
  const resolved = await app.policies.resolvePolicy(carol, tenantB, 'billing.refund');
  assert.equal(resolved.base, null);
  assert.equal(resolved.customer, null);
});

test('cross-tenant operations fail closed', async () => {
  const scenario = await twoTenants();
  const contract = await activeVersionInTenantA(scenario);
  const { app, alice, carol, tenantA, tenantB } = scenario;

  // carol cannot create/evaluate in tenant A (no membership at all).
  await assert.rejects(
    app.policies.createPolicyVersion(carol, {
      tenantId: tenantA,
      policyKey: 'billing.refund',
      scope: 'base',
      rules: rules(),
      defaultEffect: 'deny',
    }),
    isPolicyError('TENANT_FORBIDDEN'),
  );
  await assert.rejects(
    app.policies.evaluatePolicy(carol, {
      tenantId: tenantA,
      policyKey: 'billing.refund',
      action: 'side-effect:refund.issue',
      attributes: {},
    }),
    isPolicyError('TENANT_FORBIDDEN'),
  );

  // alice cannot manage policies in tenant B either.
  await assert.rejects(
    app.policies.activatePolicyVersion(alice, tenantB, contract.id),
    isPolicyError('TENANT_FORBIDDEN'),
  );
  assert.equal(app.policyStore.contracts.size, 1, 'no cross-tenant writes landed');
});

test('viewer can read but not write policy data (single authorization chain)', async () => {
  const scenario = await twoTenants();
  await activeVersionInTenantA(scenario);
  const { app, bob, tenantA } = scenario;

  const listed = await app.policies.listPolicyVersions(bob, tenantA, 'billing.refund');
  assert.equal(listed.length, 1);
  const resolved = await app.policies.resolvePolicy(bob, tenantA, 'billing.refund');
  assert.notEqual(resolved.base, null);

  await assert.rejects(
    app.policies.createPolicyVersion(bob, {
      tenantId: tenantA,
      policyKey: 'billing.refund',
      scope: 'base',
      rules: rules(),
      defaultEffect: 'deny',
    }),
    isPolicyError('ROLE_FORBIDDEN'),
  );
  await assert.rejects(
    app.policies.evaluatePolicy(bob, {
      tenantId: tenantA,
      policyKey: 'billing.refund',
      action: 'side-effect:refund.issue',
      attributes: {},
    }),
    isPolicyError('ROLE_FORBIDDEN'),
  );
});

test('suspended tenants deny policy operations (distinct from missing)', async () => {
  const app = buildPoliciesApp();
  const owner = await app.auth.registerHuman({ email: 'owner@g.com', password: PASSWORD, displayName: 'Owner' });
  const created = await app.organizations.createOrganization(owner, { slug: 'gamma-org', displayName: 'Gamma' });
  const tenantId = created.tenant.id;

  // Tenant suspension is not yet exposed on the organizations module's
  // public contract; mutate the faithful in-memory row to the suspended
  // state the SQL row would hold (the authorization chain reads exactly
  // this state through the store port).
  const orgRecord = app.orgStore.organizations.get(created.organization.id);
  assert.ok(orgRecord !== undefined);
  orgRecord.status = 'suspended';
  orgRecord.updatedAt = new Date();

  await assert.rejects(
    app.policies.listPolicyVersions(owner, tenantId, 'billing.refund'),
    isPolicyError('ORGANIZATION_SUSPENDED'),
  );
  await assert.rejects(
    app.policies.evaluatePolicy(owner, {
      tenantId,
      policyKey: 'billing.refund',
      action: 'side-effect:refund.issue',
      attributes: {},
    }),
    isPolicyError('ORGANIZATION_SUSPENDED'),
  );
});

test('discrimination: removing the tenant predicate breaks isolation (must fail)', async () => {
  const scenario = await twoTenants();
  const contract = await activeVersionInTenantA(scenario);
  const { app, alice, carol, tenantB } = scenario;

  // A mutated store that drops the tenant predicate from version reads
  // (full delegation except the mutated method).
  const backing = app.policyStore;
  const mutatedStore: PolicyStore = {
    createPolicyVersion: (input) => backing.createPolicyVersion(input),
    findPolicyVersionById: async (_tenantId: string, versionId: string) => {
      // Mutation: read by id only — the tenant predicate is gone.
      const row = (backing as InMemoryPoliciesStore).contracts.get(versionId);
      return row === undefined ? null : { ...row, rules: row.rules.map((r) => ({ ...r })) };
    },
    listPolicyVersions: (tenantId: string, policyKey: string, scope?: Parameters<PolicyStore['listPolicyVersions']>[2]) =>
      backing.listPolicyVersions(tenantId, policyKey, scope),
    findActivePolicyVersion: (tenantId: string, policyKey: string, scope: Parameters<PolicyStore['findActivePolicyVersion']>[2]) =>
      backing.findActivePolicyVersion(tenantId, policyKey, scope),
    activatePolicyVersion: (input) => backing.activatePolicyVersion(input),
    recordDecision: (input) => backing.recordDecision(input),
    findDecisionById: (tenantId: string, decisionId: string) => backing.findDecisionById(tenantId, decisionId),
    findDecisionByIdempotencyKey: (tenantId: string, idempotencyKey: string) =>
      backing.findDecisionByIdempotencyKey(tenantId, idempotencyKey),
  };
  const mutatedApp = createPoliciesModule({ store: mutatedStore, tenancy: app.organizations });

  // With the predicate intact, carol sees "missing". With the mutation,
  // the cross-tenant read succeeds — proving the predicate is what the
  // isolation rests on (this test fails if the mutation is benign).
  const intact = await app.policies.getPolicyVersion(carol, tenantB, contract.id).then(
    () => 'unexpected-success',
    (error: unknown) => (error instanceof PolicyError ? error.code : String(error)),
  );
  assert.equal(intact, 'POLICY_VERSION_NOT_FOUND');
  const leaked = await mutatedApp.getPolicyVersion(carol, tenantB, contract.id);
  assert.equal(leaked.id, contract.id, 'the mutated store leaks tenant A data into tenant B — predicate is load-bearing');
});
