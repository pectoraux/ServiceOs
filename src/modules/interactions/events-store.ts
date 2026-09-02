/**
 * ServiceOS /interactions event-substrate store port (WORK-006).
 *
 * The persistence contract for the durable event inbox/outbox substrate
 * (architecture.md §14; integration-model.md "Inbound events"; the Work
 * Order's frozen scope: event ingestion, durable inbox/outbox, idempotent
 * event consumers, provider-independent event contracts). The
 * authoritative implementation is the SQL store executed through the
 * persistence boundary's `TransactionalExecutor` (client-pinned
 * transactions); tests inject a faithful in-memory implementation of
 * this same port.
 *
 * Store contract semantics (mirrored by every implementation):
 *
 * - THE DURABLE EVENT SURFACE IS THIS PORT'S MUTATION SURFACE. The inbox
 *   (`ingestInboxEvent` the durable delivery record + deduplication,
 *   `claimInboxEvent`/`retryInboxEvent`/`reclaimInboxEvent`/`completeInboxEvent`/`failInboxEvent`
 *   the processing lifecycle) and the outbox (`createOutboxEvent` the
 *   durable outbound intent, `claimOutboxEvent`/`completeOutboxDispatch`/`failOutboxDispatch`/`reclaimOutboxDispatch`
 *   the dispatch lifecycle) live here and nowhere else. NOTHING here
 *   calls a provider or delivery port (the module invokes the injected
 *   provider-neutral delivery port between the claim and the completion
 *   writes), and nothing here mutates business state: an inbound event's
 *   domain effect is produced by the module's idempotent consumer; an
 *   outbound event's delivery acceptance is an observation of the
 *   delivery, never a business outcome.
 *
 * - INBOUND IDENTITY IS STABLE AND TENANT-SCOPED (AC-1). One durable
 *   inbox event per (tenant, source, external event id): the provider's
 *   own event identity, preserved verbatim (architecture-lock #20). An
 *   identical re-delivery (same delivery hash over the canonical
 *   envelope) converges on the durable record — duplicate inbound events
 *   converge; a DIVERGENT re-delivery of the same identity fails closed
 *   (`event-delivery-conflict`) — duplicate event mutation is detected.
 *   This is the same durable-ingestion guarantee set the /zeck callback
 *   ledger applies (Work Order AC-4: Zeck callbacks use the same
 *   guarantees; /zeck keeps its own translated-callback authority).
 *
 * - EVERY TRANSITION IS AN ATOMIC COMPARE-AND-SET. Inbox:
 *   `received -> processing` (claim), `failed -> processing` (retry),
 *   `processing -> processing` (recovery re-claim — the crash-window
 *   marker), `processing -> consumed` (consumer completion) or
 *   `processing -> failed` (typed consumer failure). Outbox:
 *   `intended -> dispatching` (claim), `dispatching -> dispatching`
 *   (recovery re-claim), `dispatching -> dispatched` (delivery
 *   acceptance) or `dispatching -> failed` (explicit dispatch failure).
 *   Concurrent workers on the same event serialize (row lock /
 *   synchronous critical section); every loser fails closed with the
 *   typed rule carrying the observed state — never a double claim,
 *   never a lost update, so two consumers of the same event never
 *   produce duplicate domain effects.
 *
 * - OUTBOUND INTENT IS IDEMPOTENT (AC-2). `createOutboxEvent` converges
 *   on the durable event identified by (tenant, idempotency key) when
 *   the submission input matches the recorded input hash; a divergent
 *   re-submission of the same key fails closed
 *   (`outbox-input-conflict`). The durable intent precedes any delivery
 *   attempt and survives a crash between intent and dispatch — the
 *   recovery surface (`reclaimOutboxDispatch`) re-dispatches it.
 *
 * - MANDATORY TENANT PREDICATES. Every lookup and list carries the
 *   tenant parameter in its signature and its query; a row in another
 *   tenant is indistinguishable from a missing row (lock #15/#16).
 *
 * - TAMPER-EVIDENT READS. Every legitimate state write recomputes the
 *   record integrity hash, and every read recomputes it from the stored
 *   fields and fails closed (`event-record-tampered`) on divergence —
 *   after-the-fact mutation of any recorded field is detected on read.
 */
import type { CapabilityClass } from '../integrations/index.js';
import type { PolicyProvenance } from './store.js';

// ---------------------------------------------------------------------------
// Store rule vocabulary (atomic guarded-transaction mirrors)
// ---------------------------------------------------------------------------

/** Atomic store-level rule violation (mirrors a guarded SQL transaction). */
export type EventsStoreRule =
  | 'event-delivery-conflict'
  | 'inbox-claim-conflict'
  | 'inbox-completion-conflict'
  | 'inbox-retry-conflict'
  | 'inbox-reclaim-conflict'
  | 'outbox-claim-conflict'
  | 'outbox-completion-conflict'
  | 'outbox-reclaim-conflict'
  | 'outbox-input-conflict'
  | 'event-record-tampered';

export class EventsStoreRuleError extends Error {
  constructor(message: string, readonly rule: EventsStoreRule) {
    super(message);
    this.name = 'EventsStoreRuleError';
  }
}

/** Single-row target absent (scoped by the tenant predicate). */
export class EventsStoreMissingError extends Error {
  constructor(message: string, readonly what: 'inbox-event' | 'outbox-event') {
    super(message);
    this.name = 'EventsStoreMissingError';
  }
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/**
 * The durable inbox lifecycle. `received` is the validated, deduplicated
 * delivery; `processing` is the claimed crash window (a worker holds the
 * claim; the consumer may or may not have run); `consumed` is terminal:
 * the idempotent consumer produced its durable domain effect;
 * `failed` is an explicit, typed, retryable consumer failure;
 * `rejected` is a durably recorded delivery rejection (the record IS the
 * evidence — identical replays converge on the same rejection).
 */
export type InboxEventState = 'received' | 'processing' | 'consumed' | 'failed' | 'rejected';

/** The frozen durable rejection reasons of a delivery (the /zeck vocabulary discipline). */
export type InboxRejectionCode = 'unknown_event_type' | 'invalid_payload' | 'uncorrelated';

/** The frozen, horizontal inbound event vocabulary (no vertical meanings). */
export type InboundEventType = 'interaction.delivery_result';

export const INBOUND_EVENT_TYPES: readonly InboundEventType[] = ['interaction.delivery_result'];

export function isInboundEventType(value: string): value is InboundEventType {
  return (INBOUND_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * The validated payload contract of `interaction.delivery_result`: a
 * provider's report of the terminal result of a dispatched interaction.
 * The observation itself is recorded through the /interactions
 * observation authority by the inbox's idempotent consumer — never
 * duplicated here as a second observation.
 */
/** The validated payload contract of `interaction.delivery_result` (a type alias: values are canonical-record-shaped). */
export type InteractionDeliveryResultPayload = {
  readonly interactionId: string;
  readonly outcome: 'succeeded' | 'failed';
  readonly providerObservation?: unknown;
};

/** The durable rejection evidence of a delivery (state `rejected`). */
export interface InboxEventRejection {
  readonly code: InboxRejectionCode;
  readonly rejectedAt: Date;
}

/** The processing claim (the crash-window marker), from claiming on. */
export interface InboxEventClaim {
  readonly claimedBy: string;
  readonly claimedAt: Date;
}

/** The recorded consumer completion (state `consumed`, terminal). */
export interface InboxEventConsumption {
  /** The consumer's durable result summary (e.g. the observed interaction). */
  readonly result: Readonly<Record<string, unknown>>;
  readonly consumedBy: string;
  readonly consumedAt: Date;
}

/** The explicit, typed consumer failure (state `failed`, retryable). */
export interface InboxEventFailure {
  readonly code: string;
  readonly message: string;
  readonly failedAt: Date;
}

/**
 * One durable inbox event: the validated, deduplicated delivery record
 * with its processing lifecycle. The payload is the contract-validated,
 * canonical provider envelope payload (never re-interpreted here).
 */
export interface InboxEventRecord {
  readonly id: string;
  readonly tenantId: string;
  /** The frozen provider-neutral event source (a /integrations capability class). */
  readonly source: CapabilityClass;
  /** The provider's own stable event identity, preserved verbatim (lock #20). */
  readonly externalEventId: string;
  readonly eventType: string;
  readonly occurredAt: Date;
  readonly payload: InteractionDeliveryResultPayload | Readonly<Record<string, unknown>>;
  /** sha256 over the canonical delivery envelope (the replay identity). */
  readonly deliveryHash: string;
  readonly state: InboxEventState;
  readonly rejection: InboxEventRejection | null;
  readonly claim: InboxEventClaim | null;
  readonly consumption: InboxEventConsumption | null;
  readonly failure: InboxEventFailure | null;
  readonly receivedBy: string;
  readonly recordHash: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * The durable outbox lifecycle. `intended` is the durable outbound
 * intent BEFORE any delivery attempt (AC-2: durable intent is never
 * silently lost); `dispatching` is the claimed crash window;
 * `dispatched` is the delivery port's recorded ACCEPTANCE (never a
 * business outcome); `failed` is an explicit, durable dispatch failure.
 */
export type OutboxEventState = 'intended' | 'dispatching' | 'dispatched' | 'failed';

/** The frozen, horizontal outbound event vocabulary (no vertical meanings). */
export type OutboundEventType = 'interaction.observed';

export const OUTBOUND_EVENT_TYPES: readonly OutboundEventType[] = ['interaction.observed'];

export function isOutboundEventType(value: string): value is OutboundEventType {
  return (OUTBOUND_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * The authority-derived payload of `interaction.observed`: the terminal
 * observation of a dispatched interaction, DERIVED from the interaction
 * authority's durable record at intent time (never re-supplied by the
 * caller — the content cannot be fabricated) and pinned into the event.
 */
/** The authority-derived payload of `interaction.observed` (a type alias: values are canonical-record-shaped). */
export type InteractionObservedPayload = {
  readonly interactionId: string;
  readonly outcome: 'succeeded' | 'failed';
  readonly provider: string;
  readonly providerReference: string | null;
  readonly observedAt: string;
};

/** The delivery acceptance facts recorded on the outbox event. */
export interface OutboxEventDispatch {
  readonly provider: string;
  readonly providerReference: string | null;
  readonly dispatchedAt: Date;
  readonly dispatchedBy: string;
}

/** The explicit, durable dispatch failure (state `failed`). */
export interface OutboxEventFailure {
  readonly code: string;
  readonly message: string;
  readonly failedAt: Date;
}

/**
 * One durable outbound event: the durable intent, the
 * authority-derived content, the provider-neutral destination reference
 * and the dispatch lifecycle. `correlation` is inert reference data
 * (same discipline as the interaction ledger).
 */
export interface OutboxEventRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly eventType: OutboundEventType;
  readonly payload: InteractionObservedPayload | Readonly<Record<string, unknown>>;
  /** The provider-neutral destination reference (resolved by the delivery port). */
  readonly destination: string;
  readonly correlation: Readonly<Record<string, string>>;
  readonly policy: PolicyProvenance | null;
  readonly requestedBy: string;
  readonly idempotencyKey: string | null;
  /** Deterministic intent identity: sha256 over the canonical intent core. */
  readonly inputHash: string;
  readonly recordHash: string;
  readonly state: OutboxEventState;
  readonly claim: InboxEventClaim | null;
  readonly dispatch: OutboxEventDispatch | null;
  readonly failure: OutboxEventFailure | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface IngestInboxEventInput {
  readonly tenantId: string;
  readonly source: CapabilityClass;
  readonly externalEventId: string;
  readonly eventType: string;
  readonly occurredAt: Date;
  /** The canonical, contract-validated payload (module-side validation). */
  readonly payload: Readonly<Record<string, unknown>>;
  /** sha256 over the canonical delivery envelope. */
  readonly deliveryHash: string;
  /** The module-side ingress-validation decision (null = a valid, receivable delivery). */
  readonly rejection: InboxRejectionCode | null;
  readonly receivedBy: string;
  readonly now: Date;
}

export interface ClaimInboxEventInput {
  readonly tenantId: string;
  readonly eventId: string;
  readonly claimedBy: string;
  readonly now: Date;
}

export interface RetryInboxEventInput {
  readonly tenantId: string;
  readonly eventId: string;
  readonly retriedBy: string;
  readonly now: Date;
}

export interface ReclaimInboxEventInput {
  readonly tenantId: string;
  readonly eventId: string;
  readonly reclaimedBy: string;
  readonly now: Date;
}

export interface CompleteInboxEventInput {
  readonly tenantId: string;
  readonly eventId: string;
  /** The consumer's durable result summary. */
  readonly result: Readonly<Record<string, unknown>>;
  readonly consumedBy: string;
  readonly now: Date;
}

export interface FailInboxEventInput {
  readonly tenantId: string;
  readonly eventId: string;
  readonly code: string;
  readonly message: string;
  readonly now: Date;
}

export interface CreateOutboxEventInput {
  readonly tenantId: string;
  readonly eventType: OutboundEventType;
  /** The authority-derived, pinned content (validated module-side). */
  readonly payload: Readonly<Record<string, unknown>>;
  readonly destination: string;
  readonly correlation: Readonly<Record<string, string>> | null;
  readonly policy: PolicyProvenance | null;
  readonly requestedBy: string;
  readonly idempotencyKey: string | null;
  /** sha256 over the canonical intent core. */
  readonly inputHash: string;
  readonly now: Date;
}

export interface ClaimOutboxEventInput {
  readonly tenantId: string;
  readonly eventId: string;
  readonly claimedBy: string;
  readonly now: Date;
}

export interface CompleteOutboxDispatchInput {
  readonly tenantId: string;
  readonly eventId: string;
  readonly provider: string;
  readonly providerReference: string | null;
  readonly dispatchedBy: string;
  readonly now: Date;
}

export interface FailOutboxDispatchInput {
  readonly tenantId: string;
  readonly eventId: string;
  readonly dispatchedBy: string;
  /** The raw delivery-port error (bounded, recorded verbatim). */
  readonly error: string;
  readonly now: Date;
}

export interface ReclaimOutboxDispatchInput {
  readonly tenantId: string;
  readonly eventId: string;
  readonly reclaimedBy: string;
  readonly now: Date;
}

/** Read-side inbox list filter (every field optional; the tenant predicate is mandatory). */
export interface InboxEventFilter {
  readonly state?: InboxEventState;
  readonly source?: CapabilityClass;
}

/** Read-side outbox list filter (every field optional; the tenant predicate is mandatory). */
export interface OutboxEventFilter {
  readonly state?: OutboxEventState;
}

// ---------------------------------------------------------------------------
// Store port
// ---------------------------------------------------------------------------

export interface EventsStore {
  /**
   * Persist the durable delivery (dedup by the stable identity
   * (tenant, source, external event id)). An identical re-delivery
   * converges on the durable record (received, settled or rejected
   * alike — the disposition is durable); a divergent re-delivery of
   * the same identity fails closed (`event-delivery-conflict`).
   */
  ingestInboxEvent(input: IngestInboxEventInput): Promise<{ event: InboxEventRecord; converged: boolean }>;
  /** Tenant-predicated lookup by the durable inbox event id; null when absent in this tenant. */
  findInboxEvent(tenantId: string, eventId: string): Promise<InboxEventRecord | null>;
  /** Tenant-predicated list (append-order), optionally filtered. */
  listInboxEvents(tenantId: string, filter?: InboxEventFilter): Promise<InboxEventRecord[]>;
  /** The worker-dispatch claim surface: `received` events of this tenant (append order, bounded). */
  listClaimableInboxEvents(tenantId: string, limit: number): Promise<InboxEventRecord[]>;
  /** The crash-recovery surface: `processing` events of this tenant. */
  listRecoverableInboxEvents(tenantId: string): Promise<InboxEventRecord[]>;
  /**
   * Atomically claim an inbox event for processing: `received -> processing`
   * exactly once. Concurrent claimants serialize; every loser fails closed
   * with `inbox-claim-conflict` carrying the observed state.
   */
  claimInboxEvent(input: ClaimInboxEventInput): Promise<InboxEventRecord>;
  /**
   * Explicit retry of a `failed` event: `failed -> processing` (claim
   * refreshed). Fails closed with `inbox-retry-conflict` when the event
   * is not in the failed state — only explicit failures are retried.
   */
  retryInboxEvent(input: RetryInboxEventInput): Promise<InboxEventRecord>;
  /**
   * Recovery re-claim: REFRESH the claim of a `processing` event (a
   * crashed worker left the window open). The state stays `processing`;
   * the re-invocation is safe by the consumer's idempotency by durable
   * identity. Fails closed with `inbox-reclaim-conflict` otherwise.
   */
  reclaimInboxEvent(input: ReclaimInboxEventInput): Promise<InboxEventRecord>;
  /**
   * Record the consumer completion: `processing -> consumed` (terminal,
   * with the consumer's durable result summary). Fails closed with
   * `inbox-completion-conflict` when the row is not in the claimed
   * state (a concurrent completion or recovery won the race).
   */
  completeInboxEvent(input: CompleteInboxEventInput): Promise<InboxEventRecord>;
  /**
   * Record an explicit consumer failure: `processing -> failed` with the
   * typed failure code/message (retryable through `retryInboxEvent`).
   */
  failInboxEvent(input: FailInboxEventInput): Promise<InboxEventRecord>;
  /**
   * Persist the durable outbound intent (state `intended`). Keyed
   * submissions converge on the durable event (input-matched); a
   * divergent re-submission of the same key fails closed
   * (`outbox-input-conflict`). Durable intent precedes any delivery.
   */
  createOutboxEvent(input: CreateOutboxEventInput): Promise<{ event: OutboxEventRecord; converged: boolean }>;
  /** Tenant-predicated lookup; null when absent in this tenant. */
  findOutboxEvent(tenantId: string, eventId: string): Promise<OutboxEventRecord | null>;
  /** Tenant-predicated list (append-order), optionally filtered. */
  listOutboxEvents(tenantId: string, filter?: OutboxEventFilter): Promise<OutboxEventRecord[]>;
  /** The crash-recovery surface: `dispatching` outbox events of this tenant. */
  listRecoverableOutboxEvents(tenantId: string): Promise<OutboxEventRecord[]>;
  /**
   * Atomically claim the dispatch: `intended -> dispatching` exactly
   * once. Concurrent dispatchers serialize; every loser fails closed
   * with `outbox-claim-conflict` carrying the observed state.
   */
  claimOutboxEvent(input: ClaimOutboxEventInput): Promise<OutboxEventRecord>;
  /**
   * Record the delivery acceptance: `dispatching -> dispatched`. Fails
   * closed with `outbox-completion-conflict` when the row is not in the
   * claimed state.
   */
  completeOutboxDispatch(input: CompleteOutboxDispatchInput): Promise<OutboxEventRecord>;
  /**
   * Record an explicit dispatch FAILURE: `dispatching -> failed` (the
   * delivery port invocation failed — explicit, durable, terminal for
   * this identity; the caller records a new intent to retry).
   */
  failOutboxDispatch(input: FailOutboxDispatchInput): Promise<OutboxEventRecord>;
  /**
   * Recovery re-claim: REFRESH the dispatch claim of a `dispatching`
   * event (a crashed dispatcher left the window open). The state stays
   * `dispatching`; the re-dispatch is safe by the delivery port
   * contract's identity idempotency. Fails closed with
   * `outbox-reclaim-conflict` otherwise.
   */
  reclaimOutboxDispatch(input: ReclaimOutboxDispatchInput): Promise<OutboxEventRecord>;
}
