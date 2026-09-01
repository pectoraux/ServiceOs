/**
 * ServiceOS /interactions store port (WORK-015).
 *
 * The persistence contract for the provider-neutral external interaction
 * ledger. The authoritative implementation is the SQL store executed
 * through the persistence boundary's `TransactionalExecutor`
 * (client-pinned transactions); tests inject a faithful in-memory
 * implementation of this same port.
 *
 * Store contract semantics (mirrored by every implementation):
 *
 * - THE BUSINESS SIDE-EFFECT BOUNDARY IS THIS PORT'S MUTATION SURFACE.
 *   Every external effect's durable lifecycle lives here: INTENT
 *   (`createInteraction`, state `intended`), DISPATCH CLAIM
 *   (`claimDispatch`, `intended -> dispatching` — the durable marker that
 *   survives a crash between intent and adapter invocation), PROVIDER
 *   ACCEPTANCE (`completeDispatch`, `dispatching -> dispatched`) and
 *   OBSERVED RESULT (`recordObservation`/`recordDispatchFailure`,
 *   `-> observed` with an explicit outcome). NO operation here mutates
 *   Service Work state, calls a provider, or completes business work: a
 *   provider success is an OBSERVATION, and the business outcome
 *   authority (consumer modules, /workflow) decides separately (Work
 *   Order AC-4; the invariant chain authorization -> durable intent ->
 *   dispatch -> observe -> business authority decides outcome).
 *
 * - MANDATORY TENANT PREDICATES. Every lookup and list carries the tenant
 *   parameter in its signature and its query; a row in another tenant is
 *   indistinguishable from a missing row (lock #15/#16; invariant 6:
 *   tenant authorization is established before adapter invocation — the
 *   module authorizes first, the store predicates second).
 *
 * - INTENT IDENTITY IS IDEMPOTENT (AC-3). `createInteraction` converges
 *   on the durable interaction identified by (tenant, idempotency key)
 *   when the submission input matches the recorded input hash; a divergent
 *   re-submission of the same key fails closed
 *   (`interaction-input-conflict`). Duplicate dispatch attempts therefore
 *   converge on ONE logical interaction.
 *
 * - THE DISPATCH CLAIM IS AN ATOMIC COMPARE-AND-SET. `claimDispatch`
 *   moves `intended -> dispatching` exactly once: concurrent dispatchers
 *   of the same interaction serialize (row lock / synchronous critical
 *   section); every loser fails closed with `dispatch-claim-conflict`
 *   carrying the observed state — never a double claim, never a lost
 *   update. The claim is the crash window marker: a `dispatching`
 *   interaction whose dispatcher died is recovered through the module's
 *   `recoverInteraction` (adapter idempotency by durable identity makes
 *   re-dispatch safe — no duplicate business effect).
 *
 * - OBSERVATIONS ARE EXPLICIT, TERMINAL AND CONVERGENT. One observation
 *   per interaction: an identical re-observation (same outcome, same
 *   canonical observation payload) converges on the durable record; a
 *   divergent re-observation fails closed (`observation-conflict`) —
 *   duplicate mutation of a recorded interaction is detected. A dispatch
 *   that the provider failed records an observed FAILURE
 *   (`recordDispatchFailure`, failure stage `dispatch`): explicit and
 *   durable, recoverable through the retry protocol (a NEW interaction
 *   identity with `retryOf` lineage — the original observation is never
 *   rewritten).
 *
 * - TAMPER-EVIDENT READS. Interaction rows are state-machine rows (unlike
 *   the append-only workflow ledger): every legitimate state write
 *   recomputes the record integrity hash, and every read recomputes it
 *   from the stored fields and fails closed
 *   (`interaction-record-tampered`) on divergence — after-the-fact
 *   mutation of any recorded field is detected on read.
 */
import type { CapabilityClass } from '../integrations/index.js';

/** Atomic store-level rule violation (mirrors a guarded SQL transaction). */
export type InteractionsStoreRule =
  | 'interaction-input-conflict'
  | 'dispatch-claim-conflict'
  | 'dispatch-reclaim-conflict'
  | 'dispatch-completion-conflict'
  | 'observation-state-invalid'
  | 'observation-conflict'
  | 'retry-target-invalid'
  | 'interaction-record-tampered';

export class InteractionsStoreRuleError extends Error {
  constructor(message: string, readonly rule: InteractionsStoreRule) {
    super(message);
    this.name = 'InteractionsStoreRuleError';
  }
}

/** Single-row target absent (scoped by the tenant predicate). */
export class InteractionsStoreMissingError extends Error {
  constructor(message: string, readonly what: 'interaction' | 'retry-target') {
    super(message);
    this.name = 'InteractionsStoreMissingError';
  }
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/**
 * The durable interaction lifecycle. `intended` is the durable intent
 * BEFORE any side effect; `dispatching` is the claimed crash window (the
 * dispatcher marked its claim, the adapter may or may not have run);
 * `dispatched` is the provider's recorded ACCEPTANCE (never an outcome);
 * `observed` is terminal: the provider result was observed, succeeded or
 * failed, and the business outcome authority decides separately.
 */
export type InteractionState = 'intended' | 'dispatching' | 'dispatched' | 'observed';

/** The observed provider result. A success NEVER completes Service Work. */
export type InteractionOutcome = 'succeeded' | 'failed';

/** Where a failure was observed: at dispatch (the request failed) or from the provider (the effect failed). */
export type InteractionFailureStage = 'dispatch' | 'provider';

/** Policy-gate provenance pinned into the durable intent record. */
export interface PolicyProvenance {
  /** The /policies policy key the intent gate consulted (public contract input). */
  readonly policyKey: string;
  /** The durable, revision-bound policy decision record that allowed the intent. */
  readonly decisionId: string;
}

/** The observed provider result, pinned at observation time. */
export interface InteractionObservation {
  readonly outcome: InteractionOutcome;
  /** Null on success; `dispatch` when the dispatch itself failed, `provider` when the provider reported failure. */
  readonly failureStage: InteractionFailureStage | null;
  /** The provider's own observation payload (receipt, status, error), canonicalized for convergence. */
  readonly providerObservation: unknown;
  readonly observedBy: string;
  readonly observedAt: Date;
}

/** The dispatch acceptance facts recorded on the interaction. */
export interface InteractionDispatch {
  /** The adapter's provider identity. */
  readonly provider: string;
  /** The provider's own request reference, when it issues one. */
  readonly providerReference: string | null;
  readonly dispatchedAt: Date;
  readonly dispatchedBy: string;
}

/** The dispatch claim facts (the crash-window marker). */
export interface InteractionClaim {
  readonly claimedBy: string;
  readonly claimedAt: Date;
}

/**
 * One external interaction: the durable, attributable, provider-neutral
 * side-effect record (AC-1). `correlation` is inert reference data (e.g.
 * `{ workId, attemptId }`) recording which business subject the effect
 * belongs to — reference only: no foreign key, no state coupling, and the
 * interaction authority never consults business state.
 */
export interface InteractionRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly capability: CapabilityClass;
  readonly params: Readonly<Record<string, unknown>>;
  readonly correlation: Readonly<Record<string, string>>;
  /** The failed interaction this one explicitly retries (lineage, not state). */
  readonly retryOfInteractionId: string | null;
  readonly policy: PolicyProvenance | null;
  readonly requestedBy: string;
  readonly idempotencyKey: string | null;
  /** Deterministic intent identity: sha256 over the canonical intent core. */
  readonly inputHash: string;
  /** Integrity hash over the canonical record core (tamper-evident reads). */
  readonly recordHash: string;
  readonly state: InteractionState;
  readonly claim: InteractionClaim | null;
  readonly dispatch: InteractionDispatch | null;
  readonly observation: InteractionObservation | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface CreateInteractionInput {
  readonly tenantId: string;
  readonly capability: CapabilityClass;
  /** Contract-validated provider-neutral params (validated module-side). */
  readonly params: Readonly<Record<string, unknown>>;
  readonly correlation: Readonly<Record<string, string>> | null;
  readonly retryOfInteractionId: string | null;
  /** Policy-gate provenance (an allow decision), or null when ungated. */
  readonly policy: PolicyProvenance | null;
  readonly requestedBy: string;
  /** Durable intent identity; null creates an unkeyed distinct interaction. */
  readonly idempotencyKey: string | null;
  /** sha256 over the canonical intent core. */
  readonly inputHash: string;
  /** Single clock read pinned into the record hash and the persisted row. */
  readonly now: Date;
}

export interface ClaimDispatchInput {
  readonly tenantId: string;
  readonly interactionId: string;
  readonly claimedBy: string;
  readonly now: Date;
}

export interface ReclaimDispatchInput {
  readonly tenantId: string;
  readonly interactionId: string;
  /** The recovering actor (the stale claim's holder is recorded in the row). */
  readonly reclaimedBy: string;
  readonly now: Date;
}

export interface CompleteDispatchInput {
  readonly tenantId: string;
  readonly interactionId: string;
  readonly provider: string;
  readonly providerReference: string | null;
  readonly dispatchedBy: string;
  readonly now: Date;
}

export interface RecordDispatchFailureInput {
  readonly tenantId: string;
  readonly interactionId: string;
  readonly dispatchedBy: string;
  /** The raw provider/dispatch error (bounded, recorded verbatim as the observation payload). */
  readonly error: string;
  readonly now: Date;
}

export interface RecordObservationInput {
  readonly tenantId: string;
  readonly interactionId: string;
  readonly outcome: InteractionOutcome;
  readonly providerObservation: unknown;
  readonly observedBy: string;
  readonly now: Date;
}

/** Read-side list filter (every field optional; the tenant predicate is mandatory). */
export interface InteractionFilter {
  readonly state?: InteractionState;
  readonly capability?: CapabilityClass;
  readonly outcome?: InteractionOutcome;
  readonly retryOfInteractionId?: string;
  /** Exact correlation entry match (correlation->>key = value). */
  readonly correlation?: { readonly key: string; readonly value: string };
}

// ---------------------------------------------------------------------------
// Store port
// ---------------------------------------------------------------------------

export interface InteractionsStore {
  /**
   * Persist the durable intent (state `intended`). Keyed submissions
   * converge on the durable interaction (input-matched); a divergent
   * re-submission of the same key fails closed. Validates the retry
   * lineage in-transaction: the retry target must exist in this tenant
   * and be an observed FAILURE (the retry protocol precondition).
   */
  createInteraction(input: CreateInteractionInput): Promise<{ interaction: InteractionRecord; converged: boolean }>;
  /** Tenant-predicated lookup; null when absent in this tenant. */
  findInteractionById(tenantId: string, interactionId: string): Promise<InteractionRecord | null>;
  /** Tenant-predicated idempotency-identity lookup. */
  findInteractionByIdempotencyKey(tenantId: string, key: string): Promise<InteractionRecord | null>;
  /** Tenant-predicated list (append-order), optionally filtered. */
  listInteractions(tenantId: string, filter?: InteractionFilter): Promise<InteractionRecord[]>;
  /** The crash-recovery surface: `dispatching` interactions of this tenant. */
  listRecoverableDispatches(tenantId: string): Promise<InteractionRecord[]>;
  /**
   * Atomically claim the dispatch: `intended -> dispatching` exactly once.
   * Concurrent claimants serialize; every loser fails closed with
   * `dispatch-claim-conflict` carrying the observed state.
   */
  claimDispatch(input: ClaimDispatchInput): Promise<InteractionRecord>;
  /**
   * Recovery re-claim: REFRESH the dispatch claim of a `dispatching`
   * interaction (a crashed dispatcher left the window open). The state
   * stays `dispatching`; the re-dispatch is safe by the adapter
   * contract's identity idempotency. Fails closed with
   * `dispatch-reclaim-conflict` when the interaction is not in the
   * claimed state.
   */
  reclaimDispatch(input: ReclaimDispatchInput): Promise<InteractionRecord>;
  /**
   * Record the provider acceptance: `dispatching -> dispatched`. Fails
   * closed with `dispatch-completion-conflict` when the row is not in the
   * claimed state (a concurrent completion or recovery won the race).
   */
  completeDispatch(input: CompleteDispatchInput): Promise<InteractionRecord>;
  /**
   * Record an explicit dispatch FAILURE: `dispatching -> observed` with
   * outcome `failed`, failure stage `dispatch`. Terminal: the retry
   * protocol creates a NEW interaction identity.
   */
  recordDispatchFailure(input: RecordDispatchFailureInput): Promise<InteractionRecord>;
  /**
   * Record the observed provider result: `dispatched -> observed`. An
   * identical re-observation converges; a divergent re-observation fails
   * closed (`observation-conflict`). Any other source state fails closed
   * (`observation-state-invalid`).
   */
  recordObservation(input: RecordObservationInput): Promise<{ interaction: InteractionRecord; converged: boolean }>;
}
