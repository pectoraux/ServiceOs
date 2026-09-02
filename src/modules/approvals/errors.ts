/**
 * ServiceOS /approvals typed error surface (WORK-008, module internal —
 * exported through the module's public interface).
 *
 * The module's own rule vocabulary for the business/human approval
 * authority. Every failure mode is typed; nothing fails silently and
 * nothing fabricates an approval (AC-4).
 */
export type ApprovalErrorCode =
  // Input validation (fail closed before any durable effect).
  | 'INVALID_INPUT'
  // Tenancy denial mapping (the single authorization chain).
  | 'TENANT_NOT_FOUND'
  | 'TENANT_SUSPENDED'
  | 'ORGANIZATION_SUSPENDED'
  | 'TENANT_FORBIDDEN'
  | 'ROLE_FORBIDDEN'
  // Work attribution validation (consumed through /work's public read).
  | 'WORK_NOT_FOUND'
  | 'ATTEMPT_NOT_FOUND'
  // The approval policy gate (consumed through /policies' public hook).
  | 'POLICY_DENIED'
  | 'POLICY_EVALUATION_FAILED'
  // The explicit human authority (activation invariants 3/5: only
  // authorized humans can decide; AI or agent output can never
  // constitute business approval — there is no path from an agent
  // claim to a decision, and a non-human principal fails closed).
  | 'DECIDER_NOT_HUMAN'
  // Durable idempotency discipline (store-serialized).
  | 'APPROVAL_REQUEST_INPUT_CONFLICT'
  | 'APPROVAL_DECISION_INPUT_CONFLICT'
  // Terminal arbitration (activation invariant 6: simultaneous
  // approval/rejection converges deterministically to ONE terminal
  // decision; a divergent decision against the recorded terminal
  // decision fails closed).
  | 'APPROVAL_DECISION_CONFLICT'
  // Reads.
  | 'APPROVAL_REQUEST_NOT_FOUND'
  | 'APPROVAL_DECISION_NOT_FOUND'
  // Read-side integrity (durable record tampering fails closed).
  | 'APPROVAL_REQUEST_RECORD_TAMPERED'
  | 'APPROVAL_DECISION_RECORD_TAMPERED';

export class ApprovalError extends Error {
  constructor(
    readonly code: ApprovalErrorCode,
    message?: string,
    readonly cause?: unknown,
  ) {
    super(message ?? code);
    this.name = 'ApprovalError';
    this.cause = cause;
  }
}
