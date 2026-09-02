/**
 * ServiceOS module: /verticals (WORK-009 implementation).
 *
 * The vertical-package registration authority (architecture.md §6, §15;
 * vertical-model.md; architecture-lock #31/#32).
 *
 * Authority (authority matrix / Work Order frozen scope):
 * - VERTICAL PACKAGE REGISTRATION is owned here: versioned, immutable,
 *   tenant-bound catalog rows describing industry domain semantics
 *   (terminology, entity/work-type/workflow-step definitions, policy
 *   defaults, approval matrix, evidence requirements, integration
 *   bindings, Zeck capability requirement declarations, pricing rules).
 *   A module other than /verticals exporting vertical-registration entry
 *   points is an architecture violation (checked structurally).
 * - PACKAGES ARE DATA, NEVER CODE (vertical-model.md "deterministic
 *   business rules" are DECLARATIONS here: ids, descriptions and
 *   parameter defaults — executable vertical logic arrives with the
 *   vertical-implementation Work Orders, e.g. WORK-010): a registered
 *   package cannot introduce executable behavior, so vertical workflow
 *   logic cannot leak into horizontal authorities by construction.
 * - VERTICALS SPECIALIZE, NEVER BIND (Work Order invariant): this module
 *   declares domain semantics only; binding declarations to the
 *   horizontal runtime (canonical workflow machine, service lifecycle,
 *   customer configuration) is /services' authority. /verticals imports
 *   no business authority other than the identity/tenancy chain — the
 *   structural boundary checks pin this.
 * - ZECK CAPABILITY REQUIREMENTS ARE DECLARATIONS ONLY (AC-4; shared
 *   contract in capability-requirements.ts): a requirement NAMES a
 *   business need for an AI capability plus optional quality/latency
 *   bounds; model/provider/agent/prompt selection is Zeck's authority
 *   and this surface cannot express it (frozen forbidden-key list,
 *   fail-closed validation). This module never imports /zeck — declared
 *   requirements are consumed at execution time by the AI intent
 *   boundary (WORK-005), never selected here.
 * - NO PUBLICATION LIFECYCLE: a registered package version is an
 *   immutable catalog entry (service definitions pin the exact version
 *   they bind); the service-package lifecycle (draft → active) is
 *   /services' authority, mirroring the /policies versioning note that
 *   contract versioning is not the Service Work state machine.
 * - AUTHORIZATION REMAINS SEPARATE: this module consumes the single
 *   authorization chain from /organizations' public interface exactly
 *   like /work, /policies, /workflow; it never re-implements a
 *   permission decision.
 *
 * Versioning (AC-2; Work Order concurrency requirement): the durable
 * identity is (tenant, package id, version). Registration is
 * caller-versioned and store-serialized — the duplicate registration of
 * an existing version converges iff the canonical content hash matches
 * (one durable row) and fails closed (typed VERSION_CONTENT_CONFLICT)
 * otherwise; version gaps and skips fail closed
 * (VERSION_NOT_SEQUENTIAL). Every read verifies the persisted content
 * and record hashes (typed VERTICAL_RECORD_TAMPERED on divergence).
 */
import { defineModule } from '../../platform/module-registry/index.js';
import type { TransactionalExecutor } from '../../platform/persistence/index.js';
import type { Principal } from '../auth/index.js';
import type { AuthorizationDecision, AuthorizationDenyReason, TenancyAction } from '../organizations/index.js';
import { createSqlVerticalsStore } from './sql-store.js';
import { hashPackageContent, hashVerticalRecord } from './content.js';
import { validateZeckCapabilityRequirements } from './capability-requirements.js';
import { VerticalsError, type VerticalErrorCode } from './errors.js';
import {
  VerticalsStoreRuleError,
  type EntityDefinition,
  type EntityFieldDefinition,
  type IntegrationBindingDeclaration,
  type PolicyDefaultDeclaration,
  type PolicyParameterDefault,
  type PricingRuleDeclaration,
  type RegisterPackageInput,
  type VerticalPackageRecord,
  type VerticalsStore,
  type VerticalStoreRule,
  type WorkTypeDefinition,
  type WorkflowStepDefinition,
  type ApprovalRuleDeclaration,
  type EvidenceRequirementDeclaration,
} from './store.js';
import type { ZeckCapabilityRequirement } from './capability-requirements.js';

// Store port (public contract): the authoritative SQL implementation runs
// through the persistence boundary; tests inject faithful in-memory
// implementations of the same port through this surface.
export { VerticalsError, VerticalsStoreRuleError, createSqlVerticalsStore };
export type { VerticalErrorCode, VerticalStoreRule };
export type {
  ApprovalRuleDeclaration,
  EntityDefinition,
  EntityFieldDefinition,
  EvidenceRequirementDeclaration,
  IntegrationBindingDeclaration,
  PolicyDefaultDeclaration,
  PolicyParameterDefault,
  PricingRuleDeclaration,
  RegisterPackageInput,
  VerticalPackageRecord,
  VerticalsStore,
  WorkTypeDefinition,
  WorkflowStepDefinition,
};

// The Zeck capability-requirement declaration contract (AC-4): shared by
// /verticals package declarations and consumed by /services through this
// public interface (/services never re-implements it).
export {
  FORBIDDEN_SELECTION_KEYS,
  MAX_ZECK_REQUIREMENTS,
  validateZeckCapabilityRequirement,
  validateZeckCapabilityRequirements,
} from './capability-requirements.js';
export type { ZeckCapabilityRequirement };

// The module's own deterministic content/record hashing discipline
// (canonical serialization is part of the registration convergence
// contract).
export { canonicalJson, hashPackageContent, hashVerticalRecord } from './content.js';
export type { PackageContentCore, VerticalRecordCore } from './content.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The tenancy authorization decision entry point consumed from
 * /organizations' public interface (injected by the composition root so
 * the authorization chain stays singular — never re-implemented here).
 */
export interface TenancyAuthorization {
  authorize(
    principalId: string,
    scope: { organizationId: string } | { tenantId: string },
    action: TenancyAction,
  ): Promise<AuthorizationDecision>;
}

/** The validated input of `registerVerticalPackage`. */
export interface RegisterVerticalPackageInput {
  readonly tenantId: string;
  /** Stable logical package id (e.g. 'construction'). */
  readonly packageId: string;
  /** Monotonic contiguous version, 1 for the first registration. */
  readonly version: number;
  readonly name: string;
  readonly description?: string;
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
  readonly idempotencyKey?: string;
}

export interface VerticalsModuleOptions {
  /** Production wiring: transaction-capable persistence executor. */
  executor?: TransactionalExecutor;
  /** Test seam: inject a faithful in-memory store instead (tests only). */
  store?: VerticalsStore;
  /** The single authorization chain, injected by the composition root. */
  tenancy: TenancyAuthorization;
  /** Clock injection for deterministic proofs. */
  now?: () => Date;
}

export interface VerticalsModule {
  /**
   * Register one vertical-package version (AC-2). The input is validated
   * fail-closed (shape, cross-references, Zeck capability declarations
   * without selection fields), the content hash pins the canonical
   * content, and the store serializes the version sequence. Duplicate
   * registration of the same version with the same content converges on
   * the durable row; different content fails closed
   * (VERSION_CONTENT_CONFLICT); version gaps/skips fail closed
   * (VERSION_NOT_SEQUENTIAL).
   */
  registerVerticalPackage(
    principal: Principal,
    input: RegisterVerticalPackageInput,
  ): Promise<{ pkg: VerticalPackageRecord; converged: boolean }>;
  /** Read one package version (hash-verified). Null when absent in this tenant. */
  getVerticalPackage(principal: Principal, tenantId: string, packageId: string, version: number): Promise<VerticalPackageRecord | null>;
  /** List package versions (optionally one package id), oldest first. */
  listVerticalPackages(principal: Principal, tenantId: string, packageId?: string): Promise<VerticalPackageRecord[]>;
  /**
   * The latest registered version of one package, or null. Convenience
   * read for registration UIs; binding consumers pin exact versions.
   */
  latestVerticalPackage(principal: Principal, tenantId: string, packageId: string): Promise<VerticalPackageRecord | null>;
}

// ---------------------------------------------------------------------------
// Validation (fail closed)
// ---------------------------------------------------------------------------

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PACKAGE_ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
const NAME_PATTERN = /^[^\n]{1,200}$/;
const IDENTIFIER_PATTERN = /^[a-zA-Z][a-zA-Z0-9_.-]{0,199}$/;
const CAPABILITY_CLASS_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;
const DECIMAL_PATTERN = /^\d{1,12}(\.\d{1,6})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

const MAX_TERMINOLOGY_TERMS = 200;
const MAX_ENTITIES = 200;
const MAX_FIELDS_PER_ENTITY = 100;
const MAX_WORK_TYPES = 200;
const MAX_WORKFLOW_STEPS = 200;
const MAX_POLICY_DEFAULTS = 100;
const MAX_PARAMETERS_PER_POLICY = 50;
const MAX_APPROVAL_RULES = 200;
const MAX_EVIDENCE_REQUIREMENTS = 200;
const MAX_INTEGRATION_BINDINGS = 64;
const MAX_PRICING_RULES = 100;
const MAX_TEXT_LENGTH = 500;

function validateUuid(value: string, what: string): void {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new VerticalsError('INVALID_INPUT', `${what} must be a UUID`);
  }
}

function validateIdentifier(value: unknown, what: string, pattern: RegExp, message: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new VerticalsError('INVALID_INPUT', `${what} ${message}`);
  }
  return value;
}

function validateOptionalText(value: unknown, what: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > MAX_TEXT_LENGTH) {
    throw new VerticalsError('INVALID_INPUT', `${what} must be a string of at most ${MAX_TEXT_LENGTH} characters`);
  }
  return value;
}

function validateOptionalIdempotencyKey(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.trim() === '' || value.length > 200) {
    throw new VerticalsError('INVALID_INPUT', 'idempotencyKey must be a non-empty string of at most 200 characters');
  }
  return value.trim();
}

function isPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function validateTerminology(terminology: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  if (typeof terminology !== 'object' || terminology === null || Array.isArray(terminology)) {
    throw new VerticalsError('INVALID_INPUT', 'terminology must be an object');
  }
  const entries = Object.entries(terminology);
  if (entries.length > MAX_TERMINOLOGY_TERMS) {
    throw new VerticalsError('INVALID_INPUT', `terminology must contain at most ${MAX_TERMINOLOGY_TERMS} terms`);
  }
  const validated: Record<string, string> = {};
  for (const [term, definition] of entries) {
    validateIdentifier(term, 'terminology term', IDENTIFIER_PATTERN, 'must match the identifier pattern');
    if (typeof definition !== 'string' || definition.trim() === '' || definition.length > MAX_TEXT_LENGTH) {
      throw new VerticalsError('INVALID_INPUT', `terminology term "${term}" must define a non-empty string of at most ${MAX_TEXT_LENGTH} characters`);
    }
    validated[term] = definition;
  }
  return validated;
}

function validateFieldTypes(type: unknown): 'string' | 'number' | 'boolean' | 'date' {
  if (type !== 'string' && type !== 'number' && type !== 'boolean' && type !== 'date') {
    throw new VerticalsError('INVALID_INPUT', 'entity field type must be "string", "number", "boolean" or "date"');
  }
  return type;
}

function validateEntities(entities: readonly EntityDefinition[]): readonly EntityDefinition[] {
  if (!Array.isArray(entities)) {
    throw new VerticalsError('INVALID_INPUT', 'entities must be an array');
  }
  if (entities.length > MAX_ENTITIES) {
    throw new VerticalsError('INVALID_INPUT', `entities must contain at most ${MAX_ENTITIES} definitions`);
  }
  const seen = new Set<string>();
  const validated: EntityDefinition[] = [];
  for (const entity of entities) {
    if (typeof entity !== 'object' || entity === null) {
      throw new VerticalsError('INVALID_INPUT', 'each entity definition must be an object');
    }
    const name = validateIdentifier(entity.name, 'entity name', IDENTIFIER_PATTERN, 'must match the identifier pattern');
    if (seen.has(name)) {
      throw new VerticalsError('INVALID_INPUT', `entity "${name}" is declared twice; entity names must be unique`);
    }
    seen.add(name);
    if (!Array.isArray(entity.fields)) {
      throw new VerticalsError('INVALID_INPUT', `entity "${name}" fields must be an array`);
    }
    if (entity.fields.length > MAX_FIELDS_PER_ENTITY) {
      throw new VerticalsError('INVALID_INPUT', `entity "${name}" must declare at most ${MAX_FIELDS_PER_ENTITY} fields`);
    }
    const fieldNames = new Set<string>();
    const fields: EntityFieldDefinition[] = [];
    for (const field of entity.fields) {
      if (typeof field !== 'object' || field === null) {
        throw new VerticalsError('INVALID_INPUT', `entity "${name}" field must be an object`);
      }
      const fieldName = validateIdentifier(field.name, 'entity field name', IDENTIFIER_PATTERN, 'must match the identifier pattern');
      if (fieldNames.has(fieldName)) {
        throw new VerticalsError('INVALID_INPUT', `entity "${name}" field "${fieldName}" is declared twice`);
      }
      fieldNames.add(fieldName);
      if (typeof field.required !== 'boolean') {
        throw new VerticalsError('INVALID_INPUT', `entity "${name}" field "${fieldName}" required must be a boolean`);
      }
      fields.push({ name: fieldName, type: validateFieldTypes(field.type), required: field.required });
    }
    validated.push({
      name,
      ...(validateOptionalText(entity.description, `entity "${name}" description`) !== null
        ? { description: entity.description as string }
        : {}),
      fields,
    });
  }
  return validated;
}

function validateWorkTypes(
  workTypes: readonly WorkTypeDefinition[],
): readonly WorkTypeDefinition[] {
  if (!Array.isArray(workTypes)) {
    throw new VerticalsError('INVALID_INPUT', 'workTypes must be an array');
  }
  if (workTypes.length > MAX_WORK_TYPES) {
    throw new VerticalsError('INVALID_INPUT', `workTypes must contain at most ${MAX_WORK_TYPES} definitions`);
  }
  const seen = new Set<string>();
  const validated: WorkTypeDefinition[] = [];
  for (const workType of workTypes) {
    if (typeof workType !== 'object' || workType === null) {
      throw new VerticalsError('INVALID_INPUT', 'each work type definition must be an object');
    }
    const name = validateIdentifier(workType.name, 'work type name', IDENTIFIER_PATTERN, 'must match the identifier pattern');
    if (seen.has(name)) {
      throw new VerticalsError('INVALID_INPUT', `work type "${name}" is declared twice; work type names must be unique`);
    }
    seen.add(name);
    if (
      workType.defaultSlaHours !== undefined &&
      (typeof workType.defaultSlaHours !== 'number' || !Number.isInteger(workType.defaultSlaHours) || workType.defaultSlaHours <= 0)
    ) {
      throw new VerticalsError('INVALID_INPUT', `work type "${name}" defaultSlaHours must be a positive integer`);
    }
    validated.push({
      name,
      ...(validateOptionalText(workType.description, `work type "${name}" description`) !== null
        ? { description: workType.description as string }
        : {}),
      ...(workType.defaultSlaHours !== undefined ? { defaultSlaHours: workType.defaultSlaHours } : {}),
    });
  }
  return validated;
}

function validateWorkflowSteps(
  steps: readonly WorkflowStepDefinition[],
  workTypeNames: ReadonlySet<string>,
  entityNames: ReadonlySet<string>,
): readonly WorkflowStepDefinition[] {
  if (!Array.isArray(steps)) {
    throw new VerticalsError('INVALID_INPUT', 'workflowSteps must be an array');
  }
  if (steps.length > MAX_WORKFLOW_STEPS) {
    throw new VerticalsError('INVALID_INPUT', `workflowSteps must contain at most ${MAX_WORKFLOW_STEPS} declarations`);
  }
  const seen = new Set<string>();
  const validated: WorkflowStepDefinition[] = [];
  for (const step of steps) {
    if (typeof step !== 'object' || step === null) {
      throw new VerticalsError('INVALID_INPUT', 'each workflow step must be an object');
    }
    const name = validateIdentifier(step.step, 'workflow step name', IDENTIFIER_PATTERN, 'must match the identifier pattern');
    if (seen.has(name)) {
      throw new VerticalsError('INVALID_INPUT', `workflow step "${name}" is declared twice; step names must be unique`);
    }
    seen.add(name);
    if (step.workType !== undefined) {
      const workType = validateIdentifier(step.workType, 'workflow step workType', IDENTIFIER_PATTERN, 'must match the identifier pattern');
      if (!workTypeNames.has(workType)) {
        throw new VerticalsError(
          'INVALID_INPUT',
          `workflow step "${name}" references work type "${workType}" which the package does not declare`,
        );
      }
    }
    if (step.entity !== undefined) {
      const entity = validateIdentifier(step.entity, 'workflow step entity', IDENTIFIER_PATTERN, 'must match the identifier pattern');
      if (!entityNames.has(entity)) {
        throw new VerticalsError(
          'INVALID_INPUT',
          `workflow step "${name}" references entity "${entity}" which the package does not declare`,
        );
      }
    }
    validated.push({
      step: name,
      ...(validateOptionalText(step.description, `workflow step "${name}" description`) !== null
        ? { description: step.description as string }
        : {}),
      ...(step.workType !== undefined ? { workType: step.workType } : {}),
      ...(step.entity !== undefined ? { entity: step.entity } : {}),
    });
  }
  return validated;
}

function validatePolicyDefaults(defaults: readonly PolicyDefaultDeclaration[]): readonly PolicyDefaultDeclaration[] {
  if (!Array.isArray(defaults)) {
    throw new VerticalsError('INVALID_INPUT', 'policyDefaults must be an array');
  }
  if (defaults.length > MAX_POLICY_DEFAULTS) {
    throw new VerticalsError('INVALID_INPUT', `policyDefaults must contain at most ${MAX_POLICY_DEFAULTS} declarations`);
  }
  const seen = new Set<string>();
  const validated: PolicyDefaultDeclaration[] = [];
  for (const declaration of defaults) {
    if (typeof declaration !== 'object' || declaration === null) {
      throw new VerticalsError('INVALID_INPUT', 'each policy default must be an object');
    }
    // DECLARATIVE ONLY: a policy default carries parameter VALUES, never
    // rules or effects — rules/effect composition is /policies' authority
    // and this shape cannot even express a rule (no duplicate policy
    // engine by construction; checked structurally as well).
    for (const key of Object.keys(declaration)) {
      if (key === 'rules' || key === 'defaultEffect' || key === 'effect' || key === 'conditions') {
        throw new VerticalsError(
          'INVALID_INPUT',
          `policy default carries forbidden key "${key}"; vertical packages declare parameter defaults only and policy rules/effects belong to /policies`,
        );
      }
    }
    const policyKey = validateIdentifier(declaration.policyKey, 'policyKey', IDENTIFIER_PATTERN, 'must match the identifier pattern');
    if (seen.has(policyKey)) {
      throw new VerticalsError('INVALID_INPUT', `policy default for "${policyKey}" is declared twice`);
    }
    seen.add(policyKey);
    if (!Array.isArray(declaration.parameters) || declaration.parameters.length === 0) {
      throw new VerticalsError('INVALID_INPUT', `policy default for "${policyKey}" must declare at least one parameter`);
    }
    if (declaration.parameters.length > MAX_PARAMETERS_PER_POLICY) {
      throw new VerticalsError('INVALID_INPUT', `policy default for "${policyKey}" must declare at most ${MAX_PARAMETERS_PER_POLICY} parameters`);
    }
    const parameterNames = new Set<string>();
    const parameters: PolicyParameterDefault[] = [];
    for (const parameter of declaration.parameters) {
      if (typeof parameter !== 'object' || parameter === null) {
        throw new VerticalsError('INVALID_INPUT', `policy default parameter of "${policyKey}" must be an object`);
      }
      const name = validateIdentifier(parameter.name, 'policy default parameter name', IDENTIFIER_PATTERN, 'must match the identifier pattern');
      if (parameterNames.has(name)) {
        throw new VerticalsError('INVALID_INPUT', `policy default parameter "${name}" of "${policyKey}" is declared twice`);
      }
      parameterNames.add(name);
      if (!isPrimitive(parameter.defaultValue)) {
        throw new VerticalsError('INVALID_INPUT', `policy default parameter "${name}" of "${policyKey}" must carry a primitive defaultValue`);
      }
      parameters.push({ name, defaultValue: parameter.defaultValue });
    }
    validated.push({ policyKey, parameters });
  }
  return validated;
}

function validateApprovalMatrix(matrix: readonly ApprovalRuleDeclaration[], workTypeNames: ReadonlySet<string>): readonly ApprovalRuleDeclaration[] {
  if (!Array.isArray(matrix)) {
    throw new VerticalsError('INVALID_INPUT', 'approvalMatrix must be an array');
  }
  if (matrix.length > MAX_APPROVAL_RULES) {
    throw new VerticalsError('INVALID_INPUT', `approvalMatrix must contain at most ${MAX_APPROVAL_RULES} rules`);
  }
  const seen = new Set<string>();
  const validated: ApprovalRuleDeclaration[] = [];
  for (const rule of matrix) {
    if (typeof rule !== 'object' || rule === null) {
      throw new VerticalsError('INVALID_INPUT', 'each approval rule must be an object');
    }
    const id = validateIdentifier(rule.id, 'approval rule id', IDENTIFIER_PATTERN, 'must match the identifier pattern');
    if (seen.has(id)) {
      throw new VerticalsError('INVALID_INPUT', `approval rule "${id}" is declared twice; ids must be unique`);
    }
    seen.add(id);
    const role = validateIdentifier(rule.role, 'approval rule role', IDENTIFIER_PATTERN, 'must match the identifier pattern');
    if (typeof rule.threshold !== 'number' || !Number.isInteger(rule.threshold) || rule.threshold < 1) {
      throw new VerticalsError('INVALID_INPUT', `approval rule "${id}" threshold must be an integer >= 1`);
    }
    if (rule.workType !== undefined) {
      const workType = validateIdentifier(rule.workType, 'approval rule workType', IDENTIFIER_PATTERN, 'must match the identifier pattern');
      if (!workTypeNames.has(workType)) {
        throw new VerticalsError(
          'INVALID_INPUT',
          `approval rule "${id}" references work type "${workType}" which the package does not declare`,
        );
      }
    }
    validated.push({
      id,
      ...(rule.workType !== undefined ? { workType: rule.workType } : {}),
      role,
      threshold: rule.threshold,
    });
  }
  return validated;
}

function validateEvidenceRequirements(requirements: readonly EvidenceRequirementDeclaration[]): readonly EvidenceRequirementDeclaration[] {
  if (!Array.isArray(requirements)) {
    throw new VerticalsError('INVALID_INPUT', 'evidenceRequirements must be an array');
  }
  if (requirements.length > MAX_EVIDENCE_REQUIREMENTS) {
    throw new VerticalsError('INVALID_INPUT', `evidenceRequirements must contain at most ${MAX_EVIDENCE_REQUIREMENTS} declarations`);
  }
  const seen = new Set<string>();
  const validated: EvidenceRequirementDeclaration[] = [];
  for (const requirement of requirements) {
    if (typeof requirement !== 'object' || requirement === null) {
      throw new VerticalsError('INVALID_INPUT', 'each evidence requirement must be an object');
    }
    const name = validateIdentifier(requirement.name, 'evidence requirement name', IDENTIFIER_PATTERN, 'must match the identifier pattern');
    if (seen.has(name)) {
      throw new VerticalsError('INVALID_INPUT', `evidence requirement "${name}" is declared twice`);
    }
    seen.add(name);
    validated.push({
      name,
      ...(validateOptionalText(requirement.description, `evidence requirement "${name}" description`) !== null
        ? { description: requirement.description as string }
        : {}),
    });
  }
  return validated;
}

function validateIntegrationBindings(bindings: readonly IntegrationBindingDeclaration[]): readonly IntegrationBindingDeclaration[] {
  if (!Array.isArray(bindings)) {
    throw new VerticalsError('INVALID_INPUT', 'integrationBindings must be an array');
  }
  if (bindings.length > MAX_INTEGRATION_BINDINGS) {
    throw new VerticalsError('INVALID_INPUT', `integrationBindings must contain at most ${MAX_INTEGRATION_BINDINGS} declarations`);
  }
  const seen = new Set<string>();
  const validated: IntegrationBindingDeclaration[] = [];
  for (const binding of bindings) {
    if (typeof binding !== 'object' || binding === null) {
      throw new VerticalsError('INVALID_INPUT', 'each integration binding must be an object');
    }
    // Declarative capability-class NAMES only: provider adapters and
    // selection live behind the /integrations + /interactions authorities
    // (WORK-015); this module cannot import them, so nothing here can
    // reach a provider. Cross-validation against the frozen capability
    // taxonomy arrives with the Work Order that owns integration binding
    // consumption (WORK-010/012).
    const capabilityClass = validateIdentifier(
      binding.capabilityClass,
      'integration binding capabilityClass',
      CAPABILITY_CLASS_PATTERN,
      'must be a lowercase snake_case capability class name',
    );
    if (seen.has(capabilityClass)) {
      throw new VerticalsError('INVALID_INPUT', `integration binding "${capabilityClass}" is declared twice`);
    }
    seen.add(capabilityClass);
    validated.push({
      capabilityClass,
      ...(validateOptionalText(binding.description, `integration binding "${capabilityClass}" description`) !== null
        ? { description: binding.description as string }
        : {}),
    });
  }
  return validated;
}

function validatePricingRules(rules: readonly PricingRuleDeclaration[]): readonly PricingRuleDeclaration[] {
  if (!Array.isArray(rules)) {
    throw new VerticalsError('INVALID_INPUT', 'pricingRules must be an array');
  }
  if (rules.length > MAX_PRICING_RULES) {
    throw new VerticalsError('INVALID_INPUT', `pricingRules must contain at most ${MAX_PRICING_RULES} rules`);
  }
  const seen = new Set<string>();
  const validated: PricingRuleDeclaration[] = [];
  for (const rule of rules) {
    if (typeof rule !== 'object' || rule === null) {
      throw new VerticalsError('INVALID_INPUT', 'each pricing rule must be an object');
    }
    const id = validateIdentifier(rule.id, 'pricing rule id', IDENTIFIER_PATTERN, 'must match the identifier pattern');
    if (seen.has(id)) {
      throw new VerticalsError('INVALID_INPUT', `pricing rule "${id}" is declared twice`);
    }
    seen.add(id);
    const model = rule.model;
    if (model !== 'subscription' && model !== 'per_work_item' && model !== 'per_outcome' && model !== 'usage_band' && model !== 'hybrid') {
      throw new VerticalsError('INVALID_INPUT', `pricing rule "${id}" model must be a known pricing model`);
    }
    if (rule.amount !== undefined && (typeof rule.amount !== 'string' || !DECIMAL_PATTERN.test(rule.amount))) {
      throw new VerticalsError('INVALID_INPUT', `pricing rule "${id}" amount must be a decimal string (e.g. "199.00")`);
    }
    if (rule.currency !== undefined && (typeof rule.currency !== 'string' || !CURRENCY_PATTERN.test(rule.currency))) {
      throw new VerticalsError('INVALID_INPUT', `pricing rule "${id}" currency must be a 3-letter ISO code`);
    }
    validated.push({
      id,
      ...(validateOptionalText(rule.description, `pricing rule "${id}" description`) !== null
        ? { description: rule.description as string }
        : {}),
      model,
      ...(rule.amount !== undefined ? { amount: rule.amount } : {}),
      ...(rule.currency !== undefined ? { currency: rule.currency } : {}),
    });
  }
  return validated;
}

/** Map an authorization denial reason to the verticals error surface. */
function denyToError(reason: AuthorizationDenyReason | undefined, tenantId: string): VerticalsError {
  switch (reason) {
    case 'TENANT_NOT_FOUND':
      return new VerticalsError('TENANT_NOT_FOUND', `service tenant ${tenantId} does not exist`);
    case 'TENANT_SUSPENDED':
      return new VerticalsError('TENANT_SUSPENDED', `service tenant ${tenantId} is suspended`);
    case 'ORGANIZATION_NOT_FOUND':
      return new VerticalsError('TENANT_NOT_FOUND', `the tenant's organization no longer exists`);
    case 'ORGANIZATION_SUSPENDED':
      return new VerticalsError('ORGANIZATION_SUSPENDED', 'the owning organization is suspended');
    case 'MEMBERSHIP_FORBIDDEN':
      return new VerticalsError('TENANT_FORBIDDEN', 'the principal has no active membership granting this tenant');
    case 'ROLE_FORBIDDEN':
      return new VerticalsError('ROLE_FORBIDDEN', 'the principal role does not grant the required capability');
    default:
      return new VerticalsError('TENANT_FORBIDDEN', 'authorization denied');
  }
}

/** Map store errors to the public verticals error surface. */
function mapStoreError(error: unknown): never {
  if (error instanceof VerticalsStoreRuleError) {
    switch (error.rule) {
      case 'version-content-conflict':
        throw new VerticalsError('VERSION_CONTENT_CONFLICT', error.message);
      case 'version-not-sequential':
        throw new VerticalsError('VERSION_NOT_SEQUENTIAL', error.message);
      case 'vertical-record-tampered':
        throw new VerticalsError('VERTICAL_RECORD_TAMPERED', error.message);
      case 'idempotency-input-conflict':
        throw new VerticalsError('IDEMPOTENCY_INPUT_CONFLICT', error.message);
    }
  }
  throw error;
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export function createVerticalsModule(options: VerticalsModuleOptions): VerticalsModule {
  if ((options.executor === undefined) === (options.store === undefined)) {
    throw new VerticalsError('INVALID_INPUT', 'createVerticalsModule requires exactly one of executor or store');
  }
  const store = options.store ?? createSqlVerticalsStore(options.executor as TransactionalExecutor);
  const tenancy = options.tenancy;
  const now = options.now ?? (() => new Date());

  /** Authorization BEFORE any domain data access (single chain). */
  async function requireTenantAccess(principal: Principal, tenantId: string, action: TenancyAction): Promise<void> {
    validateUuid(tenantId, 'tenantId');
    const decision = await tenancy.authorize(principal.id, { tenantId }, action);
    if (!decision.allowed) {
      throw denyToError(decision.reason, tenantId);
    }
  }

  return {
    async registerVerticalPackage(principal, input) {
      await requireTenantAccess(principal, input.tenantId, 'write');
      const packageId = validateIdentifier(
        input.packageId,
        'packageId',
        PACKAGE_ID_PATTERN,
        'must be a lowercase slug of at most 64 characters (letters, digits, dashes)',
      );
      if (typeof input.version !== 'number' || !Number.isInteger(input.version) || input.version < 1) {
        throw new VerticalsError('INVALID_INPUT', 'version must be a positive integer');
      }
      const name = validateIdentifier(input.name, 'name', NAME_PATTERN, 'must be a single-line string of at most 200 characters');
      const description = validateOptionalText(input.description, 'description');
      const terminology = validateTerminology(input.terminology);
      const entities = validateEntities(input.entities);
      const workTypes = validateWorkTypes(input.workTypes);
      const entityNames = new Set(entities.map((entity) => entity.name));
      const workTypeNames = new Set(workTypes.map((workType) => workType.name));
      const workflowSteps = validateWorkflowSteps(input.workflowSteps, workTypeNames, entityNames);
      const policyDefaults = validatePolicyDefaults(input.policyDefaults);
      const approvalMatrix = validateApprovalMatrix(input.approvalMatrix, workTypeNames);
      const evidenceRequirements = validateEvidenceRequirements(input.evidenceRequirements);
      const integrationBindings = validateIntegrationBindings(input.integrationBindings);
      // AC-4: capability REQUIREMENTS only — the shared declaration contract
      // rejects any model/provider/agent/prompt selection field.
      const zeckCapabilityRequirements = validateZeckCapabilityRequirements(input.zeckCapabilityRequirements);
      const pricingRules = validatePricingRules(input.pricingRules);
      const idempotencyKey = validateOptionalIdempotencyKey(input.idempotencyKey);

      const contentCore = {
        tenantId: input.tenantId,
        packageId,
        version: input.version,
        name,
        description,
        terminology,
        entities,
        workTypes,
        workflowSteps,
        policyDefaults,
        approvalMatrix,
        evidenceRequirements,
        integrationBindings,
        zeckCapabilityRequirements,
        pricingRules,
      };
      const contentHash = hashPackageContent(contentCore);
      // One clock read: the SAME instant is pinned into the record hash and
      // the persisted row (the hash is verified against the stored row on
      // every read).
      const registeredAt = now();
      const recordHash = hashVerticalRecord({
        ...contentCore,
        contentHash,
        createdBy: principal.id,
        idempotencyKey,
        createdAt: registeredAt,
        updatedAt: registeredAt,
      });

      const payload: RegisterPackageInput = {
        ...contentCore,
        contentHash,
        recordHash,
        createdBy: principal.id,
        idempotencyKey,
        now: registeredAt,
      };
      try {
        return await store.registerPackage(payload);
      } catch (error) {
        return mapStoreError(error);
      }
    },

    async getVerticalPackage(principal, tenantId, packageId, version) {
      await requireTenantAccess(principal, tenantId, 'read');
      const id = validateIdentifier(packageId, 'packageId', PACKAGE_ID_PATTERN, 'must be a lowercase slug');
      if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
        throw new VerticalsError('INVALID_INPUT', 'version must be a positive integer');
      }
      try {
        return await store.findPackage(tenantId, id, version);
      } catch (error) {
        return mapStoreError(error);
      }
    },

    async listVerticalPackages(principal, tenantId, packageId) {
      await requireTenantAccess(principal, tenantId, 'read');
      let id: string | undefined;
      if (packageId !== undefined) {
        id = validateIdentifier(packageId, 'packageId', PACKAGE_ID_PATTERN, 'must be a lowercase slug');
      }
      try {
        return await store.listPackages(tenantId, id);
      } catch (error) {
        return mapStoreError(error);
      }
    },

    async latestVerticalPackage(principal, tenantId, packageId) {
      const versions = await this.listVerticalPackages(principal, tenantId, packageId);
      return versions.length === 0 ? null : versions[versions.length - 1] ?? null;
    },
  };
}

/**
 * Module manifest (registered in the composition root's module registry).
 * The manifest declares identity only; the business contract above is the
 * module's public surface.
 */
export default defineModule({
  name: 'verticals',
  version: '1.0.0',
  description: 'vertical package registration and domain configuration',
});
