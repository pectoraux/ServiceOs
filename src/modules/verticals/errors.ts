/**
 * ServiceOS /verticals typed error surface (WORK-009, module internal —
 * exported through the module's public interface).
 */
export type VerticalErrorCode =
  | 'INVALID_INPUT'
  | 'TENANT_NOT_FOUND'
  | 'TENANT_SUSPENDED'
  | 'ORGANIZATION_SUSPENDED'
  | 'TENANT_FORBIDDEN'
  | 'ROLE_FORBIDDEN'
  | 'VERTICAL_PACKAGE_NOT_FOUND'
  | 'VERSION_CONTENT_CONFLICT'
  | 'VERSION_NOT_SEQUENTIAL'
  | 'VERTICAL_RECORD_TAMPERED'
  | 'IDEMPOTENCY_INPUT_CONFLICT'
  | 'AI_SELECTION_FORBIDDEN';

export class VerticalsError extends Error {
  constructor(
    readonly code: VerticalErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'VerticalsError';
  }
}
