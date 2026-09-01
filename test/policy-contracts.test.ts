/**
 * Behavioral proof: policy contract versioning, activation, resolution and
 * input validation (WORK-014, dynamic class).
 *
 * Proves the module contract over a faithful in-memory store:
 * - createPolicyVersion: durable tenant-bound identity with scope,
 *   monotonic per-identity version numbering, actor provenance and
 *   timestamps (AC-1); idempotent creation by logical key converges;
 * - activation: draft -> active, forward-only; activating a new version
 *   retires the prior active version of the same identity atomically;
 *   activating the already-active version converges; a retired version can
 *   never return;
 * - resolution: resolvePolicy returns the active base and customer
 *   contracts for one (tenant, policy key) plus the frozen revision;
 * - validation: malformed contracts fail closed with typed INVALID_INPUT.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPoliciesApp, type PoliciesApp } from './helpers/in-memory-stores.js';
import type { Principal } from '../src/modules/auth/index.js';
import { PolicyError, type PolicyRule } from '../src/modules/policies/index.js';

const PASSWORD = 'correct horse battery 7';

interface Scenario {
  app: PoliciesApp;
  owner: Principal;
  member: Principal;
  viewer: Principal;
  tenantId: string;
}

async function scenario(): Promise<Scenario> {
  const app = buildPoliciesApp();
  const owner = await app.auth.registerHuman({ email: 'owner@a.com', password: PASSWORD, displayName: 'Owner' });
  const member = await app.auth.registerHuman({ email: 'member@a.com', password: PASSWORD, displayName: 'Member' });
  const viewer = await app.auth.registerHuman({ email: 'viewer@a.com', password: PASSWORD, displayName: 'Viewer' });
  const created = await app.organizations.createOrganization(owner, { slug: 'alpha-org', displayName: 'Alpha' });
  await app.organizations.addMember(owner, 'alpha-org', { principalId: member.id, role: 'member' });
  await app.organizations.addMember(owner, 'alpha-org', { principalId: viewer.id, role: 'viewer' });
  return { app, owner, member, viewer, tenantId: created.tenant.id };
}

function baseRules() {
  return [
    {
      id: 'deny-large-refunds',
      when: { kind: 'attribute', name: 'amount', operator: 'gt', value: 500 },
      effect: 'deny',
    },
    {
      id: 'allow-default-channel',
      when: { kind: 'attribute', name: 'channel', operator: 'eq', value: 'web' },
      effect: 'allow',
    },
  ] as const;
}

function expectPolicyError(code: string, fn: () => Promise<unknown>): Promise<PolicyError> {
  return (async () => {
    try {
      await fn();
    } catch (error) {
      assert.ok(error instanceof PolicyError, `expected PolicyError, got ${String(error)}`);
      assert.equal(error.code, code);
      return error;
    }
    throw new Error(`expected PolicyError ${code}, but the call succeeded`);
  })();
}

test('createPolicyVersion persists a durable tenant-bound draft identity (AC-1)', async () => {
  const { app, owner, tenantId } = await scenario();
  const { contract, converged } = await app.policies.createPolicyVersion(owner, {
    tenantId,
    policyKey: 'billing.refund-threshold',
    scope: 'base',
    rules: baseRules(),
    defaultEffect: 'deny',
  });
  assert.equal(converged, false);
  assert.ok(UUID(contract.id));
  assert.equal(contract.tenantId, tenantId);
  assert.equal(contract.policyKey, 'billing.refund-threshold');
  assert.equal(contract.scope, 'base');
  assert.equal(contract.version, 1);
  assert.equal(contract.status, 'draft');
  assert.equal(contract.defaultEffect, 'deny');
  assert.equal(contract.rules.length, 2);
  assert.equal(contract.rules[0]?.id, 'deny-large-refunds');
  assert.equal(contract.createdBy, owner.id);
  assert.ok(contract.createdAt instanceof Date);

  const read = await app.policies.getPolicyVersion(owner, tenantId, contract.id);
  assert.deepEqual(
    { ...read, createdAt: read.createdAt.getTime() },
    { ...contract, createdAt: contract.createdAt.getTime() },
  );
});

test('version numbers are monotonic per (tenant, policy key, scope) and independent per scope', async () => {
  const { app, owner, tenantId } = await scenario();
  const first = await app.policies.createPolicyVersion(owner, {
    tenantId,
    policyKey: 'billing.refund-threshold',
    scope: 'base',
    rules: baseRules(),
    defaultEffect: 'deny',
  });
  const second = await app.policies.createPolicyVersion(owner, {
    tenantId,
    policyKey: 'billing.refund-threshold',
    scope: 'base',
    rules: baseRules(),
    defaultEffect: 'allow',
  });
  const customerScoped = await app.policies.createPolicyVersion(owner, {
    tenantId,
    policyKey: 'billing.refund-threshold',
    scope: 'customer',
    rules: baseRules(),
    defaultEffect: 'deny',
  });
  assert.equal(first.contract.version, 1);
  assert.equal(second.contract.version, 2);
  assert.equal(customerScoped.contract.version, 1, 'scope is part of the versioning identity');

  const listed = await app.policies.listPolicyVersions(owner, tenantId, 'billing.refund-threshold');
  assert.equal(listed.length, 3);
  const baseOnly = await app.policies.listPolicyVersions(owner, tenantId, 'billing.refund-threshold', 'base');
  assert.deepEqual(
    baseOnly.map((c) => c.version),
    [1, 2],
  );
});

test('createPolicyVersion converges on the durable identity for the same logical creation', async () => {
  const { app, owner, tenantId } = await scenario();
  const first = await app.policies.createPolicyVersion(owner, {
    tenantId,
    policyKey: 'compliance.export-approval',
    scope: 'base',
    rules: baseRules(),
    defaultEffect: 'deny',
    idempotencyKey: 'catalog-sync-42',
  });
  const second = await app.policies.createPolicyVersion(owner, {
    tenantId,
    policyKey: 'compliance.export-approval',
    scope: 'base',
    rules: baseRules(),
    defaultEffect: 'deny',
    idempotencyKey: 'catalog-sync-42',
  });
  assert.equal(first.contract.id, second.contract.id);
  assert.equal(second.converged, true);
  assert.equal(first.converged, false);
  assert.equal(app.policyStore.contracts.size, 1);
});

test('activation moves publication forward and retires the prior active version', async () => {
  const { app, owner, tenantId } = await scenario();
  const v1 = await app.policies.createPolicyVersion(owner, {
    tenantId,
    policyKey: 'billing.refund-threshold',
    scope: 'base',
    rules: baseRules(),
    defaultEffect: 'deny',
  });
  const activated = await app.policies.activatePolicyVersion(owner, tenantId, v1.contract.id);
  assert.equal(activated.contract.status, 'active');
  assert.equal(activated.converged, false);

  // Resolution observes the active version.
  const resolved = await app.policies.resolvePolicy(owner, tenantId, 'billing.refund-threshold');
  assert.equal(resolved.base?.id, v1.contract.id);
  assert.equal(resolved.base?.version, 1);
  assert.equal(resolved.customer, null);
  assert.equal(resolved.frozenRevision, 'frozen-v1.0');

  // Re-activating the active version converges.
  const again = await app.policies.activatePolicyVersion(owner, tenantId, v1.contract.id);
  assert.equal(again.converged, true);
  assert.equal(again.contract.status, 'active');

  // A new version retires the prior one atomically.
  const v2 = await app.policies.createPolicyVersion(owner, {
    tenantId,
    policyKey: 'billing.refund-threshold',
    scope: 'base',
    rules: baseRules(),
    defaultEffect: 'allow',
  });
  const activatedV2 = await app.policies.activatePolicyVersion(owner, tenantId, v2.contract.id);
  assert.equal(activatedV2.contract.status, 'active');
  const v1After = await app.policies.getPolicyVersion(owner, tenantId, v1.contract.id);
  assert.equal(v1After.status, 'retired');
  const resolved2 = await app.policies.resolvePolicy(owner, tenantId, 'billing.refund-threshold');
  assert.equal(resolved2.base?.id, v2.contract.id);

  // Forward-only: the retired version can never return.
  await expectPolicyError('VERSION_RETIRED', () => app.policies.activatePolicyVersion(owner, tenantId, v1.contract.id));
});

test('activation is scoped to the same (tenant, policy key, scope) identity', async () => {
  const { app, owner, tenantId } = await scenario();
  const baseVersion = await app.policies.createPolicyVersion(owner, {
    tenantId,
    policyKey: 'billing.refund-threshold',
    scope: 'base',
    rules: baseRules(),
    defaultEffect: 'deny',
  });
  await app.policies.activatePolicyVersion(owner, tenantId, baseVersion.contract.id);
  // Activating a customer override does not retire the base policy: the
  // one-active partial unique index is per (tenant, key, scope).
  const customerVersion = await app.policies.createPolicyVersion(owner, {
    tenantId,
    policyKey: 'billing.refund-threshold',
    scope: 'customer',
    rules: baseRules(),
    defaultEffect: 'deny',
  });
  await app.policies.activatePolicyVersion(owner, tenantId, customerVersion.contract.id);
  const resolved = await app.policies.resolvePolicy(owner, tenantId, 'billing.refund-threshold');
  assert.equal(resolved.base?.id, baseVersion.contract.id);
  assert.equal(resolved.customer?.id, customerVersion.contract.id);
});

test('malformed contracts fail closed with typed INVALID_INPUT', async () => {
  const { app, owner, tenantId } = await scenario();
  const input: {
    tenantId: string;
    policyKey: string;
    scope: 'base';
    rules: readonly PolicyRule[];
    defaultEffect: 'deny';
  } = { tenantId, policyKey: 'k', scope: 'base', rules: baseRules(), defaultEffect: 'deny' };

  await expectPolicyError('INVALID_INPUT', () =>
    app.policies.createPolicyVersion(owner, { ...input, policyKey: '' }),
  );
  await expectPolicyError('INVALID_INPUT', () =>
    app.policies.createPolicyVersion(owner, { ...input, scope: 'vertical' as 'base' }),
  );
  await expectPolicyError('INVALID_INPUT', () =>
    app.policies.createPolicyVersion(owner, { ...input, defaultEffect: 'maybe' as 'deny' }),
  );
  await expectPolicyError('INVALID_INPUT', () =>
    app.policies.createPolicyVersion(owner, { ...input, rules: [] }),
  );
  // Duplicate rule ids break decision provenance and are rejected.
  await expectPolicyError('INVALID_INPUT', () =>
    app.policies.createPolicyVersion(owner, {
      ...input,
      rules: [
        { id: 'same', when: { kind: 'always' }, effect: 'allow' },
        { id: 'same', when: { kind: 'always' }, effect: 'deny' },
      ],
    }),
  );
  // Unknown operators and typed operator/value mismatches are rejected.
  await expectPolicyError('INVALID_INPUT', () =>
    app.policies.createPolicyVersion(owner, {
      ...input,
      rules: [{ id: 'r', when: { kind: 'attribute', name: 'x', operator: 'regex' as 'eq', value: 'y' }, effect: 'allow' }] as unknown as readonly PolicyRule[],
    }),
  );
  await expectPolicyError('INVALID_INPUT', () =>
    app.policies.createPolicyVersion(owner, {
      ...input,
      rules: [{ id: 'r', when: { kind: 'attribute', name: 'x', operator: 'gt', value: 'not-a-number' as unknown as number }, effect: 'allow' }] as unknown as readonly PolicyRule[],
    }),
  );
  await expectPolicyError('INVALID_INPUT', () =>
    app.policies.createPolicyVersion(owner, {
      ...input,
      rules: [{ id: 'r', when: { kind: 'attribute', name: 'x', operator: 'eq', value: { nested: true } as unknown as string }, effect: 'allow' }] as unknown as readonly PolicyRule[],
    }),
  );
  await expectPolicyError('INVALID_INPUT', () =>
    app.policies.createPolicyVersion(owner, { ...input, idempotencyKey: '' }),
  );
  // Nothing was persisted by any rejected call.
  assert.equal(app.policyStore.contracts.size, 0);
});

test('unknown versions fail closed (POLICY_VERSION_NOT_FOUND)', async () => {
  const { app, owner, tenantId } = await scenario();
  const missing = '00000000-0000-4000-8000-000000000000';
  await expectPolicyError('POLICY_VERSION_NOT_FOUND', () => app.policies.getPolicyVersion(owner, tenantId, missing));
  await expectPolicyError('POLICY_VERSION_NOT_FOUND', () => app.policies.activatePolicyVersion(owner, tenantId, missing));
});

function UUID(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
