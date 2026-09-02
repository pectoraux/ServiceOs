/**
 * ServiceOS /interactions event substrate (WORK-006, module internal —
 * the public surface is re-exported through the module's index).
 *
 * THE durable event inbox/outbox (architecture.md §14; integration-model.md
 * "Inbound events"; the Work Order's authorized surface: event inbox/outbox,
 * durable event ingestion and dispatch, worker dispatch, callback ingestion,
 * idempotent event consumers, provider-independent event contracts):
 *
 * - THE INBOX IS THE DURABLE, DEDUPLICATED EXTERNAL EVENT SURFACE
 *   (AC-1/AC-4). `ingestExternalEvent` validates the envelope against the
 *   frozen provider-independent contracts (the /integrations capability
 *   classes as event sources; the frozen horizontal event-type
 *   enumeration), pins the delivery hash over the canonical envelope, and
 *   persists ONE durable record per stable identity (tenant, source,
 *   external event id — the provider's identity preserved verbatim,
 *   lock #20). Identical re-deliveries converge; divergent re-deliveries
 *   fail closed typed. Semantically untranslatable deliveries are
 *   DURABLY RECORDED as rejected evidence and fail closed typed — the
 *   same durable-ingestion guarantee set the /zeck callback ledger
 *   applies (AC-4: Zeck callbacks keep their own translated-callback
 *   authority with the same guarantees; nothing here shadows /zeck).
 * - INBOX PROCESSING IS WORKER-CLAIMED AND IDEMPOTENT. `processInboxEvents`
 *   claims `received` events one atomic CAS at a time (concurrent workers
 *   of the same event converge: exactly one consumer invocation per claim,
 *   the loser converges on the durable result or surfaces the typed
 *   in-progress state), invokes the composed idempotent consumer (the
 *   `interaction.delivery_result` consumer records the observation through
 *   the module's observation authority — convergent by interaction
 *   identity, so duplicate processing and crash-window re-processing
 *   converge on ONE domain effect), and records the completion or the
 *   explicit typed failure (retryable through `retryInboxEvent`; the
 *   crash window through `recoverInboxEvent`).
 * - THE OUTBOX IS THE DURABLE OUTBOUND EVENT INTENT (AC-2).
 *   `recordOutboundEvent` persists the intent BEFORE any delivery attempt
 *   (authorization first, an optional /policies gate that denies closed
 *   before the intent row exists, and authority-DERIVED content — the
 *   `interaction.observed` payload is derived from the interaction
 *   authority's terminal observation, never re-supplied by the caller,
 *   so the emitted content cannot be fabricated). Keyed submissions
 *   converge; divergent ones fail closed typed.
 * - OUTBOX DISPATCH IS CLAIMED, IDEMPOTENT AND CRASH-CONVERGENT.
 *   `dispatchOutboxEvent` claims the intent (`intended -> dispatching`,
 *   atomic CAS), delivers through the injected provider-neutral
 *   `EventDeliveryPort` (the same containment discipline as the
 *   interaction ledger's effect sink — no module other than this
 *   authority touches a delivery surface), and records the acceptance or
 *   the explicit dispatch failure. When no delivery port is composed the
 *   dispatch fails closed `EVENT_DELIVERY_UNAVAILABLE` and the claim
 *   stands for recovery (truthful unavailability — no fabricated
 *   delivery; real delivery adapters belong to the Work Order owning
 *   provider/destination configuration). The crash window between intent
 *   and dispatch converges through `recoverOutboxEvent`: the port
 *   contract's identity idempotency makes the re-dispatch safe.
 * - NO VERTICAL-SPECIFIC EVENT MEANINGS (forbidden surface): the event
 *   vocabularies are frozen horizontal enumerations in this module's
 *   code; unknown event types fail closed (durably recorded rejections).
 * - NO AI EXECUTION ENGINE (forbidden surface): the substrate moves
 *   events; it never plans, interprets or executes AI work (Zeck is the
 *   sole AI execution authority; Zeck callbacks remain /zeck's boundary).
 * - TENANT ISOLATION (AC-3): every surface authorizes through the single
 *   /organizations chain BEFORE any store access, and every store
 *   predicate is tenant-scoped — a row in another tenant is
 *   indistinguishable from a missing row.
 */
import type { Principal } from '../auth/index.js';
import type { TenancyAction } from '../organizations/index.js';
import type { PolicyDecisionRecord } from '../policies/index.js';
import { isCapabilityClass, type CapabilityClass } from '../integrations/index.js';
import type { PolicyProvenance } from './store.js';
import type { EventDeliveryPort } from './events-delivery.js';
import {
  EventsStoreMissingError,
  EventsStoreRuleError,
  isInboundEventType,
  isOutboundEventType,
  type EventsStore,
  type InboxEventFilter,
  type InboxEventRecord,
  type InteractionDeliveryResultPayload,
  type InteractionObservedPayload,
  type OutboxEventFilter,
  type OutboxEventRecord,
  type OutboundEventType,
} from './events-store.js';
import { canonicalJson, hashEventDelivery, hashOutboundInput } from './provenance.js';

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

/** The outcome of one inbox processing attempt (one event, one claim). */
export interface InboxProcessResult {
  readonly event: InboxEventRecord;
  /** True when THIS call invoked the consumer (the claim was won and the consumer ran). */
  readonly invoked: boolean;
  /** True when this call converged on another worker's durable result. */
  readonly converged: boolean;
  /** True when the claim was lost and the winner is still processing (retryable later). */
  readonly inProgress: boolean;
  /** The typed failure code when the consumer failed (the event is durably `failed`). */
  readonly failureCode: string | null;
}

/** The substrate's view of the interaction-ledger surface it builds on. */
export interface EventSubstrateDeps {
  authorizeTenant(principal: Principal, tenantId: string, action: TenancyAction): Promise<void>;
  /**
   * The interaction authority's tenant-predicated read (correlation
   * validation and content derivation, read-only). The dispatch
   * acceptance carries the provider facts; the observation carries the
   * terminal outcome facts (the interaction-ledger record shapes).
   */
  findInteraction(
    tenantId: string,
    interactionId: string,
  ): Promise<
    | {
        state: string;
        dispatch: {
          provider: string;
          providerReference: string | null;
        } | null;
        observation: {
          outcome: 'succeeded' | 'failed';
          observedAt: Date;
        } | null;
      }
    | null
  >;
  /**
   * The observation surface consumed by the inbox's idempotent consumer
   * (the module's own recordObservedResult — the ONE observation path).
   */
  recordObservation(
    principal: Principal,
    tenantId: string,
    interactionId: string,
    input: { outcome: 'succeeded' | 'failed'; providerObservation?: unknown },
  ): Promise<{ interaction: { observation: { outcome: 'succeeded' | 'failed' } | null }; converged: boolean }>;
  /** The policy gate (evaluatePolicy from /policies' public contract). */
  evaluatePolicy(
    principal: Principal,
    input: {
      tenantId: string;
      policyKey: string;
      action: string;
      attributes: Readonly<Record<string, string | number | boolean | null>>;
      idempotencyKey?: string;
    },
  ): Promise<{ decision: PolicyDecisionRecord; converged: boolean }>;
  /** The provider-neutral outbound event delivery port (absent = the boundary ships closed). */
  eventDelivery?: EventDeliveryPort;
  now(): Date;
}

/** The module error factory (typed code + message). */
export interface EventSubstrateErrorShape {
  (code: string, message: string): Error & { code: string };
}

/** The public event-surface operations added to the /interactions module. */
export interface EventSubstrateSurface {
  ingestExternalEvent(
    principal: Principal,
    tenantId: string,
    input: {
      source: CapabilityClass;
      eventId: string;
      eventType: string;
      occurredAt: Date;
      payload: unknown;
    },
  ): Promise<{ event: InboxEventRecord; converged: boolean }>;
  processInboxEvents(
    principal: Principal,
    tenantId: string,
    input?: { limit?: number },
  ): Promise<{ outcomes: InboxProcessResult[] }>;
  retryInboxEvent(principal: Principal, tenantId: string, eventId: string): Promise<InboxProcessResult>;
  recoverInboxEvent(principal: Principal, tenantId: string, eventId: string): Promise<InboxProcessResult>;
  getInboxEvent(principal: Principal, tenantId: string, eventId: string): Promise<InboxEventRecord>;
  listInboxEvents(principal: Principal, tenantId: string, filter?: InboxEventFilter): Promise<InboxEventRecord[]>;
  listRecoverableInboxEvents(principal: Principal, tenantId: string): Promise<InboxEventRecord[]>;
  recordOutboundEvent(
    principal: Principal,
    tenantId: string,
    input: {
      eventType: OutboundEventType;
      interactionId: string;
      destination: string;
      correlation?: Readonly<Record<string, string>>;
      policyKey?: string;
      idempotencyKey?: string;
    },
  ): Promise<{ event: OutboxEventRecord; converged: boolean }>;
  dispatchOutboxEvent(
    principal: Principal,
    tenantId: string,
    eventId: string,
  ): Promise<{ event: OutboxEventRecord; invoked: boolean; converged: boolean }>;
  recoverOutboxEvent(
    principal: Principal,
    tenantId: string,
    eventId: string,
  ): Promise<{ event: OutboxEventRecord; invoked: boolean; converged: boolean }>;
  getOutboxEvent(principal: Principal, tenantId: string, eventId: string): Promise<OutboxEventRecord>;
  listOutboxEvents(principal: Principal, tenantId: string, filter?: OutboxEventFilter): Promise<OutboxEventRecord[]>;
  listRecoverableOutboxEvents(principal: Principal, tenantId: string): Promise<OutboxEventRecord[]>;
}

// ---------------------------------------------------------------------------
// Validation (fail closed)
// ---------------------------------------------------------------------------

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXTERNAL_ID_PATTERN = /^[\x21-\x7E]{1,200}$/; // printable ASCII, 1..200 (the provider's event id, verbatim)
const DESTINATION_PATTERN = /^[\x21-\x7E]{1,200}$/;
const CORRELATION_KEY_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_CORRELATION_ENTRIES = 10;

/** The policy action the outbox intent gate uses (reserved). */
const OUTBOX_POLICY_ACTION = 'event.emit';

/**
 * Namespaced idempotency key for the policy decision a gated outbound
 * intent consults (the /policies decision namespace discipline).
 */
function policyIdempotencyKey(intentKey: string | null): string | undefined {
  return intentKey === null ? undefined : `event.outbox:${intentKey}`;
}

function validateOptionalKey(value: string | undefined, what: string, makeError: EventSubstrateErrorShape): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.trim() === '' || value.length > 200) {
    throw makeError('INVALID_INPUT', `${what} must be a non-empty string of at most 200 characters`);
  }
  return value.trim();
}

function validateObservationValue(value: unknown, depth = 0): void {
  if (depth > 8) throw new Error('providerObservation must not nest deeper than 8 levels');
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    if (typeof value === 'string' && value.length > 100_000) {
      throw new Error('providerObservation strings must stay under 100000 characters');
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 1_000) throw new Error('providerObservation arrays must stay under 1000 entries');
    for (const entry of value) validateObservationValue(entry, depth + 1);
    return;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 1_000) throw new Error('providerObservation objects must stay under 1000 entries');
    for (const [, entry] of entries) validateObservationValue(entry, depth + 1);
    return;
  }
  throw new Error('providerObservation must be a JSON value (no undefined/functions)');
}

/**
 * Validate the payload contract of one inbound event type. Returns the
 * validated payload, or null when the delivery is well-shaped but its
 * payload does not conform (the durable `invalid_payload` rejection).
 */
function validateInboundPayload(
  eventType: string,
  payload: unknown,
): { valid: InteractionDeliveryResultPayload | null; reason: string | null } {
  if (eventType === 'interaction.delivery_result') {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return { valid: null, reason: 'payload must be an object' };
    }
    const candidate = payload as Record<string, unknown>;
    const unknownKeys = Object.keys(candidate).filter(
      (key) => key !== 'interactionId' && key !== 'outcome' && key !== 'providerObservation',
    );
    if (unknownKeys.length > 0) {
      return { valid: null, reason: `payload carries unknown keys: ${unknownKeys.join(', ')}` };
    }
    if (typeof candidate.interactionId !== 'string' || !UUID_PATTERN.test(candidate.interactionId)) {
      return { valid: null, reason: 'payload.interactionId must be a UUID' };
    }
    if (candidate.outcome !== 'succeeded' && candidate.outcome !== 'failed') {
      return { valid: null, reason: 'payload.outcome must be "succeeded" or "failed"' };
    }
    if (candidate.providerObservation !== undefined) {
      try {
        validateObservationValue(candidate.providerObservation);
      } catch (error) {
        return { valid: null, reason: (error as Error).message };
      }
    }
    const validated: InteractionDeliveryResultPayload = {
      interactionId: candidate.interactionId,
      outcome: candidate.outcome,
      ...(candidate.providerObservation !== undefined ? { providerObservation: candidate.providerObservation } : {}),
    };
    return { valid: validated, reason: null };
  }
  return { valid: null, reason: `event type "${eventType}" has no payload contract` };
}

function validateCorrelation(
  value: Readonly<Record<string, string>> | undefined,
  makeError: EventSubstrateErrorShape,
): Readonly<Record<string, string>> | null {
  if (value === undefined) return null;
  const entries = Object.entries(value);
  if (entries.length > MAX_CORRELATION_ENTRIES) {
    throw makeError('INVALID_INPUT', `correlation must carry at most ${MAX_CORRELATION_ENTRIES} entries`);
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of entries) {
    if (!CORRELATION_KEY_PATTERN.test(key)) {
      throw makeError('INVALID_INPUT', `correlation key "${key}" must match [A-Za-z0-9_.-]{1,64}`);
    }
    if (typeof entry !== 'string' || entry.length > 256) {
      throw makeError('INVALID_INPUT', `correlation entry "${key}" must be a string of at most 256 characters`);
    }
    out[key] = entry;
  }
  return out;
}

/**
 * The evidence payload of a rejected delivery: the raw payload as
 * received, deterministically record-shaped (non-object values are
 * wrapped under a `value` key so the durable evidence and the delivery
 * hash agree on one canonical envelope).
 */
function evidencePayload(raw: unknown, makeError: EventSubstrateErrorShape): Readonly<Record<string, unknown>> {
  try {
    canonicalJson(raw);
  } catch {
    throw makeError('INVALID_INPUT', 'payload must be a JSON value');
  }
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    return raw as Readonly<Record<string, unknown>>;
  }
  return { value: raw };
}

// ---------------------------------------------------------------------------
// The substrate surface
// ---------------------------------------------------------------------------

/**
 * Build the event substrate over the shared dependencies. The surface
 * functions share the module's single authorization chain, its policy
 * gate, its observation authority (the inbox consumer's ONE observation
 * path) and the injected provider-neutral delivery port.
 */
export function createEventSubstrate(
  deps: EventSubstrateDeps,
  store: EventsStore,
  makeError: EventSubstrateErrorShape,
): EventSubstrateSurface {
  const { now, authorizeTenant, eventDelivery } = deps;

  // -- store-error mapping -------------------------------------------------

  function mapStoreError(error: unknown): never {
    if (error instanceof EventsStoreRuleError) {
      switch (error.rule) {
        case 'event-delivery-conflict':
          throw makeError('EVENT_DELIVERY_CONFLICT', error.message);
        case 'inbox-claim-conflict':
        case 'inbox-completion-conflict':
          throw makeError('INBOX_EVENT_IN_PROGRESS', error.message);
        case 'inbox-retry-conflict':
          throw makeError('INBOX_EVENT_NOT_FAILED', error.message);
        case 'inbox-reclaim-conflict':
          throw makeError('INBOX_RECOVERY_NOT_AVAILABLE', error.message);
        case 'outbox-claim-conflict':
        case 'outbox-completion-conflict':
          throw makeError('OUTBOX_EVENT_IN_PROGRESS', error.message);
        case 'outbox-reclaim-conflict':
          throw makeError('OUTBOX_RECOVERY_NOT_AVAILABLE', error.message);
        case 'outbox-input-conflict':
          throw makeError('EVENT_INPUT_CONFLICT', error.message);
        case 'event-record-tampered':
          throw makeError('EVENT_RECORD_TAMPERED', error.message);
      }
    }
    if (error instanceof EventsStoreMissingError) {
      throw makeError('EVENT_NOT_FOUND', error.message);
    }
    throw error;
  }

  // -- the inbox's idempotent consumer --------------------------------------

  /**
   * THE `interaction.delivery_result` consumer: record the provider's
   * observed result through the module's ONE observation path. The
   * consumer is idempotent by durable identity: re-invocation (crash
   * recovery, retry) converges on the same durable observation — two
   * consumers of the same event never produce duplicate domain effects.
   */
  async function consumeDeliveryResult(
    principal: Principal,
    tenantId: string,
    event: InboxEventRecord,
  ): Promise<Record<string, unknown>> {
    const payload = event.payload as InteractionDeliveryResultPayload;
    const { interaction, converged } = await deps.recordObservation(principal, tenantId, payload.interactionId, {
      outcome: payload.outcome,
      ...(payload.providerObservation !== undefined ? { providerObservation: payload.providerObservation } : {}),
    });
    return {
      kind: 'interaction.observed',
      interactionId: payload.interactionId,
      observationOutcome: interaction.observation?.outcome ?? null,
      converged,
    };
  }

  function consumerFailureCode(error: unknown): string {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' && code.length > 0 && code.length <= 64 ? code : 'CONSUMER_FAILURE';
  }

  // -- inbox processing core -------------------------------------------------

  /**
   * Run one CLAIMED inbox event through the consumer and record the
   * outcome. The claim is durable and atomic; the consumer runs between
   * the claim and the completion write; every outcome (consumed, typed
   * failure, lost-claim convergence) is surfaced explicitly.
   */
  async function runClaimedInboxEvent(
    principal: Principal,
    tenantId: string,
    eventId: string,
  ): Promise<InboxProcessResult> {
    try {
      const result = await consumeDeliveryResultSafe(principal, tenantId, eventId);
      if (result.error !== undefined) {
        const failed = await store.failInboxEvent({
          tenantId,
          eventId,
          code: consumerFailureCode(result.error),
          message: String((result.error as Error).message ?? result.error).slice(0, 2_000),
          now: now(),
        });
        return {
          event: failed,
          invoked: true,
          converged: false,
          inProgress: false,
          failureCode: failed.failure?.code ?? null,
        };
      }
      const completed = await store.completeInboxEvent({
        tenantId,
        eventId,
        result: result.result as Record<string, unknown>,
        consumedBy: principal.id,
        now: now(),
      });
      return { event: completed, invoked: true, converged: false, inProgress: false, failureCode: null };
    } catch (error) {
      // A concurrent worker completed first (completion conflict): the
      // durable result IS this event's outcome — converge on it.
      if (error instanceof EventsStoreRuleError && error.rule === 'inbox-completion-conflict') {
        const settled = await store.findInboxEvent(tenantId, eventId);
        if (settled !== null && (settled.state === 'consumed' || settled.state === 'failed')) {
          return {
            event: settled,
            invoked: true,
            converged: true,
            inProgress: false,
            failureCode: settled.failure?.code ?? null,
          };
        }
      }
      throw error;
    }
  }

  /**
   * The consumer invocation, isolated so a consumer failure is ALWAYS
   * recorded (never thrown past the claim) while the failure itself is
   * captured with its typed code for the durable record.
   */
  async function consumeDeliveryResultSafe(
    principal: Principal,
    tenantId: string,
    eventId: string,
  ): Promise<{ result?: Record<string, unknown>; error?: unknown }> {
    let event: InboxEventRecord | null;
    try {
      event = await store.findInboxEvent(tenantId, eventId);
    } catch (error) {
      return { error };
    }
    if (event === null) {
      return { error: new Error(`inbox event ${eventId} disappeared while claimed`) };
    }
    try {
      return { result: await consumeDeliveryResult(principal, tenantId, event) };
    } catch (error) {
      return { error };
    }
  }

  /**
   * Claim-and-run for one inbox event from a source state, with the
   * post-conflict re-check discipline (the WORK-004 lesson): a lost
   * claim converges on the winner's durable result or surfaces the
   * in-progress state — never a duplicate domain effect.
   */
  async function processInboxEventFrom(
    principal: Principal,
    tenantId: string,
    eventId: string,
    source: 'received' | 'failed' | 'processing',
  ): Promise<InboxProcessResult> {
    let existing: InboxEventRecord | null;
    try {
      existing = await store.findInboxEvent(tenantId, eventId);
    } catch (error) {
      return mapStoreError(error);
    }
    if (existing === null) {
      throw makeError('EVENT_NOT_FOUND', `inbox event ${eventId} does not exist in this tenant`);
    }
    if (existing.state === 'consumed') {
      return { event: existing, invoked: false, converged: true, inProgress: false, failureCode: null };
    }
    if (existing.state === 'rejected') {
      throw makeError(
        'INBOX_EVENT_REJECTED',
        `inbox event ${eventId} is durably recorded as rejected (${existing.rejection?.code}); rejected deliveries are evidence, not work`,
      );
    }

    try {
      if (source === 'received') {
        await store.claimInboxEvent({ tenantId, eventId, claimedBy: principal.id, now: now() });
      } else if (source === 'failed') {
        await store.retryInboxEvent({ tenantId, eventId, retriedBy: principal.id, now: now() });
      } else {
        await store.reclaimInboxEvent({ tenantId, eventId, reclaimedBy: principal.id, now: now() });
      }
    } catch (error) {
      if (error instanceof EventsStoreRuleError) {
        // A twin claimed/finished between the read and the claim: the
        // durable record is the outcome — converge on settled states,
        // surface in-progress claims explicitly (retryable later).
        const raced = await store.findInboxEvent(tenantId, eventId);
        if (raced !== null) {
          if (raced.state === 'consumed') {
            return { event: raced, invoked: false, converged: true, inProgress: false, failureCode: null };
          }
          if (raced.state === 'failed') {
            return {
              event: raced,
              invoked: false,
              converged: false,
              inProgress: false,
              failureCode: raced.failure?.code ?? null,
            };
          }
          if (raced.state === 'processing') {
            return { event: raced, invoked: false, converged: false, inProgress: true, failureCode: null };
          }
        }
      }
      return mapStoreError(error);
    }
    return runClaimedInboxEvent(principal, tenantId, eventId);
  }

  // -- outbox dispatch core ---------------------------------------------------

  /**
   * The dispatch core shared by `dispatchOutboxEvent` (claim from
   * `intended`) and `recoverOutboxEvent` (re-claim from `dispatching`):
   * the claim is durable; the delivery port is invoked between the claim
   * and the completion write; the acceptance or the explicit failure is
   * recorded. A missing port (composition gap) fails closed with the
   * claim standing for recovery — never a fabricated delivery.
   */
  async function invokeAndRecordOutbox(
    principal: Principal,
    tenantId: string,
    event: OutboxEventRecord,
  ): Promise<{ event: OutboxEventRecord; invoked: boolean; converged: boolean }> {
    if (eventDelivery === undefined) {
      throw makeError(
        'EVENT_DELIVERY_UNAVAILABLE',
        `no event delivery port is composed for outbound event ${event.id}: the outbox delivery boundary ships closed until the Work Order owning provider/destination configuration registers a real delivery adapter (the durable intent stands and is recoverable)`,
      );
    }
    let acceptance: Awaited<ReturnType<EventDeliveryPort['deliverEvent']>>;
    try {
      acceptance = await eventDelivery.deliverEvent({
        tenantId,
        eventId: event.id,
        eventType: event.eventType,
        destination: event.destination,
        payload: event.payload as Readonly<Record<string, unknown>>,
      });
    } catch (error) {
      // A delivery failure: explicit, durable, terminal for this
      // identity — the caller records a new intent to retry.
      const failed = await store.failOutboxDispatch({
        tenantId,
        eventId: event.id,
        dispatchedBy: principal.id,
        error: String((error as Error).message ?? error).slice(0, 2_000),
        now: now(),
      });
      return { event: failed, invoked: true, converged: false };
    }
    const dispatched = await store.completeOutboxDispatch({
      tenantId,
      eventId: event.id,
      provider: acceptance.provider,
      providerReference: acceptance.providerReference,
      dispatchedBy: principal.id,
      now: now(),
    });
    return { event: dispatched, invoked: true, converged: false };
  }

  // -- surface ---------------------------------------------------------------

  return {
    async ingestExternalEvent(principal, tenantId, raw) {
      await authorizeTenant(principal, tenantId, 'write');
      if (typeof raw !== 'object' || raw === null) {
        throw makeError('INVALID_INPUT', 'the external event input must be an object');
      }
      if (raw.source === undefined || !isCapabilityClass(raw.source)) {
        throw makeError('INVALID_INPUT', 'source must be a frozen provider-neutral capability class');
      }
      const source = raw.source;
      if (typeof raw.eventId !== 'string' || !EXTERNAL_ID_PATTERN.test(raw.eventId)) {
        throw makeError('INVALID_INPUT', 'eventId must be the provider\'s stable event identity (1..200 printable ASCII characters)');
      }
      if (typeof raw.eventType !== 'string' || raw.eventType.length === 0 || raw.eventType.length > 200) {
        throw makeError('INVALID_INPUT', 'eventType must be a non-empty string of at most 200 characters');
      }
      if (!(raw.occurredAt instanceof Date)) {
        throw makeError('INVALID_INPUT', 'occurredAt must be a Date');
      }

      // Ingress validation (the frozen contracts): the type vocabulary,
      // then the per-type payload contract. Well-shaped but
      // untranslatable deliveries are DURABLY RECORDED as rejected
      // evidence and fail closed typed (the /zeck disposition
      // discipline — identical replays converge on the same rejection).
      let rejection: 'unknown_event_type' | 'invalid_payload' | 'uncorrelated' | null = null;
      let payload: InteractionDeliveryResultPayload | Readonly<Record<string, unknown>> | null = null;
      if (!isInboundEventType(raw.eventType)) {
        rejection = 'unknown_event_type';
      } else {
        const validated = validateInboundPayload(raw.eventType, raw.payload);
        if (validated.valid === null) {
          rejection = 'invalid_payload';
        } else {
          payload = validated.valid;
        }
      }

      // Correlation validation (for correlatable types): the delivery
      // must reference an interaction this tenant actually holds. The
      // interaction's observation state is NOT pre-decided here — the
      // observation authority enforces it at processing time (the
      // typed, retryable consumer-failure path).
      if (rejection === null && raw.eventType === 'interaction.delivery_result') {
        const interactionId = (payload as InteractionDeliveryResultPayload).interactionId;
        let interaction: Awaited<ReturnType<EventSubstrateDeps['findInteraction']>>;
        try {
          interaction = await deps.findInteraction(tenantId, interactionId);
        } catch (error) {
          return mapStoreError(error);
        }
        if (interaction === null) {
          rejection = 'uncorrelated';
        }
      }
      if (payload === null) {
        payload = evidencePayload(raw.payload, makeError);
      }

      const deliveryHash = hashEventDelivery({
        tenantId,
        source,
        externalEventId: raw.eventId,
        eventType: raw.eventType,
        occurredAt: raw.occurredAt.toISOString(),
        payload,
      });

      let recorded: { event: InboxEventRecord; converged: boolean };
      try {
        recorded = await store.ingestInboxEvent({
          tenantId,
          source,
          externalEventId: raw.eventId,
          eventType: raw.eventType,
          occurredAt: raw.occurredAt,
          payload,
          deliveryHash,
          rejection,
          receivedBy: principal.id,
          now: now(),
        });
      } catch (error) {
        return mapStoreError(error);
      }
      const { event, converged } = recorded;

      // Rejections fail closed with typed errors — the durable record IS
      // the evidence (identical replays converge on the same rejection).
      if (event.state === 'rejected') {
        const code = event.rejection?.code;
        const detail = `external event ${raw.eventId} from source ${source} was durably recorded as rejected evidence${converged ? ' (re-delivery converged on the existing rejection)' : ''}`;
        if (code === 'unknown_event_type') {
          throw makeError(
            'EVENT_UNKNOWN_TYPE',
            `${detail}: event type "${raw.eventType}" is outside the frozen horizontal inbound vocabulary (interaction.delivery_result); no vertical-specific event meanings are translated here`,
          );
        }
        if (code === 'invalid_payload') {
          throw makeError('EVENT_INVALID_PAYLOAD', `${detail}: the payload does not conform to the "${raw.eventType}" contract`);
        }
        throw makeError('EVENT_UNCORRELATED', `${detail}: the referenced interaction is not held by this tenant`);
      }
      return { event, converged };
    },

    async processInboxEvents(principal, tenantId, input) {
      await authorizeTenant(principal, tenantId, 'write');
      let limit = 50;
      if (input?.limit !== undefined) {
        if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
          throw makeError('INVALID_INPUT', 'limit must be an integer between 1 and 100');
        }
        limit = input.limit;
      }
      let claimable: InboxEventRecord[];
      try {
        claimable = await store.listClaimableInboxEvents(tenantId, limit);
      } catch (error) {
        return mapStoreError(error);
      }
      const outcomes: InboxProcessResult[] = [];
      for (const event of claimable) {
        // One event at a time: each claim is independent; a lost claim
        // converges (never throws the batch away).
        outcomes.push(await processInboxEventFrom(principal, tenantId, event.id, 'received'));
      }
      return { outcomes };
    },

    async retryInboxEvent(principal, tenantId, eventId) {
      await authorizeTenant(principal, tenantId, 'write');
      if (typeof eventId !== 'string' || !UUID_PATTERN.test(eventId)) {
        throw makeError('INVALID_INPUT', 'eventId must be a UUID');
      }
      return processInboxEventFrom(principal, tenantId, eventId, 'failed');
    },

    async recoverInboxEvent(principal, tenantId, eventId) {
      await authorizeTenant(principal, tenantId, 'write');
      if (typeof eventId !== 'string' || !UUID_PATTERN.test(eventId)) {
        throw makeError('INVALID_INPUT', 'eventId must be a UUID');
      }
      return processInboxEventFrom(principal, tenantId, eventId, 'processing');
    },

    async getInboxEvent(principal, tenantId, eventId) {
      await authorizeTenant(principal, tenantId, 'read');
      if (typeof eventId !== 'string' || !UUID_PATTERN.test(eventId)) {
        throw makeError('INVALID_INPUT', 'eventId must be a UUID');
      }
      try {
        const event = await store.findInboxEvent(tenantId, eventId);
        if (event === null) {
          throw makeError('EVENT_NOT_FOUND', `inbox event ${eventId} does not exist in this tenant`);
        }
        return event;
      } catch (error) {
        return mapStoreError(error);
      }
    },

    async listInboxEvents(principal, tenantId, filter) {
      await authorizeTenant(principal, tenantId, 'read');
      if (filter !== undefined) {
        if (filter.state !== undefined && !['received', 'processing', 'consumed', 'failed', 'rejected'].includes(filter.state)) {
          throw makeError('INVALID_INPUT', 'filter.state is outside the inbox event lifecycle');
        }
        if (filter.source !== undefined && !isCapabilityClass(filter.source)) {
          throw makeError('INVALID_INPUT', 'filter.source is outside the frozen taxonomy');
        }
      }
      try {
        return await store.listInboxEvents(tenantId, filter);
      } catch (error) {
        return mapStoreError(error);
      }
    },

    async listRecoverableInboxEvents(principal, tenantId) {
      await authorizeTenant(principal, tenantId, 'read');
      try {
        return await store.listRecoverableInboxEvents(tenantId);
      } catch (error) {
        return mapStoreError(error);
      }
    },

    async recordOutboundEvent(principal, tenantId, raw) {
      await authorizeTenant(principal, tenantId, 'write');
      if (raw.eventType === undefined || !isOutboundEventType(raw.eventType)) {
        throw makeError('INVALID_INPUT', 'eventType must be a frozen horizontal outbound event type');
      }
      const eventType: OutboundEventType = raw.eventType;
      if (typeof raw.interactionId !== 'string' || !UUID_PATTERN.test(raw.interactionId)) {
        throw makeError('INVALID_INPUT', 'interactionId must be a UUID');
      }
      if (typeof raw.destination !== 'string' || !DESTINATION_PATTERN.test(raw.destination)) {
        throw makeError('INVALID_INPUT', 'destination must be a provider-neutral destination reference (1..200 printable ASCII characters)');
      }
      const destination = raw.destination;
      const correlation = validateCorrelation(raw.correlation, makeError);
      const policyKey = validateOptionalKey(raw.policyKey, 'policyKey', makeError);
      const idempotencyKey = validateOptionalKey(raw.idempotencyKey, 'idempotencyKey', makeError);

      // Authority-DERIVED content: the interaction.observed payload is
      // read from the interaction authority's terminal observation and
      // pinned into the durable intent — the caller supplies the
      // SUBJECT and the destination, never the content (it cannot be
      // fabricated). The observation is terminal and immutable, so the
      // derivation is race-free.
      let interaction: Awaited<ReturnType<EventSubstrateDeps['findInteraction']>>;
      try {
        interaction = await deps.findInteraction(tenantId, raw.interactionId);
      } catch (error) {
        return mapStoreError(error);
      }
      if (interaction === null) {
        throw makeError('INTERACTION_NOT_FOUND', `interaction ${raw.interactionId} does not exist in this tenant`);
      }
      if (interaction.state !== 'observed' || interaction.observation === null || interaction.dispatch === null) {
        throw makeError(
          'EVENT_NOT_OBSERVED',
          `interaction ${raw.interactionId} is in state "${interaction.state}"; the ${eventType} event derives its content from a TERMINAL observed interaction`,
        );
      }
      const payload: InteractionObservedPayload = {
        interactionId: raw.interactionId,
        outcome: interaction.observation.outcome,
        provider: interaction.dispatch.provider,
        providerReference: interaction.dispatch.providerReference,
        observedAt: interaction.observation.observedAt.toISOString(),
      };

      // Durable intent identity (keyed convergence comparisons use this).
      const inputHash = hashOutboundInput({ eventType, subject: raw.interactionId, destination, policyKey });

      // Policy gate BEFORE the durable intent row exists (the same
      // order as the interaction ledger: policy -> durable intent ->
      // delivery). A deny fails closed with NO side effect, NO intent
      // row and NO delivery-port call; an allow pins the decision
      // provenance into the intent record.
      let policy: PolicyProvenance | null = null;
      if (policyKey !== null) {
        let decision: PolicyDecisionRecord;
        try {
          const outcome = await deps.evaluatePolicy(principal, {
            tenantId,
            policyKey,
            action: OUTBOX_POLICY_ACTION,
            attributes: { eventType },
            idempotencyKey: policyIdempotencyKey(idempotencyKey),
          });
          decision = outcome.decision;
        } catch (error) {
          throw makeError('POLICY_EVALUATION_FAILED', `the policy gate for key "${policyKey}" failed: ${(error as Error).message}`);
        }
        if (decision.outcome !== 'allow') {
          throw makeError(
            'POLICY_DENIED',
            `the policy gate denied the ${eventType} outbound intent (decision ${decision.id}, deciding layer ${decision.decidingLayer})`,
          );
        }
        policy = { policyKey, decisionId: decision.id };
      }

      try {
        return await store.createOutboxEvent({
          tenantId,
          eventType,
          payload,
          destination,
          correlation,
          policy,
          requestedBy: principal.id,
          idempotencyKey,
          inputHash,
          now: now(),
        });
      } catch (error) {
        return mapStoreError(error);
      }
    },

    async dispatchOutboxEvent(principal, tenantId, eventId) {
      await authorizeTenant(principal, tenantId, 'write');
      if (typeof eventId !== 'string' || !UUID_PATTERN.test(eventId)) {
        throw makeError('INVALID_INPUT', 'eventId must be a UUID');
      }

      let event: OutboxEventRecord | null;
      try {
        event = await store.findOutboxEvent(tenantId, eventId);
      } catch (error) {
        return mapStoreError(error);
      }
      if (event === null) {
        throw makeError('EVENT_NOT_FOUND', `outbox event ${eventId} does not exist in this tenant`);
      }

      switch (event.state) {
        case 'dispatched':
          // A twin already delivered this event: converge on the durable
          // acceptance WITHOUT a second delivery invocation (AC-2).
          return { event, invoked: false, converged: true };
        case 'dispatching':
          // Another dispatcher holds the claim (or a crashed one left the
          // window open — the recovery surface owns that case).
          throw makeError(
            'OUTBOX_EVENT_IN_PROGRESS',
            `outbox event ${eventId} is claimed for dispatch (since ${event.claim?.claimedAt.toISOString()}); concurrent dispatches converge on one delivery, and a crashed claim is recovered through recoverOutboxEvent`,
          );
        case 'failed':
          // Terminal for this identity: the durable failure record IS the
          // outcome — surface it explicitly (the caller records a new
          // intent to retry).
          return { event, invoked: false, converged: true };
        case 'intended':
          break;
      }

      try {
        await store.claimOutboxEvent({ tenantId, eventId, claimedBy: principal.id, now: now() });
      } catch (error) {
        // A twin claimed between the read and the claim: converge on the
        // durable state (the post-conflict re-check discipline).
        if (error instanceof EventsStoreRuleError && error.rule === 'outbox-claim-conflict') {
          const raced = await store.findOutboxEvent(tenantId, eventId);
          if (raced !== null) {
            if (raced.state === 'dispatched' || raced.state === 'failed') {
              return { event: raced, invoked: false, converged: true };
            }
            if (raced.state === 'dispatching') {
              throw makeError('OUTBOX_EVENT_IN_PROGRESS', error.message);
            }
          }
        }
        return mapStoreError(error);
      }
      const claimed = event; // the durable claim rewrites state atomically below

      try {
        return await invokeAndRecordOutbox(principal, tenantId, {
          ...claimed,
          state: 'dispatching',
          claim: { claimedBy: principal.id, claimedAt: now() },
        });
      } catch (error) {
        if (error instanceof EventsStoreRuleError && error.rule === 'outbox-completion-conflict') {
          const settled = await store.findOutboxEvent(tenantId, eventId);
          if (settled !== null && (settled.state === 'dispatched' || settled.state === 'failed')) {
            return { event: settled, invoked: true, converged: true };
          }
        }
        return mapStoreError(error);
      }
    },

    async recoverOutboxEvent(principal, tenantId, eventId) {
      await authorizeTenant(principal, tenantId, 'write');
      if (typeof eventId !== 'string' || !UUID_PATTERN.test(eventId)) {
        throw makeError('INVALID_INPUT', 'eventId must be a UUID');
      }

      let event: OutboxEventRecord | null;
      try {
        event = await store.findOutboxEvent(tenantId, eventId);
      } catch (error) {
        return mapStoreError(error);
      }
      if (event === null) {
        throw makeError('EVENT_NOT_FOUND', `outbox event ${eventId} does not exist in this tenant`);
      }
      if (event.state !== 'dispatching') {
        throw makeError(
          'OUTBOX_RECOVERY_NOT_AVAILABLE',
          `outbox event ${eventId} is in state "${event.state}"; recovery applies to claimed-but-unsettled dispatches only (intended events dispatch directly; failed events are retried through a new intent)`,
        );
      }

      // Re-claim (the stale claim is refreshed; the delivery port
      // converges by durable identity, so a re-dispatch cannot duplicate
      // the outbound event).
      let reclaimed: OutboxEventRecord;
      try {
        reclaimed = await store.reclaimOutboxDispatch({ tenantId, eventId, reclaimedBy: principal.id, now: now() });
      } catch (error) {
        return mapStoreError(error);
      }
      try {
        return await invokeAndRecordOutbox(principal, tenantId, reclaimed);
      } catch (error) {
        if (error instanceof EventsStoreRuleError && error.rule === 'outbox-completion-conflict') {
          const settled = await store.findOutboxEvent(tenantId, eventId);
          if (settled !== null && (settled.state === 'dispatched' || settled.state === 'failed')) {
            return { event: settled, invoked: false, converged: true };
          }
        }
        return mapStoreError(error);
      }
    },

    async getOutboxEvent(principal, tenantId, eventId) {
      await authorizeTenant(principal, tenantId, 'read');
      if (typeof eventId !== 'string' || !UUID_PATTERN.test(eventId)) {
        throw makeError('INVALID_INPUT', 'eventId must be a UUID');
      }
      try {
        const event = await store.findOutboxEvent(tenantId, eventId);
        if (event === null) {
          throw makeError('EVENT_NOT_FOUND', `outbox event ${eventId} does not exist in this tenant`);
        }
        return event;
      } catch (error) {
        return mapStoreError(error);
      }
    },

    async listOutboxEvents(principal, tenantId, filter) {
      await authorizeTenant(principal, tenantId, 'read');
      if (filter !== undefined && filter.state !== undefined) {
        if (!['intended', 'dispatching', 'dispatched', 'failed'].includes(filter.state)) {
          throw makeError('INVALID_INPUT', 'filter.state is outside the outbox event lifecycle');
        }
      }
      try {
        return await store.listOutboxEvents(tenantId, filter);
      } catch (error) {
        return mapStoreError(error);
      }
    },

    async listRecoverableOutboxEvents(principal, tenantId) {
      await authorizeTenant(principal, tenantId, 'read');
      try {
        return await store.listRecoverableOutboxEvents(tenantId);
      } catch (error) {
        return mapStoreError(error);
      }
    },
  };
}
