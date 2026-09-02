/**
 * ServiceOS /services store port (WORK-009).
 *
 * The persistence contract for versioned service definitions, the
 * service-package lifecycle and customer configurations. The
 * authoritative implementation is the SQL store executed through the
 * persistence boundary's `TransactionalExecutor`; tests inject a
 * faithful in-memory implementation of this same port.
 *
 * Store contract semantics (mirrored by every implementation):
 *
 * - TENANT PREDICATES ARE MANDATORY (architecture-lock #15/#16).
 *
 * - SERVICE DEFINITIONS ARE VERSIONED AND IMMUTABLE IN CONTENT. The
 *   durable identity is (tenant, service id, version); registration is
 *   caller-versioned and STORE-SERIALIZED (rule `version-not-sequential`
 *   for gaps/skips; duplicate registration of an existing version
 *   converges iff the content hash matches, else rule
 *   `version-content-conflict`).
 *
 * - THE SERVICE-PACKAGE LIFECYCLE IS FORWARD-ONLY: `draft` → `active`
 *   (the previously active version of the same identity is retired
 *   first — the one-active partial unique index is per-statement); a
 *   `retired` version can never return (rule `version-retired`);
 *   activating the already-active version converges. This is CONTRACT
 *   VERSIONING, not the Service Work state machine.
 *
 * - CUSTOMER CONFIGURATIONS ARE VERSIONED, IMMUTABLE IN CONTENT AND
 *   BOUND TO THE SERVICE VERSION THEY PIN. Configuration versions are
 *   allocated by the store under a lock (monotonic per (tenant,
 *   service id)); the same logical registration (tenant + idempotency
 *   key) converges on one durable identity (divergent content fails
 *   closed with rule `idempotency-input-conflict`). The same
 *   forward-only, one-active lifecycle applies.
 *
 * - READS VERIFY THE PERSISTED RECORD HASHES (rules
 *   `service-record-tampered` / `configuration-record-tampered` when a
 *   stored field no longer matches its persisted integrity hash, or the
 *   content no longer matches its content hash). Lifecycle writes
 *   recompute the record hash over the new row state atomically with
 *   the status write.
 */
import type { ZeckCapabilityRequirement } from '../verticals/index.js';

// ---------------------------------------------------------------------------
// Definition sections (validated shapes; content, never code)
// ---------------------------------------------------------------------------

/** Binds one vertical entity definition into the service. */
export interface EntityBinding {
  readonly entity: string;
  readonly required: boolean;
}

/** Binds one vertical work type into the service's work catalog. */
export interface WorkDefinitionBinding {
  readonly workType: string;
  readonly description?: string;
}

/**
 * Binds one vertical workflow step to the FROZEN canonical Service Work
 * state machine: `from` → `to` must be a legal canonical transition
 * (validated against /workflow's frozen code — a binding can never add
 * states or transitions, architecture-lock #31).
 */
export interface WorkflowStepBinding {
  readonly step: string;
  readonly from: string;
  readonly to: string;
  readonly description?: string;
}

/**
 * One business-policy configuration schema entry: WHICH policy key the
 * service applies and WHICH parameters a customer may configure, with
 * the declarative bounds. SCHEMA ONLY — this shape cannot express rules
 * or effects (rule content belongs exclusively to /policies).
 */
export interface PolicyConfigurationDeclaration {
  readonly policyKey: string;
  readonly parameters: readonly PolicyParameterSchema[];
}

export interface PolicyParameterSchema {
  readonly name: string;
  readonly type: 'number' | 'string' | 'boolean' | 'enum';
  readonly required: boolean;
  /** Number constraints (inclusive). */
  readonly min?: number;
  readonly max?: number;
  /** Enum constraint (type 'enum' only; non-empty). */
  readonly values?: readonly string[];
  /** Default within the schema bounds. */
  readonly defaultValue?: string | number | boolean;
}

/** Binds one vertical approval matrix rule with a service threshold (>= the vertical's). */
export interface ApprovalRuleBinding {
  readonly id: string;
  readonly threshold: number;
}

/** Service-level SLA default for one work type (<= the vertical's floor when declared). */
export interface SlaDefault {
  readonly workType: string;
  readonly deadlineHours: number;
}

/**
 * The business outcome contract: what must be true for the service's
 * work to complete — output schema, required evidence, and the
 * verification mode. Verification is ALWAYS a ServiceOS business
 * authority concept; AI execution verification is Zeck's and can never
 * be declared here (validated fail-closed).
 */
export interface OutcomeContract {
  readonly outcomeId: string;
  readonly description?: string;
  readonly outputSchema: readonly OutputFieldDefinition[];
  readonly evidenceRequirements: readonly string[];
  readonly verification: 'deterministic' | 'human_approval' | 'external_record';
}

export interface OutputFieldDefinition {
  readonly name: string;
  readonly type: 'string' | 'number' | 'boolean' | 'date';
  readonly required: boolean;
}

/**
 * Declarative pricing/metering metadata (architecture.md §17: hybrid
 * pricing models, service-level economics). Billing execution is
 * /billing's authority; this is catalog metadata only.
 */
export interface PricingMetadata {
  readonly model: 'subscription' | 'per_work_item' | 'per_outcome' | 'usage_band' | 'hybrid';
  readonly amount?: string;
  readonly currency?: string;
  readonly metering: readonly MeteringRule[];
}

export interface MeteringRule {
  readonly metric: string;
  readonly unit: string;
  readonly unitPrice?: string;
}

// ---------------------------------------------------------------------------
// Customer configuration sections (specialize; never weaken)
// ---------------------------------------------------------------------------

/** Customer-supplied values for one policy key's parameters (within the service's schema). */
export interface PolicyParameterValueSet {
  readonly policyKey: string;
  readonly values: Readonly<Record<string, string | number | boolean>>;
}

/** Customer SLA tightening for one work type (deadline <= the service's default). */
export interface SlaAdjustment {
  readonly workType: string;
  readonly deadlineHours: number;
}

/** Customer approval threshold strengthening for one rule (threshold >= the service's). */
export interface ApprovalAdjustment {
  readonly id: string;
  readonly threshold: number;
}

// ---------------------------------------------------------------------------
// Durable records
// ---------------------------------------------------------------------------

/**
 * Publication state of a service definition version. CONTRACT VERSIONING
 * (the service-package lifecycle, /services' architecture.md §6 scope),
 * never the Service Work state machine.
 */
export type ServiceStatus = 'draft' | 'active' | 'retired';

/** The durable service-definition version. */
export interface ServiceDefinitionRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly serviceId: string;
  readonly version: number;
  readonly status: ServiceStatus;
  readonly name: string;
  readonly description: string | null;
  readonly verticalPackageId: string;
  readonly verticalPackageVersion: number;
  readonly entities: readonly EntityBinding[];
  readonly workDefinitions: readonly WorkDefinitionBinding[];
  readonly workflowBinding: readonly WorkflowStepBinding[];
  readonly policyConfiguration: readonly PolicyConfigurationDeclaration[];
  readonly approvalRules: readonly ApprovalRuleBinding[];
  readonly slaDefaults: readonly SlaDefault[];
  readonly outcomeContract: OutcomeContract;
  readonly requiredExternalCapabilities: readonly string[];
  readonly requiredAiCapabilities: readonly ZeckCapabilityRequirement[];
  readonly pricing: PricingMetadata;
  /** sha256 over the canonical definition content (convergence matching). */
  readonly contentHash: string;
  /** Integrity hash over the canonical record core INCLUDING the current lifecycle state. */
  readonly recordHash: string;
  readonly createdBy: string;
  readonly idempotencyKey: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The durable customer-configuration version, pinned to a service version. */
export interface ServiceConfigurationRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly serviceId: string;
  /** The service-definition version this configuration was validated against and pins. */
  readonly serviceVersion: number;
  /** Store-allocated monotonic configuration version per (tenant, service id). */
  readonly configurationVersion: number;
  readonly status: ServiceStatus;
  readonly policyParameters: readonly PolicyParameterValueSet[];
  readonly slaAdjustments: readonly SlaAdjustment[];
  readonly approvalAdjustments: readonly ApprovalAdjustment[];
  readonly contentHash: string;
  readonly recordHash: string;
  readonly createdBy: string;
  readonly idempotencyKey: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Store port
// ---------------------------------------------------------------------------

export type ServiceStoreRule =
  | 'version-content-conflict'
  | 'version-not-sequential'
  | 'version-retired'
  | 'service-record-tampered'
  | 'configuration-record-tampered'
  | 'idempotency-input-conflict';

export class ServicesStoreRuleError extends Error {
  constructor(
    message: string,
    readonly rule: ServiceStoreRule,
  ) {
    super(message);
    this.name = 'ServicesStoreRuleError';
  }
}

export class ServicesStoreMissingError extends Error {
  constructor(
    readonly what: 'definition' | 'configuration',
    readonly id: string,
  ) {
    super(`${what} ${id} does not exist`);
    this.name = 'ServicesStoreMissingError';
  }
}

export interface RegisterDefinitionInput {
  readonly tenantId: string;
  readonly serviceId: string;
  readonly version: number;
  readonly name: string;
  readonly description: string | null;
  readonly verticalPackageId: string;
  readonly verticalPackageVersion: number;
  readonly entities: readonly EntityBinding[];
  readonly workDefinitions: readonly WorkDefinitionBinding[];
  readonly workflowBinding: readonly WorkflowStepBinding[];
  readonly policyConfiguration: readonly PolicyConfigurationDeclaration[];
  readonly approvalRules: readonly ApprovalRuleBinding[];
  readonly slaDefaults: readonly SlaDefault[];
  readonly outcomeContract: OutcomeContract;
  readonly requiredExternalCapabilities: readonly string[];
  readonly requiredAiCapabilities: readonly ZeckCapabilityRequirement[];
  readonly pricing: PricingMetadata;
  readonly contentHash: string;
  readonly recordHash: string;
  readonly createdBy: string;
  readonly idempotencyKey: string | null;
  readonly now: Date;
}

export interface RegisterConfigurationInput {
  readonly tenantId: string;
  readonly serviceId: string;
  readonly serviceVersion: number;
  readonly policyParameters: readonly PolicyParameterValueSet[];
  readonly slaAdjustments: readonly SlaAdjustment[];
  readonly approvalAdjustments: readonly ApprovalAdjustment[];
  readonly contentHash: string;
  readonly createdBy: string;
  readonly idempotencyKey: string | null;
  readonly now: Date;
}

export interface ActivateDefinitionInput {
  readonly tenantId: string;
  readonly serviceId: string;
  readonly version: number;
  readonly now: Date;
}

export interface ActivateConfigurationInput {
  readonly tenantId: string;
  readonly serviceId: string;
  readonly configurationVersion: number;
  readonly now: Date;
}

export interface ServicesStore {
  /**
   * Atomically register one service-definition version (starts `draft`).
   * Store rules (one serialized critical section): same (tenant,
   * idempotency key) converges on the durable identity (content compared;
   * divergence throws `idempotency-input-conflict`); version sequencing is
   * enforced (`version-not-sequential` for gaps/skips; duplicate of an
   * existing version converges iff the content hash matches, else
   * `version-content-conflict`).
   */
  registerDefinition(input: RegisterDefinitionInput): Promise<{ definition: ServiceDefinitionRecord; converged: boolean }>;
  /** Tenant-predicated (service id, version) lookup; null when absent. */
  findDefinition(tenantId: string, serviceId: string, version: number): Promise<ServiceDefinitionRecord | null>;
  /** Tenant-predicated list (optionally one service id and status), oldest version first. */
  listDefinitions(tenantId: string, serviceId?: string, status?: ServiceStatus): Promise<ServiceDefinitionRecord[]>;
  /**
   * Atomically move a definition version to `active`: the currently
   * active version of the same identity is retired FIRST, then this
   * version is activated. Forward-only (`version-retired`); activating
   * the already-active version converges. The record hash is recomputed
   * over the new row state atomically with the status write.
   */
  activateDefinition(input: ActivateDefinitionInput): Promise<{ definition: ServiceDefinitionRecord; converged: boolean }>;
  /** The currently active definition version, or null. */
  findActiveDefinition(tenantId: string, serviceId: string): Promise<ServiceDefinitionRecord | null>;
  /**
   * Atomically register one customer configuration (`draft`). The
   * configuration version is allocated per (tenant, service id) under a
   * lock — and the record hash is COMPUTED BY THE STORE over the full
   * allocated identity (the module supplies the content hash; the
   * store-owned version participates in the record hash, so only its
   * allocator can hash it). Same (tenant, idempotency key) converges on
   * the durable identity (content compared; divergence throws
   * `idempotency-input-conflict`).
   */
  registerConfiguration(input: RegisterConfigurationInput): Promise<{ configuration: ServiceConfigurationRecord; converged: boolean }>;
  /** Tenant-predicated configuration lookup by row id; null when absent. */
  findConfigurationById(tenantId: string, configurationId: string): Promise<ServiceConfigurationRecord | null>;
  /** Tenant-predicated configuration list (optionally one service id), configuration version ascending. */
  listConfigurations(tenantId: string, serviceId?: string): Promise<ServiceConfigurationRecord[]>;
  /** Same forward-only lifecycle as definitions, keyed by configuration version. */
  activateConfiguration(input: ActivateConfigurationInput): Promise<{ configuration: ServiceConfigurationRecord; converged: boolean }>;
  /** The currently active configuration of one service, or null. */
  findActiveConfiguration(tenantId: string, serviceId: string): Promise<ServiceConfigurationRecord | null>;
}
