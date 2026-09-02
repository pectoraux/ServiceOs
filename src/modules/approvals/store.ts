/**
 * ServiceOS /approvals store port contract (WORK-008, module internal —
 * exported through the module's public interface).
 *
 * The authoritative SQL implementation runs through the persistence
 * boundary (executor-pinned transactions); tests inject the faithful
 * in-memory implementation of the SAME port. This is a persistence
 * contract, never a second approval authority (architecture-lock #3:
 * /approvals is the SOLE ServiceOS authority for business/human
 * approval state).
 *
 * Store disciplines (mirrored by the in-memory double):
 *
 * - REQUESTS: the durable logical identity is the (tenant,
 *   idempotencyKey) pair. `createRequest` is store-serialized per
 *   (tenant, key) with the POST-LOCK IDEMPOTENCY RE-CHECK: same key +
 *   identical content converges; divergent content under the same key
 *   fails closed `approval-request-input-conflict`. The request row's
 *   authority state (status/decisionId) is written ONLY by the decide
 *   path below. Reads verify the record hash
 *   (`approval-request-record-tampered`).
 *
 * - DECISIONS — THE SERIALIZED TERMINAL ARBITRATION (activation
 *   invariant 6: simultaneous approval/rejection converges
 *   deterministically to ONE terminal decision): `decide` is ONE
 *   serialized critical section per (tenant, idempotency key) AND per
 *   (tenant, request). Inside the section: the keyed re-check (same
 *   key + identical decision input converges; divergent input fails
 *   closed `approval-decision-input-conflict`), then the request's
 *   durable state arbitrates — a `pending` request records the
 *   decision row and terminalizes exactly once (the guarded
 *   status-flip update); an already-terminal request CONVERGES when
 *   the incoming verdict matches the recorded terminal decision (the
 *   durable row is the authority — any key re-observes it) and fails
 *   closed `approval-decision-conflict` when it diverges (the loser of
 *   a true approve/reject race). Exactly ONE decision row per request
 *   exists at any time (the unique terminal-decision index is the
 *   schema-level backstop). Decision rows are IMMUTABLE; reads verify
 *   the record hash (`approval-decision-record-tampered`).
 *
 * - LOCK ORDER (deadlock-free by construction): the keyed lock first,
 *   the request-state lock second — every decision writer takes the
 *   same two locks in the same order; request creation takes only its
 *   keyed lock (creation and decision share no state domain: a decide
 *   names a request id that either exists durably or fails
 *   `approval-request-missing`).
 */
import type { ApprovalDecisionKind, ApprovalRequestStatus } from './contract.js';

// ---------------------------------------------------------------------------
// Public record shapes
// ---------------------------------------------------------------------------

/**
 * ONE approval request (the ApprovalRequest domain object): an explicit
 * business/human approval request durably bound to a Service Work
 * (and, optionally, one of its Work Attempts) and to the applicable
 * business policy, awaiting exactly ONE terminal human decision. The
 * authority state (`status`/`decisionId`) is owned by this module and
 * written only through the decision path.
 */
export interface ApprovalRequestRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly serviceWorkId: string;
  /** The attempt attribution (validated through /work's public read; null for work-level requests). */
  readonly workAttemptId: string | null;
  /** The applicable business policy key the request is bound to (AC-1). */
  readonly policyKey: string;
  /** The pinned policy admission decision (/policies' public ledger identity). */
  readonly policyDecisionId: string;
  /** The business content under approval (any JSON value, preserved verbatim). */
  readonly subject: unknown;
  /** 'pending' at creation; 'approved' | 'rejected' exactly once, terminally. */
  readonly status: ApprovalRequestStatus;
  readonly idempotencyKey: string;
  readonly contentHash: string;
  readonly recordHash: string;
  readonly requestedBy: string;
  readonly requestedAt: Date;
  /** The terminal decision of this request, once decided; null while pending. */
  readonly decisionId: string | null;
}

/**
 * ONE approval decision (the terminal human verdict): the explicit,
 * attributable, immutable record that terminalizes a request. Exactly
 * one exists per request (the terminal-arbitration invariant). The
 * decider is always an authenticated HUMAN principal (the module
 * rejects non-human principals before any durable effect); an AI
 * execution, agent claim or transport success can never produce one of
 * these rows (activation invariants 3/5).
 */
export interface ApprovalDecisionRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly requestId: string;
  /** Denormalized from the request inside the critical section (tenant-predicated review without a join). */
  readonly serviceWorkId: string;
  /** The terminal verdict: 'approve' | 'reject'. */
  readonly decision: ApprovalDecisionKind;
  /** The human reason, preserved verbatim; null when absent. */
  readonly reason: string | null;
  readonly idempotencyKey: string;
  /** Hash over scope + request + verdict + reason (the decision INPUT). */
  readonly contentHash: string;
  readonly recordHash: string;
  readonly decidedBy: string;
  /** The single timestamp of the immutable decision row (rows never update). */
  readonly decidedAt: Date;
}

// ---------------------------------------------------------------------------
// Store inputs (module-validated, hash-carrying)
// ---------------------------------------------------------------------------

export interface CreateApprovalRequestStoreInput {
  readonly tenantId: string;
  readonly serviceWorkId: string;
  readonly workAttemptId: string | null;
  readonly policyKey: string;
  readonly policyDecisionId: string;
  readonly subject: unknown;
  readonly idempotencyKey: string;
  readonly contentHash: string;
  readonly requestedBy: string;
  readonly now: Date;
}

export interface DecideApprovalStoreInput {
  readonly tenantId: string;
  readonly requestId: string;
  readonly decision: ApprovalDecisionKind;
  readonly reason: string | null;
  readonly idempotencyKey: string;
  readonly decidedBy: string;
  readonly now: Date;
  /**
   * The decision content hash, computed by the module over the
   * validated input (scope + request + verdict + reason): the keyed
   * convergence comparison inside the serialized critical section.
   */
  readonly contentHash: string;
}

// ---------------------------------------------------------------------------
// Store rules (typed; the module maps them onto the public error surface)
// ---------------------------------------------------------------------------

export type ApprovalStoreRule =
  | 'approval-request-input-conflict'
  | 'approval-decision-input-conflict'
  | 'approval-decision-conflict'
  | 'approval-request-record-tampered'
  | 'approval-decision-record-tampered';

export class ApprovalStoreRuleError extends Error {
  constructor(
    message: string,
    readonly rule: ApprovalStoreRule,
  ) {
    super(message);
    this.name = 'ApprovalStoreRuleError';
  }
}

export class ApprovalStoreMissingError extends Error {
  constructor(
    readonly kind: 'request' | 'decision',
    readonly key: string,
  ) {
    super(kind === 'request' ? `approval request ${key} not found` : `approval decision ${key} not found`);
    this.name = 'ApprovalStoreMissingError';
  }
}

/** Uniqueness arbitration surfaced by ON CONFLICT convergence re-reads. */
export class ApprovalStoreConflictError extends Error {
  constructor(
    message: string,
    readonly constraint: string,
  ) {
    super(message);
    this.name = 'ApprovalStoreConflictError';
  }
}

// ---------------------------------------------------------------------------
// The store port
// ---------------------------------------------------------------------------

export interface ApprovalStore {
  /**
   * Create one approval request (pending). Same (tenant, idempotency
   * key) + identical content converges; divergent content under the
   * same key fails closed. The authority state is written only by
   * `decide`.
   */
  createRequest(input: CreateApprovalRequestStoreInput): Promise<{ request: ApprovalRequestRecord; converged: boolean }>;
  /** Tenant-predicated request lookup; null when absent. */
  findRequest(tenantId: string, requestId: string): Promise<ApprovalRequestRecord | null>;
  /** The request of one (tenant, idempotency key); null when absent. */
  findRequestByKey(tenantId: string, idempotencyKey: string): Promise<ApprovalRequestRecord | null>;
  /** Tenant-predicated request ledger (optionally work/attempt/status/requester), request order. */
  listRequests(
    tenantId: string,
    filter?: { serviceWorkId?: string; workAttemptId?: string; status?: ApprovalRequestStatus; requestedBy?: string },
  ): Promise<ApprovalRequestRecord[]>;
  /**
   * THE serialized terminal arbitration: record the explicit human
   * decision and terminalize the request exactly once. Same key +
   * identical content converges; same key + divergent content fails
   * closed; an already-terminal request converges when the verdict
   * matches the recorded terminal decision and fails closed when it
   * diverges (one terminal decision per request, ever).
   */
  decide(input: DecideApprovalStoreInput): Promise<{
    request: ApprovalRequestRecord;
    decision: ApprovalDecisionRecord;
    converged: boolean;
  }>;
  /** Tenant-predicated decision lookup; null when absent. */
  findDecision(tenantId: string, decisionId: string): Promise<ApprovalDecisionRecord | null>;
  /** The decision of one (tenant, idempotency key); null when absent. */
  findDecisionByKey(tenantId: string, idempotencyKey: string): Promise<ApprovalDecisionRecord | null>;
  /** The terminal decision of one request; null when the request is pending or absent. */
  findDecisionByRequest(tenantId: string, requestId: string): Promise<ApprovalDecisionRecord | null>;
  /** Tenant-predicated decision ledger (optionally work/request/decider/verdict), decision order. */
  listDecisions(
    tenantId: string,
    filter?: { serviceWorkId?: string; requestId?: string; decidedBy?: string; decision?: ApprovalDecisionKind },
  ): Promise<ApprovalDecisionRecord[]>;
}
