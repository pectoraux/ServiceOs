/**
 * Behavioral proof: deterministic policy evaluation, override precedence,
 * frozen-invariant protection, decision provenance and mutation detection
 * (WORK-014, dynamic + discrimination classes).
 *
 * Proves over a faithful in-memory store:
 * - allow/deny cases: first matching rule decides; default effect applies
 *   when no rule matches; missing attributes never match (AC-2);
 * - determinism: the same inputs produce the same decision — repeatedly,
 *   and with attribute order shuffled (identical canonical input hash);
 * - frozen floor: inputs naming a frozen-denied capability are DENIED with
 *   the frozen layer deciding, even when every data layer allows (AC-3);
 * - override precedence: a customer deny tightens a base allow; a customer
 *   allow cannot weaken a base deny (provenance records the base layer);
 *   allow requires an active base policy (fail closed) (AC-3);
 * - provenance: every decision pins the policy id/version each layer
 *   consulted, the frozen revision, the input snapshot, its input hash, the
 *   actor and the record integrity hash (AC-5);
 * - idempotent decisions: same key + same input converge; same key +
 *   different input fails closed (typed DECISION_INPUT_CONFLICT);
 * - mutation detection: an after-the-fact change to a recorded decision is
 *   detected on read (typed DECISION_RECORD_TAMPERED), and verifyDecision
 *   replays the pinned versions against the pinned input (DECISION_
 *   REPLAY_MISMATCH when rule content was tampered);
 * - typed evaluation errors: ordered comparisons on non-number attributes
 *   fail closed instead of guessing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPoliciesApp, type PoliciesApp } from './helpers/in-memory-stores.js';
import type { Principal } from '../src/modules/auth/index.js';
import { PolicyError, FROZEN_POLICY_REVISION, type PolicyRule } from '../src/modules/policies/index.js';
import {
  evaluateLayer,
  evaluateFrozenFloor,
  composeDecision,
  hashPolicyInput,
} from '../src/modules/policies/index.js';

const PASSWORD = 'correct horse battery 7';

interface Scenario {
  app: PoliciesApp;
  owner: Principal;
  tenantId: string;
}

async function scenario(): Promise<Scenario> {
  const app = buildPoliciesApp();
  const owner = await app.auth.registerHuman({ email: 'owner@a.com', password: PASSWORD, displayName: 'Owner' });
  const created = await app.organizations.createOrganization(owner, { slug: 'alpha-org', displayName: 'Alpha' });
  return { app, owner, tenantId: created.tenant.id };
}

/** Base policy: allow refunds up to 500 on the web channel; deny otherwise by default. */
function refundBaseRules() {
  return [
    { id: 'deny-large', when: { kind: 'attribute' as const, name: 'amount', operator: 'gt' as const, value: 500 }, effect: 'deny' as const },
    { id: 'allow-web', when: { kind: 'attribute' as const, name: 'channel', operator: 'eq' as const, value: 'web' }, effect: 'allow' as const },
  ];
}

async function activatedBase(app: PoliciesApp, owner: Principal, tenantId: string, rules: readonly PolicyRule[], defaultEffect: 'allow' | 'deny') {
  const created = await app.policies.createPolicyVersion(owner, { tenantId, policyKey: 'billing.refund', scope: 'base', rules, defaultEffect });
  await app.policies.activatePolicyVersion(owner, tenantId, created.contract.id);
  return created.contract;
}

async function activatedCustomer(app: PoliciesApp, owner: Principal, tenantId: string, rules: readonly PolicyRule[], defaultEffect: 'allow' | 'deny') {
  const created = await app.policies.createPolicyVersion(owner, { tenantId, policyKey: 'billing.refund', scope: 'customer', rules, defaultEffect });
  await app.policies.activatePolicyVersion(owner, tenantId, created.contract.id);
  return created.contract;
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

const GATED = { policyKey: 'billing.refund', action: 'side-effect:refund.issue' } as const;

test('allow/deny cases: first matching rule decides; default effect otherwise (AC-2)', async () => {
  const { app, owner, tenantId } = await scenario();
  await activatedBase(app, owner, tenantId, refundBaseRules(), 'deny');

  const small = await app.policies.evaluatePolicy(owner, {
    tenantId,
    ...GATED,
    attributes: { amount: 120, channel: 'web' },
  });
  assert.equal(small.decision.outcome, 'allow');
  assert.equal(small.decision.decidingLayer, 'base');
  assert.equal(small.decision.decidingRuleId, 'allow-web');

  const large = await app.policies.evaluatePolicy(owner, {
    tenantId,
    ...GATED,
    attributes: { amount: 900, channel: 'web' },
  });
  assert.equal(large.decision.outcome, 'deny');
  assert.equal(large.decision.decidingLayer, 'base');
  assert.equal(large.decision.decidingRuleId, 'deny-large');

  // No rule matches (channel != web): the contract's default effect decides.
  const otherChannel = await app.policies.evaluatePolicy(owner, {
    tenantId,
    ...GATED,
    attributes: { amount: 10, channel: 'branch' },
  });
  assert.equal(otherChannel.decision.outcome, 'deny');
  assert.equal(otherChannel.decision.decidingLayer, 'base');
  assert.equal(otherChannel.decision.decidingRuleId, null);

  // A missing attribute never matches any operator: the default governs.
  const missingChannel = await app.policies.evaluatePolicy(owner, {
    tenantId,
    ...GATED,
    attributes: { amount: 10 },
  });
  assert.equal(missingChannel.decision.outcome, 'deny');
  assert.equal(missingChannel.decision.decidingLayer, 'base');
});

test('determinism: the same inputs produce the same decision and input hash (AC-2)', async () => {
  const { app, owner, tenantId } = await scenario();
  await activatedBase(app, owner, tenantId, refundBaseRules(), 'deny');

  const first = await app.policies.evaluatePolicy(owner, {
    tenantId,
    ...GATED,
    attributes: { amount: 120, channel: 'web' },
  });
  const second = await app.policies.evaluatePolicy(owner, {
    tenantId,
    ...GATED,
    attributes: { amount: 120, channel: 'web' },
  });
  assert.equal(first.decision.outcome, second.decision.outcome);
  assert.equal(first.decision.decidingLayer, second.decision.decidingLayer);
  assert.equal(first.decision.decidingRuleId, second.decision.decidingRuleId);
  assert.equal(first.decision.inputHash, second.decision.inputHash);
  assert.notEqual(first.decision.id, second.decision.id, 'two distinct evaluations (no idempotency key)');

  // Attribute insertion order is irrelevant: canonical hashing sorts keys.
  const shuffled = await app.policies.evaluatePolicy(owner, {
    tenantId,
    ...GATED,
    attributes: { channel: 'web', amount: 120 },
  });
  assert.equal(shuffled.decision.inputHash, first.decision.inputHash);

  // The pure evaluator is order-stable and repeatable.
  const ruleset = { rules: refundBaseRules(), defaultEffect: 'deny' as const };
  assert.deepEqual(evaluateLayer(ruleset, { amount: 120, channel: 'web' }), evaluateLayer(ruleset, { channel: 'web', amount: 120 }));
});

test('frozen floor: frozen-denied capabilities are denied even when every layer allows (AC-3)', async () => {
  const { app, owner, tenantId } = await scenario();
  // Everything allows... including a customer override that explicitly
  // tries to grant the frozen capability.
  await activatedBase(app, owner, tenantId, [{ id: 'allow-all', when: { kind: 'always' }, effect: 'allow' }], 'allow');
  await activatedCustomer(app, owner, tenantId, [
    { id: 'grant-bypass', when: { kind: 'attribute', name: 'capability', operator: 'eq', value: 'authorization-bypass' }, effect: 'allow' },
  ], 'allow');

  for (const capability of ['authorization-bypass', 'ai-authority', 'cross-tenant-data']) {
    const decision = await app.policies.evaluatePolicy(owner, {
      tenantId,
      ...GATED,
      attributes: { capability },
    });
    assert.equal(decision.decision.outcome, 'deny', `${capability} must be denied`);
    assert.equal(decision.decision.decidingLayer, 'frozen');
    assert.ok(decision.decision.decidingRuleId?.startsWith('frozen:denied-capability:'));
    // Provenance records every layer's outcome (all allowed; frozen denied).
    const customer = decision.decision.layers.find((l) => l.layer === 'customer');
    const base = decision.decision.layers.find((l) => l.layer === 'base');
    assert.equal(customer?.outcome, 'allow');
    assert.equal(base?.outcome, 'allow');
  }

  // The pure floor is the same code path: deny-only, revision-pinned.
  assert.equal(evaluateFrozenFloor({ capability: 'policy-gate-bypass' }).outcome, 'deny');
  assert.equal(evaluateFrozenFloor({ capability: 'ordinary-capability' }).outcome, 'allow');
  assert.equal(FROZEN_POLICY_REVISION, 'frozen-v1.0');
});

test('override precedence: customer deny tightens; customer allow cannot weaken base deny (AC-3)', async () => {
  const { app, owner, tenantId } = await scenario();
  // Base ALLOWS small web refunds.
  const base = await activatedBase(app, owner, tenantId, refundBaseRules(), 'deny');
  // Customer tightens: partner-channel refunds are denied.
  const customer = await activatedCustomer(app, owner, tenantId, [
    { id: 'deny-partner-channel', when: { kind: 'attribute', name: 'channel', operator: 'eq', value: 'partner' }, effect: 'deny' },
  ], 'deny');

  const partner = await app.policies.evaluatePolicy(owner, {
    tenantId,
    ...GATED,
    attributes: { amount: 10, channel: 'partner' },
  });
  assert.equal(partner.decision.outcome, 'deny');
  assert.equal(partner.decision.decidingLayer, 'customer');
  assert.equal(partner.decision.decidingRuleId, 'deny-partner-channel');

  // Now invert: base DENIES partner-channel; customer tries to ALLOW it.
  // deny-dominates composition: the decision stays deny, decided by base.
  const app2Scenario = await scenario();
  const base2 = await activatedBase(app2Scenario.app, app2Scenario.owner, app2Scenario.tenantId, [
    { id: 'deny-partner', when: { kind: 'attribute', name: 'channel', operator: 'eq', value: 'partner' }, effect: 'deny' },
  ], 'deny');
  const customer2 = await activatedCustomer(app2Scenario.app, app2Scenario.owner, app2Scenario.tenantId, [
    { id: 'allow-partner-anyway', when: { kind: 'attribute', name: 'channel', operator: 'eq', value: 'partner' }, effect: 'allow' },
  ], 'allow');

  const attempt = await app2Scenario.app.policies.evaluatePolicy(app2Scenario.owner, {
    tenantId: app2Scenario.tenantId,
    ...GATED,
    attributes: { channel: 'partner' },
  });
  assert.equal(attempt.decision.outcome, 'deny', 'a customer override cannot weaken the base deny');
  assert.equal(attempt.decision.decidingLayer, 'base');
  assert.equal(attempt.decision.decidingRuleId, 'deny-partner');
  // Provenance recorded that the customer layer wanted to allow.
  const customerLayer = attempt.decision.layers.find((l) => l.layer === 'customer');
  assert.equal(customerLayer?.policyId, customer2.id);
  assert.equal(customerLayer?.version, customer2.version);
  assert.equal(customerLayer?.outcome, 'allow');

  // Sanity on the first scenario's provenance as well.
  const baseLayer = partner.decision.layers.find((l) => l.layer === 'base');
  assert.equal(baseLayer?.policyId, base.id);
  assert.equal(baseLayer?.version, base.version);
  const customerLayerP = partner.decision.layers.find((l) => l.layer === 'customer');
  assert.equal(customerLayerP?.policyId, customer.id);
});

test('override default effects: deny-default tightens uncovered inputs; allow-default follows the base', async () => {
  const { app, owner, tenantId } = await scenario();
  await activatedBase(app, owner, tenantId, refundBaseRules(), 'deny');

  // An allow-default override ("tighten partner-channel only; otherwise
  // follow the base"): the web input stays allowed.
  await activatedCustomer(app, owner, tenantId, [
    { id: 'deny-partner', when: { kind: 'attribute', name: 'channel', operator: 'eq', value: 'partner' }, effect: 'deny' },
  ], 'allow');
  const webWithFollow = await app.policies.evaluatePolicy(owner, {
    tenantId,
    ...GATED,
    attributes: { amount: 120, channel: 'web' },
  });
  assert.equal(webWithFollow.decision.outcome, 'allow');
  assert.equal(webWithFollow.decision.decidingLayer, 'customer', 'the override\'s allow default carries the uncovered input');
  assert.equal(webWithFollow.decision.decidingRuleId, null);

  // A base deny still dominates the allow-default override (no weakening).
  const partnerDenyBaseScenario = await scenario();
  await activatedBase(partnerDenyBaseScenario.app, partnerDenyBaseScenario.owner, partnerDenyBaseScenario.tenantId, [
    { id: 'deny-partner', when: { kind: 'attribute', name: 'channel', operator: 'eq', value: 'partner' }, effect: 'deny' },
  ], 'deny');
  await activatedCustomer(partnerDenyBaseScenario.app, partnerDenyBaseScenario.owner, partnerDenyBaseScenario.tenantId, [
    { id: 'allow-partner-anyway', when: { kind: 'attribute', name: 'channel', operator: 'eq', value: 'partner' }, effect: 'allow' },
  ], 'allow');
  const overridden = await partnerDenyBaseScenario.app.policies.evaluatePolicy(partnerDenyBaseScenario.owner, {
    tenantId: partnerDenyBaseScenario.tenantId,
    ...GATED,
    attributes: { channel: 'partner' },
  });
  assert.equal(overridden.decision.outcome, 'deny');
  assert.equal(overridden.decision.decidingLayer, 'base');

  // A deny-default override ("deny anything my rules do not allow"): the
  // uncovered web input is denied even though the base allows it.
  const strictScenario = await scenario();
  await activatedBase(strictScenario.app, strictScenario.owner, strictScenario.tenantId, refundBaseRules(), 'deny');
  await activatedCustomer(strictScenario.app, strictScenario.owner, strictScenario.tenantId, [
    { id: 'deny-partner', when: { kind: 'attribute', name: 'channel', operator: 'eq', value: 'partner' }, effect: 'deny' },
  ], 'deny');
  const webUnderStrict = await strictScenario.app.policies.evaluatePolicy(strictScenario.owner, {
    tenantId: strictScenario.tenantId,
    ...GATED,
    attributes: { amount: 120, channel: 'web' },
  });
  assert.equal(webUnderStrict.decision.outcome, 'deny');
  assert.equal(webUnderStrict.decision.decidingLayer, 'customer');
  assert.equal(webUnderStrict.decision.decidingRuleId, null);
});

test('fail closed: with no active base policy the decision is deny (no grant from nothing)', async () => {
  const { app, owner, tenantId } = await scenario();
  // Only a customer override exists — it allows everything.
  await activatedCustomer(app, owner, tenantId, [{ id: 'allow-all', when: { kind: 'always' }, effect: 'allow' }], 'allow');
  const decision = await app.policies.evaluatePolicy(owner, {
    tenantId,
    ...GATED,
    attributes: { amount: 10, channel: 'web' },
  });
  assert.equal(decision.decision.outcome, 'deny');
  assert.equal(decision.decision.decidingLayer, 'default');
  assert.equal(decision.decision.decidingRuleId, null);
  const baseLayer = decision.decision.layers.find((l) => l.layer === 'base');
  assert.equal(baseLayer?.outcome, 'no-policy');
});

test('provenance: decisions are revision-bound and attributable (AC-5)', async () => {
  const { app, owner, tenantId } = await scenario();
  const base = await activatedBase(app, owner, tenantId, refundBaseRules(), 'deny');
  const customer = await activatedCustomer(app, owner, tenantId, [
    { id: 'deny-anonymous', when: { kind: 'attribute', name: 'actor', operator: 'eq', value: 'anonymous' }, effect: 'deny' },
  ], 'deny');

  const { decision } = await app.policies.evaluatePolicy(owner, {
    tenantId,
    ...GATED,
    attributes: { amount: 120, channel: 'web' },
  });
  // The override's deny DEFAULT tightens inputs its rules do not cover
  // (deny-dominates composition): this input matches no customer rule and
  // the customer contract's declared posture for uncovered inputs is deny.
  assert.equal(decision.outcome, 'deny');
  assert.equal(decision.decidingLayer, 'customer');
  assert.equal(decision.decidingRuleId, null);
  assert.equal(decision.tenantId, tenantId);
  assert.equal(decision.decidedBy, owner.id, 'attributable to the deciding principal');
  assert.equal(decision.frozenRevision, FROZEN_POLICY_REVISION);
  // Each layer pins the policy id + version it consulted.
  assert.deepEqual(
    decision.layers.map((l) => ({ layer: l.layer, policyId: l.policyId, version: l.version })),
    [
      { layer: 'frozen', policyId: null, version: null },
      { layer: 'customer', policyId: customer.id, version: customer.version },
      { layer: 'base', policyId: base.id, version: base.version },
    ],
  );
  // The input revision: snapshot + deterministic hash.
  assert.deepEqual(decision.input, { action: GATED.action, attributes: { amount: 120, channel: 'web' } });
  assert.equal(
    decision.inputHash,
    hashPolicyInput({ action: GATED.action, attributes: { amount: 120, channel: 'web' } }),
  );
  // The record carries a non-empty integrity hash.
  assert.match(decision.recordHash, /^[0-9a-f]{64}$/);

  // verifyDecision replays the pinned versions against the pinned input.
  const verified = await app.policies.verifyDecision(owner, tenantId, decision.id);
  assert.equal(verified.id, decision.id);
});

test('idempotent decisions: same key + same input converge; different input fails closed', async () => {
  const { app, owner, tenantId } = await scenario();
  await activatedBase(app, owner, tenantId, refundBaseRules(), 'deny');

  const first = await app.policies.evaluatePolicy(owner, {
    tenantId,
    ...GATED,
    attributes: { amount: 120, channel: 'web' },
    idempotencyKey: 'intent-77',
  });
  assert.equal(first.converged, false);
  const second = await app.policies.evaluatePolicy(owner, {
    tenantId,
    ...GATED,
    attributes: { amount: 120, channel: 'web' },
    idempotencyKey: 'intent-77',
  });
  assert.equal(second.converged, true);
  assert.equal(second.decision.id, first.decision.id);
  assert.equal(app.policyStore.decisions.size, 1);

  // Same key, DIFFERENT input: the gate can never be silently re-pointed.
  await expectPolicyError('DECISION_INPUT_CONFLICT', () =>
    app.policies.evaluatePolicy(owner, {
      tenantId,
      ...GATED,
      attributes: { amount: 999, channel: 'web' },
      idempotencyKey: 'intent-77',
    }),
  );

  // getDecision reads the durable record by id.
  const read = await app.policies.getDecision(owner, tenantId, first.decision.id);
  assert.equal(read.id, first.decision.id);
});

test('mutation detection: tampering with a recorded decision is detected on read (discrimination)', async () => {
  const { app, owner, tenantId } = await scenario();
  await activatedBase(app, owner, tenantId, refundBaseRules(), 'deny');
  const allowed = await app.policies.evaluatePolicy(owner, {
    tenantId,
    ...GATED,
    attributes: { amount: 120, channel: 'web' },
  });
  assert.equal(allowed.decision.outcome, 'allow');

  // Mutate the recorded result after evaluation (flip allow -> deny).
  const stored = app.policyStore.decisions.get(allowed.decision.id);
  assert.ok(stored !== undefined);
  stored.outcome = 'deny';

  // The raw row exists, but the predicated read DETECTS the mutation.
  assert.ok(app.policyStore.decisions.has(allowed.decision.id));
  await expectPolicyError('DECISION_RECORD_TAMPERED', () => app.policies.getDecision(owner, tenantId, allowed.decision.id));
  await expectPolicyError('DECISION_RECORD_TAMPERED', () => app.policies.verifyDecision(owner, tenantId, allowed.decision.id));

  // Restore, then tamper the INPUT snapshot instead (hash must catch it).
  stored.outcome = 'allow';
  stored.input = { action: GATED.action, attributes: { amount: 9999, channel: 'web' } };
  await expectPolicyError('DECISION_RECORD_TAMPERED', () => app.policies.getDecision(owner, tenantId, allowed.decision.id));

  // Restore, then tamper provenance (the deciding rule id).
  stored.input = { action: GATED.action, attributes: { amount: 120, channel: 'web' } };
  stored.decidingRuleId = 'some-other-rule';
  await expectPolicyError('DECISION_RECORD_TAMPERED', () => app.policies.getDecision(owner, tenantId, allowed.decision.id));

  // Restore honestly: the record reads and verifies again.
  stored.decidingRuleId = 'allow-web';
  const honest = await app.policies.getDecision(owner, tenantId, allowed.decision.id);
  assert.equal(honest.outcome, 'allow');
});

test('replay discrimination: tampered rule content diverges from the recorded decision', async () => {
  const { app, owner, tenantId } = await scenario();
  const base = await activatedBase(app, owner, tenantId, refundBaseRules(), 'deny');
  const allowed = await app.policies.evaluatePolicy(owner, {
    tenantId,
    ...GATED,
    attributes: { amount: 120, channel: 'web' },
  });
  assert.equal(allowed.decision.outcome, 'allow');

  // Mutate the pinned contract's rule content after the fact (an
  // out-of-band data change). The record hash still matches (decision
  // fields untouched) but replay re-evaluates the tampered rules and the
  // outcomes diverge.
  const stored = app.policyStore.contracts.get(base.id);
  assert.ok(stored !== undefined);
  stored.rules = [{ id: 'deny-everything', when: { kind: 'always' }, effect: 'deny' }];

  await expectPolicyError('DECISION_REPLAY_MISMATCH', () => app.policies.verifyDecision(owner, tenantId, allowed.decision.id));
  // getDecision (hash-only verification) still returns the record: the
  // recorded result itself was not mutated. Replay is the stronger check.
  const read = await app.policies.getDecision(owner, tenantId, allowed.decision.id);
  assert.equal(read.outcome, 'allow');
});

test('typed evaluation errors: ordered comparisons on wrong types fail closed', async () => {
  const { app, owner, tenantId } = await scenario();
  // amount will be a string at evaluation time: gt requires a number.
  await activatedBase(app, owner, tenantId, refundBaseRules(), 'deny');
  await expectPolicyError('EVALUATION_TYPE_ERROR', () =>
    app.policies.evaluatePolicy(owner, {
      tenantId,
      ...GATED,
      attributes: { amount: 'one-hundred' as unknown as number, channel: 'web' },
    }),
  );
});

test('pure composition table: deny dominates at every layer (discrimination)', () => {
  const noMatch = { outcome: 'no-policy', ruleId: null } as const;
  const allow = { outcome: 'allow', ruleId: 'a' } as const;
  const deny = { outcome: 'deny', ruleId: 'd' } as const;
  const frozenAllow = { outcome: 'allow', ruleId: null } as const;

  // floor deny dominates everything.
  assert.deepEqual(
    composeDecision({ frozen: { outcome: 'deny', ruleId: 'f' }, customer: allow, base: allow }),
    { outcome: 'deny', decidingLayer: 'frozen', decidingRuleId: 'f' },
  );
  // customer deny (tightening) beats base allow.
  assert.deepEqual(
    composeDecision({ frozen: { outcome: 'allow', ruleId: null }, customer: deny, base: allow }),
    { outcome: 'deny', decidingLayer: 'customer', decidingRuleId: 'd' },
  );
  // base deny beats customer allow (no weakening).
  assert.deepEqual(
    composeDecision({ frozen: { outcome: 'allow', ruleId: null }, customer: allow, base: deny }),
    { outcome: 'deny', decidingLayer: 'base', decidingRuleId: 'd' },
  );
  // customer allow with base allow.
  assert.deepEqual(
    composeDecision({ frozen: { outcome: 'allow', ruleId: null }, customer: allow, base: allow }),
    { outcome: 'allow', decidingLayer: 'customer', decidingRuleId: 'a' },
  );
  // base allow with no customer policy.
  assert.deepEqual(
    composeDecision({ frozen: { outcome: 'allow', ruleId: null }, customer: noMatch, base: allow }),
    { outcome: 'allow', decidingLayer: 'base', decidingRuleId: 'a' },
  );
  // no base policy: fail closed.
  assert.deepEqual(
    composeDecision({ frozen: { outcome: 'allow', ruleId: null }, customer: allow, base: noMatch }),
    { outcome: 'deny', decidingLayer: 'default', decidingRuleId: null },
  );
  // customer allow alone (no base, no-policy) still fails closed.
  assert.deepEqual(
    composeDecision({ frozen: frozenAllow, customer: allow, base: noMatch }),
    { outcome: 'deny', decidingLayer: 'default', decidingRuleId: null },
  );
});
