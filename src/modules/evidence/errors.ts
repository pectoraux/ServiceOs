/**
 * ServiceOS /evidence typed error surface (WORK-007, module internal —
 * exported through the module's public interface).
 *
 * The module's own rule vocabulary for the business-evidence authority.
 * Every failure mode is typed; nothing fails silently and nothing
 * fabricates a satisfied outcome (AC-4).
 */
export type EvidenceErrorCode =
  // Input validation (fail closed before any durable effect).
  | 'INVALID_INPUT'
  // Outcome contracts carrying an AI-execution verification concept
  // (mirrors /services' fail-closed rule — verification is ServiceOS
  // business authority; Zeck owns AI execution verification).
  | 'AI_VERIFICATION_FORBIDDEN'
  // Tenancy denial mapping (the single authorization chain).
  | 'TENANT_NOT_FOUND'
  | 'TENANT_SUSPENDED'
  | 'ORGANIZATION_SUSPENDED'
  | 'TENANT_FORBIDDEN'
  | 'ROLE_FORBIDDEN'
  // Work attribution validation (consumed through /work's public read).
  | 'WORK_NOT_FOUND'
  | 'ATTEMPT_NOT_FOUND'
  // Durable idempotency discipline (store-serialized).
  | 'EVIDENCE_INPUT_CONFLICT'
  | 'VERIFICATION_INPUT_CONFLICT'
  // Reads.
  | 'EVIDENCE_NOT_FOUND'
  | 'VERIFICATION_NOT_FOUND'
  // Read-side integrity (durable record tampering fails closed).
  | 'EVIDENCE_RECORD_TAMPERED'
  | 'VERIFICATION_RECORD_TAMPERED';

export class EvidenceError extends Error {
  constructor(
    readonly code: EvidenceErrorCode,
    message?: string,
    readonly cause?: unknown,
  ) {
    super(message ?? code);
    this.name = 'EvidenceError';
    this.cause = cause;
  }
}
