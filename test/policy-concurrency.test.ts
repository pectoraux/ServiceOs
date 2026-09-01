/**
 * Concurrency proof: policy creation convergence, activation serialization
 * and decision-record convergence under interleaving (WORK-014, CRITICAL).
 *
 * The in-memory store's async hooks inject deterministic interleaving
 * points BEFORE each synchronous critical section (the exact semantics of
 * the locked SQL transaction), so these proofs exercise real
 * check-then-act races:
 *
 * - two actors creating the same logical policy version (tenant +
 *   idempotency key) converge on one durable identity — never two rows
 *   (Work Order: "concurrent creation/resolution of the same policy
 *   identity converges");
 * - concurrent activations of the SAME version converge (one activation
 *   observed, exactly one active version at rest);
 * - concurrent activations of DIFFERENT versions of one identity leave
 *   exactly one active version — retirement-then-activation is atomic;
 * - concurrent evaluations of the same gated decision (idempotency key)
 *   converge on ONE durable decision record;
 * - a decision that resolves while a NEW version is being activated pins
 *   the versions it actually consulted — provenance stays truthful (AC-5);
 * - concurrent same-key evaluations with DIVERGENT inputs: exactly one
 *   wins, the loser fails closed with DECISION_INPUT_CONFLICT (the gate
 *   can never be re-pointed by a race).
 *
 * The SQL-level equivalents of the same races run against live PostgreSQL
 * in test/policies.integration.test.ts (CI).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPoliciesApp, type PoliciesApp } from './helpers/in-memory-stores.js';
import type { Principal } from '../src/modules/auth/index.js';
import { PolicyError } from '../src/modules/policies/index.js';

const PASSWORD = 'correct horse battery 7';

interface Base {
  app: PoliciesApp;
  owner: Principal;
  colleague: Principal;
  tenantId: string;
}

async function base(): Promise<Base> {
  const app = buildPoliciesApp();
  const owner = await app.auth.registerHuman({ email: 'owner@a.com', password: PASSWORD, displayName: 'Owner' });
  const colleague = await app.auth.registerHuman({ email: 'member@a.com', password: PASSWORD, displayName: 'Member' });
  const created = await app.organizations.createOrganization(owner, { slug: 'alpha-org', displayName: 'Alpha' });
  await app.organizations.addMember(owner, 'alpha-org', { principalId: colleague.id, role: 'member' });
  return { app, owner, colleague, tenantId: created.tenant.id };
}

function rules(effect: 'allow' | 'deny') {
  return [{ id: `rule-${effect}`, when: { kind: 'always' as const }, effect }];
}

async function draft(app: PoliciesApp, actor: Principal, tenantId: string, key: string, effect: 'allow' | 'deny') {
  return app.policies.createPolicyVersion(actor, {
    tenantId,
    policyKey: 'billing.refund',
    scope: 'base',
    rules: rules(effect),
    defaultEffect: effect,
    idempotencyKey: key,
  });
}

test('two actors creating the same logical policy version converge (independent actors)', async () => {
  const { app, owner, colleague, tenantId } = await base();
  const [a, b] = await Promise.all([
    draft(app, owner, tenantId, 'catalog-sync-7', 'deny'),
    draft(app, colleague, tenantId, 'catalog-sync-7', 'deny'),
  ]);
  assert.equal(a.contract.id, b.contract.id);
  const exactlyOne = (a.converged ? 1 : 0) + (b.converged ? 1 : 0);
  assert.equal(exactlyOne, 1, 'exactly one creator observed convergence');
  assert.equal(app.policyStore.contracts.size, 1);
});

test('concurrent same-key creations interleave at the race point and still converge', async () => {
  // Deterministic interleaving: both actors pass the async hook before
  // either critical section runs (the check-then-insert race), exactly as
  // two in-flight SQL INSERTs against the partial unique index.
  const { app, owner, colleague, tenantId } = await base();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  app.policyStore.options.beforeCreatePolicyVersion = async () => {
    await gate;
  };
  const pending = [
    draft(app, owner, tenantId, 'catalog-sync-8', 'deny'),
    draft(app, colleague, tenantId, 'catalog-sync-8', 'deny'),
  ];
  release();
  const [a, b] = await Promise.all(pending);
  assert.equal(a.contract.id, b.contract.id);
  assert.equal(app.policyStore.contracts.size, 1);
});

test('concurrent activations of the same version converge; one active at rest', async () => {
  const { app, owner, colleague, tenantId } = await base();
  const created = await draft(app, owner, tenantId, 'v1-key', 'deny');
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  app.policyStore.options.beforeActivatePolicyVersion = async () => {
    await gate;
  };
  const pending = [
    app.policies.activatePolicyVersion(owner, tenantId, created.contract.id),
    app.policies.activatePolicyVersion(colleague, tenantId, created.contract.id),
  ];
  release();
  const [a, b] = await Promise.all(pending);
  assert.equal(a.contract.id, created.contract.id);
  assert.equal(b.contract.id, created.contract.id);
  assert.equal(a.contract.status, 'active');
  assert.equal(b.contract.status, 'active');
  const exactlyOne = (a.converged ? 1 : 0) + (b.converged ? 1 : 0);
  assert.equal(exactlyOne, 1, 'exactly one activation was observed as new');
  // Exactly one active version of the identity exists at rest.
  const resolved = await app.policies.resolvePolicy(owner, tenantId, 'billing.refund');
  assert.equal(resolved.base?.id, created.contract.id);
});

test('concurrent activations of different versions leave exactly one active version', async () => {
  const { app, owner, colleague, tenantId } = await base();
  const v1 = await draft(app, owner, tenantId, 'v1-key', 'deny');
  const v2 = await app.policies.createPolicyVersion(owner, {
    tenantId,
    policyKey: 'billing.refund',
    scope: 'base',
    rules: rules('allow'),
    defaultEffect: 'allow',
  });
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  app.policyStore.options.beforeActivatePolicyVersion = async () => {
    await gate;
  };
  const pending = [
    app.policies.activatePolicyVersion(owner, tenantId, v1.contract.id),
    app.policies.activatePolicyVersion(colleague, tenantId, v2.contract.id),
  ];
  release();
  const [a, b] = await Promise.all(pending);
  assert.equal(a.contract.status, 'active');
  assert.equal(b.contract.status, 'active');
  // Exactly one active version at rest; the loser was retired by the
  // winner's atomic retirement-then-activation.
  let activeCount = 0;
  let retiredCount = 0;
  for (const contract of app.policyStore.contracts.values()) {
    if (contract.policyKey === 'billing.refund' && contract.scope === 'base') {
      if (contract.status === 'active') activeCount += 1;
      if (contract.status === 'retired') retiredCount += 1;
    }
  }
  assert.equal(activeCount, 1);
  assert.equal(retiredCount, 1);
  // No version was lost and no phantom drafts remain.
  assert.equal(activeCount + retiredCount, 2);
});

test('concurrent evaluations of the same gated decision converge on one record', async () => {
  const { app, owner, colleague, tenantId } = await base();
  const created = await draft(app, owner, tenantId, 'v1-key', 'allow');
  await app.policies.activatePolicyVersion(owner, tenantId, created.contract.id);
  const input = {
    tenantId,
    policyKey: 'billing.refund',
    action: 'side-effect:refund.issue',
    attributes: { amount: 120, channel: 'web' },
    idempotencyKey: 'intent-91',
  };
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  app.policyStore.options.beforeRecordDecision = async () => {
    await gate;
  };
  const pending = [app.policies.evaluatePolicy(owner, input), app.policies.evaluatePolicy(colleague, input)];
  release();
  const [a, b] = await Promise.all(pending);
  assert.equal(a.decision.id, b.decision.id);
  assert.equal(a.decision.outcome, b.decision.outcome);
  const exactlyOne = (a.converged ? 1 : 0) + (b.converged ? 1 : 0);
  assert.equal(exactlyOne, 1, 'exactly one evaluation was observed as new');
  assert.equal(app.policyStore.decisions.size, 1);
});

test('a decision resolving while a new version activates pins what it consulted (truthful provenance)', async () => {
  const { app, owner, colleague, tenantId } = await base();
  const v1 = await draft(app, owner, tenantId, 'v1-key', 'deny');
  await app.policies.activatePolicyVersion(owner, tenantId, v1.contract.id);
  const v2 = await app.policies.createPolicyVersion(owner, {
    tenantId,
    policyKey: 'billing.refund',
    scope: 'base',
    rules: rules('allow'),
    defaultEffect: 'allow',
  });

  // The decision resolves v1 (active), then — before its record is
  // persisted — a colleague activates v2. The decision must pin v1 (what
  // it consulted) and remain verifiable: provenance is truthful, not
  // retroactive.
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  app.policyStore.options.beforeRecordDecision = async () => {
    app.policyStore.options.beforeRecordDecision = undefined;
    await app.policies.activatePolicyVersion(colleague, tenantId, v2.contract.id);
    await gate;
  };
  const pending = app.policies.evaluatePolicy(owner, {
    tenantId,
    policyKey: 'billing.refund',
    action: 'side-effect:refund.issue',
    attributes: { amount: 120, channel: 'web' },
  });
  release();
  const { decision } = await pending;
  const baseLayer = decision.layers.find((l) => l.layer === 'base');
  assert.equal(baseLayer?.policyId, v1.contract.id, 'the decision pins the version it consulted');
  assert.equal(baseLayer?.version, v1.contract.version);

  // The record is internally consistent and verifies by replay (replay
  // reads the PINNED version row, which is immutable in content).
  const verified = await app.policies.verifyDecision(owner, tenantId, decision.id);
  assert.equal(verified.outcome, decision.outcome);

  // Resolution now observes v2 for FUTURE decisions.
  const resolved = await app.policies.resolvePolicy(owner, tenantId, 'billing.refund');
  assert.equal(resolved.base?.id, v2.contract.id);
});

test('racing divergent inputs on one decision key: exactly one wins, the other fails closed', async () => {
  const { app, owner, colleague, tenantId } = await base();
  const created = await draft(app, owner, tenantId, 'v1-key', 'allow');
  await app.policies.activatePolicyVersion(owner, tenantId, created.contract.id);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  app.policyStore.options.beforeRecordDecision = async () => {
    await gate;
  };
  const pending = [
    app.policies
      .evaluatePolicy(owner, {
        tenantId,
        policyKey: 'billing.refund',
        action: 'side-effect:refund.issue',
        attributes: { amount: 120, channel: 'web' },
        idempotencyKey: 'intent-divergent',
      })
      .catch((error: unknown) => error),
    app.policies
      .evaluatePolicy(colleague, {
        tenantId,
        policyKey: 'billing.refund',
        action: 'side-effect:refund.issue',
        attributes: { amount: 999, channel: 'web' },
        idempotencyKey: 'intent-divergent',
      })
      .catch((error: unknown) => error),
  ];
  release();
  const [a, b] = await Promise.all(pending);
  const outcomes = [a, b];
  const winners = outcomes.filter((o) => !(o instanceof Error));
  const losers = outcomes.filter((o) => o instanceof Error);
  assert.equal(winners.length, 1, 'exactly one divergent input won the race');
  assert.equal(losers.length, 1, 'exactly one failed closed');
  const loser = losers[0] as PolicyError;
  assert.ok(loser instanceof PolicyError);
  assert.equal(loser.code, 'DECISION_INPUT_CONFLICT');
  assert.equal(app.policyStore.decisions.size, 1);
});
