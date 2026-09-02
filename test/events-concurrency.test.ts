/**
 * Concurrency + crash-safety proof: the /interactions durable event
 * substrate (WORK-006 — "two consumers of the same event do not produce
 * duplicate domain effects; crash between intent and dispatch
 * converges").
 *
 * Proven over the faithful in-memory event store with REAL parallel
 * actors (Promise.all through the module's async surfaces) and
 * deterministic race-injection hooks:
 *
 * - parallel duplicate deliveries converge on ONE durable inbox record;
 * - parallel inbox workers of the same event: ONE consumer invocation,
 *   ONE domain effect (the observation recorded exactly once — the
 *   loser converges on the durable result or surfaces the typed
 *   in-progress state);
 * - the CAS-SKIPPING MUTANT discrimination: without the claim CAS both
 *   workers invoke the consumer (the authority-level single-flight
 *   guarantee is gone) — the guarded store prevents this;
 * - the inbox crash window (claim stands, consumer never ran) recovers
 *   convergently: the re-invoked idempotent consumer converges on the
 *   same durable observation;
 * - parallel outbox dispatches: ONE delivery-port invocation (the loser
 *   fails closed typed or converges);
 * - the outbox CAS-SKIPPING MUTANT discrimination: both dispatchers
 *   invoke the port (single-flight gone; the provider-side identity
 *   idempotency remains the contract backstop);
 * - the outbox crash windows converge: crash AFTER the claim (intent
 *   claimed, nothing delivered) and crash AFTER the delivery acceptance
 *   but BEFORE the durable completion — both recover with exactly ONE
 *   provider-side event.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInteractionsApp, InMemoryEventsStore, type InteractionsApp } from './helpers/in-memory-stores.js';
import type { Principal } from '../src/modules/auth/index.js';
import {
  computeInboxEventRecordHash,
  computeOutboxEventRecordHash,
  createInteractionsModule,
  createInMemoryEventDelivery,
  InteractionsError,
  type InboxProcessResult,
} from '../src/modules/interactions/index.js';
import { createEffectSink } from '../src/modules/integrations/index.js';
import { InMemoryInteractionsStore } from './helpers/in-memory-stores.js';

const PASSWORD = 'correct horse battery 7';
const EMAIL_PARAMS = { to: ['vendor@example.com'], subject: 'Insurance certificate', body: 'Please send it.' };

interface Base {
  app: InteractionsApp;
  owner: Principal;
  colleague: Principal;
  tenantId: string;
}

async function base(options: Parameters<typeof buildInteractionsApp>[0] = {}): Promise<Base> {
  const app = buildInteractionsApp(options);
  const owner = await app.auth.registerHuman({ email: 'owner@a.com', password: PASSWORD, displayName: 'Owner' });
  const colleague = await app.auth.registerHuman({ email: 'member@a.com', password: PASSWORD, displayName: 'Member' });
  const created = await app.organizations.createOrganization(owner, { slug: 'alpha-org', displayName: 'Alpha' });
  await app.organizations.addMember(owner, 'alpha-org', { principalId: colleague.id, role: 'member' });
  return { app, owner, colleague, tenantId: created.tenant.id };
}

async function error(promise: Promise<unknown>): Promise<InteractionsError | null> {
  try {
    await promise;
    return null;
  } catch (caught) {
    assert.ok(caught instanceof InteractionsError, `expected InteractionsError, got ${String(caught)}`);
    return caught;
  }
}

/** A dispatched (not yet observed) interaction of this tenant. */
async function dispatchedInteraction(b: Base): Promise<string> {
  const { interaction } = await b.app.interactions.createInteraction(b.owner, b.tenantId, {
    capability: 'email',
    params: EMAIL_PARAMS,
  });
  await b.app.interactions.dispatchInteraction(b.owner, b.tenantId, interaction.id);
  return interaction.id;
}

/** A terminally observed interaction of this tenant (outbox source). */
async function observedInteraction(b: Base): Promise<string> {
  const interactionId = await dispatchedInteraction(b);
  await b.app.interactions.recordObservedResult(b.owner, b.tenantId, interactionId, {
    outcome: 'succeeded',
    providerObservation: { receipt: 'smth-1' },
  });
  return interactionId;
}

function deliveryResult(interactionId: string, eventId = 'evt-1') {
  return {
    source: 'email' as const,
    eventId,
    eventType: 'interaction.delivery_result',
    occurredAt: new Date('2026-09-02T12:05:00.000Z'),
    payload: { interactionId, outcome: 'succeeded' as const, providerObservation: { delivered: true, receipt: 'smth-1' } },
  };
}

// ---------------------------------------------------------------------------
// Parallel duplicate deliveries converge (AC-1)
// ---------------------------------------------------------------------------

test('TRUE-PARALLEL duplicate deliveries of the same identity converge on ONE durable record', async () => {
  const b = await base();
  const interactionId = await dispatchedInteraction(b);
  const results = await Promise.all([
    b.app.interactions.ingestExternalEvent(b.owner, b.tenantId, deliveryResult(interactionId)),
    b.app.interactions.ingestExternalEvent(b.colleague, b.tenantId, deliveryResult(interactionId)),
    b.app.interactions.ingestExternalEvent(b.owner, b.tenantId, deliveryResult(interactionId)),
  ]);
  const ids = new Set(results.map((result) => result.event.id));
  assert.equal(ids.size, 1, 'all concurrent deliveries converge on ONE durable record');
  assert.equal(results.filter((result) => result.converged).length >= 1, true);
  assert.equal((await b.app.interactions.listInboxEvents(b.owner, b.tenantId)).length, 1);
});

// ---------------------------------------------------------------------------
// Two consumers of the same event: no duplicate domain effects
// ---------------------------------------------------------------------------

test('TRUE-PARALLEL inbox workers: ONE consumer invocation, ONE domain effect, the loser converges or surfaces in-progress', async () => {
  const b = await base();
  const interactionId = await dispatchedInteraction(b);
  await b.app.interactions.ingestExternalEvent(b.owner, b.tenantId, deliveryResult(interactionId));

  // Count real observation attempts through the interaction store's hook.
  let observationAttempts = 0;
  const hookedStore = new InMemoryInteractionsStore({
    now: () => new Date(),
    beforeRecordObservation: async () => {
      observationAttempts += 1;
    },
  });
  for (const [id, row] of b.app.interactionsStore.interactions) hookedStore.interactions.set(id, row);
  for (const [key, id] of b.app.interactionsStore.interactionsByIdempotency) hookedStore.interactionsByIdempotency.set(key, id);
  const module = createInteractionsModule({
    store: hookedStore,
    eventsStore: b.app.eventsStore,
    eventDelivery: b.app.eventDelivery,
    tenancy: b.app.organizations,
    policies: b.app.policies,
    sink: b.app.sink,
  });

  const [mine, theirs] = await Promise.all([
    module.processInboxEvents(b.owner, b.tenantId),
    module.processInboxEvents(b.colleague, b.tenantId),
  ]);
  const outcomes = [...mine.outcomes, ...theirs.outcomes];
  // Exactly ONE consumer invocation happened (the observation was
  // attempted once; identical re-observation would converge, but the
  // claim CAS keeps it single-flight).
  assert.equal(observationAttempts, 1, `the consumer must run exactly once (got ${observationAttempts} attempts)`);
  // The event settled exactly once: one consumed outcome, the loser
  // converged or surfaced in-progress (both legal, neither a failure).
  const consumed = outcomes.filter((o: InboxProcessResult) => o.event.state === 'consumed');
  assert.equal(consumed.length, 1);
  const invoked = outcomes.filter((o: InboxProcessResult) => o.invoked);
  assert.equal(invoked.length, 1);
  // ONE domain effect: the interaction is observed exactly once.
  const observed = await module.getInteraction(b.owner, b.tenantId, interactionId);
  assert.equal(observed.state, 'observed');
  assert.equal(observed.observation?.outcome, 'succeeded');
  // The durable event record is settled.
  assert.equal((await module.listInboxEvents(b.owner, b.tenantId, { state: 'consumed' })).length, 1);
});

test('DISCRIMINATION: without the inbox claim CAS, BOTH workers invoke the consumer (the guarded store prevents this)', async () => {
  const b = await base();
  const interactionId = await dispatchedInteraction(b);
  await b.app.interactions.ingestExternalEvent(b.owner, b.tenantId, deliveryResult(interactionId));

  let observationAttempts = 0;
  const hookedStore = new InMemoryInteractionsStore({
    now: () => new Date(),
    beforeRecordObservation: async () => {
      observationAttempts += 1;
    },
  });
  for (const [id, row] of b.app.interactionsStore.interactions) hookedStore.interactions.set(id, row);
  for (const [key, id] of b.app.interactionsStore.interactionsByIdempotency) hookedStore.interactionsByIdempotency.set(key, id);

  // The CAS-SKIPPING mutant: the claim mutation has NO state CHECK —
  // both workers "win" the claim and both run the consumer. The module
  // logic is IDENTICAL; only the store's guard is removed.
  const mutant = new (class extends InMemoryEventsStore {
    async claimInboxEvent(input: { tenantId: string; eventId: string; claimedBy: string; now: Date }) {
      const row = this.inboxEvents.get(input.eventId);
      if (row === undefined || row.tenantId !== input.tenantId) {
        throw new Error('missing row');
      }
      // THE MUTATION: no state CHECK — both claimants "win".
      row.state = 'processing';
      row.claim = { claimedBy: input.claimedBy, claimedAt: input.now };
      row.updatedAt = input.now;
      row.recordHash = computeInboxEventRecordHash(row);
      return this.copyInbox(row);
    }
  })({ now: () => new Date() });
  for (const [id, row] of b.app.eventsStore.inboxEvents) mutant.inboxEvents.set(id, row);
  for (const [key, id] of b.app.eventsStore.inboxEventsByIdentity) mutant.inboxEventsByIdentity.set(key, id);

  const mutatedModule = createInteractionsModule({
    store: hookedStore,
    eventsStore: mutant,
    eventDelivery: b.app.eventDelivery,
    tenancy: b.app.organizations,
    policies: b.app.policies,
    sink: b.app.sink,
  });

  await Promise.all([
    mutatedModule.processInboxEvents(b.owner, b.tenantId),
    mutatedModule.processInboxEvents(b.colleague, b.tenantId),
  ]);
  // With the claim CAS removed, BOTH workers run the consumer: TWO
  // observation attempts for one event identity — the double-invocation
  // anomaly. (The consumer's idempotency keeps the DURABLE effect at
  // one — the backstop — but the authority-level single-flight
  // guarantee is gone.)
  assert.equal(
    observationAttempts,
    2,
    `the CAS-skipping mutant must exhibit the double-invocation anomaly (got ${observationAttempts} attempts)`,
  );
});

// ---------------------------------------------------------------------------
// The inbox crash window converges
// ---------------------------------------------------------------------------

test('CRASH WINDOW (inbox): a claim left by a dead worker recovers with ONE durable domain effect', async () => {
  const b = await base({ eventsStoreOptions: { crashAfterInboxClaim: true, oneShotCrash: true } });
  const interactionId = await dispatchedInteraction(b);
  const { event } = await b.app.interactions.ingestExternalEvent(b.owner, b.tenantId, deliveryResult(interactionId));

  // The worker claims and dies INSIDE the critical section: the claim
  // stands, the consumer never ran.
  await assert.rejects(b.app.interactions.processInboxEvents(b.owner, b.tenantId), /SIMULATED CRASH/);
  const crashed = await b.app.interactions.getInboxEvent(b.owner, b.tenantId, event.id);
  assert.equal(crashed.state, 'processing');
  assert.equal((await b.app.interactions.listRecoverableInboxEvents(b.owner, b.tenantId)).length, 1);

  // Recovery re-claims and re-invokes the IDEMPOTENT consumer: the
  // observation was never recorded, so it lands exactly once.
  const recovered = await b.app.interactions.recoverInboxEvent(b.owner, b.tenantId, event.id);
  assert.equal(recovered.invoked, true);
  assert.equal(recovered.event.state, 'consumed');
  const observed = await b.app.interactions.getInteraction(b.owner, b.tenantId, interactionId);
  assert.equal(observed.state, 'observed');
  assert.equal(observed.observation?.observedBy, b.owner.id);
});

test('CRASH WINDOW (inbox, second form): the consumer ran and observed, the completion never landed — recovery converges on the SAME observation', async () => {
  const b = await base();
  const interactionId = await dispatchedInteraction(b);
  const { event } = await b.app.interactions.ingestExternalEvent(b.owner, b.tenantId, deliveryResult(interactionId));

  // Simulate: the consumer completed the observation, then the worker
  // died before the completion write (claim stands, observation exists).
  await b.app.eventsStore.claimInboxEvent({
    tenantId: b.tenantId,
    eventId: event.id,
    claimedBy: b.owner.id,
    now: new Date('2026-09-02T12:06:00.000Z'),
  });
  await b.app.interactions.recordObservedResult(b.owner, b.tenantId, interactionId, {
    outcome: 'succeeded',
    providerObservation: { delivered: true, receipt: 'smth-1' },
  });

  // Recovery re-invokes the consumer: recordObservedResult CONVERGES on
  // the identical existing observation (one domain effect, no
  // duplicate), and the event settles consumed with the convergence
  // visible in the consumer result.
  const recovered = await b.app.interactions.recoverInboxEvent(b.owner, b.tenantId, event.id);
  assert.equal(recovered.event.state, 'consumed');
  assert.deepEqual(recovered.event.consumption?.result, {
    kind: 'interaction.observed',
    interactionId,
    observationOutcome: 'succeeded',
    converged: true,
  });
  // No second observation exists: still one terminal observation.
  const observed = await b.app.interactions.getInteraction(b.owner, b.tenantId, interactionId);
  assert.equal(observed.state, 'observed');
});

// ---------------------------------------------------------------------------
// Outbox: one delivery per intent, convergent under parallelism
// ---------------------------------------------------------------------------

test('TRUE-PARALLEL outbox dispatches: exactly ONE delivery-port invocation, losers typed or convergent', async () => {
  const b = await base();
  const interactionId = await observedInteraction(b);
  const { event } = await b.app.interactions.recordOutboundEvent(b.owner, b.tenantId, {
    eventType: 'interaction.observed',
    interactionId,
    destination: 'customer-webhook://ops-alpha',
  });

  const outcomes = await Promise.allSettled([
    b.app.interactions.dispatchOutboxEvent(b.owner, b.tenantId, event.id),
    b.app.interactions.dispatchOutboxEvent(b.colleague, b.tenantId, event.id),
    b.app.interactions.dispatchOutboxEvent(b.owner, b.tenantId, event.id),
  ]);
  // Exactly ONE invocation, ONE accepted provider-side event.
  assert.equal(b.app.eventDelivery.attemptsFor(event.id), 1, 'the delivery port is invoked exactly once');
  assert.equal(b.app.eventDelivery.delivered.length, 1);
  // The durable record settles dispatched; every caller either sees the
  // settled record or fails closed with the typed in-progress error
  // (recoverable through the recovery surface — never a lost update).
  const record = await b.app.interactions.getOutboxEvent(b.owner, b.tenantId, event.id);
  assert.equal(record.state, 'dispatched');
  assert.equal(record.dispatch?.provider, 'in-memory-event-double');
  const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
  const rejected = outcomes.filter((o) => o.status === 'rejected');
  assert.equal(fulfilled.length + rejected.length, 3);
  for (const outcome of fulfilled) {
    const value = (outcome as PromiseFulfilledResult<{ event: { state: string }; invoked: boolean; converged: boolean }>).value;
    assert.equal(value.event.state, 'dispatched');
  }
  for (const outcome of rejected) {
    const reason = (outcome as PromiseRejectedResult).reason as InteractionsError;
    assert.ok(reason instanceof InteractionsError);
    assert.equal(reason.code, 'OUTBOX_EVENT_IN_PROGRESS');
  }
  // A twin dispatch AFTER settlement converges without invocation.
  const replay = await b.app.interactions.dispatchOutboxEvent(b.colleague, b.tenantId, event.id);
  assert.equal(replay.invoked, false);
  assert.equal(replay.converged, true);
  assert.equal(b.app.eventDelivery.attemptsFor(event.id), 1);
});

test('parallel keyed outbound intents converge on ONE durable event', async () => {
  const b = await base();
  const interactionId = await observedInteraction(b);
  const input = {
    eventType: 'interaction.observed' as const,
    interactionId,
    destination: 'customer-webhook://ops-alpha',
    idempotencyKey: 'notify-race',
  };
  const results = await Promise.all([
    b.app.interactions.recordOutboundEvent(b.owner, b.tenantId, input),
    b.app.interactions.recordOutboundEvent(b.colleague, b.tenantId, input),
  ]);
  const ids = new Set(results.map((result) => result.event.id));
  assert.equal(ids.size, 1);
  assert.equal((await b.app.interactions.listOutboxEvents(b.owner, b.tenantId)).length, 1);
});

test('DISCRIMINATION: without the outbox claim CAS, BOTH dispatchers invoke the delivery port (the guarded store prevents this)', async () => {
  const b = await base();
  const interactionId = await observedInteraction(b);
  const { event } = await b.app.interactions.recordOutboundEvent(b.owner, b.tenantId, {
    eventType: 'interaction.observed',
    interactionId,
    destination: 'customer-webhook://ops-alpha',
  });

  // The CAS-skipping outbox mutant: the claim has NO state CHECK — both
  // dispatchers "win" and both invoke the port.
  const mutant = new (class extends InMemoryEventsStore {
    async claimOutboxEvent(input: { tenantId: string; eventId: string; claimedBy: string; now: Date }) {
      const row = this.outboxEvents.get(input.eventId);
      if (row === undefined || row.tenantId !== input.tenantId) {
        throw new Error('missing row');
      }
      row.state = 'dispatching';
      row.claim = { claimedBy: input.claimedBy, claimedAt: input.now };
      row.updatedAt = input.now;
      row.recordHash = computeOutboxEventRecordHash(row);
      return this.copyOutbox(row);
    }
  })({ now: () => new Date() });
  for (const [id, row] of b.app.eventsStore.outboxEvents) mutant.outboxEvents.set(id, row);
  for (const [key, id] of b.app.eventsStore.outboxEventsByIdempotency) mutant.outboxEventsByIdempotency.set(key, id);

  const eventDelivery = createInMemoryEventDelivery({ now: () => new Date() });
  const mutatedModule = createInteractionsModule({
    store: b.app.interactionsStore,
    eventsStore: mutant,
    eventDelivery,
    tenancy: b.app.organizations,
    policies: b.app.policies,
    sink: createEffectSink(b.app.registry),
  });

  const outcomes = await Promise.allSettled([
    mutatedModule.dispatchOutboxEvent(b.owner, b.tenantId, event.id),
    mutatedModule.dispatchOutboxEvent(b.colleague, b.tenantId, event.id),
  ]);
  // With the claim CAS removed, BOTH dispatchers invoke the port: TWO
  // delivery attempts for one event identity — the double-invocation
  // anomaly. (The provider-side identity idempotency keeps the ACCEPTED
  // event count at one — the contract backstop — but the
  // authority-level single-flight guarantee is gone.)
  assert.equal(
    eventDelivery.attemptsFor(event.id),
    2,
    `the CAS-skipping mutant must exhibit the double-invocation anomaly (got ${eventDelivery.attemptsFor(event.id)} attempts)`,
  );
  assert.equal(eventDelivery.delivered.length, 1, 'the contract backstop keeps the accepted event count at ONE');
  // Both callers still observe a settled durable record (the first
  // completion wins; the second converges on it).
  const settled = outcomes.filter(
    (outcome) => outcome.status === 'fulfilled' && (outcome.value as { event: { state: string } }).event.state === 'dispatched',
  );
  assert.equal(settled.length, 2);
});

// ---------------------------------------------------------------------------
// The outbox crash windows converge ("crash between intent and dispatch")
// ---------------------------------------------------------------------------

test('CRASH WINDOW (outbox): crash AFTER the claim (nothing delivered yet) — recovery delivers exactly once', async () => {
  const b = await base({ eventsStoreOptions: { crashAfterOutboxClaim: true, oneShotCrash: true } });
  const interactionId = await observedInteraction(b);
  const { event } = await b.app.interactions.recordOutboundEvent(b.owner, b.tenantId, {
    eventType: 'interaction.observed',
    interactionId,
    destination: 'customer-webhook://ops-alpha',
  });

  // The dispatcher claims and dies: the claim stands, nothing delivered.
  await assert.rejects(b.app.interactions.dispatchOutboxEvent(b.owner, b.tenantId, event.id), /SIMULATED CRASH/);
  const claimed = await b.app.interactions.getOutboxEvent(b.owner, b.tenantId, event.id);
  assert.equal(claimed.state, 'dispatching');
  assert.equal(b.app.eventDelivery.delivered.length, 0);
  assert.equal((await b.app.interactions.listRecoverableOutboxEvents(b.owner, b.tenantId)).length, 1);

  // The durable intent was NOT lost: recovery re-dispatches and the
  // delivery lands exactly once.
  const recovered = await b.app.interactions.recoverOutboxEvent(b.owner, b.tenantId, event.id);
  assert.equal(recovered.event.state, 'dispatched');
  assert.equal(b.app.eventDelivery.delivered.length, 1);
  assert.equal(recovered.event.dispatch?.provider, 'in-memory-event-double');
});

test('CRASH WINDOW (outbox, W3 form): the port ACCEPTED the event, the completion never landed — recovery converges on ONE provider event', async () => {
  const b = await base({ eventsStoreOptions: { crashBeforeOutboxComplete: true, oneShotCrash: true } });
  const interactionId = await observedInteraction(b);
  const { event } = await b.app.interactions.recordOutboundEvent(b.owner, b.tenantId, {
    eventType: 'interaction.observed',
    interactionId,
    destination: 'customer-webhook://ops-alpha',
  });

  // The dispatcher claims, the port ACCEPTS (the provider-side event
  // exists), then the worker dies before the durable completion write.
  await assert.rejects(b.app.interactions.dispatchOutboxEvent(b.owner, b.tenantId, event.id), /SIMULATED CRASH/);
  assert.equal(b.app.eventDelivery.delivered.length, 1, 'the provider accepted the event before the crash');
  const claimed = await b.app.interactions.getOutboxEvent(b.owner, b.tenantId, event.id);
  assert.equal(claimed.state, 'dispatching');

  // Recovery re-dispatches: the port's identity idempotency CONVERGES on
  // the already-accepted event — no duplicate outbound event — and the
  // durable record settles dispatched.
  const recovered = await b.app.interactions.recoverOutboxEvent(b.owner, b.tenantId, event.id);
  assert.equal(recovered.event.state, 'dispatched');
  assert.equal(b.app.eventDelivery.attemptsFor(event.id), 2);
  assert.equal(b.app.eventDelivery.delivered.length, 1, 'exactly ONE provider-side event despite the re-dispatch');
  assert.equal(recovered.invoked, true);
});

test('concurrent recovery of one outbox crash window: one delivery, the settled record is the outcome for every recoverer', async () => {
  const b = await base();
  const interactionId = await observedInteraction(b);
  const { event } = await b.app.interactions.recordOutboundEvent(b.owner, b.tenantId, {
    eventType: 'interaction.observed',
    interactionId,
    destination: 'customer-webhook://ops-alpha',
  });
  // Open the crash window directly (claim without completion).
  await b.app.eventsStore.claimOutboxEvent({
    tenantId: b.tenantId,
    eventId: event.id,
    claimedBy: b.owner.id,
    now: new Date('2026-09-02T12:06:00.000Z'),
  });

  const outcomes = await Promise.allSettled([
    b.app.interactions.recoverOutboxEvent(b.owner, b.tenantId, event.id),
    b.app.interactions.recoverOutboxEvent(b.colleague, b.tenantId, event.id),
  ]);
  // Exactly ONE provider-side event despite the concurrent recovery.
  assert.equal(b.app.eventDelivery.delivered.length, 1);
  const record = await b.app.interactions.getOutboxEvent(b.owner, b.tenantId, event.id);
  assert.equal(record.state, 'dispatched');
  for (const outcome of outcomes) {
    if (outcome.status === 'fulfilled') {
      const value = (outcome as PromiseFulfilledResult<{ event: { state: string } }>).value;
      assert.equal(value.event.state, 'dispatched');
    } else {
      // The loser that arrived AFTER the window closed fails closed
      // typed (the window is gone — the settled record is the outcome).
      const reason = (outcome as PromiseRejectedResult).reason as InteractionsError;
      assert.ok(reason instanceof InteractionsError);
      assert.equal(reason.code, 'OUTBOX_RECOVERY_NOT_AVAILABLE');
    }
  }
  // A twin dispatch on the settled record converges without invocation.
  const replay = await b.app.interactions.dispatchOutboxEvent(b.colleague, b.tenantId, event.id);
  assert.equal(replay.invoked, false);
  assert.equal(replay.converged, true);
  assert.equal(b.app.eventDelivery.attemptsFor(event.id) <= 2, true);
});
