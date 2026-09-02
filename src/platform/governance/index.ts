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
export {
  checkWorkBoundaries,
  extractCreatedTables,
  extractRelativeModuleImports,
  stripSqlComments,
  RESERVED_TRANSITION_EXPORTS,
  RESERVED_ZECK_LIFECYCLE_EXPORTS,
  ALLOWED_MIGRATION_TABLE_PREFIXES,
  type WorkBoundaryCheckOptions,
} from './work-boundary-checks.js';
export {
  checkPoliciesBoundaries,
  RESERVED_POLICY_AUTHORITY_EXPORTS,
  RESERVED_AI_POLICY_EXPORTS,
  type PoliciesBoundaryCheckOptions,
} from './policies-boundary-checks.js';
export {
  checkWorkflowBoundaries,
  RESERVED_WORKFLOW_AUTHORITY_EXPORTS,
  RESERVED_AI_WORKFLOW_EXPORTS,
  WORKFLOW_FORBIDDEN_IMPORTS,
  type WorkflowBoundaryCheckOptions,
} from './workflow-boundary-checks.js';
export {
  checkServiceVerticalBoundaries,
  RESERVED_VERTICAL_AUTHORITY_EXPORTS,
  RESERVED_SERVICE_AUTHORITY_EXPORTS,
  RESERVED_AI_SERVICE_RUNTIME_EXPORTS,
  VERTICALS_ALLOWED_IMPORTS,
  SERVICES_ALLOWED_IMPORTS,
  VERTICALS_IMPORTERS,
  SERVICES_IMPORTERS,
  type ServiceVerticalBoundaryCheckOptions,
} from './service-vertical-boundary-checks.js';
export {
  checkBillingBoundaries,
  RESERVED_BILLING_AUTHORITY_EXPORTS,
  RESERVED_AI_COST_AUTHORITY_EXPORTS,
  BILLING_ALLOWED_IMPORTS,
  BILLING_IMPORTERS,
  type BillingBoundaryCheckOptions,
} from './billing-boundary-checks.js';
export {
  checkExternalInteractionBoundaries,
  RESERVED_INTERACTION_AUTHORITY_EXPORTS,
  RESERVED_ADAPTER_AUTHORITY_EXPORTS,
  RESERVED_NOTIFICATION_AUTHORITY_EXPORTS,
  RESERVED_AI_EXTERNAL_EXPORTS,
  PROVIDER_SDK_PACKAGES,
  PROVIDER_SDK_PACKAGE_PREFIXES,
  INTEGRATIONS_IMPORTERS,
  INTERACTIONS_IMPORTERS,
  INTERACTIONS_ALLOWED_IMPORTS,
  NOTIFICATIONS_ALLOWED_IMPORTS,
  type ExternalInteractionBoundaryCheckOptions,
} from './interactions-boundary-checks.js';
