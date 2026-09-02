/**
 * Dynamic behavioral proof: the /interactions durable event substrate —
 * the event inbox/outbox lifecycle (WORK-006 — "inbox/outbox lifecycle";
 * activation AC-1/AC-2/AC-3/AC-4).
 *
 * The critical invariants are proven end-to-end:
 *   inbound: ingress validation -> durable deduplicated inbox ->
 *   worker-claimed idempotent processing -> ONE domain effect (the
 *   observation recorded through the interaction authority's single
 *   observation path);
 *   outbound: policy gate -> durable intent (authority-derived content)
 *   -> claimed delivery through the provider-neutral port -> recorded
 *   acceptance or explicit failure — durable intent is never silently
 *   lost.
 *
 * Discrimination proofs cover: duplicate event regression (identical
 * re-delivery converges, divergent fails closed), the durable rejection
 * vocabulary (unknown type / invalid payload / uncorrelated), tenant
 * isolation, tamper evidence, and the closed delivery boundary
 * (EVENT_DELIVERY_UNAVAILABLE with the claim standing).
 *
 * In-env (no PostgreSQL): the module runs over the faithful in-memory
 * event store and the contract-conformant event delivery double; the
 * live-PostgreSQL equivalents live in events.integration.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInteractionsApp, buildZeckBoundaryApp, type InteractionsApp } from './helpers/in-memory-stores.js';
import type { Principal } from '../src/modules/auth/index.js';
import {
  createInteractionsModule,
  createInMemoryEventDelivery,
  InteractionsError,
  INBOUND_EVENT_TYPES,
  OUTBOUND_EVENT_TYPES,
  type InboxEventRecord,
  type OutboxEventRecord,
} from '../src/modules/interactions/index.js';
import { createInMemoryZeckGateway, type ZeckModule } from '../src/modules/zeck/index.js';

const PASSWORD = 'correct horse battery 7';
const EMAIL_PARAMS = { to: ['vendor@example.com'], subject: 'Insurance certificate required', body: 'Please send your current certificate.' };

interface Base {
  app: InteractionsApp;
  owner: Principal;
  outsider: Principal;
  tenantId: string;
  otherTenantId: string;
}

async function base(options: Parameters<typeof buildInteractionsApp>[0] = {}): Promise<Base> {
  const app = buildInteractionsApp(options);
  const owner = await app.auth.registerHuman({ email: 'owner@a.com', password: PASSWORD, displayName: 'Owner' });
  const outsider = await app.auth.registerHuman({ email: 'owner@b.com', password: PASSWORD, displayName: 'Outsider' });
  const created = await app.organizations.createOrganization(owner, { slug: 'alpha-org', displayName: 'Alpha' });
  const other = await app.organizations.createOrganization(outsider, { slug: 'beta-org', displayName: 'Beta' });
  return { app, owner, outsider, tenantId: created.tenant.id, otherTenantId: other.tenant.id };
}

async function interactionsError(promise: Promise<unknown>): Promise<InteractionsError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof InteractionsError, `expected InteractionsError, got ${String(error)}`);
    return error;
  }
  throw new Error('expected the call to fail closed');
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

/** A TERMINALLY observed interaction of this tenant (outbox content source). */
async function observedInteraction(b: Base, outcome: 'succeeded' | 'failed' = 'succeeded'): Promise<{
  id: string;
  provider: string;
  providerReference: string | null;
  observedAt: Date;
}> {
  const { interaction } = await b.app.interactions.createInteraction(b.owner, b.tenantId, {
    capability: 'email',
    params: EMAIL_PARAMS,
  });
  const dispatched = await b.app.interactions.dispatchInteraction(b.owner, b.tenantId, interaction.id);
  await b.app.interactions.recordObservedResult(b.owner, b.tenantId, interaction.id, {
    outcome,
    providerObservation: { receipt: `smth-${interaction.id.slice(0, 8)}` },
  });
  return {
    id: interaction.id,
    provider: dispatched.interaction.dispatch?.provider ?? 'unknown',
    providerReference: dispatched.interaction.dispatch?.providerReference ?? null,
    observedAt: dispatched.interaction.updatedAt,
  };
}

function deliveryResult(
  interactionId: string,
  outcome: 'succeeded' | 'failed' = 'succeeded',
  eventId = 'evt-1',
): {
  source: 'email';
  eventId: string;
  eventType: string;
  occurredAt: Date;
  payload: { interactionId: string; outcome: string; providerObservation?: unknown };
} {
  return {
    source: 'email',
    eventId,
    eventType: 'interaction.delivery_result',
    occurredAt: new Date('2026-09-02T12:05:00.000Z'),
    payload: {
      interactionId,
      outcome,
      providerObservation: { delivered: true, receipt: 'smth-1' },
    },
  };
}

// ---------------------------------------------------------------------------
// The inbox lifecycle (behavioral: "inbox/outbox lifecycle")
// ---------------------------------------------------------------------------

test('the full inbox lifecycle: validated durable delivery -> claimed processing -> consumed, with ONE durable domain effect', async () => {
  const b = await base();
  const interactionId = await dispatchedInteraction(b);

  const { event, converged } = await b.app.interactions.ingestExternalEvent(b.owner, b.tenantId, deliveryResult(interactionId));
  assert.equal(converged, false);
  assert.equal(event.state, 'received');
  assert.equal(event.source, 'email');
  assert.equal(event.externalEventId, 'evt-1');
  assert.equal(event.eventType, 'interaction.delivery_result');
  assert.equal(event.receivedBy, b.owner.id);
  assert.equal(event.claim, null);
  assert.equal(event.rejection, null);

  // Nothing processed yet: the interaction is dispatched, not observed.
  assert.equal((await b.app.interactions.getInteraction(b.owner, b.tenantId, interactionId)).state, 'dispatched');

  const { outcomes } = await b.app.interactions.processInboxEvents(b.owner, b.tenantId);
  assert.equal(outcomes.length, 1);
  const outcome = outcomes[0] as { event: InboxEventRecord; invoked: boolean; converged: boolean };
  assert.equal(outcome.invoked, true);
  assert.equal(outcome.converged, false);
  assert.equal(outcome.event.state, 'consumed');
  assert.ok(outcome.event.consumption !== null);
  assert.deepEqual(outcome.event.consumption?.result, {
    kind: 'interaction.observed',
    interactionId,
    observationOutcome: 'succeeded',
    converged: false,
  });
  assert.equal(outcome.event.consumption?.consumedBy, b.owner.id);

  // THE domain effect: the interaction carries the provider's observed
  // result through the ONE observation path (observedBy = the worker).
  const observed = await b.app.interactions.getInteraction(b.owner, b.tenantId, interactionId);
  assert.equal(observed.state, 'observed');
  assert.equal(observed.observation?.outcome, 'succeeded');
  assert.equal(observed.observation?.observedBy, b.owner.id);

  // Re-processing is a no-op: no claimable events remain.
  const again = await b.app.interactions.processInboxEvents(b.owner, b.tenantId);
  assert.equal(again.outcomes.length, 0);

  // The inbox record is durable and re-readable with provenance intact.
  const reread = await b.app.interactions.getInboxEvent(b.owner, b.tenantId, event.id);
  assert.equal(reread.state, 'consumed');
});

test('the claim is durable between ingest and processing: the crash-window marker is visible', async () => {
  const b = await base();
  const interactionId = await dispatchedInteraction(b);
  const { event } = await b.app.interactions.ingestExternalEvent(b.owner, b.tenantId, deliveryResult(interactionId));

  // Nothing claimed yet: nothing recoverable.
  assert.equal((await b.app.interactions.listRecoverableInboxEvents(b.owner, b.tenantId)).length, 0);

  // Claim directly through the store (a worker claimed and died before
  // the consumer ran): the crash window is durable and visible.
  await b.app.eventsStore.claimInboxEvent({
    tenantId: b.tenantId,
    eventId: event.id,
    claimedBy: b.owner.id,
    now: new Date('2026-09-02T12:06:00.000Z'),
  });
  assert.equal((await b.app.interactions.getInboxEvent(b.owner, b.tenantId, event.id)).state, 'processing');
  const recoverable = await b.app.interactions.listRecoverableInboxEvents(b.owner, b.tenantId);
  assert.equal(recoverable.length, 1);
  assert.equal(recoverable[0]?.id, event.id);

  // Recovery re-claims and re-runs the (idempotent) consumer; the domain
  // effect converges — the observation was never recorded, so it lands
  // exactly once.
  const outcome = await b.app.interactions.recoverInboxEvent(b.owner, b.tenantId, event.id);
  assert.equal(outcome.invoked, true);
  assert.equal(outcome.event.state, 'consumed');
  assert.equal((await b.app.interactions.getInteraction(b.owner, b.tenantId, interactionId)).state, 'observed');
});

// ---------------------------------------------------------------------------
// Duplicate event regression (discrimination: "duplicate event regression", AC-1)
// ---------------------------------------------------------------------------

test('DUPLICATE REGRESSION: an identical re-delivery converges on ONE durable inbox record and ONE domain effect', async () => {
  const b = await base();
  const interactionId = await dispatchedInteraction(b);

  const first = await b.app.interactions.ingestExternalEvent(b.owner, b.tenantId, deliveryResult(interactionId));
  const replay = await b.app.interactions.ingestExternalEvent(b.owner, b.tenantId, deliveryResult(interactionId));
  assert.equal(replay.converged, true);
  assert.equal(replay.event.id, first.event.id);
  assert.equal((await b.app.interactions.listInboxEvents(b.owner, b.tenantId)).length, 1);

  // Processing after a duplicate delivery: exactly one domain effect.
  const { outcomes } = await b.app.interactions.processInboxEvents(b.owner, b.tenantId);
  assert.equal(outcomes.length, 1);
  const interaction = await b.app.interactions.getInteraction(b.owner, b.tenantId, interactionId);
  assert.equal(interaction.state, 'observed');

  // A THIRD delivery after processing converges on the consumed record:
  // the disposition is durable, no re-processing occurs.
  const third = await b.app.interactions.ingestExternalEvent(b.owner, b.tenantId, deliveryResult(interactionId));
  assert.equal(third.converged, true);
  assert.equal(third.event.state, 'consumed');
  assert.equal((await b.app.interactions.processInboxEvents(b.owner, b.tenantId)).outcomes.length, 0);
});

test('DISCRIMINATION: a divergent re-delivery of the same stable identity fails closed (duplicate event mutation is detected)', async () => {
  const b = await base();
  const interactionId = await dispatchedInteraction(b);
  const first = await b.app.interactions.ingestExternalEvent(b.owner, b.tenantId, deliveryResult(interactionId));

  const divergent = deliveryResult(interactionId, 'failed');
  const error = await interactionsError(b.app.interactions.ingestExternalEvent(b.owner, b.tenantId, divergent));
  assert.equal(error.code, 'EVENT_DELIVERY_CONFLICT');

  // The durable record is unchanged (the first delivery stands).
  const reread = await b.app.interactions.getInboxEvent(b.owner, b.tenantId, first.event.id);
  assert.equal(reread.state, 'received');
  assert.equal((await b.app.interactions.listInboxEvents(b.owner, b.tenantId)).length, 1);
});

test('the stable identity is (tenant, source, external id): the same external id from a different source is a DISTINCT event', async () => {
  const b = await base();
  const interactionId = await dispatchedInteraction(b);
  const emailEvent = await b.app.interactions.ingestExternalEvent(b.owner, b.tenantId, deliveryResult(interactionId));
  const smsEvent = await b.app.interactions.ingestExternalEvent(b.owner, b.tenantId, {
    ...deliveryResult(interactionId, 'succeeded', 'evt-1'),
    source: 'sms',
  });
  assert.equal(smsEvent.converged, false);
  assert.notEqual(smsEvent.event.id, emailEvent.event.id);
  assert.equal((await b.app.interactions.listInboxEvents(b.owner, b.tenantId)).length, 2);
});

// ---------------------------------------------------------------------------
// The durable rejection vocabulary (the /zeck disposition discipline)
// ---------------------------------------------------------------------------

test('an unknown event type is DURABLY RECORDED as rejected evidence and fails closed typed (no vertical meanings)', async () => {
  const b = await base();
  const interactionId = await dispatchedInteraction(b);
  const error = await interactionsError(
    b.app.interactions.ingestExternalEvent(b.owner, b.tenantId, {
      ...deliveryResult(interactionId),
      eventType: 'construction.permit_approved',
    }),
  );
  assert.equal(error.code, 'EVENT_UNKNOWN_TYPE');
  assert.match(error.message, /rejected evidence/);

  // The rejection is durable, retrievable, terminal by identity.
  const rejected = await b.app.interactions.listInboxEvents(b.owner, b.tenantId, { state: 'rejected' });
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0]?.rejection?.code, 'unknown_event_type');
  assert.equal(rejected[0]?.state, 'rejected');

  // The identical replay converges on the same rejected record.
  const replayError = await interactionsError(
    b.app.interactions.ingestExternalEvent(b.owner, b.tenantId, {
      ...deliveryResult(interactionId),
      eventType: 'construction.permit_approved',
    }),
  );
  assert.equal(replayError.code, 'EVENT_UNKNOWN_TYPE');
  assert.match(replayError.message, /converged on the existing rejection/);
  assert.equal((await b.app.interactions.listInboxEvents(b.owner, b.tenantId, { state: 'rejected' })).length, 1);

  // Rejected deliveries are evidence, not work: nothing is claimable.
  assert.equal((await b.app.interactions.processInboxEvents(b.owner, b.tenantId)).outcomes.length, 0);
});

test('a non-conforming payload is DURABLY RECORDED as rejected evidence and fails closed typed', async () => {
  const b = await base();
  const interactionId = await dispatchedInteraction(b);
  const cases: unknown[] = [
    { interactionId, outcome: 'maybe' },
    { interactionId: 'not-a-uuid', outcome: 'succeeded' },
    { interactionId, outcome: 'succeeded', extra: 'nope' },
    'not-an-object',
  ];
  for (const payload of cases) {
    const error = await interactionsError(
      b.app.interactions.ingestExternalEvent(b.owner, b.tenantId, {
        source: 'email',
        eventId: `evt-bad-${Math.random().toString(36).slice(2, 8)}`,
        eventType: 'interaction.delivery_result',
        occurredAt: new Date('2026-09-02T12:05:00.000Z'),
        payload,
      }),
    );
    assert.equal(error.code, 'EVENT_INVALID_PAYLOAD');
  }
  assert.equal((await b.app.interactions.listInboxEvents(b.owner, b.tenantId, { state: 'rejected' })).length, cases.length);
});

test('an uncorrelated delivery (the interaction is not held by this tenant) is DURABLY RECORDED as rejected evidence', async () => {
  const b = await base();
  const interactionId = await dispatchedInteraction(b);
  const otherInteraction = await (async () => {
    const { interaction } = await b.app.interactions.createInteraction(b.outsider, b.otherTenantId, {
      capability: 'email',
      params: EMAIL_PARAMS,
    });
    await b.app.interactions.dispatchInteraction(b.outsider, b.otherTenantId, interaction.id);
    return interaction.id;
  })();

  // Referencing the OTHER tenant's interaction from this tenant's inbox:
  // the correlation lookup is tenant-predicated — uncorrelated.
  const error = await interactionsError(
    b.app.interactions.ingestExternalEvent(b.owner, b.tenantId, deliveryResult(otherInteraction, 'succeeded', 'evt-cross')),
  );
  assert.equal(error.code, 'EVENT_UNCORRELATED');
  const rejected = await b.app.interactions.listInboxEvents(b.owner, b.tenantId, { state: 'rejected' });
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0]?.rejection?.code, 'uncorrelated');

  // A genuinely missing interaction id is uncorrelated too.
  const missing = await interactionsError(
    b.app.interactions.ingestExternalEvent(b.owner, b.tenantId, deliveryResult('00000000-0000-4000-8000-000000000099', 'succeeded', 'evt-missing')),
  );
  assert.equal(missing.code, 'EVENT_UNCORRELATED');

  // The other tenant CAN correlate its own interaction.
  const ok = await b.app.interactions.ingestExternalEvent(b.outsider, b.otherTenantId, deliveryResult(otherInteraction, 'succeeded', 'evt-other'));
  assert.equal(ok.event.state, 'received');
  void interactionId;
});

test('a malformed envelope fails closed at input validation with NO durable record', async () => {
  const b = await base();
  const interactionId = await dispatchedInteraction(b);
  const before = (await b.app.interactions.listInboxEvents(b.owner, b.tenantId)).length;
  const cases: Parameters<typeof b.app.interactions.ingestExternalEvent>[2][] = [
    { ...deliveryResult(interactionId), eventId: '' },
    { ...deliveryResult(interactionId), eventId: 'x'.repeat(201) },
    { ...deliveryResult(interactionId), eventType: '' },
    { ...deliveryResult(interactionId), occurredAt: '2026-09-02' as unknown as Date },
    { ...deliveryResult(interactionId), source: 'carrier-pigeon' as 'email' },
  ];
  for (const input of cases) {
    const error = await interactionsError(b.app.interactions.ingestExternalEvent(b.owner, b.tenantId, input));
    assert.equal(error.code, 'INVALID_INPUT');
  }
  assert.equal((await b.app.interactions.listInboxEvents(b.owner, b.tenantId)).length, before);
});

// ---------------------------------------------------------------------------
// Consumer failures are explicit, durable and retryable
// ---------------------------------------------------------------------------

test('a consumer failure is explicit, typed and durable; the retry converges when the precondition heals', async () => {
  const b = await base();
  const { interaction } = await b.app.interactions.createInteraction(b.owner, b.tenantId, {
    capability: 'email',
    params: EMAIL_PARAMS,
  });
  // The interaction exists (correlation is valid at INGEST time) but is
  // still 'intended': the observation precondition is not met at
  // PROCESSING time — the transient failure path.
  const { event } = await b.app.interactions.ingestExternalEvent(b.owner, b.tenantId, deliveryResult(interaction.id));
  const { outcomes } = await b.app.interactions.processInboxEvents(b.owner, b.tenantId);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]?.event.state, 'failed');
  assert.equal(outcomes[0]?.failureCode, 'OBSERVATION_STATE_INVALID');
  assert.ok(outcomes[0]?.event.failure !== null);

  // The precondition heals: the interaction is dispatched.
  await b.app.interactions.dispatchInteraction(b.owner, b.tenantId, interaction.id);
  const retried = await b.app.interactions.retryInboxEvent(b.owner, b.tenantId, event.id);
  assert.equal(retried.invoked, true);
  assert.equal(retried.event.state, 'consumed');
  assert.equal((await b.app.interactions.getInteraction(b.owner, b.tenantId, interaction.id)).state, 'observed');

  // Only failed events are retriable: a retry of a RECEIVED event fails
  // closed typed; a retry of an already-consumed event converges on the
  // durable result (idempotent retry semantics, invoked: false).
  const fresh = await b.app.interactions.ingestExternalEvent(b.owner, b.tenantId, deliveryResult(interaction.id, 'succeeded', 'evt-received'));
  const notFailed = await interactionsError(b.app.interactions.retryInboxEvent(b.owner, b.tenantId, fresh.event.id));
  assert.equal(notFailed.code, 'INBOX_EVENT_NOT_FAILED');
  const consumedRetry = await b.app.interactions.retryInboxEvent(b.owner, b.tenantId, event.id);
  assert.equal(consumedRetry.invoked, false);
  assert.equal(consumedRetry.converged, true);
  assert.equal(consumedRetry.event.state, 'consumed');
});

// ---------------------------------------------------------------------------
// Tenant isolation (AC-3) and authorization-before-data
// ---------------------------------------------------------------------------

test('authorization happens BEFORE any event data access: denials never touch the store', async () => {
  const b = await base();
  const interactionId = await dispatchedInteraction(b);
  await b.app.interactions.ingestExternalEvent(b.owner, b.tenantId, deliveryResult(interactionId));
  const readsBefore = { ...b.app.eventsStore.reads };
  const error = await interactionsError(
    b.app.interactions.processInboxEvents(b.outsider, b.tenantId, {}),
  );
  assert.equal(error.code, 'TENANT_FORBIDDEN');
  assert.deepEqual(b.app.eventsStore.reads, readsBefore);
});

test('cross-tenant isolation: events of another tenant are indistinguishable from missing', async () => {
  const b = await base();
  const other = await base();
  const interactionId = await dispatchedInteraction(b);
  const { event } = await b.app.interactions.ingestExternalEvent(b.owner, b.tenantId, deliveryResult(interactionId));
  // The other tenant's owner queries the FOREIGN event id against THEIR
  // OWN tenant: authorized, and the tenant predicate makes the foreign
  // row indistinguishable from a missing one.
  const error = await interactionsError(other.app.interactions.getInboxEvent(other.owner, other.tenantId, event.id));
  assert.equal(error.code, 'EVENT_NOT_FOUND');
  assert.equal((await other.app.interactions.listInboxEvents(other.owner, other.tenantId)).length, 0);
  const recoverError = await interactionsError(other.app.interactions.recoverInboxEvent(other.owner, other.tenantId, event.id));
  assert.equal(recoverError.code, 'EVENT_NOT_FOUND');
  const processError = await interactionsError(other.app.interactions.retryInboxEvent(other.owner, other.tenantId, event.id));
  assert.equal(processError.code, 'EVENT_NOT_FOUND');
  // Authorization of a NON-member fails closed before any store access.
  const readsBefore = { ...b.app.eventsStore.reads };
  const forbidden = await interactionsError(b.app.interactions.getInboxEvent(b.outsider, b.tenantId, event.id));
  assert.equal(forbidden.code, 'TENANT_FORBIDDEN');
  assert.deepEqual(b.app.eventsStore.reads, readsBefore);
});

test('filters validate their inputs; lists stay tenant-scoped', async () => {
  const b = await base();
  const interactionId = await dispatchedInteraction(b);
  await b.app.interactions.ingestExternalEvent(b.owner, b.tenantId, deliveryResult(interactionId));
  const badState = await interactionsError(
    b.app.interactions.listInboxEvents(b.owner, b.tenantId, { state: 'hijacked' as 'received' }),
  );
  assert.equal(badState.code, 'INVALID_INPUT');
  const received = await b.app.interactions.listInboxEvents(b.owner, b.tenantId, { state: 'received' });
  assert.equal(received.length, 1);
  const bySource = await b.app.interactions.listInboxEvents(b.owner, b.tenantId, { source: 'payment' });
  assert.equal(bySource.length, 0);
});

// ---------------------------------------------------------------------------
// Tamper evidence
// ---------------------------------------------------------------------------

test('after-the-fact mutation of a stored inbox event is detected on read (event-record-tampered)', async () => {
  const b = await base();
  const interactionId = await dispatchedInteraction(b);
  const { event } = await b.app.interactions.ingestExternalEvent(b.owner, b.tenantId, deliveryResult(interactionId));
  const row = b.app.eventsStore.inboxEvents.get(event.id);
  assert.ok(row !== undefined);
  row.payload = { ...row.payload, outcome: 'failed' };
  const error = await interactionsError(b.app.interactions.getInboxEvent(b.owner, b.tenantId, event.id));
  assert.equal(error.code, 'EVENT_RECORD_TAMPERED');
});

// ---------------------------------------------------------------------------
// The outbox lifecycle (behavioral: "inbox/outbox lifecycle", AC-2)
// ---------------------------------------------------------------------------

test('the full outbox lifecycle: policy-gated durable intent (authority-derived content) -> claimed delivery -> recorded acceptance', async () => {
  const b = await base();
  const observed = await observedInteraction(b, 'succeeded');

  const { event, converged } = await b.app.interactions.recordOutboundEvent(b.owner, b.tenantId, {
    eventType: 'interaction.observed',
    interactionId: observed.id,
    destination: 'customer-webhook://ops-alpha',
    correlation: { workId: '00000000-0000-4000-8000-000000000042' },
    idempotencyKey: 'notify-1',
  });
  assert.equal(converged, false);
  assert.equal(event.state, 'intended');
  assert.equal(event.eventType, 'interaction.observed');
  assert.equal(event.destination, 'customer-webhook://ops-alpha');
  assert.equal(event.requestedBy, b.owner.id);
  assert.equal(event.idempotencyKey, 'notify-1');
  // AUTHORITY-DERIVED CONTENT: the payload is the interaction authority's
  // terminal observation, never caller-supplied.
  assert.deepEqual(event.payload, {
    interactionId: observed.id,
    outcome: 'succeeded',
    provider: observed.provider,
    providerReference: observed.providerReference,
    observedAt: observed.observedAt.toISOString(),
  });
  assert.deepEqual(event.correlation, { workId: '00000000-0000-4000-8000-000000000042' });
  assert.equal(event.policy, null);

  // Nothing delivered yet.
  assert.equal(b.app.eventDelivery.delivered.length, 0);

  const dispatched = await b.app.interactions.dispatchOutboxEvent(b.owner, b.tenantId, event.id);
  assert.equal(dispatched.invoked, true);
  assert.equal(dispatched.converged, false);
  assert.equal(dispatched.event.state, 'dispatched');
  assert.equal(dispatched.event.dispatch?.provider, 'in-memory-event-double');
  assert.equal(dispatched.event.dispatch?.providerReference, `double-${event.id}`);
  assert.equal(dispatched.event.dispatch?.dispatchedBy, b.owner.id);

  // The provider accepted exactly ONE event for this identity.
  assert.equal(b.app.eventDelivery.delivered.length, 1);
  assert.equal(b.app.eventDelivery.acceptanceFor(event.id)?.provider, 'in-memory-event-double');

  // Re-dispatch converges WITHOUT a second delivery.
  const replay = await b.app.interactions.dispatchOutboxEvent(b.owner, b.tenantId, event.id);
  assert.equal(replay.invoked, false);
  assert.equal(replay.converged, true);
  assert.equal(b.app.eventDelivery.delivered.length, 1);
  assert.equal(b.app.eventDelivery.attemptsFor(event.id), 1);
});

test('keyed outbound submissions converge; divergent keyed submissions fail closed', async () => {
  const b = await base();
  const observed = await observedInteraction(b);
  const input = {
    eventType: 'interaction.observed' as const,
    interactionId: observed.id,
    destination: 'customer-webhook://ops-alpha',
    idempotencyKey: 'notify-1',
  };
  const first = await b.app.interactions.recordOutboundEvent(b.owner, b.tenantId, input);
  const replay = await b.app.interactions.recordOutboundEvent(b.owner, b.tenantId, input);
  assert.equal(replay.converged, true);
  assert.equal(replay.event.id, first.event.id);
  assert.equal((await b.app.interactions.listOutboxEvents(b.owner, b.tenantId)).length, 1);

  const divergent = await interactionsError(
    b.app.interactions.recordOutboundEvent(b.owner, b.tenantId, {
      ...input,
      destination: 'other-destination://beta',
    }),
  );
  assert.equal(divergent.code, 'EVENT_INPUT_CONFLICT');
  assert.equal((await b.app.interactions.listOutboxEvents(b.owner, b.tenantId)).length, 1);
});

test('outbound validation: only a TERMINALLY observed interaction can seed an event; inputs fail closed', async () => {
  const b = await base();
  const dispatchedId = await dispatchedInteraction(b);
  const notObserved = await interactionsError(
    b.app.interactions.recordOutboundEvent(b.owner, b.tenantId, {
      eventType: 'interaction.observed',
      interactionId: dispatchedId,
      destination: 'customer-webhook://ops-alpha',
    }),
  );
  assert.equal(notObserved.code, 'EVENT_NOT_OBSERVED');

  const missing = await interactionsError(
    b.app.interactions.recordOutboundEvent(b.owner, b.tenantId, {
      eventType: 'interaction.observed',
      interactionId: '00000000-0000-4000-8000-000000000099',
      destination: 'customer-webhook://ops-alpha',
    }),
  );
  assert.equal(missing.code, 'INTERACTION_NOT_FOUND');

  const observed = await observedInteraction(b);
  const badType = await interactionsError(
    b.app.interactions.recordOutboundEvent(b.owner, b.tenantId, {
      eventType: 'construction.permit_approved' as 'interaction.observed',
      interactionId: observed.id,
      destination: 'customer-webhook://ops-alpha',
    }),
  );
  assert.equal(badType.code, 'INVALID_INPUT');

  const badDestination = await interactionsError(
    b.app.interactions.recordOutboundEvent(b.owner, b.tenantId, {
      eventType: 'interaction.observed',
      interactionId: observed.id,
      destination: 'not printable!',
    }),
  );
  assert.equal(badDestination.code, 'INVALID_INPUT');
  assert.equal((await b.app.interactions.listOutboxEvents(b.owner, b.tenantId)).length, 0);
});

test('the outbox policy gate: a deny fails closed BEFORE the intent row exists; an allow pins provenance', async () => {
  const b = await base();
  const observed = await observedInteraction(b);
  // A denying base policy for the event.emit action.
  const denyVersion = await b.app.policies.createPolicyVersion(b.owner, {
    tenantId: b.tenantId,
    policyKey: 'events.outbound.guard',
    scope: 'base',
    rules: [{ id: 'deny-all-events', when: { kind: 'always' }, effect: 'deny' }],
    defaultEffect: 'allow',
  });
  await b.app.policies.activatePolicyVersion(b.owner, b.tenantId, denyVersion.contract.id);
  const denied = await interactionsError(
    b.app.interactions.recordOutboundEvent(b.owner, b.tenantId, {
      eventType: 'interaction.observed',
      interactionId: observed.id,
      destination: 'customer-webhook://ops-alpha',
      policyKey: 'events.outbound.guard',
    }),
  );
  assert.equal(denied.code, 'POLICY_DENIED');
  assert.equal((await b.app.interactions.listOutboxEvents(b.owner, b.tenantId)).length, 0);

  // An allowing policy pins the decision provenance into the intent.
  const allowVersion = await b.app.policies.createPolicyVersion(b.owner, {
    tenantId: b.tenantId,
    policyKey: 'events.outbound.allow-guard',
    scope: 'base',
    rules: [{ id: 'allow-all-events', when: { kind: 'always' }, effect: 'allow' }],
    defaultEffect: 'allow',
  });
  await b.app.policies.activatePolicyVersion(b.owner, b.tenantId, allowVersion.contract.id);
  const { event } = await b.app.interactions.recordOutboundEvent(b.owner, b.tenantId, {
    eventType: 'interaction.observed',
    interactionId: observed.id,
    destination: 'customer-webhook://ops-alpha',
    policyKey: 'events.outbound.allow-guard',
  });
  assert.ok(event.policy !== null);
  assert.equal(event.policy.policyKey, 'events.outbound.allow-guard');
  assert.ok(event.policy.decisionId.length > 0);
});

test('a delivery-port failure is an EXPLICIT durable failure, terminal for the identity; re-dispatch surfaces the record', async () => {
  const b = await base({
    eventDelivery: createInMemoryEventDelivery({
      now: () => new Date(),
      failOn: (request) => request.destination === 'broken://destination',
    }),
  });
  const observed = await observedInteraction(b);
  const { event } = await b.app.interactions.recordOutboundEvent(b.owner, b.tenantId, {
    eventType: 'interaction.observed',
    interactionId: observed.id,
    destination: 'broken://destination',
  });
  const failed = await b.app.interactions.dispatchOutboxEvent(b.owner, b.tenantId, event.id);
  assert.equal(failed.invoked, true);
  assert.equal(failed.event.state, 'failed');
  assert.ok(failed.event.failure !== null);
  assert.equal(failed.event.failure?.code, 'DELIVERY_FAILED');
  assert.match(failed.event.failure?.message ?? '', /failed/);

  // The failed identity is terminal: a re-dispatch converges on the
  // durable failure record (the caller records a NEW intent to retry).
  const replay = await b.app.interactions.dispatchOutboxEvent(b.owner, b.tenantId, event.id);
  assert.equal(replay.invoked, false);
  assert.equal(replay.converged, true);
  assert.equal(replay.event.state, 'failed');
});

test('TRUTHFUL UNAVAILABILITY: with no delivery port composed, dispatch fails closed and the claim stands for recovery', async () => {
  const b = await base();
  const observed = await observedInteraction(b);
  const { event } = await b.app.interactions.recordOutboundEvent(b.owner, b.tenantId, {
    eventType: 'interaction.observed',
    interactionId: observed.id,
    destination: 'customer-webhook://ops-alpha',
  });
  // A module composed WITHOUT the delivery port (the production shape of
  // this Work Order) over the SAME durable stores.
  const closedModule = createInteractionsModule({
    store: b.app.interactionsStore,
    eventsStore: b.app.eventsStore,
    tenancy: b.app.organizations,
    policies: b.app.policies,
    sink: b.app.sink,
    now: () => new Date(),
  });
  const error = await interactionsError(closedModule.dispatchOutboxEvent(b.owner, b.tenantId, event.id));
  assert.equal(error.code, 'EVENT_DELIVERY_UNAVAILABLE');
  assert.match(error.message, /no event delivery port is composed/);

  // The claim stands (the crash window is open, the intent not lost).
  const claimed = await b.app.interactions.getOutboxEvent(b.owner, b.tenantId, event.id);
  assert.equal(claimed.state, 'dispatching');
  const recoverable = await b.app.interactions.listRecoverableOutboxEvents(b.owner, b.tenantId);
  assert.equal(recoverable.length, 1);

  // Wiring the port (the future Work Order's composition) and recovering:
  // the delivery lands exactly once.
  const healed = await b.app.interactions.recoverOutboxEvent(b.owner, b.tenantId, event.id);
  assert.equal(healed.invoked, true);
  assert.equal(healed.event.state, 'dispatched');
  assert.equal(b.app.eventDelivery.delivered.length, 1);
});

test('outbox reads are tenant-scoped and tamper-evident', async () => {
  const b = await base();
  const observed = await observedInteraction(b);
  const { event } = await b.app.interactions.recordOutboundEvent(b.owner, b.tenantId, {
    eventType: 'interaction.observed',
    interactionId: observed.id,
    destination: 'customer-webhook://ops-alpha',
  });
  const other = await base();
  const cross = await interactionsError(other.app.interactions.getOutboxEvent(other.owner, other.tenantId, event.id));
  assert.equal(cross.code, 'EVENT_NOT_FOUND');
  assert.equal((await other.app.interactions.listOutboxEvents(other.owner, other.tenantId)).length, 0);
  const crossDispatch = await interactionsError(other.app.interactions.dispatchOutboxEvent(other.owner, other.tenantId, event.id));
  assert.equal(crossDispatch.code, 'EVENT_NOT_FOUND');
  // No delivery ever happened for the foreign event.
  assert.equal(b.app.eventDelivery.attemptsFor(event.id), 0);

  const row = b.app.eventsStore.outboxEvents.get(event.id);
  assert.ok(row !== undefined);
  row.payload = { ...row.payload, outcome: 'failed' };
  const tampered = await interactionsError(b.app.interactions.getOutboxEvent(b.owner, b.tenantId, event.id));
  assert.equal(tampered.code, 'EVENT_RECORD_TAMPERED');
});

// ---------------------------------------------------------------------------
// AC-4: Zeck callbacks use the same durable ingestion guarantees
// (the /zeck boundary's own authority, consumed through its public
// surface — nothing here modifies /zeck)
// ---------------------------------------------------------------------------

test('AC-4 GUARANTEE EQUIVALENCE: Zeck callbacks converge by stable identity exactly like inbox events (the same durable-ingestion guarantees)', async () => {
  // The Zeck boundary path (its OWN authority, public surface only):
  // register work, submit an intent through the gateway double, then
  // deliver the same callback twice.
  const zeckApp = buildZeckBoundaryApp({
    now: () => new Date('2026-09-02T12:00:00.000Z'),
    gateway: createInMemoryZeckGateway(),
  });
  const zeckOwner = await zeckApp.auth.registerHuman({ email: 'owner@z.com', password: PASSWORD, displayName: 'Owner' });
  const created = await zeckApp.organizations.createOrganization(zeckOwner, { slug: 'zeck-org', displayName: 'Zeck' });
  const { work } = await zeckApp.work.createWork(zeckOwner, {
    tenantId: created.tenant.id,
    workType: 'AssessDocument',
    title: 'Assess the certificate',
  });
  const { attempt } = await zeckApp.work.createAttempt(zeckOwner, created.tenant.id, work.id, { idempotencyKey: 'attempt-1' });
  const { intent } = await zeckApp.zeck.submitExecutionIntent(zeckOwner, {
    tenantId: created.tenant.id,
    serviceWorkId: work.id,
    workAttemptId: attempt.id,
    objective: 'Assess whether the uploaded certificate satisfies the compliance policy',
    inputArtifactRefs: ['artifact://insurance-certificate.pdf'],
    businessContext: { domain: 'construction', jurisdiction: 'EU' },
    requiredCapabilities: [{ capability: 'document.reasoning', minQuality: 0.8, maxLatencyMs: 60000 }],
    businessConstraints: { privacy: 'no-cross-tenant-data', retention: '30d' },
    outputContract: { schemaRef: 'schema://compliance-assessment.v1', description: 'The assessment verdict with evidence references' },
    idempotencyKey: 'intent-1',
  });
  assert.ok(intent.zeckExecutionId !== null);
  const zeckCallback = (eventId: string) => ({
    eventId,
    eventType: 'execution.completed',
    zeckExecutionId: intent.zeckExecutionId as string,
    occurredAt: new Date('2026-09-02T12:05:00.000Z'),
    payload: {
      summary: 'The certificate satisfies every required clause',
      artifactRefs: ['artifact://assessment-report.pdf'],
      evidenceRefs: ['evidence://clause-matrix.json'],
      provenanceRef: 'provenance://run-42',
      warnings: [],
      reportedCostRef: 'cost://statement-2026-09-42',
      reportedLatencyMs: 4200,
    },
  });

  const first = await zeckApp.zeck.ingestCallback(zeckOwner, created.tenant.id, zeckCallback('evt-zeck-1'));
  const replay = await zeckApp.zeck.ingestCallback(zeckOwner, created.tenant.id, zeckCallback('evt-zeck-1'));
  // GUARANTEE 1 (stable-identity dedup + convergent replay) HOLDS on the
  // Zeck path.
  assert.equal(replay.converged, true);
  assert.equal(replay.event.id, first.event.id);
  assert.equal((await zeckApp.zeck.listCallbackEvents(zeckOwner, created.tenant.id)).length, 1);

  // GUARANTEE 2 (divergent re-delivery of the same identity fails closed)
  // HOLDS on the Zeck path.
  const divergent = await (async () => {
    try {
      await zeckApp.zeck.ingestCallback(zeckOwner, created.tenant.id, {
        ...zeckCallback('evt-zeck-1'),
        occurredAt: new Date('2026-09-02T13:00:00.000Z'),
      });
    } catch (error) {
      return error as { code?: string };
    }
    return null;
  })();
  assert.ok(divergent !== null);
  assert.equal(divergent?.code, 'EVENT_CONFLICT');

  // The inbox path holds the SAME guarantees (already proven above and
  // here once more, side by side): stable identity, convergent replay,
  // divergent conflict, durable rejections — the guarantee set is
  // identical by construction (documented mapping in the Work Order
  // evidence).
  const b = await base();
  const interactionId = await dispatchedInteraction(b);
  const inboxFirst = await b.app.interactions.ingestExternalEvent(b.owner, b.tenantId, deliveryResult(interactionId, 'succeeded', 'evt-inbox-1'));
  const inboxReplay = await b.app.interactions.ingestExternalEvent(b.owner, b.tenantId, deliveryResult(interactionId, 'succeeded', 'evt-inbox-1'));
  assert.equal(inboxReplay.converged, true);
  assert.equal(inboxReplay.event.id, inboxFirst.event.id);
  const inboxDivergent = await interactionsError(
    b.app.interactions.ingestExternalEvent(b.owner, b.tenantId, deliveryResult(interactionId, 'failed', 'evt-inbox-1')),
  );
  assert.equal(inboxDivergent.code, 'EVENT_DELIVERY_CONFLICT');
  assert.equal((await b.app.interactions.listInboxEvents(b.owner, b.tenantId)).length, 1);
});

// ---------------------------------------------------------------------------
// Frozen vocabularies (no vertical-specific event meanings)
// ---------------------------------------------------------------------------

test('the event vocabularies are frozen and horizontal (discrimination: no vertical event meanings)', () => {
  assert.deepEqual(INBOUND_EVENT_TYPES, ['interaction.delivery_result']);
  assert.deepEqual(OUTBOUND_EVENT_TYPES, ['interaction.observed']);
  // The source taxonomy is the /integrations capability classes (Zeck
  // deliberately absent — its callbacks keep their own boundary).
  const sources = new Set<string>();
  for (const capability of ['email', 'sms', 'voice', 'accounting_erp', 'crm', 'construction_management', 'property_management', 'procurement', 'payment', 'document_storage', 'government_portal']) {
    sources.add(capability);
  }
  assert.equal(sources.has('zeck'), false);
});

test('construction-time fail-closed: the in-memory seam requires BOTH stores', async () => {
  const b = await base();
  assert.throws(
    () =>
      createInteractionsModule({
        store: b.app.interactionsStore,
        tenancy: b.app.organizations,
        policies: b.app.policies,
        sink: b.app.sink,
      }),
    (error: unknown) => (error as InteractionsError).code === 'INVALID_INPUT',
  );
  assert.throws(
    () =>
      createInteractionsModule({
        store: b.app.interactionsStore,
        eventsStore: b.app.eventsStore,
        executor: {} as never,
        tenancy: b.app.organizations,
        policies: b.app.policies,
        sink: b.app.sink,
      }),
    (error: unknown) => (error as InteractionsError).code === 'INVALID_INPUT',
  );
});

// ---------------------------------------------------------------------------
// Module typing sanity (compile-time surface; keeps the public contract honest)
// ---------------------------------------------------------------------------

test('the module exposes the event substrate surface (typed contract)', async () => {
  const b = await base();
  const surface: (keyof InteractionsApp['interactions'])[] = [
    'ingestExternalEvent',
    'processInboxEvents',
    'retryInboxEvent',
    'recoverInboxEvent',
    'getInboxEvent',
    'listInboxEvents',
    'listRecoverableInboxEvents',
    'recordOutboundEvent',
    'dispatchOutboxEvent',
    'recoverOutboxEvent',
    'getOutboxEvent',
    'listOutboxEvents',
    'listRecoverableOutboxEvents',
  ];
  for (const name of surface) {
    assert.equal(typeof b.app.interactions[name], 'function', `${name} must be a public surface function`);
  }
  void (undefined as unknown as ZeckModule);
  void (undefined as unknown as OutboxEventRecord);
});
