/**
 * ServiceOS /zeck typed error surface (WORK-005, module internal —
 * exported through the module's public interface).
 *
 * The module's own rule vocabulary for the Zeck integration boundary.
 * Every failure mode of the boundary is typed; nothing fails silently
 * and nothing fabricates success (zeck-integration-contract.md §4/§7).
 */
export type ZeckErrorCode =
  // Input validation (fail closed before any durable effect).
  | 'INVALID_INPUT'
  // Capability-requirement declarations carrying a model/provider/agent/
  // prompt selection field (surfaced from /verticals' shared frozen
  // validator — never re-implemented here).
  | 'AI_SELECTION_FORBIDDEN'
  // Tenancy denial mapping (the single authorization chain).
  | 'TENANT_NOT_FOUND'
  | 'TENANT_SUSPENDED'
  | 'ORGANIZATION_SUSPENDED'
  | 'TENANT_FORBIDDEN'
  | 'ROLE_FORBIDDEN'
  // Work correlation validation (consumed through /work's public read).
  | 'WORK_NOT_FOUND'
  | 'ATTEMPT_NOT_FOUND'
  | 'ATTEMPT_NOT_SUBMITTABLE'
  | 'ATTEMPT_ALREADY_LINKED'
  // Durable idempotency discipline (store-serialized).
  | 'IDEMPOTENCY_INPUT_CONFLICT'
  | 'REFERENCE_CONFLICT'
  | 'EVENT_CONFLICT'
  // Reads.
  | 'INTENT_NOT_FOUND'
  | 'EVENT_NOT_FOUND'
  // Read-side integrity (durable record tampering fails closed).
  | 'INTENT_RECORD_TAMPERED'
  | 'EVENT_RECORD_TAMPERED'
  // The external boundary itself (honest unavailability; never fabricated).
  | 'ZECK_GATEWAY_UNAVAILABLE'
  | 'ZECK_GATEWAY_ERROR'
  // Callback translation rejections (fail closed with durable evidence).
  | 'CALLBACK_INVALID_PAYLOAD'
  | 'CALLBACK_UNKNOWN_EVENT_TYPE'
  | 'CALLBACK_UNCORRELATED'
  | 'CALLBACK_CONFLICTING_CORRELATION';

export class ZeckError extends Error {
  constructor(
    readonly code: ZeckErrorCode,
    message?: string,
    readonly cause?: unknown,
  ) {
    super(message ?? code);
    this.name = 'ZeckError';
    this.cause = cause;
  }
}
