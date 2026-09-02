/**
 * Concurrency proof: duplicate dispatch convergence and deterministic
 * conflict arbitration (WORK-015 — "concurrent dispatch converges; two
 * consumers do not produce duplicate domain effects").
 *
 * The in-memory store's async hooks inject deterministic interleaving
 * points BEFORE the synchronous critical sections (the exact semantics
 * of the row FOR UPDATE locks in the SQL store), so these proofs
 * exercise real check-then-act races:
 *
 * - concurrent keyed intent creations converge on ONE logical
 *   interaction (exactly one creator observes converged);
 * - concurrent dispatches of one interaction: exactly ONE adapter
 *   invocation — the loser of the claim CAS fails closed with
 *   DISPATCH_IN_PROGRESS or converges on the dispatched record;
 * - concurrent same-payload observations converge; divergent
 *   observations arbitrate deterministically (one wins, one fails);
 * - concurrent notification dispatches converge on ONE interaction and
 *   ONE adapter invocation;
 * - concurrent identical notification retries converge on ONE retry
 *   interaction (the caller-keyed convergence);
 * - DISCRIMINATION: a mutated store that skips the claim CAS accepts
 *   BOTH dispatchers (double adapter invocations) — the anomaly the
 *   guarded store prevents is detectable, proving the guard is
 *   load-bearing.
 *
 * The SQL-level equivalents of the same races run against live
 * PostgreSQL in test/interactions.integration.test.ts (CI).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildExternalEffectsApp,
  InMemoryInteractionsStore,
  type ExternalEffectsApp,
} from './helpers/in-memory-stores.js';
import type { Principal } from '../src/modules/auth/index.js';
import {
  InteractionsError,
  InteractionsStoreRuleError,
  type InteractionsStore,
} from '../src/modules/interactions/index.js';
import { createInMemoryProviderAdapter, createAdapterRegistry, createEffectSink } from '../src/modules/integrations/index.js';
import {
  computeInteractionRecordHash,
  createInteractionsModule,
  type ClaimDispatchInput,
  type InteractionRecord,
} from '../src/modules/interactions/index.js';

const PASSWORD = 'correct horse battery 7';
const EMAIL_PARAMS = { to: ['vendor@example.com'], subject: 'Certificate', body: 'Please send it.' };

interface Base {
  app: ExternalEffectsApp;
  owner: Principal;
  colleague: Principal;
  tenantId: string;
  emailLog: ReturnType<typeof createInMemoryProviderAdapter>['log'];
}

async function base(options: Parameters<typeof buildExternalEffectsApp>[0] = {}): Promise<Base> {
  const { adapter: emailAdapter, log: emailLog } = createInMemoryProviderAdapter('email');
  const registry = createAdapterRegistry();
  registry.register(emailAdapter);
  registry.seal();
  const app = buildExternalEffectsApp({
    ...options,
    capabilities: [],
    sink: options.sink ?? createEffectSink(registry),
  });
  const owner = await app.auth.registerHuman({ email: 'owner@a.com', password: PASSWORD, displayName: 'Owner' });
  const colleague = await app.auth.registerHuman({ email: 'member@a.com', password: PASSWORD, displayName: 'Member' });
  const created = await app.organizations.createOrganization(owner, { slug: 'alpha-org', displayName: 'Alpha' });
  await app.organizations.addMember(owner, 'alpha-org', { principalId: colleague.id, role: 'member' });
  return { app, owner, colleague, tenantId: created.tenant.id, emailLog };
}

async function intend(b: Base, key?: string): Promise<InteractionRecord> {
  const { interaction } = await b.app.interactions.createInteraction(b.owner, b.tenantId, {
    capability: 'email',
    params: EMAIL_PARAMS,
    idempotencyKey: key,
  });
  return interaction;
}

// ---------------------------------------------------------------------------
// Concurrent keyed intent creations
// ---------------------------------------------------------------------------

test('concurrent keyed intent creations converge on ONE logical interaction', async () => {
  const b = await base();
  const [a, c] = await Promise.all([
    b.app.interactions.createInteraction(b.owner, b.tenantId, { capability: 'email', params: EMAIL_PARAMS, idempotencyKey: 'race-1' }),
    b.app.interactions.createInteraction(b.colleague, b.tenantId, { capability: 'email', params: EMAIL_PARAMS, idempotencyKey: 'race-1' }),
  ]);
  assert.equal(a.interaction.id, c.interaction.id);
  assert.equal(a.converged || c.converged, true);
  assert.equal(a.converged && c.converged, false, 'exactly one creator observes convergence');
  assert.equal((await b.app.interactions.listInteractions(b.owner, b.tenantId)).length, 1);
});

// ---------------------------------------------------------------------------
// Concurrent dispatches: exactly ONE adapter invocation
// ---------------------------------------------------------------------------

test('concurrent dispatches of one interaction: ONE adapter invocation, the loser fails or converges deterministically', async () => {
  const b = await base();
  const interaction = await intend(b, 'dispatch-race');
  const outcomes = await Promise.allSettled([
    b.app.interactions.dispatchInteraction(b.owner, b.tenantId, interaction.id),
    b.app.interactions.dispatchInteraction(b.colleague, b.tenantId, interaction.id),
  ]);
  const fulfilled = outcomes.flatMap((outcome) => (outcome.status === 'fulfilled' ? [outcome.value] : []));
  const rejected = outcomes.flatMap((outcome) =>
    outcome.status === 'rejected' ? [{ error: outcome.reason as InteractionsError }] : [],
  );
  // Exactly one dispatcher invoked the adapter.
  assert.equal(fulfilled.length, 1, 'exactly one dispatch settles');
  const winner = fulfilled[0] as { interaction: InteractionRecord; invoked: boolean };
  assert.equal(winner.invoked, true);
  assert.equal(winner.interaction.state, 'dispatched');
  // The loser failed closed with the typed, recoverable in-flight error.
  assert.equal(rejected.length, 1);
  const loser = (rejected[0] as { error: InteractionsError }).error;
  assert.ok(loser instanceof InteractionsError);
  assert.equal(loser.code, 'DISPATCH_IN_PROGRESS');
  // ONE provider effect for the identity — never a double side effect.
  assert.equal(b.emailLog.count(), 1);
  assert.equal(b.emailLog.find(interaction.id)?.attempts, 1);
});

test('sequential re-dispatch after a settled dispatch converges without invocation', async () => {
  const b = await base();
  const interaction = await intend(b, 'settle-1');
  await b.app.interactions.dispatchInteraction(b.owner, b.tenantId, interaction.id);
  const second = await b.app.interactions.dispatchInteraction(b.colleague, b.tenantId, interaction.id);
  assert.equal(second.invoked, false);
  assert.equal(second.converged, true);
  assert.equal(b.emailLog.count(), 1);
});

test('concurrent recovery converges: the provider sees ONE effect (adapter identity idempotency)', async () => {
  const b = await base({ storeOptions: { crashAfterClaim: true, oneShotCrash: true } });
  const interaction = await intend(b, 'recover-race');
  // Dispatcher 1 crashes after the claim (the W2 window).
  await assert.rejects(
    b.app.interactions.dispatchInteraction(b.owner, b.tenantId, interaction.id),
    (error: unknown) => error instanceof Error && /SIMULATED CRASH/.test(error.message),
  );
  // Two concurrent recoverers: both re-claim and re-invoke the adapter
  // with the SAME durable identity — the adapter contract converges
  // (ONE effect); the module settles deterministically.
  const outcomes = await Promise.allSettled([
    b.app.interactions.recoverInteraction(b.owner, b.tenantId, interaction.id),
    b.app.interactions.recoverInteraction(b.colleague, b.tenantId, interaction.id),
  ]);
  // Every settled outcome shows the dispatched record; any completion
  // conflict converged on the durable record.
  for (const outcome of outcomes) {
    if (outcome.status === 'fulfilled') {
      assert.ok(['dispatched', 'observed'].includes(outcome.value.interaction.state));
    } else {
      const reason = outcome.reason as InteractionsError;
      assert.ok(reason instanceof InteractionsError);
      // The only legal loser failure is the completion race converging
      // (mapped) or the in-flight claim; a raw store rule escaping is a
      // defect.
      assert.ok(['DISPATCH_IN_PROGRESS', 'INTERACTION_NOT_FOUND'].includes(reason.code));
    }
  }
  // THE invariant: exactly ONE provider effect for the identity.
  assert.equal(b.emailLog.count(), 1);
  assert.equal(b.emailLog.find(interaction.id)?.attempts, 2);
  // And the durable state is settled.
  const view = await b.app.interactions.getInteraction(b.owner, b.tenantId, interaction.id);
  assert.equal(view.state, 'dispatched');
});

// ---------------------------------------------------------------------------
// Concurrent observations: convergence and deterministic arbitration
// ---------------------------------------------------------------------------

test('concurrent identical observations converge on ONE durable observation', async () => {
  const b = await base();
  const interaction = await intend(b, 'obs-race');
  await b.app.interactions.dispatchInteraction(b.owner, b.tenantId, interaction.id);
  const [a, c] = await Promise.all([
    b.app.interactions.recordObservedResult(b.owner, b.tenantId, interaction.id, { outcome: 'succeeded', providerObservation: { receipt: 'r9' } }),
    b.app.interactions.recordObservedResult(b.colleague, b.tenantId, interaction.id, { outcome: 'succeeded', providerObservation: { receipt: 'r9' } }),
  ]);
  assert.equal(a.interaction.observation?.observedBy, c.interaction.observation?.observedBy);
  assert.equal(a.converged || c.converged, true);
  assert.notEqual(a.converged && c.converged, true);
  assert.equal(b.emailLog.count(), 1);
});

test('concurrent divergent observations arbitrate deterministically: one wins, one fails closed', async () => {
  const b = await base();
  const interaction = await intend(b, 'obs-conflict-race');
  await b.app.interactions.dispatchInteraction(b.owner, b.tenantId, interaction.id);
  const outcomes = await Promise.allSettled([
    b.app.interactions.recordObservedResult(b.owner, b.tenantId, interaction.id, { outcome: 'succeeded', providerObservation: { receipt: 'A' } }),
    b.app.interactions.recordObservedResult(b.colleague, b.tenantId, interaction.id, { outcome: 'failed', providerObservation: { receipt: 'B' } }),
  ]);
  const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
  assert.equal(rejected.length, 1, 'exactly one divergent observation fails closed');
  const reason = (rejected[0] as { reason: InteractionsError }).reason;
  assert.ok(reason instanceof InteractionsError);
  assert.equal(reason.code, 'OBSERVATION_CONFLICT');
  // The durable record carries EXACTLY ONE observation.
  const view = await b.app.interactions.getInteraction(b.owner, b.tenantId, interaction.id);
  assert.equal(view.state, 'observed');
  assert.ok(view.observation !== null);
  assert.ok(['A', 'B'].includes((view.observation.providerObservation as { receipt: string }).receipt));
});

// ---------------------------------------------------------------------------
// Concurrent notification dispatch and retry (notification authority)
// ---------------------------------------------------------------------------

test('concurrent notification dispatches converge on ONE interaction and ONE adapter invocation', async () => {
  const b = await base();
  const { notification } = await b.app.notifications.requestNotification(b.owner, b.tenantId, {
    channel: 'email',
    recipient: { address: 'vendor@example.com' },
    content: { subject: 'Onboarding', body: 'Welcome.' },
    idempotencyKey: 'notif-race-1',
  });
  const outcomes = await Promise.allSettled([
    b.app.notifications.dispatchNotification(b.owner, b.tenantId, notification.id),
    b.app.notifications.dispatchNotification(b.colleague, b.tenantId, notification.id),
  ]);
  // Both settle (one dispatches, the other converges on the keyed
  // interaction + claim CAS), OR the loser fails with the typed
  // in-flight error. Never a second effect.
  let failures = 0;
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') {
      failures += 1;
      const reason = outcome.reason as InteractionsError;
      assert.ok(reason instanceof InteractionsError, `unexpected rejection: ${outcome.reason}`);
      assert.equal(reason.code, 'DISPATCH_IN_PROGRESS');
    } else {
      assert.ok(['in_flight', 'delivered', 'failed'].includes(outcome.value.view.delivery));
    }
  }
  assert.ok(failures <= 1);
  // ONE interaction, ONE provider effect.
  assert.equal((await b.app.interactions.listInteractions(b.owner, b.tenantId)).length, 1);
  assert.equal(b.emailLog.count(), 1);
  // The pointer is pinned exactly once (idempotent write).
  const view = await b.app.notifications.getNotification(b.owner, b.tenantId, notification.id);
  assert.notEqual(view.interaction, null);
  assert.equal(view.delivery, 'in_flight');
});

test('concurrent identical notification retries converge on ONE retry interaction', async () => {
  const b2 = await failingFirstBase();
  const { notification } = await b2.app.notifications.requestNotification(b2.owner, b2.tenantId, {
    channel: 'email',
    recipient: { address: 'vendor@example.com' },
    content: { subject: 'Chase', body: 'Please respond.' },
    idempotencyKey: 'notif-retry-race',
  });
  const first = await b2.app.notifications.dispatchNotification(b2.owner, b2.tenantId, notification.id);
  assert.equal(first.view.delivery, 'failed', 'the first delivery failed (injected provider failure)');
  // Two concurrent retries with the SAME retry key: they converge on ONE
  // retry interaction (the /interactions keyed convergence).
  const retries = await Promise.allSettled([
    b2.app.notifications.retryNotification(b2.owner, b2.tenantId, notification.id, { idempotencyKey: 'retry-1' }),
    b2.app.notifications.retryNotification(b2.colleague, b2.tenantId, notification.id, { idempotencyKey: 'retry-1' }),
  ]);
  let failures = 0;
  for (const outcome of retries) {
    if (outcome.status === 'rejected') {
      failures += 1;
      const reason = outcome.reason as InteractionsError;
      assert.ok(reason instanceof InteractionsError, `unexpected rejection: ${outcome.reason}`);
      assert.ok(['DISPATCH_IN_PROGRESS'].includes(reason.code));
    } else {
      assert.equal(outcome.value.view.interaction?.retryOfInteractionId, first.view.interaction?.id);
      assert.ok(['in_flight', 'delivered', 'failed'].includes(outcome.value.view.delivery));
    }
  }
  assert.ok(failures <= 1);
  // ONE retry interaction; the failed ORIGINAL recorded no provider
  // effect (its dispatch failed before any effect), so the single
  // recorded effect belongs to the retry identity.
  const interactions = await b2.app.interactions.listInteractions(b2.owner, b2.tenantId);
  assert.equal(interactions.length, 2, 'the failed original + ONE retry');
  assert.equal(b2.emailLog.count(), 1);
  assert.equal(b2.emailLog.find(interactions[1]!.id)?.attempts, 1, 'the retry identity was dispatched once');
  assert.equal(b2.emailLog.find(interactions[0]!.id), null, 'the failed original produced no provider effect');
});

/** A base whose email adapter fails the first dispatch, then works. */
async function failingFirstBase(): Promise<Base> {
  const { adapter: emailAdapter, log: emailLog } = createInMemoryProviderAdapter('email', { failNextDispatches: 1 });
  const registry = createAdapterRegistry();
  registry.register(emailAdapter);
  registry.seal();
  const app = buildExternalEffectsApp({ capabilities: [], sink: createEffectSink(registry) });
  const owner = await app.auth.registerHuman({ email: 'owner@a.com', password: PASSWORD, displayName: 'Owner' });
  const colleague = await app.auth.registerHuman({ email: 'member@a.com', password: PASSWORD, displayName: 'Member' });
  const created = await app.organizations.createOrganization(owner, { slug: 'alpha-org', displayName: 'Alpha' });
  await app.organizations.addMember(owner, 'alpha-org', { principalId: colleague.id, role: 'member' });
  return { app, owner, colleague, tenantId: created.tenant.id, emailLog };
}

// ---------------------------------------------------------------------------
// Discrimination: the claim CAS is load-bearing
// ---------------------------------------------------------------------------

/**
 * A MUTATED store that skips the dispatch-claim CAS check: the state
 * transition is applied but the `intended`-state precondition is NOT
 * verified, so any caller can claim regardless of state. This is the
 * discrimination/mutation proof — the anomaly the guarded store
 * prevents (double adapter invocations for one interaction) becomes
 * observable here, proving the guard is load-bearing.
 */
class CASSkippingInteractionsStore extends InMemoryInteractionsStore {
  async claimDispatch(input: ClaimDispatchInput): Promise<InteractionRecord> {
    await this.options.beforeClaimDispatch?.();
    const row = this.interactions.get(input.interactionId);
    if (row === undefined || row.tenantId !== input.tenantId) {
      throw new InteractionsStoreRuleError(
        `interaction ${input.interactionId} does not exist in this tenant`,
        'dispatch-claim-conflict',
      );
    }
    // THE MUTATION: no state CHECK — both concurrent claimants "win" the
    // claim and both proceed to invoke the adapter.
    row.state = 'dispatching';
    row.claim = { claimedBy: input.claimedBy, claimedAt: input.now };
    row.recordHash = computeInteractionRecordHash(row);
    return { ...row, correlation: { ...row.correlation } };
  }
}

test('DISCRIMINATION: without the claim CAS, both dispatchers invoke the adapter (the guarded store prevents this)', async () => {
  const { adapter: emailAdapter, log } = createInMemoryProviderAdapter('email');
  const registry = createAdapterRegistry();
  registry.register(emailAdapter);
  registry.seal();
  const app = buildExternalEffectsApp({ capabilities: [], sink: createEffectSink(registry) });
  const owner = await app.auth.registerHuman({ email: 'owner@a.com', password: PASSWORD, displayName: 'Owner' });
  const colleague = await app.auth.registerHuman({ email: 'member@a.com', password: PASSWORD, displayName: 'Member' });
  const created = await app.organizations.createOrganization(owner, { slug: 'alpha-org', displayName: 'Alpha' });
  await app.organizations.addMember(owner, 'alpha-org', { principalId: colleague.id, role: 'member' });

  // Replace the store with the CAS-skipping mutant: the module logic is
  // IDENTICAL, only the store's guard is removed.
  const mutatedStore = new CASSkippingInteractionsStore({});
  for (const [id, row] of app.interactionsStore.interactions) mutatedStore.interactions.set(id, row);
  const mutatedModule = createInteractionsModule({
    store: mutatedStore,
    eventsStore: app.eventsStore,
    eventDelivery: app.eventDelivery,
    tenancy: app.organizations,
    policies: app.policies,
    sink: createEffectSink(registry),
  });

  const { interaction } = await mutatedModule.createInteraction(owner, created.tenant.id, {
    capability: 'email',
    params: EMAIL_PARAMS,
    idempotencyKey: 'mutant-1',
  });
  const outcomes = await Promise.allSettled([
    mutatedModule.dispatchInteraction(owner, created.tenant.id, interaction.id),
    mutatedModule.dispatchInteraction(colleague, created.tenant.id, interaction.id),
  ]);
  // With the claim CAS removed, BOTH dispatchers claim and BOTH invoke
  // the adapter: TWO dispatch attempts for one interaction identity —
  // the double-invocation anomaly. (The provider-side identity
  // idempotency keeps the EFFECT count at one — the contract backstop —
  // but the authority-level single-flight guarantee is gone.)
  const attempts = log.find(interaction.id)?.attempts ?? 0;
  assert.equal(
    attempts,
    2,
    `the CAS-skipping mutant must exhibit the double-invocation anomaly (got ${attempts} attempts)`,
  );
  // The guarded outcome under the REAL store is exactly one invocation
  // (proven by the concurrent-dispatch test above): the guard is
  // load-bearing, not decorative.
  const settled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
  assert.equal(settled.length, 1, 'one completion survives; the other fails the completion CAS');
});
