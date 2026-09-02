/**
 * Behavioral + discrimination proofs for the /billing authority
 * (WORK-011, required classes `dynamic` + `discrimination`).
 *
 * Behavioral:
 * - subscriptions register against the ACTIVE service definition,
 *   validate their plan against the pinned version's declared pricing
 *   metadata, and live a forward-only one-live lifecycle;
 * - service work is METERED (AC-1): work-sourced, outcome-linked and
 *   keyed manual usage records persist and round-trip;
 * - settlement prices the period through the module's pure pricing
 *   policy (recurring component + per-metric rates; unrated metered
 *   usage contributes ZERO charge) and produces ONE ledger outcome;
 * - cost references record as opaque non-authoritative references and
 *   the margin report derives revenue/costs/margin per currency (AC-3);
 *
 * Discrimination / mutation:
 * - duplicate billable work NEVER double-charges: re-metering the same
 *   work/outcome converges (identical content) or fails closed
 *   (USAGE_INPUT_CONFLICT on divergence);
 * - re-settling a settled period converges (ONE durable ledger row);
 * - plan shape violations, undeclared metrics/outcomes, unknown work,
 *   missing live subscription, forbidden cost-breakdown keys and
 *   tampered rows ALL fail closed with typed codes;
 * - authorization happens BEFORE any domain data access.
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
  otherTenantId: string;
  otherOwner: Principal;
}

async function base(): Promise<Base> {
  const app = buildBillingEconomicsApp({ now: () => new Date('2026-09-15T12:00:00.000Z') });
  const owner = await app.auth.registerHuman({ email: 'owner@a.com', password: PASSWORD, displayName: 'Owner' });
  const colleague = await app.auth.registerHuman({ email: 'member@a.com', password: PASSWORD, displayName: 'Member' });
  const created = await app.organizations.createOrganization(owner, { slug: 'alpha-org', displayName: 'Alpha' });
  await app.organizations.addMember(owner, 'alpha-org', { principalId: colleague.id, role: 'member' });
  const otherOwner = await app.auth.registerHuman({ email: 'owner@b.com', password: PASSWORD, displayName: 'Other Owner' });
  const other = await app.organizations.createOrganization(otherOwner, { slug: 'beta-org', displayName: 'Beta' });
  return { app, owner, colleague, tenantId: created.tenant.id, otherTenantId: other.tenant.id, otherOwner };
}

function packageInput(tenantId: string, version: number) {
  return {
    tenantId,
    packageId: 'construction',
    version,
    name: 'Construction',
    terminology: { subcontractor: 'A company engaged to perform part of the works' },
    entities: [{ name: 'Project', fields: [{ name: 'projectNumber', type: 'string' as const, required: true }] }],
    workTypes: [{ name: 'OnboardSubcontractor', defaultSlaHours: 48 }],
    workflowSteps: [{ step: 'collect' }],
    policyDefaults: [{ policyKey: 'k', parameters: [{ name: 'p', defaultValue: 1 }] }],
    approvalMatrix: [{ id: 'approval-1', role: 'pm', threshold: 1 }],
    evidenceRequirements: [{ name: 'insurance-certificate' }],
    integrationBindings: [{ capabilityClass: 'email' }],
    zeckCapabilityRequirements: [{ capability: 'document.reasoning' }],
    pricingRules: [{ id: 'r', model: 'per_work_item' as const }],
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
    policyConfiguration: [
      { policyKey: 'k', parameters: [{ name: 'p', type: 'number' as const, required: false, min: 0, max: 100000 }] },
    ],
    approvalRules: [{ id: 'approval-1', threshold: 1 }],
    slaDefaults: [{ workType: 'OnboardSubcontractor', deadlineHours: 24 }],
    outcomeContract: {
      outcomeId: 'subcontractor-compliant',
      outputSchema: [{ name: 'compliancePackageRef', type: 'string' as const, required: true }],
      evidenceRequirements: ['insurance-certificate'],
      verification: 'deterministic' as const,
    },
    requiredExternalCapabilities: ['email'],
    requiredAiCapabilities: [{ capability: 'document.reasoning' }],
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

function subscriptionPlan(model: 'subscription' | 'work_based' | 'hybrid') {
  return {
    model,
    currency: 'EUR',
    ...(model !== 'work_based' ? { recurring: { amount: '199.00' } } : {}),
    ...(model !== 'subscription'
      ? {
          workRates: [
            { metric: 'onboarded-subcontractor', unitPrice: '25.50' },
            { metric: 'processed-document', unitPrice: '0.10' },
          ],
        }
      : {}),
  };
}

/** Register the catalog (package + active service) and return the app state. */
async function cataloged(baseFixture: Base): Promise<void> {
  await baseFixture.app.verticals.registerVerticalPackage(baseFixture.owner, packageInput(baseFixture.tenantId, 1));
  await baseFixture.app.services.registerServiceDefinition(baseFixture.owner, serviceInput(baseFixture.tenantId, 1, 'svc-v1'));
  await baseFixture.app.services.activateServiceDefinition(baseFixture.owner, baseFixture.tenantId, 'subcontractor-compliance', 1);
}

async function expectBillingError(code: string, run: () => Promise<unknown>): Promise<BillingError> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof BillingError, `expected a BillingError, got ${String(error)}`);
    assert.equal((error as BillingError).code, code);
    return error as BillingError;
  }
  assert.fail(`expected a typed ${code} rejection`);
}

async function activeSubscription(baseFixture: Base, model: 'subscription' | 'work_based' | 'hybrid' = 'hybrid') {
  const { subscription } = await baseFixture.app.billing.registerSubscription(baseFixture.owner, {
    tenantId: baseFixture.tenantId,
    serviceId: 'subcontractor-compliance',
    plan: subscriptionPlan(model),
    idempotencyKey: `sub-${model}`,
  });
  const activated = await baseFixture.app.billing.activateSubscription(baseFixture.owner, baseFixture.tenantId, subscription.id);
  return activated.subscription;
}

async function createWorkFor(baseFixture: Base, actor: Principal, title: string) {
  const created = await baseFixture.app.work.createWork(actor, {
    tenantId: baseFixture.tenantId,
    workType: 'OnboardSubcontractor',
    title,
  });
  return created.work;
}

// ---------------------------------------------------------------------------
// Subscriptions (AC-2)
// ---------------------------------------------------------------------------

test('a subscription registers against the active definition, validates its plan and round-trips', async () => {
  const fixture = await base();
  await cataloged(fixture);
  const { subscription, converged } = await fixture.app.billing.registerSubscription(fixture.owner, {
    tenantId: fixture.tenantId,
    serviceId: 'subcontractor-compliance',
    plan: subscriptionPlan('hybrid'),
    idempotencyKey: 'sub-1',
  });
  assert.equal(converged, false);
  assert.equal(subscription.status, 'draft');
  assert.equal(subscription.serviceVersion, 1, 'pins the ACTIVE service version');
  assert.equal(subscription.plan.currency, 'EUR');
  assert.equal(subscription.plan.recurringAmount, '199');
  assert.equal(subscription.plan.workRates.length, 2);
  const read = await fixture.app.billing.getSubscription(fixture.owner, fixture.tenantId, subscription.id);
  assert.equal(read?.id, subscription.id);
  assert.equal(read?.plan.model, 'hybrid');
});

test('customer pricing can be subscription, work-based or hybrid (AC-2)', async () => {
  const fixture = await base();
  await cataloged(fixture);
  const subscription = await activeSubscription(fixture, 'subscription');
  assert.equal(subscription.plan.model, 'subscription');
  // One live subscription per service: a second registration conflicts.
  await expectBillingError('SUBSCRIPTION_ALREADY_ACTIVE', () =>
    fixture.app.billing.registerSubscription(fixture.owner, {
      tenantId: fixture.tenantId,
      serviceId: 'subcontractor-compliance',
      plan: subscriptionPlan('hybrid'),
      idempotencyKey: 'sub-3',
    }),
  );
  // After cancellation the next model can take over (work-based).
  await fixture.app.billing.cancelSubscription(fixture.owner, fixture.tenantId, subscription.id);
  const work = await activeSubscription(fixture, 'work_based');
  assert.equal(work.plan.model, 'work_based');
});

test('plan shape violations fail closed with typed codes', async () => {
  const fixture = await base();
  await cataloged(fixture);
  await expectBillingError('INVALID_INPUT', () =>
    fixture.app.billing.registerSubscription(fixture.owner, {
      tenantId: fixture.tenantId,
      serviceId: 'subcontractor-compliance',
      // subscription model without a recurring component
      plan: { model: 'subscription', currency: 'EUR', workRates: [{ metric: 'onboarded-subcontractor', unitPrice: '1' }] },
    }),
  );
  await expectBillingError('INVALID_INPUT', () =>
    fixture.app.billing.registerSubscription(fixture.owner, {
      tenantId: fixture.tenantId,
      serviceId: 'subcontractor-compliance',
      // work_based model with a recurring component
      plan: { model: 'work_based', currency: 'EUR', recurring: { amount: '10' }, workRates: [{ metric: 'onboarded-subcontractor', unitPrice: '1' }] },
    }),
  );
  await expectBillingError('INVALID_INPUT', () =>
    fixture.app.billing.registerSubscription(fixture.owner, {
      tenantId: fixture.tenantId,
      serviceId: 'subcontractor-compliance',
      // hybrid missing the work component
      plan: { model: 'hybrid', currency: 'EUR', recurring: { amount: '10' } },
    }),
  );
  await expectBillingError('METERING_NOT_DECLARED', () =>
    fixture.app.billing.registerSubscription(fixture.owner, {
      tenantId: fixture.tenantId,
      serviceId: 'subcontractor-compliance',
      plan: { model: 'work_based', currency: 'EUR', workRates: [{ metric: 'undeclared-metric', unitPrice: '1' }] },
    }),
  );
  await expectBillingError('INVALID_INPUT', () =>
    fixture.app.billing.registerSubscription(fixture.owner, {
      tenantId: fixture.tenantId,
      serviceId: 'subcontractor-compliance',
      plan: { model: 'work_based', currency: 'EURO', workRates: [{ metric: 'onboarded-subcontractor', unitPrice: '1' }] },
    }),
  );
});

test('a subscription requires an ACTIVE service definition (binding, never invention)', async () => {
  const fixture = await base();
  await fixture.app.verticals.registerVerticalPackage(fixture.owner, packageInput(fixture.tenantId, 1));
  await fixture.app.services.registerServiceDefinition(fixture.owner, serviceInput(fixture.tenantId, 1, 'svc-v1'));
  // Registered but NOT activated.
  await expectBillingError('SERVICE_NOT_ACTIVE', () =>
    fixture.app.billing.registerSubscription(fixture.owner, {
      tenantId: fixture.tenantId,
      serviceId: 'subcontractor-compliance',
      plan: subscriptionPlan('subscription'),
    }),
  );
});

test('the subscription lifecycle is forward-only with one live subscription', async () => {
  const fixture = await base();
  await cataloged(fixture);
  const { subscription } = await fixture.app.billing.registerSubscription(fixture.owner, {
    tenantId: fixture.tenantId,
    serviceId: 'subcontractor-compliance',
    plan: subscriptionPlan('subscription'),
  });
  const activated = await fixture.app.billing.activateSubscription(fixture.owner, fixture.tenantId, subscription.id);
  assert.equal(activated.subscription.status, 'active');
  assert.equal(activated.converged, false);
  // Re-activation converges.
  const reactivated = await fixture.app.billing.activateSubscription(fixture.owner, fixture.tenantId, subscription.id);
  assert.equal(reactivated.converged, true);
  // Cancel is terminal and absorbing.
  const cancelled = await fixture.app.billing.cancelSubscription(fixture.owner, fixture.tenantId, subscription.id);
  assert.equal(cancelled.subscription.status, 'cancelled');
  assert.notEqual(cancelled.subscription.cancelledAt, null);
  const reCancelled = await fixture.app.billing.cancelSubscription(fixture.owner, fixture.tenantId, subscription.id);
  assert.equal(reCancelled.converged, true);
  // A cancelled subscription can never return.
  await expectBillingError('SUBSCRIPTION_STATE_ILLEGAL', () =>
    fixture.app.billing.activateSubscription(fixture.owner, fixture.tenantId, subscription.id),
  );
  // After cancellation a replacement may register.
  const replacement = await fixture.app.billing.registerSubscription(fixture.owner, {
    tenantId: fixture.tenantId,
    serviceId: 'subcontractor-compliance',
    plan: subscriptionPlan('hybrid'),
    idempotencyKey: 'sub-replacement',
  });
  assert.equal(replacement.subscription.status, 'draft');
});

test('keyed subscription registration converges on identical content and conflicts on divergence', async () => {
  const fixture = await base();
  await cataloged(fixture);
  const first = await fixture.app.billing.registerSubscription(fixture.owner, {
    tenantId: fixture.tenantId,
    serviceId: 'subcontractor-compliance',
    plan: subscriptionPlan('hybrid'),
    idempotencyKey: 'sub-key',
  });
  const second = await fixture.app.billing.registerSubscription(fixture.colleague, {
    tenantId: fixture.tenantId,
    serviceId: 'subcontractor-compliance',
    plan: subscriptionPlan('hybrid'),
    idempotencyKey: 'sub-key',
  });
  assert.equal(second.converged, true);
  assert.equal(second.subscription.id, first.subscription.id);
  // Cancel, then diverge on the same key.
  await fixture.app.billing.cancelSubscription(fixture.owner, fixture.tenantId, first.subscription.id);
  await expectBillingError('IDEMPOTENCY_INPUT_CONFLICT', () =>
    fixture.app.billing.registerSubscription(fixture.owner, {
      tenantId: fixture.tenantId,
      serviceId: 'subcontractor-compliance',
      plan: subscriptionPlan('subscription'),
      idempotencyKey: 'sub-key',
    }),
  );
});

// ---------------------------------------------------------------------------
// Metering (AC-1)
// ---------------------------------------------------------------------------

test('service work is metered: work-sourced usage persists and round-trips (AC-1)', async () => {
  const fixture = await base();
  await cataloged(fixture);
  await activeSubscription(fixture);
  const work = await createWorkFor(fixture, fixture.owner, 'Onboard Acme');
  const { usage, converged } = await fixture.app.billing.meterWorkUsage(fixture.owner, {
    tenantId: fixture.tenantId,
    serviceId: 'subcontractor-compliance',
    workId: work.id,
    metric: 'onboarded-subcontractor',
    quantity: '1',
  });
  assert.equal(converged, false);
  assert.equal(usage.source, 'work');
  assert.equal(usage.metric, 'onboarded-subcontractor');
  assert.equal(usage.unit, 'count', 'the unit comes from the pinned version\'s metering rule');
  assert.equal(usage.quantity, '1');
  assert.equal(usage.billingPeriod.length, 7);
  assert.equal(usage.settledLedgerId, null);
});

test('outcome-linked usage binds the declared outcome contract', async () => {
  const fixture = await base();
  await cataloged(fixture);
  await activeSubscription(fixture);
  const { usage } = await fixture.app.billing.meterOutcomeUsage(fixture.owner, {
    tenantId: fixture.tenantId,
    serviceId: 'subcontractor-compliance',
    outcomeId: 'subcontractor-compliant',
    metric: 'processed-document',
    quantity: '2.5',
  });
  assert.equal(usage.source, 'outcome');
  assert.equal(usage.outcomeId, 'subcontractor-compliant');
  // An undeclared outcome fails closed.
  await expectBillingError('OUTCOME_NOT_DECLARED', () =>
    fixture.app.billing.meterOutcomeUsage(fixture.owner, {
      tenantId: fixture.tenantId,
      serviceId: 'subcontractor-compliance',
      outcomeId: 'some-other-outcome',
      metric: 'processed-document',
      quantity: '1',
    }),
  );
});

test('manual usage is keyed and converges; metering validates against the pinned version', async () => {
  const fixture = await base();
  await cataloged(fixture);
  await activeSubscription(fixture);
  const first = await fixture.app.billing.recordManualUsage(fixture.owner, {
    tenantId: fixture.tenantId,
    serviceId: 'subcontractor-compliance',
    metric: 'processed-document',
    quantity: '10',
    idempotencyKey: 'manual-1',
  });
  const second = await fixture.app.billing.recordManualUsage(fixture.colleague, {
    tenantId: fixture.tenantId,
    serviceId: 'subcontractor-compliance',
    metric: 'processed-document',
    quantity: '10',
    idempotencyKey: 'manual-1',
  });
  assert.equal(second.converged, true);
  assert.equal(second.usage.id, first.usage.id);
  await expectBillingError('IDEMPOTENCY_INPUT_CONFLICT', () =>
    fixture.app.billing.recordManualUsage(fixture.owner, {
      tenantId: fixture.tenantId,
      serviceId: 'subcontractor-compliance',
      metric: 'processed-document',
      quantity: '11',
      idempotencyKey: 'manual-1',
    }),
  );
  // Undeclared metric fails closed.
  await expectBillingError('METERING_NOT_DECLARED', () =>
    fixture.app.billing.recordManualUsage(fixture.owner, {
      tenantId: fixture.tenantId,
      serviceId: 'subcontractor-compliance',
      metric: 'undeclared-metric',
      quantity: '1',
      idempotencyKey: 'manual-2',
    }),
  );
});

test('metering requires a live subscription and a real work identity', async () => {
  const fixture = await base();
  await cataloged(fixture);
  await expectBillingError('SUBSCRIPTION_NOT_ACTIVE', () =>
    fixture.app.billing.meterWorkUsage(fixture.owner, {
      tenantId: fixture.tenantId,
      serviceId: 'subcontractor-compliance',
      workId: '00000000-0000-4000-8000-000000000001',
      metric: 'onboarded-subcontractor',
      quantity: '1',
    }),
  );
  await activeSubscription(fixture);
  await expectBillingError('WORK_NOT_FOUND', () =>
    fixture.app.billing.meterWorkUsage(fixture.owner, {
      tenantId: fixture.tenantId,
      serviceId: 'subcontractor-compliance',
      workId: '00000000-0000-4000-8000-000000000001',
      metric: 'onboarded-subcontractor',
      quantity: '1',
    }),
  );
  // A work item of ANOTHER tenant is invisible (tenant predicate).
  const foreignCreated = await fixture.app.work.createWork(fixture.otherOwner, {
    tenantId: fixture.otherTenantId,
    workType: 'OnboardSubcontractor',
    title: 'Foreign work',
  });
  const foreign = foreignCreated.work;
  await expectBillingError('WORK_NOT_FOUND', () =>
    fixture.app.billing.meterWorkUsage(fixture.owner, {
      tenantId: fixture.tenantId,
      serviceId: 'subcontractor-compliance',
      workId: foreign.id,
      metric: 'onboarded-subcontractor',
      quantity: '1',
    }),
  );
});

// ---------------------------------------------------------------------------
// Duplicate-charge prevention (discrimination requirement)
// ---------------------------------------------------------------------------

test('duplicate billable work NEVER double-charges: re-metering converges on identical content', async () => {
  const fixture = await base();
  await cataloged(fixture);
  await activeSubscription(fixture);
  const work = await createWorkFor(fixture, fixture.owner, 'Onboard Acme');
  const first = await fixture.app.billing.meterWorkUsage(fixture.owner, {
    tenantId: fixture.tenantId,
    serviceId: 'subcontractor-compliance',
    workId: work.id,
    metric: 'onboarded-subcontractor',
    quantity: '1',
  });
  const second = await fixture.app.billing.meterWorkUsage(fixture.colleague, {
    tenantId: fixture.tenantId,
    serviceId: 'subcontractor-compliance',
    workId: work.id,
    metric: 'onboarded-subcontractor',
    quantity: '1',
  });
  assert.equal(second.converged, true, 'same billable work converges on ONE usage row');
  assert.equal(second.usage.id, first.usage.id);
  assert.equal(fixture.app.billingStore.usage.size, 1, 'never two rows for one billable work');
  // Divergent content for the same work fails closed.
  await expectBillingError('USAGE_INPUT_CONFLICT', () =>
    fixture.app.billing.meterWorkUsage(fixture.owner, {
      tenantId: fixture.tenantId,
      serviceId: 'subcontractor-compliance',
      workId: work.id,
      metric: 'onboarded-subcontractor',
      quantity: '2',
    }),
  );
  assert.equal(fixture.app.billingStore.usage.size, 1, 'the rejected divergence never persists');
});

test('duplicate outcome metering converges; the outcome identity is billable exactly once', async () => {
  const fixture = await base();
  await cataloged(fixture);
  await activeSubscription(fixture);
  const first = await fixture.app.billing.meterOutcomeUsage(fixture.owner, {
    tenantId: fixture.tenantId,
    serviceId: 'subcontractor-compliance',
    outcomeId: 'subcontractor-compliant',
    metric: 'processed-document',
    quantity: '1',
  });
  const second = await fixture.app.billing.meterOutcomeUsage(fixture.colleague, {
    tenantId: fixture.tenantId,
    serviceId: 'subcontractor-compliance',
    outcomeId: 'subcontractor-compliant',
    metric: 'processed-document',
    quantity: '1',
  });
  assert.equal(second.converged, true);
  assert.equal(second.usage.id, first.usage.id);
  await expectBillingError('USAGE_INPUT_CONFLICT', () =>
    fixture.app.billing.meterOutcomeUsage(fixture.owner, {
      tenantId: fixture.tenantId,
      serviceId: 'subcontractor-compliance',
      outcomeId: 'subcontractor-compliant',
      metric: 'processed-document',
      quantity: '3',
    }),
  );
});

// ---------------------------------------------------------------------------
// Settlement (concurrency requirement, in the single-actor case here)
// ---------------------------------------------------------------------------

test('settlement prices the period exactly: recurring + rated usage; unrated metered usage charges zero', async () => {
  const fixture = await base();
  await cataloged(fixture);
  // A hybrid plan pricing ONLY onboarded-subcontractor: processed-document
  // stays meterable but unrated (it charges zero — the plan decides).
  const { subscription } = await fixture.app.billing.registerSubscription(fixture.owner, {
    tenantId: fixture.tenantId,
    serviceId: 'subcontractor-compliance',
    plan: {
      model: 'hybrid',
      currency: 'EUR',
      recurring: { amount: '199.00' },
      workRates: [{ metric: 'onboarded-subcontractor', unitPrice: '25.50' }],
    },
    idempotencyKey: 'sub-partial-rate',
  });
  await fixture.app.billing.activateSubscription(fixture.owner, fixture.tenantId, subscription.id);
  const workA = await createWorkFor(fixture, fixture.owner, 'Onboard Acme');
  const workB = await createWorkFor(fixture, fixture.owner, 'Onboard Beta');
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
  await fixture.app.billing.meterOutcomeUsage(fixture.owner, {
    tenantId: fixture.tenantId,
    serviceId: 'subcontractor-compliance',
    outcomeId: 'subcontractor-compliant',
    metric: 'processed-document',
    quantity: '100',
  });
  // Metered on a metric the plan does NOT price: contributes ZERO charge
  // (metering is measurement; charging follows the plan). This
  // subscription prices ONLY onboarded-subcontractor.
  const workC = await createWorkFor(fixture, fixture.owner, 'Onboard Gamma');
  await fixture.app.billing.meterWorkUsage(fixture.owner, {
    tenantId: fixture.tenantId,
    serviceId: 'subcontractor-compliance',
    workId: workC.id,
    metric: 'processed-document',
    quantity: '4',
  });
  const { ledger, converged } = await fixture.app.billing.settleBillingPeriod(fixture.owner, {
    tenantId: fixture.tenantId,
    serviceId: 'subcontractor-compliance',
    billingPeriod: PERIOD,
  });
  assert.equal(converged, false);
  assert.equal(ledger.subscriptionCharge, '199');
  // 2*25.5 + 1*25.5 (rated) + 0 (outcome: unrated by this plan) + 0
  // (workC: unrated by this plan) = 76.5
  assert.equal(ledger.usageCharge, '76.5');
  assert.equal(ledger.totalCharge, '275.5');
  assert.equal(ledger.usageCount, 4);
  assert.equal(ledger.currency, 'EUR');
  // Every settled usage row points at the ledger outcome.
  const usage = await fixture.app.billing.listUsageRecords(fixture.owner, fixture.tenantId, { billingPeriod: PERIOD });
  assert.equal(usage.length, 4);
  for (const record of usage) {
    assert.equal(record.settledLedgerId, ledger.id);
  }
});

test('re-settling a settled period converges on the SAME durable ledger outcome (no double-charge)', async () => {
  const fixture = await base();
  await cataloged(fixture);
  await activeSubscription(fixture);
  const work = await createWorkFor(fixture, fixture.owner, 'Onboard Acme');
  await fixture.app.billing.meterWorkUsage(fixture.owner, {
    tenantId: fixture.tenantId,
    serviceId: 'subcontractor-compliance',
    workId: work.id,
    metric: 'onboarded-subcontractor',
    quantity: '1',
  });
  const first = await fixture.app.billing.settleBillingPeriod(fixture.owner, {
    tenantId: fixture.tenantId,
    serviceId: 'subcontractor-compliance',
    billingPeriod: PERIOD,
  });
  const second = await fixture.app.billing.settleBillingPeriod(fixture.colleague, {
    tenantId: fixture.tenantId,
    serviceId: 'subcontractor-compliance',
    billingPeriod: PERIOD,
  });
  assert.equal(second.converged, true);
  assert.equal(second.ledger.id, first.ledger.id);
  assert.equal(fixture.app.billingStore.ledger.size, 1, 'exactly one ledger outcome per period');
  // Late usage after settlement stays metered but is never re-billed into
  // the settled period (one authoritative outcome; no double-charge).
  const lateWork = await createWorkFor(fixture, fixture.owner, 'Onboard Late');
  const late = await fixture.app.billing.meterWorkUsage(fixture.owner, {
    tenantId: fixture.tenantId,
    serviceId: 'subcontractor-compliance',
    workId: lateWork.id,
    metric: 'onboarded-subcontractor',
    quantity: '1',
  });
  assert.equal(late.usage.settledLedgerId, null, 'late usage is metered, not silently billed');
  const settled = await fixture.app.billing.getLedgerEntry(fixture.owner, fixture.tenantId, 'subcontractor-compliance', PERIOD);
  assert.equal(settled?.totalCharge, first.ledger.totalCharge, 'the settled outcome is immutable');
  assert.equal(settled?.usageCount, 1);
});

test('settlement requires a non-draft subscription and a valid period', async () => {
  const fixture = await base();
  await cataloged(fixture);
  const { subscription } = await fixture.app.billing.registerSubscription(fixture.owner, {
    tenantId: fixture.tenantId,
    serviceId: 'subcontractor-compliance',
    plan: subscriptionPlan('subscription'),
  });
  await expectBillingError('SUBSCRIPTION_NOT_ACTIVE', () =>
    fixture.app.billing.settleBillingPeriod(fixture.owner, {
      tenantId: fixture.tenantId,
      serviceId: 'subcontractor-compliance',
      billingPeriod: PERIOD,
    }),
  );
  await fixture.app.billing.activateSubscription(fixture.owner, fixture.tenantId, subscription.id);
  await expectBillingError('PERIOD_INVALID', () =>
    fixture.app.billing.settleBillingPeriod(fixture.owner, {
      tenantId: fixture.tenantId,
      serviceId: 'subcontractor-compliance',
      billingPeriod: '2026-13',
    }),
  );
  const empty = await fixture.app.billing.settleBillingPeriod(fixture.owner, {
    tenantId: fixture.tenantId,
    serviceId: 'subcontractor-compliance',
    billingPeriod: PERIOD,
  });
  assert.equal(empty.ledger.usageCount, 0, 'an empty period settles at the recurring charge only');
  assert.equal(empty.ledger.usageCharge, '0');
  assert.equal(empty.ledger.totalCharge, '199');
});

// ---------------------------------------------------------------------------
// Cost references + margin (AC-3)
// ---------------------------------------------------------------------------

test('cost references record as opaque non-authoritative references (AC-3)', async () => {
  const fixture = await base();
  const { reference, converged } = await fixture.app.billing.recordCostReference(fixture.owner, {
    tenantId: fixture.tenantId,
    billingPeriod: PERIOD,
    source: 'ai_authority',
    externalReference: 'statement-2026-09-0001',
    amount: '52.25',
    currency: 'EUR',
    idempotencyKey: 'cost-1',
  });
  assert.equal(converged, false);
  assert.equal(reference.source, 'ai_authority');
  assert.equal(reference.amount, '52.25');
  // Keyed convergence.
  const again = await fixture.app.billing.recordCostReference(fixture.owner, {
    tenantId: fixture.tenantId,
    billingPeriod: PERIOD,
    source: 'ai_authority',
    externalReference: 'statement-2026-09-0001',
    amount: '52.25',
    currency: 'EUR',
    idempotencyKey: 'cost-1',
  });
  assert.equal(again.converged, true);
  // Divergent content for the same key fails closed.
  await expectBillingError('IDEMPOTENCY_INPUT_CONFLICT', () =>
    fixture.app.billing.recordCostReference(fixture.owner, {
      tenantId: fixture.tenantId,
      billingPeriod: PERIOD,
      source: 'ai_authority',
      externalReference: 'statement-2026-09-0001',
      amount: '99',
      currency: 'EUR',
      idempotencyKey: 'cost-1',
    }),
  );
});

test('cost references cannot smuggle provider/model/usage breakdowns (AC-3 boundary)', async () => {
  const fixture = await base();
  const forbiddenKeys = ['provider', 'model', 'modelName', 'tokens', 'usage', 'prompt', 'perModel', 'modelRates', 'rateCard'];
  for (const key of forbiddenKeys) {
    const input: Record<string, unknown> = {
      tenantId: fixture.tenantId,
      billingPeriod: PERIOD,
      source: 'ai_authority',
      externalReference: 'statement-1',
      amount: '10',
      currency: 'EUR',
      idempotencyKey: `cost-${key}`,
    };
    input[key] = 'anything';
    await expectBillingError('AI_COST_BREAKDOWN_FORBIDDEN', () =>
      fixture.app.billing.recordCostReference(fixture.owner, input as unknown as Parameters<typeof fixture.app.billing.recordCostReference>[1]),
    );
  }
  // The source enumeration is closed: no provider-specific source exists.
  await expectBillingError('INVALID_INPUT', () =>
    fixture.app.billing.recordCostReference(fixture.owner, {
      tenantId: fixture.tenantId,
      billingPeriod: PERIOD,
      source: 'some-provider' as 'ai_authority',
      externalReference: 'statement-1',
      amount: '10',
      currency: 'EUR',
      idempotencyKey: 'cost-bad-source',
    }),
  );
});

test('the margin report derives revenue minus external cost references per currency (AC-3)', async () => {
  const fixture = await base();
  await cataloged(fixture);
  await activeSubscription(fixture);
  const work = await createWorkFor(fixture, fixture.owner, 'Onboard Acme');
  await fixture.app.billing.meterWorkUsage(fixture.owner, {
    tenantId: fixture.tenantId,
    serviceId: 'subcontractor-compliance',
    workId: work.id,
    metric: 'onboarded-subcontractor',
    quantity: '2',
  });
  await fixture.app.billing.settleBillingPeriod(fixture.owner, {
    tenantId: fixture.tenantId,
    serviceId: 'subcontractor-compliance',
    billingPeriod: PERIOD,
  });
  await fixture.app.billing.recordCostReference(fixture.owner, {
    tenantId: fixture.tenantId,
    billingPeriod: PERIOD,
    source: 'ai_authority',
    externalReference: 'statement-2026-09-0001',
    amount: '52.25',
    currency: 'EUR',
    idempotencyKey: 'cost-eur',
  });
  await fixture.app.billing.recordCostReference(fixture.owner, {
    tenantId: fixture.tenantId,
    billingPeriod: PERIOD,
    source: 'ai_authority',
    externalReference: 'statement-2026-09-0002',
    amount: '10',
    currency: 'USD',
    idempotencyKey: 'cost-usd',
  });
  const report = await fixture.app.billing.computeMarginReport(fixture.owner, fixture.tenantId, PERIOD);
  assert.equal(report.lines.length, 2, 'one line per currency');
  const eur = report.lines.find((line) => line.currency === 'EUR');
  const usd = report.lines.find((line) => line.currency === 'USD');
  assert.notEqual(eur, undefined);
  assert.notEqual(usd, undefined);
  // 199 + 2*25.5 = 250 revenue; 52.25 costs.
  assert.equal(eur?.revenue, '250');
  assert.equal(eur?.externalCosts, '52.25');
  assert.equal(eur?.margin, '197.75');
  assert.equal(eur?.settledLedgerCount, 1);
  assert.equal(eur?.costReferenceCount, 1);
  assert.equal(usd?.revenue, '0');
  assert.equal(usd?.margin, '-10', 'a negative margin is reported as an exact signed decimal');
  // The report is DERIVED: nothing margin-shaped persists.
  assert.equal(fixture.app.billingStore.ledger.size, 1);
  assert.equal(fixture.app.billingStore.costReferences.size, 2);
});

// ---------------------------------------------------------------------------
// Tamper detection, authorization, tenancy
// ---------------------------------------------------------------------------

test('after-the-fact mutation of stored rows is detected on read', async () => {
  const fixture = await base();
  await cataloged(fixture);
  const subscription = await activeSubscription(fixture);
  const work = await createWorkFor(fixture, fixture.owner, 'Onboard Acme');
  await fixture.app.billing.meterWorkUsage(fixture.owner, {
    tenantId: fixture.tenantId,
    serviceId: 'subcontractor-compliance',
    workId: work.id,
    metric: 'onboarded-subcontractor',
    quantity: '1',
  });
  await fixture.app.billing.settleBillingPeriod(fixture.owner, {
    tenantId: fixture.tenantId,
    serviceId: 'subcontractor-compliance',
    billingPeriod: PERIOD,
  });
  await fixture.app.billing.recordCostReference(fixture.owner, {
    tenantId: fixture.tenantId,
    billingPeriod: PERIOD,
    source: 'ai_authority',
    externalReference: 'statement-1',
    amount: '5',
    currency: 'EUR',
    idempotencyKey: 'cost-tamper',
  });
  // Subscription content tamper.
  fixture.app.billingStore.subscriptions.get(subscription.id)!.plan = { ...subscription.plan, currency: 'USD' };
  await expectBillingError('SUBSCRIPTION_RECORD_TAMPERED', () =>
    fixture.app.billing.getSubscription(fixture.owner, fixture.tenantId, subscription.id),
  );
  // Usage quantity tamper.
  const usageRow = [...fixture.app.billingStore.usage.values()][0]!;
  usageRow.quantity = '999';
  await expectBillingError('USAGE_RECORD_TAMPERED', () =>
    fixture.app.billing.listUsageRecords(fixture.owner, fixture.tenantId, { billingPeriod: PERIOD }),
  );
  // Ledger charge tamper.
  const ledgerRow = [...fixture.app.billingStore.ledger.values()][0]!;
  ledgerRow.totalCharge = '9999';
  await expectBillingError('LEDGER_RECORD_TAMPERED', () =>
    fixture.app.billing.listLedgerEntries(fixture.owner, fixture.tenantId, PERIOD),
  );
  // Cost reference amount tamper.
  const costRow = [...fixture.app.billingStore.costReferences.values()][0]!;
  costRow.amount = '0';
  await expectBillingError('COST_REFERENCE_RECORD_TAMPERED', () =>
    fixture.app.billing.listCostReferences(fixture.owner, fixture.tenantId, PERIOD),
  );
});

test('authorization happens BEFORE any domain data access; denials never touch data', async () => {
  const fixture = await base();
  const outsider = await fixture.app.auth.registerHuman({ email: 'out@c.com', password: PASSWORD, displayName: 'Outsider' });
  await cataloged(fixture);
  await activeSubscription(fixture);
  const subscriptionReads = fixture.app.billingStore.reads.subscriptionsList;
  await expectBillingError('TENANT_FORBIDDEN', () =>
    fixture.app.billing.listSubscriptions(outsider, fixture.tenantId),
  );
  await expectBillingError('TENANT_FORBIDDEN', () =>
    fixture.app.billing.meterWorkUsage(outsider, {
      tenantId: fixture.tenantId,
      serviceId: 'subcontractor-compliance',
      workId: '00000000-0000-4000-8000-000000000001',
      metric: 'onboarded-subcontractor',
      quantity: '1',
    }),
  );
  assert.equal(fixture.app.billingStore.reads.subscriptionsList, subscriptionReads, 'denials never touch data');
});

test('cross-tenant reads are indistinguishable from missing records', async () => {
  const fixture = await base();
  await cataloged(fixture);
  await activeSubscription(fixture);
  // The other tenant owns its own catalog and subscription.
  await fixture.app.verticals.registerVerticalPackage(fixture.otherOwner, packageInput(fixture.otherTenantId, 1));
  await fixture.app.services.registerServiceDefinition(fixture.otherOwner, serviceInput(fixture.otherTenantId, 1, 'svc-other'));
  await fixture.app.services.activateServiceDefinition(fixture.otherOwner, fixture.otherTenantId, 'subcontractor-compliance', 1);
  const otherSubscription = await fixture.app.billing.registerSubscription(fixture.otherOwner, {
    tenantId: fixture.otherTenantId,
    serviceId: 'subcontractor-compliance',
    plan: subscriptionPlan('subscription'),
  });
  // A principal of the primary tenant reading the OTHER tenant's row id:
  // authorized for its own tenant, the row is simply absent (the store
  // predicate never returns another tenant's row).
  const read = await fixture.app.billing.getSubscription(fixture.owner, fixture.tenantId, otherSubscription.subscription.id);
  assert.equal(read, null);
  const ledger = await fixture.app.billing.getLedgerEntry(fixture.owner, fixture.tenantId, 'subcontractor-compliance', PERIOD);
  assert.equal(ledger, null);
  // The other tenant has its own independent billing surface.
  const otherReport = await fixture.app.billing.computeMarginReport(fixture.otherOwner, fixture.otherTenantId, PERIOD);
  assert.equal(otherReport.lines.length, 0);
  assert.equal(fixture.app.billingStore.subscriptions.size, 2, 'each tenant has its own subscription');
});
