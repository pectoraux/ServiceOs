/**
 * ServiceOS /verticals store port (WORK-009).
 *
 * The persistence contract for versioned vertical-package registrations.
 * The authoritative implementation is the SQL store executed through the
 * persistence boundary's `TransactionalExecutor` (client-pinned
 * transactions); tests inject a faithful in-memory implementation of this
 * same port.
 *
 * Store contract semantics (mirrored by every implementation):
 *
 * - TENANT PREDICATES ARE MANDATORY. Every lookup and list carries the
 *   tenant parameter in its signature and its query; a row in another
 *   tenant is indistinguishable from a missing row (architecture-lock
 *   #15/#16; a missing read stays distinguishable from an empty result,
 *   lock #30).
 *
 * - VERTICAL PACKAGES ARE VERSIONED AND IMMUTABLE IN CONTENT (AC-2). The
 *   durable identity is (tenant, package id, version). Registration is
 *   caller-versioned and STORE-SERIALIZED: a new version must be exactly
 *   max+1 (rule `version-not-sequential` otherwise), the duplicate
 *   registration of an EXISTING version with the SAME content hash
 *   converges on the durable row, and the duplicate registration of an
 *   existing version with a DIFFERENT content hash fails closed with rule
 *   `version-content-conflict` — "duplicate package/version registration
 *   converges or rejects deterministically" (Work Order concurrency
 *   requirement).
 *
 * - CONVERGENCE, NOT DUPLICATION. `registerPackage` is idempotent by
 *   durable identity: the same logical registration (tenant + idempotency
 *   key) converges on ONE durable row (concurrent creators receive the
 *   same identity); a divergent content for the same key fails closed
 *   with rule `idempotency-input-conflict`.
 *
 * - REGISTRATION HAS NO PUBLICATION LIFECYCLE. A registered package
 *   version is a durable immutable catalog entry that service
 *   definitions pin exactly (`services_definitions` references the row).
 *   "Service-package lifecycle" is /services' authority (draft → active),
 *   not this store's.
 *
 * - READS VERIFY THE PERSISTED RECORD HASH (rule
 *   `vertical-record-tampered` when a stored field no longer matches its
 *   persisted integrity hash; a stored content that no longer matches its
 *   content hash is likewise tampering).
 */
import { VerticalsError } from './errors.js';
import type { ZeckCapabilityRequirement } from './capability-requirements.js';

// ---------------------------------------------------------------------------
// Declarative package sections (validated shapes; content, never code)
// ---------------------------------------------------------------------------

/** One industry entity definition (name + fields). Declarative only. */
export interface EntityDefinition {
  readonly name: string;
  readonly description?: string;
  readonly fields: readonly EntityFieldDefinition[];
}

export interface EntityFieldDefinition {
  readonly name: string;
  readonly type: 'string' | 'number' | 'boolean' | 'date';
  readonly required: boolean;
}

/** One industry work-type definition (domain semantics of a class of Service Work). */
export interface WorkTypeDefinition {
  readonly name: string;
  readonly description?: string;
  /**
   * Vertical-declared SLA floor in hours (optional). A service definition
   * may only declare a TIGHTER (smaller) deadline for the same work type.
   */
  readonly defaultSlaHours?: number;
}

/** One domain workflow step declaration (a named phase; the binding to the canonical machine is /services' authority). */
export interface WorkflowStepDefinition {
  readonly step: string;
  readonly description?: string;
  /** Optional work type this step performs (must be declared in the same package). */
  readonly workType?: string;
  /** Optional entity this step primarily operates on (must be declared in the same package). */
  readonly entity?: string;
}

/**
 * One policy default declaration: the vertical's default VALUE for one
 * business-policy parameter. Declarative only — rules/effect composition
 * is /policies' authority; this shape cannot even express a rule.
 */
export interface PolicyDefaultDeclaration {
  readonly policyKey: string;
  readonly parameters: readonly PolicyParameterDefault[];
}

export interface PolicyParameterDefault {
  readonly name: string;
  readonly defaultValue: string | number | boolean;
}

/** One approval matrix entry: a role-based approval requirement. */
export interface ApprovalRuleDeclaration {
  readonly id: string;
  readonly workType?: string;
  readonly role: string;
  /** Minimum approver count (>= 1). */
  readonly threshold: number;
}

/** One evidence requirement declaration (a named business evidence class). */
export interface EvidenceRequirementDeclaration {
  readonly name: string;
  readonly description?: string;
}

/**
 * One integration binding declaration: names an external capability class
 * the vertical's workflows may need. Declarative only — adapter selection
 * and provider neutrality are the /integrations + /interactions
 * authorities (WORK-015); this module cannot import them.
 */
export interface IntegrationBindingDeclaration {
  readonly capabilityClass: string;
  readonly description?: string;
}

/** One declarative pricing/metering rule of the vertical (billing execution is /billing's authority). */
export interface PricingRuleDeclaration {
  readonly id: string;
  readonly description?: string;
  /** Pricing model this rule contributes to (declarative label). */
  readonly model: 'subscription' | 'per_work_item' | 'per_outcome' | 'usage_band' | 'hybrid';
  readonly amount?: string;
  readonly currency?: string;
}

// ---------------------------------------------------------------------------
// Durable record
// ---------------------------------------------------------------------------

/** The durable, immutable vertical package version registration. */
export interface VerticalPackageRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly packageId: string;
  readonly version: number;
  readonly name: string;
  readonly description: string | null;
  readonly terminology: Readonly<Record<string, string>>;
  readonly entities: readonly EntityDefinition[];
  readonly workTypes: readonly WorkTypeDefinition[];
  readonly workflowSteps: readonly WorkflowStepDefinition[];
  readonly policyDefaults: readonly PolicyDefaultDeclaration[];
  readonly approvalMatrix: readonly ApprovalRuleDeclaration[];
  readonly evidenceRequirements: readonly EvidenceRequirementDeclaration[];
  readonly integrationBindings: readonly IntegrationBindingDeclaration[];
  readonly zeckCapabilityRequirements: readonly ZeckCapabilityRequirement[];
  readonly pricingRules: readonly PricingRuleDeclaration[];
  /** sha256 over the canonical package CONTENT (convergence matching). */
  readonly contentHash: string;
  /** Integrity hash over the canonical record core (tamper detection on read). */
  readonly recordHash: string;
  readonly createdBy: string;
  readonly idempotencyKey: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Store port
// ---------------------------------------------------------------------------

export type VerticalStoreRule =
  | 'version-content-conflict'
  | 'version-not-sequential'
  | 'vertical-record-tampered'
  | 'idempotency-input-conflict';

export class VerticalsStoreRuleError extends Error {
  constructor(
    message: string,
    readonly rule: VerticalStoreRule,
  ) {
    super(message);
    this.name = 'VerticalsStoreRuleError';
  }
}

export interface RegisterPackageInput {
  readonly tenantId: string;
  readonly packageId: string;
  readonly version: number;
  readonly name: string;
  readonly description: string | null;
  readonly terminology: Readonly<Record<string, string>>;
  readonly entities: readonly EntityDefinition[];
  readonly workTypes: readonly WorkTypeDefinition[];
  readonly workflowSteps: readonly WorkflowStepDefinition[];
  readonly policyDefaults: readonly PolicyDefaultDeclaration[];
  readonly approvalMatrix: readonly ApprovalRuleDeclaration[];
  readonly evidenceRequirements: readonly EvidenceRequirementDeclaration[];
  readonly integrationBindings: readonly IntegrationBindingDeclaration[];
  readonly zeckCapabilityRequirements: readonly ZeckCapabilityRequirement[];
  readonly pricingRules: readonly PricingRuleDeclaration[];
  /** sha256 over the canonical package CONTENT (convergence matching). */
  readonly contentHash: string;
  /** Integrity hash over the canonical record core (tamper detection on read). */
  readonly recordHash: string;
  readonly createdBy: string;
  readonly idempotencyKey: string | null;
  readonly now: Date;
}

export interface VerticalsStore {
  /**
   * Atomically register one package version. Store rules (all enforced in
   * one serialized critical section):
   * - same (tenant, idempotency key) → converge on the durable row (input
   *   content compared; divergence throws `idempotency-input-conflict`);
   * - version == max+1 (or first) → insert;
   * - version ≤ max and existing with same content hash → converge;
   * - version ≤ max and existing with different content hash →
   *   `version-content-conflict`;
   * - version > max+1 → `version-not-sequential`.
   */
  registerPackage(input: RegisterPackageInput): Promise<{ pkg: VerticalPackageRecord; converged: boolean }>;
  /** Tenant-predicated row lookup; null when absent in this tenant. */
  findPackageById(tenantId: string, rowId: string): Promise<VerticalPackageRecord | null>;
  /** Tenant-predicated (package id, version) lookup; null when absent. */
  findPackage(tenantId: string, packageId: string, version: number): Promise<VerticalPackageRecord | null>;
  /** Tenant-predicated list (optionally one package id), oldest version first. */
  listPackages(tenantId: string, packageId?: string): Promise<VerticalPackageRecord[]>;
}

// Re-export for the module's public surface.
export { VerticalsError };
