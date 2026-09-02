/**
 * ServiceOS /zeck store port contract (WORK-005, module internal —
 * exported through the module's public interface).
 *
 * The authoritative SQL implementation runs through the persistence
 * boundary (executor-pinned transactions); tests inject the faithful
 * in-memory implementation of the SAME port. This is a persistence
 * contract, never a second Zeck authority and never a shadow Zeck
 * execution state machine (architecture-lock #19): the durable surface
 * is the business-side linkage (intents + foreign execution references)
 * and the translated callback delivery ledger (observations).
 *
 * Store disciplines (mirrored by the in-memory double):
 *
 * - INTENTS: the durable logical identity is the (tenant,
 *   idempotencyKey) pair; the durable correlation identity is (tenant,
 *   workAttemptId) — ONE logical intent per work attempt (AC-2: the
 *   Zeck execution linkage binds to exactly one Service Work/Attempt
 *   identity; a new logical AI request for the same attempt is the
 *   idempotent retry of the same key, never a second intent).
 *   Registration is store-serialized per (tenant, key) with the
 *   POST-LOCK IDEMPOTENCY RE-CHECK (same key + identical content
 *   converges; divergence fails closed `idempotency-input-conflict`;
 *   same attempt under a different key fails closed
 *   `attempt-already-linked`).
 *
 * - EXECUTION REFERENCES: `attachExecutionReference` is ONE serialized
 *   critical section per (tenant, intent): the FIRST acceptance wins
 *   and pins the foreign execution identity durably (with submission
 *   metadata + recomputed record hash, one clock read per write); a
 *   racing or retried attach converges on the identical foreign
 *   identity; a divergent foreign identity — or a foreign identity
 *   already owned by another intent — fails closed
 *   `reference-conflict` (AC-6: duplicate requests converge on ONE
 *   execution reference; the unique (tenant, zeck_execution_id) index
 *   backstops it).
 *
 * - CALLBACK EVENTS: `recordCallbackEvent` is ONE serialized critical
 *   section per (tenant, eventId): the first delivery decides the
 *   disposition (accepted — with the intent's last-seen ingestion
 *   cursor touched in the SAME transaction — or rejected with a typed
 *   reason: unknown event type, invalid payload, uncorrelated
 *   execution, conflicting correlation). Identical re-delivery
 *   converges (idempotent replay, no duplicate business evidence, no
 *   second intent touch); divergent re-delivery fails closed
 *   `event-conflict`. Rejections are durable evidence.
 *
 * - READS verify BOTH persisted hashes exactly like the SQL store
 *   (`intent-record-tampered` / `event-record-tampered`).
 */
import type { ZeckResultObservation } from './contract.js';

// ---------------------------------------------------------------------------
// Public record shapes
// ---------------------------------------------------------------------------

/** The durable rejection reasons of a callback delivery. */
export type CallbackRejectionCode =
  | 'unknown_event_type'
  | 'invalid_payload'
  | 'uncorrelated'
  | 'conflicting_correlation';

/** The delivery disposition: what the boundary did with one delivery. */
export type CallbackDisposition = 'accepted' | 'rejected';

/**
 * The business-side AI Execution Intent linkage record: the ServiceOS
 * intent identity, its Service Work/Attempt correlation, the validated
 * request content, and — once Zeck accepted a dispatch — the FOREIGN
 * execution reference plus ingestion metadata. This is NOT a Zeck
 * execution record: no execution state, no result content, no
 * lifecycle. The authoritative execution stays in Zeck.
 */
export interface ZeckIntentRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly serviceWorkId: string;
  readonly workAttemptId: string;
  readonly objective: string;
  readonly inputArtifactRefs: readonly string[];
  readonly businessContext: Readonly<Record<string, string>>;
  readonly requiredCapabilities: readonly unknown[];
  readonly businessConstraints: Readonly<Record<string, string>>;
  readonly outputContract: unknown;
  readonly idempotencyKey: string;
  readonly contentHash: string;
  readonly recordHash: string;
  readonly createdBy: string;
  /** The FOREIGN execution identity, set by the first accepted dispatch. */
  readonly zeckExecutionId: string | null;
  readonly zeckApplicationRef: string | null;
  readonly submittedBy: string | null;
  readonly submittedAt: Date | null;
  /** Ingestion metadata (contract §3): the last accepted callback cursor. */
  readonly lastSeenEventId: string | null;
  readonly lastSeenAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * One translated callback delivery: the durable observation of what
 * Zeck delivered and what the boundary did with it. `observed` carries
 * the translated result observation for accepted events only (a claim
 * Zeck reported — never a business outcome); rejected deliveries keep
 * their typed reason as durable evidence.
 */
export interface ZeckCallbackEventRecord {
  readonly id: string;
  readonly tenantId: string;
  /** Zeck's event identity (the replay/dedup identity). */
  readonly eventId: string;
  /** The event type as delivered (validated against the frozen enumeration for accepted events). */
  readonly eventType: string;
  /** The foreign execution identity the delivery correlates to (when known). */
  readonly zeckExecutionId: string | null;
  /** The linked intent (accepted, correlated events only). */
  readonly intentId: string | null;
  readonly disposition: CallbackDisposition;
  readonly rejectionCode: CallbackRejectionCode | null;
  /** The translated result observation (accepted events only). */
  readonly observed: ZeckResultObservation | null;
  /** Hash over the delivery envelope as received (the replay identity). */
  readonly deliveryHash: string;
  /** Integrity hash over the full immutable delivery record core. */
  readonly recordHash: string;
  readonly receivedBy: string;
  /** The single timestamp of the immutable delivery record (rows never update). */
  readonly receivedAt: Date;
}

// ---------------------------------------------------------------------------
// Store inputs (module-validated, hash-carrying)
// ---------------------------------------------------------------------------

export interface RegisterIntentStoreInput {
  readonly tenantId: string;
  readonly serviceWorkId: string;
  readonly workAttemptId: string;
  readonly objective: string;
  readonly inputArtifactRefs: readonly string[];
  readonly businessContext: Readonly<Record<string, string>>;
  readonly requiredCapabilities: readonly unknown[];
  readonly businessConstraints: Readonly<Record<string, string>>;
  readonly outputContract: unknown;
  readonly idempotencyKey: string;
  readonly contentHash: string;
  readonly createdBy: string;
  readonly now: Date;
}

export interface AttachReferenceInput {
  readonly tenantId: string;
  readonly intentId: string;
  /** The foreign execution identity from Zeck's acceptance. */
  readonly zeckExecutionId: string;
  readonly applicationRef: string | null;
  readonly submittedBy: string;
  readonly now: Date;
}

export interface RecordCallbackEventStoreInput {
  readonly tenantId: string;
  readonly eventId: string;
  /** The event type as delivered (raw string). */
  readonly eventType: string;
  /** The foreign execution identity the delivery claims (validated UUID-free string). */
  readonly zeckExecutionId: string | null;
  /** Hash over the delivery envelope as received (computed by the module). */
  readonly deliveryHash: string;
  /**
   * The module's pre-validated proposal: null when the envelope and the
   * event type are valid (the store then decides correlation inside the
   * critical section); otherwise the typed rejection reason decided by
   * pure validation (unknown_event_type / invalid_payload).
   */
  readonly proposedRejection: CallbackRejectionCode | null;
  /** The validated translated payload (null when invalid). */
  readonly observed: ZeckResultObservation | null;
  /** Optional explicit correlation the delivery carries (must match the intent's). */
  readonly correlation: { readonly serviceWorkId?: string; readonly workAttemptId?: string } | null;
  readonly receivedBy: string;
  readonly now: Date;
}

// ---------------------------------------------------------------------------
// Store rules (typed; the module maps them onto the public error surface)
// ---------------------------------------------------------------------------

export type IntentStoreRule =
  | 'idempotency-input-conflict'
  | 'attempt-already-linked'
  | 'reference-conflict'
  | 'intent-record-tampered';

export type EventStoreRule =
  | 'event-conflict'
  | 'event-record-tampered';

export class ZeckStoreRuleError extends Error {
  constructor(
    message: string,
    readonly rule: IntentStoreRule | EventStoreRule,
  ) {
    super(message);
    this.name = 'ZeckStoreRuleError';
  }
}

export class ZeckStoreMissingError extends Error {
  constructor(
    readonly kind: 'intent',
    readonly key: string,
  ) {
    super(`execution intent ${key} not found`);
    this.name = 'ZeckStoreMissingError';
  }
}

/** Uniqueness arbitration surfaced by ON CONFLICT convergence re-reads. */
export class ZeckStoreConflictError extends Error {
  constructor(
    message: string,
    readonly constraint: string,
  ) {
    super(message);
    this.name = 'ZeckStoreConflictError';
  }
}

// ---------------------------------------------------------------------------
// The store port
// ---------------------------------------------------------------------------

export interface ZeckStore {
  /**
   * Register one execution intent (durable logical identity). Same
   * (tenant, idempotency key) + identical content converges; divergent
   * content fails closed; a different key targeting the same work
   * attempt fails closed (one intent per attempt).
   */
  registerIntent(input: RegisterIntentStoreInput): Promise<{ intent: ZeckIntentRecord; converged: boolean }>;
  /** Tenant-predicated row lookup; null when absent. */
  findIntent(tenantId: string, intentId: string): Promise<ZeckIntentRecord | null>;
  /** The intent owning one foreign execution reference; null when absent. */
  findIntentByExecutionRef(tenantId: string, zeckExecutionId: string): Promise<ZeckIntentRecord | null>;
  /** Tenant-predicated intent list (optionally one work/attempt), registration order. */
  listIntents(tenantId: string, filter?: { serviceWorkId?: string; workAttemptId?: string }): Promise<ZeckIntentRecord[]>;
  /**
   * ONE serialized critical section: pin the foreign execution reference
   * to the intent (first acceptance wins; identical re-attach converges;
   * divergent/foreign-owned identity fails closed).
   */
  attachExecutionReference(input: AttachReferenceInput): Promise<{ intent: ZeckIntentRecord; converged: boolean }>;
  /**
   * ONE serialized critical section per (tenant, eventId): record the
   * delivery with its decided disposition; accepted events touch the
   * intent's last-seen cursor in the same transaction. Identical
   * re-delivery converges; divergent re-delivery fails closed.
   */
  recordCallbackEvent(input: RecordCallbackEventStoreInput): Promise<{ event: ZeckCallbackEventRecord; converged: boolean }>;
  /** The callback event of one (tenant, event id); null when absent. */
  findCallbackEvent(tenantId: string, eventId: string): Promise<ZeckCallbackEventRecord | null>;
  /** Tenant-predicated delivery ledger (optionally intent/disposition), delivery order. */
  listCallbackEvents(
    tenantId: string,
    filter?: { intentId?: string; disposition?: CallbackDisposition },
  ): Promise<ZeckCallbackEventRecord[]>;
}
