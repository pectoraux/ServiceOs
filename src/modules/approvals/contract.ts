/**
 * ServiceOS /approvals public contract (WORK-008, module internal —
 * exported through the module's public interface).
 *
 * The frozen domain vocabulary of the ServiceOS business/human
 * approval authority (architecture.md §6, §7, §9, §13;
 * architecture-lock #3: /approvals is the SOLE ServiceOS authority for
 * business/human approval state; WORK-008 activation record):
 *
 * - THE EXPLICIT REQUEST/DECISION LIFECYCLE (AC-1; verification
 *   requirement "request/approve/reject/review lifecycle"): one
 *   approval REQUEST is a durable, tenant-bound record bound to a
 *   specific Service Work (and, optionally, one of its Work Attempts)
 *   and to the applicable business policy (the frozen policyKey it was
 *   admitted under, with the policy decision provenance pinned by the
 *   module). One approval DECISION is the explicit terminal human
 *   verdict — 'approve' or 'reject' — durably recorded with its
 *   decider, reason and instant. The request states are the closed
 *   enumeration 'pending' -> 'approved' | 'rejected' (terminal, one
 *   per request); there is no third terminal outcome and no
 *   non-terminal state besides 'pending'.
 *
 * - THE HUMAN AUTHORITY (AC-2/AC-4; activation invariants 1/3/5):
 *   nothing in this vocabulary accepts an AI execution, agent claim or
 *   machine principal as a decision. The decision input is the
 *   authenticated human principal's verdict; a non-human principal is
 *   rejected before any durable effect (typed DECIDER_NOT_HUMAN at the
 *   module layer). Foreign execution outcomes may be carried inside
 *   the request SUBJECT as opaque business content (data under
 *   approval), never as a decision.
 */
import { ApprovalError } from './errors.js';

// ---------------------------------------------------------------------------
// Frozen enumerations
// ---------------------------------------------------------------------------

/**
 * The approval-request lifecycle states. Frozen enumeration: a request
 * is created 'pending' and reaches exactly one terminal state
 * ('approved' | 'rejected') through ONE recorded human decision
 * (activation invariant 6). Extending this enumeration is an
 * architecture-level decision.
 */
export const APPROVAL_REQUEST_STATUSES: readonly string[] = ['pending', 'approved', 'rejected'];

export type ApprovalRequestStatus = 'pending' | 'approved' | 'rejected';

export function isApprovalRequestStatus(value: string): value is ApprovalRequestStatus {
  return APPROVAL_REQUEST_STATUSES.includes(value);
}

/**
 * The explicit human decision verdicts. Frozen enumeration; a terminal
 * arbitration records exactly one of these (there is no
 * 'partially-approved' business state in this authority).
 */
export const APPROVAL_DECISIONS: readonly string[] = ['approve', 'reject'];

export type ApprovalDecisionKind = 'approve' | 'reject';

export function isApprovalDecisionKind(value: string): value is ApprovalDecisionKind {
  return APPROVAL_DECISIONS.includes(value);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENTIFIER_PATTERN = /^[a-zA-Z][a-zA-Z0-9_.-]{0,199}$/;
const KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,200}$/;
const MAX_REASON_LENGTH = 2000;

// ---------------------------------------------------------------------------
// Public input shapes
// ---------------------------------------------------------------------------

/** The public request input: one explicit approval request. */
export interface RequestApprovalInput {
  readonly tenantId: string;
  /** The Service Work the approval is bound to (validated through /work's public read). */
  readonly serviceWorkId: string;
  /** Optional Work Attempt attribution (validated to belong to the work when present). */
  readonly workAttemptId?: string;
  /**
   * The applicable business policy key the request is bound to
   * (AC-1: approval requests are bound to policy). The module evaluates
   * it through /policies' public hook at creation; a deny decision
   * fails closed and the request is never created.
   */
  readonly policyKey: string;
  /**
   * The business content under approval (any JSON value, preserved
   * verbatim). This is DATA being approved, never an approval: foreign
   * execution outcomes cited here are opaque content, and only the
   * explicit human decision terminalizes the request.
   */
  readonly subject: unknown;
  /** The durable logical identity of this request submission. */
  readonly idempotencyKey: string;
}

/** The validated canonical form (frozen). */
export interface ValidatedRequestApprovalInput {
  readonly tenantId: string;
  readonly serviceWorkId: string;
  readonly workAttemptId: string | null;
  readonly policyKey: string;
  readonly subject: unknown;
  readonly idempotencyKey: string;
}

/** The public decide input: one explicit human decision. */
export interface DecideApprovalInput {
  readonly tenantId: string;
  readonly requestId: string;
  /** The terminal verdict. */
  readonly decision: ApprovalDecisionKind;
  /** Optional human reason for the decision (auditable, ≤ 2000 characters). */
  readonly reason?: string;
  /** The durable logical identity of this decision submission. */
  readonly idempotencyKey: string;
}

/** The validated canonical form (frozen). */
export interface ValidatedDecideApprovalInput {
  readonly tenantId: string;
  readonly requestId: string;
  readonly decision: ApprovalDecisionKind;
  readonly reason: string | null;
  readonly idempotencyKey: string;
}

// ---------------------------------------------------------------------------
// Validation (fail closed)
// ---------------------------------------------------------------------------

function fail(code: 'INVALID_INPUT', message: string): never {
  throw new ApprovalError(code, message);
}

function validateUuid(value: unknown, what: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    fail('INVALID_INPUT', `${what} must be a UUID`);
  }
  return value;
}

function validateIdentifier(value: unknown, what: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    fail('INVALID_INPUT', `${what} must match the identifier pattern`);
  }
  return value;
}

function validateIdempotencyKey(value: unknown, what: string): string {
  if (typeof value !== 'string' || !KEY_PATTERN.test(value)) {
    fail('INVALID_INPUT', `${what} must be a non-empty string of at most 200 characters matching [A-Za-z0-9_.:-]`);
  }
  return value;
}

/** Validate one request input into its canonical frozen form. */
export function validateRequestApprovalInput(raw: RequestApprovalInput): ValidatedRequestApprovalInput {
  if (typeof raw !== 'object' || raw === null) {
    fail('INVALID_INPUT', 'the request-approval input must be an object');
  }
  const candidate = raw as Partial<RequestApprovalInput>;
  const tenantId = validateUuid(candidate.tenantId, 'tenantId');
  const serviceWorkId = validateUuid(candidate.serviceWorkId, 'serviceWorkId');
  const workAttemptId =
    candidate.workAttemptId === undefined || candidate.workAttemptId === null
      ? null
      : validateUuid(candidate.workAttemptId, 'workAttemptId');
  const policyKey = validateIdentifier(candidate.policyKey, 'policyKey');
  if (candidate.subject === undefined) {
    fail('INVALID_INPUT', 'subject is required (the business content under approval)');
  }
  const idempotencyKey = validateIdempotencyKey(candidate.idempotencyKey, 'idempotencyKey');
  return Object.freeze({
    tenantId,
    serviceWorkId,
    workAttemptId,
    policyKey,
    subject: candidate.subject,
    idempotencyKey,
  });
}

/** Validate one decide input into its canonical frozen form. */
export function validateDecideApprovalInput(raw: DecideApprovalInput): ValidatedDecideApprovalInput {
  if (typeof raw !== 'object' || raw === null) {
    fail('INVALID_INPUT', 'the decide-approval input must be an object');
  }
  const candidate = raw as Partial<DecideApprovalInput>;
  const tenantId = validateUuid(candidate.tenantId, 'tenantId');
  const requestId = validateUuid(candidate.requestId, 'requestId');
  if (typeof candidate.decision !== 'string' || !isApprovalDecisionKind(candidate.decision)) {
    fail('INVALID_INPUT', `decision must be one of ${APPROVAL_DECISIONS.join(', ')}`);
  }
  let reason: string | null = null;
  if (candidate.reason !== undefined && candidate.reason !== null) {
    if (typeof candidate.reason !== 'string') {
      fail('INVALID_INPUT', 'reason must be a string when present');
    }
    const trimmed = candidate.reason.trim();
    if (trimmed.length > MAX_REASON_LENGTH) {
      fail('INVALID_INPUT', `reason must be at most ${MAX_REASON_LENGTH} characters`);
    }
    reason = trimmed === '' ? null : trimmed;
  }
  const idempotencyKey = validateIdempotencyKey(candidate.idempotencyKey, 'idempotencyKey');
  return Object.freeze({
    tenantId,
    requestId,
    decision: candidate.decision,
    reason,
    idempotencyKey,
  });
}
