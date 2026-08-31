/**
 * Governance platform surface for ServiceOS (WORK-001).
 *
 * Read-side access to canonical repository governance state plus the
 * architecture structural checks used by CI and the local check entrypoint.
 * This module never mutates governance state (Architect-only transitions).
 */
export {
  GovernanceError,
  readProgramState,
  readWorkOrderStatus,
  currentLiveWorkOrder,
  type ProgramStatus,
  type WorkOrderRecord,
} from './program-state.js';
export {
  checkArchitecture,
  checkPackageDependencies,
  parseArchitectureModules,
  FORBIDDEN_AI_PACKAGES,
  FORBIDDEN_AI_PATH_SEGMENTS,
  ALLOWED_RUNTIME_PACKAGES,
  ALLOWED_DEV_PACKAGES,
  type ArchitectureViolation,
  type ArchitectureCheckOptions,
} from './architecture-checks.js';
export {
  checkIdentityTenancyBoundaries,
  extractExportNames,
  RESERVED_AUTHORIZATION_EXPORTS,
  RESERVED_CREDENTIAL_EXPORTS,
  ROUTE_GUARD_FACTORY_PATTERN,
} from './identity-boundary-checks.js';
