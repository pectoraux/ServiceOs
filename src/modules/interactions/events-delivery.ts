/**
 * ServiceOS /interactions event delivery port (WORK-006, module internal
 * — exported through the module's public interface).
 *
 * THE provider-neutral outbound event delivery contract: the single
 * surface through which a durable outbox event is delivered to an
 * external destination. The port is the outbox's exact analog of the
 * /integrations effect sink the interaction ledger dispatches through:
 * adapters translate, they never own state; a real delivery adapter is
 * registered by the future Work Order that owns provider/destination
 * configuration — none ships here. The contract conformance future
 * adapters must reproduce is pinned by the in-memory double below
 * (identity-idempotent delivery by durable event identity: a
 * re-delivery of the same event identity converges on ONE provider
 * event — the crash-recovery re-dispatch cannot duplicate the outbound
 * event — and honest pre-delivery failures).
 *
 * No provider SDK, no credential, no Zeck/AI surface anywhere near this
 * contract (WORK-006 forbidden surfaces; the AI execution boundary is
 * /zeck's).
 */
import type { OutboundEventType } from './events-store.js';

/** One outbound event delivery request, addressed provider-neutrally. */
export interface EventDeliveryRequest {
  readonly tenantId: string;
  /** The durable outbox event identity: the delivery idempotency identity. */
  readonly eventId: string;
  readonly eventType: OutboundEventType;
  /** The provider-neutral destination reference (resolved by the adapter). */
  readonly destination: string;
  /** The authority-derived, contract-validated event content. */
  readonly payload: Readonly<Record<string, unknown>>;
}

/** The delivery adapter's recorded acceptance (never a business outcome). */
export interface EventDeliveryAcceptance {
  /** The delivering adapter's provider identity. */
  readonly provider: string;
  /** The provider's own event reference, when it issues one. */
  readonly providerReference: string | null;
}

/**
 * The provider-neutral event delivery port. Implementations MUST be
 * identity-idempotent by `eventId`: re-delivering the same durable
 * event identity converges on ONE provider-side event (returns the
 * recorded acceptance) — recovery re-dispatch is safe by construction.
 * Failures throw honestly (recorded as explicit dispatch failures by
 * the outbox authority).
 */
export interface EventDeliveryPort {
  deliverEvent(request: EventDeliveryRequest): Promise<EventDeliveryAcceptance>;
}

// ---------------------------------------------------------------------------
// Contract-conformant test double (no real provider adapter ships here)
// ---------------------------------------------------------------------------

export interface ProviderEventDeliveryOptions {
  now?: () => Date;
  /** The double's provider identity (default 'in-memory-event-double'). */
  provider?: string;
  /**
   * Deterministic hook: invoked before the acceptance decision (use to
   * observe delivery attempts, including converged re-deliveries).
   */
  onDeliver?: (request: EventDeliveryRequest) => void;
  /**
   * Honest pre-delivery failure predicate: when set and matching, the
   * double THROWS (the dispatch failure the outbox records explicitly).
   */
  failOn?: (request: EventDeliveryRequest) => boolean;
}

/** One recorded provider-side event (converged by identity). */
export interface RecordedProviderEvent {
  readonly request: EventDeliveryRequest;
  readonly acceptance: EventDeliveryAcceptance;
  readonly deliveredAt: Date;
}

export interface InMemoryEventDelivery extends EventDeliveryPort {
  /** The provider events accepted so far, in delivery order (ONE per identity). */
  readonly delivered: readonly RecordedProviderEvent[];
  /** Total delivery ATTEMPTS (including converged re-deliveries of an already-accepted identity). */
  attempts: number;
  /** The acceptance recorded for one event identity (null when never delivered). */
  acceptanceFor(eventId: string): EventDeliveryAcceptance | null;
  /** Delivery attempts for one event identity (0 when never attempted). */
  attemptsFor(eventId: string): number;
}

/**
 * The in-memory contract-conformant delivery double: identity-idempotent
 * by durable event identity (a re-delivery converges on the recorded
 * acceptance — no second provider event), honest configurable failures,
 * deterministic hooks. Mirrors the /integrations in-memory provider
 * adapter's discipline for the event-shaped contract.
 */
export function createInMemoryEventDelivery(options: ProviderEventDeliveryOptions = {}): InMemoryEventDelivery {
  const now = options.now ?? (() => new Date());
  const provider = options.provider ?? 'in-memory-event-double';
  const byIdentity = new Map<string, RecordedProviderEvent>();
  const attemptsByIdentity = new Map<string, number>();
  let attempts = 0;

  const double: InMemoryEventDelivery = {
    attempts,
    get delivered(): readonly RecordedProviderEvent[] {
      return [...byIdentity.values()];
    },
    acceptanceFor(eventId: string): EventDeliveryAcceptance | null {
      return byIdentity.get(eventId)?.acceptance ?? null;
    },
    attemptsFor(eventId: string): number {
      return attemptsByIdentity.get(eventId) ?? 0;
    },
    async deliverEvent(request: EventDeliveryRequest): Promise<EventDeliveryAcceptance> {
      double.attempts += 1;
      attemptsByIdentity.set(request.eventId, (attemptsByIdentity.get(request.eventId) ?? 0) + 1);
      options.onDeliver?.(request);
      if (options.failOn?.(request) === true) {
        throw new Error(`event delivery to destination "${request.destination}" failed (in-memory double)`);
      }
      const existing = byIdentity.get(request.eventId);
      if (existing !== undefined) {
        // Identity idempotency: the re-delivery converges on the ONE
        // provider-side event for this durable identity.
        return existing.acceptance;
      }
      const acceptance: EventDeliveryAcceptance = {
        provider,
        providerReference: `double-${request.eventId}`,
      };
      byIdentity.set(request.eventId, {
        request,
        acceptance,
        deliveredAt: now(),
      });
      return acceptance;
    },
  };
  return double;
}
