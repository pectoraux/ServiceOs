/**
 * ServiceOS /entities typed error surface (WORK-010).
 *
 * Two public error classes share this module's surface:
 *
 * - `EntitiesError` — the entity-instance AUTHORITY's error surface
 *   (entity CRUD: validation, tenancy denials, missing records,
 *   keyed-input conflicts, tamper evidence).
 * - `ConstructionError` — the construction compliance FLOW's error
 *   surface. The flow is pure orchestration over horizontal
 *   authorities: it introduces NO second authority, so its codes
 *   cover only flow-level validation, derived-state preconditions and
 *   the composition of the authorities' own typed failures.
 */
export type EntitiesErrorCode =
  | 'INVALID_INPUT'
  | 'TENANT_NOT_FOUND'
  | 'TENANT_SUSPENDED'
  | 'ORGANIZATION_SUSPENDED'
  | 'TENANT_FORBIDDEN'
  | 'ROLE_FORBIDDEN'
  | 'ENTITY_NOT_FOUND'
  | 'ENTITY_INPUT_CONFLICT'
  | 'ENTITY_RECORD_TAMPERED'
  | 'VERTICAL_PACKAGE_NOT_FOUND'
  | 'ENTITY_TYPE_NOT_DECLARED'
  | 'FIELD_NOT_DECLARED'
  | 'FIELD_TYPE_MISMATCH'
  | 'FIELD_REQUIRED';

export class EntitiesError extends Error {
  constructor(
    readonly code: EntitiesErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'EntitiesError';
  }
}

export type ConstructionErrorCode =
  | 'INVALID_INPUT'
  | 'WORK_NOT_FOUND'
  | 'PROJECT_NOT_FOUND'
  | 'SUBCONTRACTOR_NOT_FOUND'
  | 'WORK_STATE_INVALID'
  | 'NOT_COMPLIANT'
  | 'PACKAGE_NOT_ASSEMBLABLE'
  | 'ESCALATION_NOT_DECIDED'
  | 'ESCALATION_DECISION_NOT_FOUND'
  | 'REASONING_NOT_SUBMITTED'
  | 'AUTHORITY_FAILURE';

export class ConstructionError extends Error {
  constructor(
    readonly code: ConstructionErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'ConstructionError';
  }
}
