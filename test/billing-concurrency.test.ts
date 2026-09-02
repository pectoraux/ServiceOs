/**
 * Concurrency proof: billing registration, metering and settlement
 * convergence under interleaving (WORK-011, required class
 * `concurrency`).
 *
 * The in-memory store's async hooks inject deterministic interleaving
 * points BEFORE each synchronous critical section (the exact semantics
 * of the advisory-locked SQL transactions), so these proofs exercise
 * real check-then-act races between INDEPENDENT actors:
 *
 * - two actors registering the same-key subscription converge on ONE
 *   durable row (identical content) or one fails closed
 *   (IDEMPOTENCY_INPUT_CONFLICT on divergence — inside the serialized
 *   critical section);
 * - two actors racing the same billable work: ONE usage row (identical
 *   content converges; divergence fails closed — duplicate billable
 *   work can never double-charge);
 * - CONCURRENT SETTLEMENT converges on ONE ledger outcome: both
 *   settlement calls observe the same durable row; the settled usage
 *   set is priced exactly once; concurrent duplicate settlements never
 *   double-charge;
 * - concurrent keyed cost-reference recording converges on one row;
 * - concurrent activations of the same subscription converge.
 *
 * The SQL-level equivalents of the same races run against live
 * PostgreSQL in test/billing.integration.test.ts (CI).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBillingEconomicsApp, type BillingEconomicsApp } from './helpers/in-memory-stores.js';
import type { Principal } from '../src/modules/auth/index.js';
import { BillingError } from '../src/modules/billing/index.js';

const PASSWORD = 'correct horse battery 7';
const PERIOD = '2026-09';

interface Base {
  app: BillingEconomicsApp;
  owner: Principal;
  colleague: Principal;
  tenantId: string;
}

async function base(race?: () => Promise<void>): Promise<Base> {
  const app = buildBillingEconomicsApp({
    now: () => new Date('2026-09-15T12:00:00.000Z'),
    billingStoreOptions: {
      beforeRegisterSubscription: race,
      beforeActivateSubscription: race,
      beforeCancelSubscription: race,
      beforeRecordUsage: race,
      beforeSettlePeriod: race,
      beforeRecordCostReference: race,
    },
  });
  const owner = await app.auth.registerHuman({ email: 'owner@a.com', password: PASSWORD, displayName: 'Owner' });
  const colleague = await app.auth.registerHuman({ email: 'member@a.com', password: PASSWORD, displayName: 'Member' });
  const created = await app.organizations.createOrganization(owner, { slug: 'alpha-org', displayName: 'Alpha' });
  await app.organizations.addMember(owner, 'alpha-org', { principalId: colleague.id, role: 'member' });
  await app.verticals.registerVerticalPackage(owner, {
    tenantId: created.tenant.id,
    packageId: 'construction',
    version: 1,
    name: 'Construction',
    terminology: {},
    entities: [{ name: 'Project', fields: [{ name: 'projectNumber', type: 'string' as const, required: true }] }],
    workTypes: [{ name: 'OnboardSubcontractor' }],
    workflowSteps: [{ step: 'collect' }],
    policyDefaults: [],
    approvalMatrix: [],
    evidenceRequirements: [],
    integrationBindings: [],
    zeckCapabilityRequirements: [],
    pricingRules: [],
  });
  await app.services.registerServiceDefinition(owner, {
    tenantId: created.tenant.id,
    serviceId: 'subcontractor-compliance',
    version: 1,
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
      metering: [{ metric: 'onboarded-subcontractor', unit: 'count' }],
    },
    idempotencyKey: 'svc-v1',
  });
  await app.services.activateServiceDefinition(owner, created.tenant.id, 'subcontractor-compliance', 1);
  return { app, owner, colleague, tenantId: created.tenant.id };
}

const PLAN = {
  model: 'hybrid' as const,
  currency: 'EUR',
  recurring: { amount: '199.00' },
  workRates: [{ metric: 'onboarded-subcontractor', unitPrice: '25.50' }],
};

function oneTimeRace(): () => Promise<void> {
  let release = 0;
  return async () => {
    if (release === 0) {
      release = 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
}

async function capture<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}

async function activeSubscriptionFrom(baseFixture: Base) {
  const { subscription } = await baseFixture.app.billing.registerSubscription(baseFixture.owner, {
    tenantId: baseFixture.tenantId,
    serviceId: 'subcontractor-compliance',
    plan: PLAN,
    idempotencyKey: 'sub-1',
  });
  const activated = await baseFixture.app.billing.activateSubscription(baseFixture.owner, baseFixture.tenantId, subscription.id);
  return activated.subscription;
}

async function createWork(baseFixture: Base, title: string) {
  const created = await baseFixture.app.work.createWork(baseFixture.owner, {
    tenantId: baseFixture.tenantId,
    workType: 'OnboardSubcontractor',
    title,
  });
  return created.work;
}

test('two actors racing the same subscription key with identical content converge on one row', async () => {
  const race = oneTimeRace();
  const fixture = await base(race);
  const [a, b] = await Promise.all([
    fixture.app.billing.registerSubscription(fixture.owner, {
      tenantId: fixture.tenantId,
      serviceId: 'subcontractor-compliance',
      plan: PLAN,
      idempotencyKey: 'sub-race',
    }),
    fixture.app.billing.registerSubscription(fixture.colleague, {
      tenantId: fixture.tenantId,
      serviceId: 'subcontractor-compliance',
      plan: PLAN,
      idempotencyKey: 'sub-race',
    }),
  ]);
  assert.notEqual(a.converged, b.converged, 'exactly one insert and one convergence');
  assert.equal(a.subscription.id, b.subscription.id, 'ONE durable identity');
  assert.equal(fixture.app.billingStore.subscriptions.size, 1);
});

test('two actors racing the same subscription key with divergent content: one wins, one fails closed', async () => {
  const race = oneTimeRace();
  const fixture = await base(race);
  const [a, b] = await Promise.all([
    capture(
      fixture.app.billing.registerSubscription(fixture.owner, {
        tenantId: fixture.tenantId,
        serviceId: 'subcontractor-compliance',
        plan: PLAN,
        idempotencyKey: 'sub-divergent',
      }),
    ),
    capture(
      fixture.app.billing.registerSubscription(fixture.colleague, {
        tenantId: fixture.tenantId,
        serviceId: 'subcontractor-compliance',
        plan: { ...PLAN, recurring: { amount: '299.00' } },
        idempotencyKey: 'sub-divergent',
      }),
    ),
  ]);
  const results = [a, b];
  assert.equal(results.filter((result) => result.ok).length, 1, 'exactly one winner');
  const losers = results.filter((result) => !result.ok);
  assert.equal(losers.length, 1, 'exactly one loser');
  const loser = losers[0];
  if (!loser.ok) {
    assert.ok(loser.error instanceof BillingError, `typed error, got ${String(loser.error)}`);
    // The serialized critical section's contract: the key is the logical
    // identity — divergent content for the same key fails closed with the
    // IDEMPOTENCY code, never the one-live code.
    assert.equal(loser.error.code, 'IDEMPOTENCY_INPUT_CONFLICT');
  }
  assert.equal(fixture.app.billingStore.subscriptions.size, 1, 'never two rows for one logical identity');
});

test('two actors racing DIFFERENT keys for the same service: one wins, one fails with the one-live invariant', async () => {
  const race = oneTimeRace();
  const fixture = await base(race);
  const [a, b] = await Promise.all([
    capture(
      fixture.app.billing.registerSubscription(fixture.owner, {
        tenantId: fixture.tenantId,
        serviceId: 'subcontractor-compliance',
        plan: PLAN,
        idempotencyKey: 'key-a',
      }),
    ),
    capture(
      fixture.app.billing.registerSubscription(fixture.colleague, {
        tenantId: fixture.tenantId,
        serviceId: 'subcontractor-compliance',
        plan: PLAN,
        idempotencyKey: 'key-b',
      }),
    ),
  ]);
  const results = [a, b];
  assert.equal(results.filter((result) => result.ok).length, 1, 'exactly one winner');
  const losers = results.filter((result) => !result.ok);
  const loser = losers[0];
  if (!loser.ok) {
    assert.ok(loser.error instanceof BillingError, `typed error, got ${String(loser.error)}`);
    assert.equal(loser.error.code, 'SUBSCRIPTION_ALREADY_ACTIVE');
  }
  assert.equal(fixture.app.billingStore.subscriptions.size, 1);
});

test('concurrent activations of the same subscription converge (one active at rest)', async () => {
  const race = oneTimeRace();
  const fixture = await base();
  const { subscription } = await fixture.app.billing.registerSubscription(fixture.owner, {
    tenantId: fixture.tenantId,
    serviceId: 'subcontractor-compliance',
    plan: PLAN,
    idempotencyKey: 'sub-act',
  });
  fixture.app.billingStore.options.beforeActivateSubscription = race;
  const [a, b] = await Promise.all([
    fixture.app.billing.activateSubscription(fixture.owner, fixture.tenantId, subscription.id),
    fixture.app.billing.activateSubscription(fixture.colleague, fixture.tenantId, subscription.id),
  ]);
  assert.equal([a.converged, b.converged].filter((converged) => converged).length, 1, 'exactly one activation');
  const read = await fixture.app.billing.getSubscription(fixture.owner, fixture.tenantId, subscription.id);
  assert.equal(read?.status, 'active');
});

test('two actors metering the SAME billable work in parallel converge on ONE usage row (no double-charge)', async () => {
  const race = oneTimeRace();
  const fixture = await base(race);
  await activeSubscriptionFrom(fixture);
  const work = await createWork(fixture, 'Onboard Acme');
  const meterInput = (actor: Principal) =>
    fixture.app.billing.meterWorkUsage(actor, {
      tenantId: fixture.tenantId,
      serviceId: 'subcontractor-compliance',
      workId: work.id,
      metric: 'onboarded-subcontractor',
      quantity: '1',
    });
  const [a, b] = await Promise.all([meterInput(fixture.owner), meterInput(fixture.colleague)]);
  assert.notEqual(a.converged, b.converged, 'exactly one insert and one convergence');
  assert.equal(a.usage.id, b.usage.id, 'ONE usage row for one billable work');
  assert.equal(fixture.app.billingStore.usage.size, 1, 'never two rows for one billable work');
  // Divergent quantity for the same work: one wins, one fails closed.
  const [divA, divB] = await Promise.all([
    capture(
      fixture.app.billing.meterWorkUsage(fixture.owner, {
        tenantId: fixture.tenantId,
        serviceId: 'subcontractor-compliance',
        workId: work.id,
        metric: 'onboarded-subcontractor',
        quantity: '5',
      }),
    ),
    capture(
      fixture.app.billing.meterWorkUsage(fixture.colleague, {
        tenantId: fixture.tenantId,
        serviceId: 'subcontractor-compliance',
        workId: work.id,
        metric: 'onboarded-subcontractor',
        quantity: '6',
      }),
    ),
  ]);
  const results = [divA, divB];
  assert.equal(results.filter((result) => result.ok).length, 0, 'both diverge from the settled content');
  for (const result of results) {
    if (!result.ok) {
      assert.ok(result.error instanceof BillingError);
      assert.equal(result.error.code, 'USAGE_INPUT_CONFLICT');
    }
  }
  assert.equal(fixture.app.billingStore.usage.size, 1, 'the divergence never persists');
});

test('concurrent settlement converges on ONE ledger outcome with the usage priced exactly once', async () => {
  const race = oneTimeRace();
  const fixture = await base(race);
  await activeSubscriptionFrom(fixture);
  const workA = await createWork(fixture, 'Onboard Acme');
  const workB = await createWork(fixture, 'Onboard Beta');
  await fixture.app.billing.meterWorkUsage(fixture.owner, {
    tenantId: fixture.tenantId,
    serviceId: 'subcontractor-compliance',
    workId: workA.id,
    metric: 'onboarded-subcontractor',
    quantity: '2',
  });
  await fixture.app.billing.meterWorkUsage(fixture.owner, {
    tenantId: fixture.tenantId,
    serviceId: 'subcontractor-compliance',
    workId: workB.id,
    metric: 'onboarded-subcontractor',
    quantity: '1',
  });
  const [a, b] = await Promise.all([
    fixture.app.billing.settleBillingPeriod(fixture.owner, {
      tenantId: fixture.tenantId,
      serviceId: 'subcontractor-compliance',
      billingPeriod: PERIOD,
    }),
    fixture.app.billing.settleBillingPeriod(fixture.colleague, {
      tenantId: fixture.tenantId,
      serviceId: 'subcontractor-compliance',
      billingPeriod: PERIOD,
    }),
  ]);
  assert.notEqual(a.converged, b.converged, 'exactly one settlement and one convergence');
  assert.equal(a.ledger.id, b.ledger.id, 'ONE durable ledger outcome');
  // The usage is priced EXACTLY once: 2*25.5 + 1*25.5 = 76.5 (+199 recurring).
  assert.equal(a.ledger.usageCharge, b.ledger.usageCharge);
  assert.equal(a.ledger.usageCharge, '76.5');
  assert.equal(a.ledger.usageCount, 2);
  assert.equal(a.ledger.totalCharge, '275.5');
  assert.equal(fixture.app.billingStore.ledger.size, 1, 'never two ledger rows for one period');
  // Every usage row is settled exactly once and points at the outcome.
  const usage = await fixture.app.billing.listUsageRecords(fixture.owner, fixture.tenantId, { billingPeriod: PERIOD });
  for (const record of usage) {
    assert.equal(record.settledLedgerId, a.ledger.id);
  }
});

test('concurrent settlement racing NEW late usage: the late usage is never double-billed into the settled period', async () => {
  // Settle while a late metering races: one of two durable outcomes is
  // legal — the late usage settles with the ledger (if the metering won
  // the settlement lock first) or stays metered-but-unsettled (if the
  // settlement won). NEVER a second ledger row, never a double charge.
  const race = oneTimeRace();
  const fixture = await base(race);
  await activeSubscriptionFrom(fixture);
  const workA = await createWork(fixture, 'Onboard Acme');
  await fixture.app.billing.meterWorkUsage(fixture.owner, {
    tenantId: fixture.tenantId,
    serviceId: 'subcontractor-compliance',
    workId: workA.id,
    metric: 'onboarded-subcontractor',
    quantity: '1',
  });
  const lateWork = await createWork(fixture, 'Onboard Late');
  const [settled, late] = await Promise.all([
    fixture.app.billing.settleBillingPeriod(fixture.owner, {
      tenantId: fixture.tenantId,
      serviceId: 'subcontractor-compliance',
      billingPeriod: PERIOD,
    }),
    fixture.app.billing.meterWorkUsage(fixture.colleague, {
      tenantId: fixture.tenantId,
      serviceId: 'subcontractor-compliance',
      workId: lateWork.id,
      metric: 'onboarded-subcontractor',
      quantity: '1',
    }),
  ]);
  assert.equal(fixture.app.billingStore.ledger.size, 1, 'exactly one ledger outcome regardless of the race outcome');
  assert.equal(fixture.app.billingStore.usage.size, 2, 'both usages are durable (metered)');
  // The ledger row and its settled set agree; re-settling converges on
  // the same immutable outcome (late usage is NOT double-billed).
  const again = await fixture.app.billing.settleBillingPeriod(fixture.owner, {
    tenantId: fixture.tenantId,
    serviceId: 'subcontractor-compliance',
    billingPeriod: PERIOD,
  });
  assert.equal(again.converged, true);
  assert.equal(again.ledger.id, settled.ledger.id);
  assert.equal(again.ledger.usageCount, settled.ledger.usageCount);
  assert.equal(again.ledger.totalCharge, settled.ledger.totalCharge);
  // The late usage (whenever it landed) carries the one-work identity.
  assert.notEqual(late.usage.id, settled.ledger.id);
});

test('concurrent keyed cost-reference recording converges on one row; divergence fails closed', async () => {
  const race = oneTimeRace();
  const fixture = await base(race);
  const [a, b] = await Promise.all([
    fixture.app.billing.recordCostReference(fixture.owner, {
      tenantId: fixture.tenantId,
      billingPeriod: PERIOD,
      source: 'ai_authority',
      externalReference: 'statement-1',
      amount: '10.50',
      currency: 'EUR',
      idempotencyKey: 'cost-race',
    }),
    fixture.app.billing.recordCostReference(fixture.colleague, {
      tenantId: fixture.tenantId,
      billingPeriod: PERIOD,
      source: 'ai_authority',
      externalReference: 'statement-1',
      amount: '10.50',
      currency: 'EUR',
      idempotencyKey: 'cost-race',
    }),
  ]);
  assert.notEqual(a.converged, b.converged);
  assert.equal(a.reference.id, b.reference.id);
  assert.equal(fixture.app.billingStore.costReferences.size, 1);
  // Divergent amount for the same key: both fail closed (the stored
  // content differs from both inputs).
  const [divA, divB] = await Promise.all([
    capture(
      fixture.app.billing.recordCostReference(fixture.owner, {
        tenantId: fixture.tenantId,
        billingPeriod: PERIOD,
        source: 'ai_authority',
        externalReference: 'statement-1',
        amount: '11',
        currency: 'EUR',
        idempotencyKey: 'cost-race',
      }),
    ),
    capture(
      fixture.app.billing.recordCostReference(fixture.colleague, {
        tenantId: fixture.tenantId,
        billingPeriod: PERIOD,
        source: 'ai_authority',
        externalReference: 'statement-1',
        amount: '12',
        currency: 'EUR',
        idempotencyKey: 'cost-race',
      }),
    ),
  ]);
  for (const result of [divA, divB]) {
    if (!result.ok) {
      assert.ok(result.error instanceof BillingError);
      assert.equal(result.error.code, 'IDEMPOTENCY_INPUT_CONFLICT');
    } else {
      assert.fail('a divergent keyed recording must not succeed');
    }
  }
  assert.equal(fixture.app.billingStore.costReferences.size, 1);
});
