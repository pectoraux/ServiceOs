/**
 * ServiceOS /billing typed error surface (WORK-011, module internal —
 * exported through the module's public interface).
 */
export type BillingErrorCode =
  | 'INVALID_INPUT'
  | 'TENANT_NOT_FOUND'
  | 'TENANT_SUSPENDED'
  | 'ORGANIZATION_SUSPENDED'
  | 'TENANT_FORBIDDEN'
  | 'ROLE_FORBIDDEN'
  | 'SERVICE_NOT_ACTIVE'
  | 'SUBSCRIPTION_NOT_FOUND'
  | 'SUBSCRIPTION_NOT_ACTIVE'
  | 'SUBSCRIPTION_ALREADY_ACTIVE'
  | 'SUBSCRIPTION_STATE_ILLEGAL'
  | 'METERING_NOT_DECLARED'
  | 'WORK_NOT_FOUND'
  | 'OUTCOME_NOT_DECLARED'
  | 'USAGE_INPUT_CONFLICT'
  | 'IDEMPOTENCY_INPUT_CONFLICT'
  | 'PERIOD_INVALID'
  | 'CURRENCY_MISMATCH'
  | 'AI_COST_BREAKDOWN_FORBIDDEN'
  | 'SUBSCRIPTION_RECORD_TAMPERED'
  | 'USAGE_RECORD_TAMPERED'
  | 'LEDGER_RECORD_TAMPERED'
  | 'COST_REFERENCE_RECORD_TAMPERED';

export class BillingError extends Error {
  constructor(
    readonly code: BillingErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'BillingError';
  }
}
