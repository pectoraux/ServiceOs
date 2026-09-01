/**
 * ServiceOS module: /services (WORK-009 implementation).
 *
 * The service-definition and service-package lifecycle authority plus the
 * customer-configuration authority (architecture.md §6, §15, §17;
 * domain-model.md ServiceDefinition; vertical-model.md boundary).
 *
 * Authority (authority matrix / Work Order frozen scope):
 * - SERVICE-DEFINITION REGISTRATION AND THE SERVICE-PACKAGE LIFECYCLE are
 *   owned here: versioned, immutable-in-content service definitions bound
 *   to a pinned vertical-package version, the forward-only draft → active
 *   lifecycle (one active version per identity), and the durable
 *   customer-configuration records that specialize an ACTIVE service.
 *   A module other than /services exporting service-definition
 *   registration/configuration entry points is an architecture violation
 *   (checked structurally).
 * - BINDING, NOT REDEFINITION (Work Order invariant; architecture-lock
 *   #31): the workflow-definition binding maps the vertical's declared
 *   workflow steps onto the FROZEN canonical Service Work state machine
 *   consumed from /workflow's public interface. Every `from`/`to` pair
 *   must be a legal canonical transition — a binding that invents a
 *   state, redefines a transition or maps an illegal edge fails closed
 *   (WORKFLOW_STATE_UNKNOWN / TRANSITION_ILLEGAL). The horizontal
 *   lifecycle authority can never be weakened by vertical/service data.
 * - POLICY CONFIGURATION IS A SCHEMA, NEVER AN ENGINE (allowed scope
 *   "business policy configuration schema"): the service definition
 *   declares WHICH policy keys apply and WHICH parameters customers may
 *   configure with their declarative bounds. This module holds no rule
 *   content, no effects, no evaluation — /policies remains the sole
 *   policy authority, and a declaration carrying rule/effect keys fails
 *   closed (POLICY_RULES_FORBIDDEN).
 * - CUSTOMER CONFIGURATION SPECIALIZES, NEVER WEAKENS (AC-3;
 *   architecture-lock #33): the configurable surface is exactly policy
 *   parameter values (within the service's schema), SLA deadlines (only
 *   TIGHTER than the service default) and approval thresholds (only
 *   STRICTER than the service requirement). Weakening attempts fail
 *   closed (POLICY_PARAMETER_OUT_OF_BOUNDS / SLA_WEAKENED /
 *   APPROVAL_WEAKENED) and are NEVER persisted. Workflow bindings,
 *   outcome contracts, external/AI capability requirements and pricing
 *   are STRUCTURALLY non-configurable (absent from the configuration
 *   input shape — no data can weaken them).
 * - ZECK CAPABILITY REQUIREMENTS ARE DECLARATIONS ONLY (AC-4): the
 *   service's required AI capabilities reuse /verticals' shared
 *   declaration contract (names + quality/latency bounds; any
 *   model/provider/agent/prompt selection field fails closed
 *   AI_SELECTION_FORBIDDEN) and must be a SUBSET of the vertical
 *   package's declared requirements (CAPABILITY_NOT_DECLARED). This
 *   module never imports /zeck — no surface here can select a
 *   model/provider.
 * - OUTCOME VERIFICATION IS BUSINESS AUTHORITY: the outcome contract's
 *   verification mode is one of the ServiceOS business-verification
 *   concepts (deterministic / human approval / external authoritative
 *   record — architecture.md §12); declaring AI execution verification
 *   fails closed (AI_VERIFICATION_FORBIDDEN — that is Zeck's authority).
 * - AUTHORIZATION REMAINS SEPARATE: consumed from /organizations' public
 *   interface exactly like /work, /policies, /workflow.
 *
 * Vertical resolution is consumed through /verticals' public interface
 * (never a second package registry); tenancy through /organizations; the
 * frozen transition table through /workflow's public contract.
 */
import { defineModule } from '../../platform/module-registry/index.js';
import type { TransactionalExecutor } from '../../platform/persistence/index.js';
import type { Principal } from '../auth/index.js';
import type { AuthorizationDecision, AuthorizationDenyReason, TenancyAction } from '../organizations/index.js';
import { isLegalTransition, isWorkflowState, type WorkStatus } from '../workflow/index.js';
import { VerticalsError, type VerticalPackageRecord, type VerticalsModule, type ZeckCapabilityRequirement } from '../verticals/index.js';
import { validateZeckCapabilityRequirements } from '../verticals/index.js';
import { createSqlServicesStore } from './sql-store.js';
import {
  computeConfigurationContentHash,
  computeDefinitionContentHash,
  computeDefinitionRecordHash,
} from './content.js';
import { ServicesError, type ServiceErrorCode } from './errors.js';
import {
  ServicesStoreMissingError,
  ServicesStoreRuleError,
  type ActivateConfigurationInput,
  type ActivateDefinitionInput,
  type ApprovalAdjustment,
  type ApprovalRuleBinding,
  type EntityBinding,
  type MeteringRule,
  type OutcomeContract,
  type OutputFieldDefinition,
  type PolicyConfigurationDeclaration,
  type PolicyParameterSchema,
  type PolicyParameterValueSet,
  type PricingMetadata,
  type RegisterConfigurationInput,
  type RegisterDefinitionInput,
  type ServiceConfigurationRecord,
  type ServiceDefinitionRecord,
  type ServiceStatus,
  type ServiceStoreRule,
  type ServicesStore,
  type SlaAdjustment,
  type SlaDefault,
  type WorkDefinitionBinding,
  type WorkflowStepBinding,
} from './store.js';

// Store port (public contract): the authoritative SQL implementation runs
// through the persistence boundary; tests inject faithful in-memory
// implementations of the same port through this surface.
export { ServicesError, ServicesStoreMissingError, ServicesStoreRuleError, createSqlServicesStore };
export type { ServiceErrorCode, ServiceStoreRule };
export type {
  ActivateConfigurationInput,
  ActivateDefinitionInput,
  ApprovalAdjustment,
  ApprovalRuleBinding,
  EntityBinding,
  MeteringRule,
  OutcomeContract,
  OutputFieldDefinition,
  PolicyConfigurationDeclaration,
  PolicyParameterSchema,
  PolicyParameterValueSet,
  PricingMetadata,
  RegisterConfigurationInput,
  RegisterDefinitionInput,
  ServiceConfigurationRecord,
  ServiceDefinitionRecord,
  ServiceStatus,
  ServicesStore,
  SlaAdjustment,
  SlaDefault,
  WorkDefinitionBinding,
  WorkflowStepBinding,
};

// The module's deterministic content/record hashing discipline (the
// canonical serialization is part of the registration-convergence and
// tamper-detection contract).
export { canonicalJson, computeConfigurationContentHash, computeConfigurationRecordHash, computeDefinitionContentHash, computeDefinitionRecordHash, sha256Canonical } from './content.js';

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

/** The validated input of `registerServiceDefinition`. */
export interface RegisterServiceDefinitionInput {
  readonly tenantId: string;
  /** Stable logical service id (e.g. 'subcontractor-compliance'). */
  readonly serviceId: string;
  /** Monotonic contiguous version, 1 for the first registration. */
  readonly version: number;
  readonly name: string;
  readonly description?: string;
  /** The pinned vertical package this service binds. */
  readonly vertical: { readonly packageId: string; readonly version: number };
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
  readonly idempotencyKey?: string;
}

/** The validated input of `registerCustomerConfiguration`. */
export interface RegisterCustomerConfigurationInput {
  readonly tenantId: string;
  /** The ACTIVE service being configured (the configuration pins its version). */
  readonly serviceId: string;
  readonly policyParameters: readonly PolicyParameterValueSet[];
  readonly slaAdjustments: readonly SlaAdjustment[];
  readonly approvalAdjustments: readonly ApprovalAdjustment[];
  readonly idempotencyKey?: string;
}

export interface ServicesModuleOptions {
  /** Production wiring: transaction-capable persistence executor. */
  executor?: TransactionalExecutor;
  /** Test seam: inject a faithful in-memory store instead (tests only). */
  store?: ServicesStore;
  /** The single authorization chain, injected by the composition root. */
  tenancy: TenancyAuthorization;
  /** The vertical-package registration authority (consumed public contract). */
  verticals: VerticalsModule;
  /** Clock injection for deterministic proofs. */
  now?: () => Date;
}

export interface ServicesModule {
  /**
   * Register one service-definition version (AC-1). The input is
   * validated fail-closed against: its own shape; the pinned vertical
   * package (every referenced entity/work type/step/policy key/parameter/
   * approval rule/evidence requirement/capability class/AI capability
   * requirement must be DECLARED by the package); the frozen canonical
   * workflow machine (every binding edge must be a legal transition); and
   * the specialization floors (service SLA deadlines may only tighten the
   * vertical's, service approval thresholds may only strengthen the
   * vertical's). Duplicate registration of the same version with the same
   * content converges; different content fails closed
   * (VERSION_CONTENT_CONFLICT); version gaps/skips fail closed
   * (VERSION_NOT_SEQUENTIAL). Starts as `draft`.
   */
  registerServiceDefinition(
    principal: Principal,
    input: RegisterServiceDefinitionInput,
  ): Promise<{ definition: ServiceDefinitionRecord; converged: boolean }>;
  /** Read one definition version (hash-verified). */
  getServiceDefinition(principal: Principal, tenantId: string, serviceId: string, version: number): Promise<ServiceDefinitionRecord>;
  /** List definition versions (optionally one service id and status), oldest first. */
  listServiceDefinitions(principal: Principal, tenantId: string, serviceId?: string, status?: ServiceStatus): Promise<ServiceDefinitionRecord[]>;
  /**
   * Activate a draft definition version (forward-only; the prior active
   * version of the same identity is retired atomically first — one active
   * per (tenant, service id)). Activating the already-active version
   * converges; retired versions are rejected.
   */
  activateServiceDefinition(
    principal: Principal,
    tenantId: string,
    serviceId: string,
    version: number,
  ): Promise<{ definition: ServiceDefinitionRecord; converged: boolean }>;
  /** The currently active definition version of one service, or null. */
  resolveActiveServiceDefinition(principal: Principal, tenantId: string, serviceId: string): Promise<ServiceDefinitionRecord | null>;
  /**
   * Register one customer configuration (AC-3) against the ACTIVE service
   * definition. Every adjustment is validated against the service's
   * declared contract BEFORE persistence: policy parameter values within
   * the schema (out-of-bounds rejected), SLA deadlines only tighter
   * (looser rejected SLA_WEAKENED), approval thresholds only stricter
   * (weaker rejected APPROVAL_WEAKENED). Weakened content is never
   * persisted. The configuration pins the service version it was
   * validated against; same logical registration (idempotency key)
   * converges. Starts as `draft`.
   */
  registerCustomerConfiguration(
    principal: Principal,
    input: RegisterCustomerConfigurationInput,
  ): Promise<{ configuration: ServiceConfigurationRecord; converged: boolean }>;
  /** Read one configuration (hash-verified). */
  getCustomerConfiguration(principal: Principal, tenantId: string, configurationId: string): Promise<ServiceConfigurationRecord>;
  /** List configurations (optionally one service id), configuration version ascending. */
  listCustomerConfigurations(principal: Principal, tenantId: string, serviceId?: string): Promise<ServiceConfigurationRecord[]>;
  /** Activate a draft configuration (same forward-only, one-active lifecycle). */
  activateCustomerConfiguration(
    principal: Principal,
    tenantId: string,
    serviceId: string,
    configurationVersion: number,
  ): Promise<{ configuration: ServiceConfigurationRecord; converged: boolean }>;
  /** The currently active configuration of one service, or null. */
  resolveActiveCustomerConfiguration(principal: Principal, tenantId: string, serviceId: string): Promise<ServiceConfigurationRecord | null>;
}

// ---------------------------------------------------------------------------
// Validation (fail closed)
// ---------------------------------------------------------------------------

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SERVICE_ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
const NAME_PATTERN = /^[^\n]{1,200}$/;
const IDENTIFIER_PATTERN = /^[a-zA-Z][a-zA-Z0-9_.-]{0,199}$/;
const CAPABILITY_CLASS_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;
const DECIMAL_PATTERN = /^\d{1,12}(\.\d{1,6})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

const MAX_ENTITIES = 200;
const MAX_WORK_DEFINITIONS = 200;
const MAX_WORKFLOW_BINDINGS = 200;
const MAX_POLICY_DECLARATIONS = 100;
const MAX_PARAMETERS_PER_POLICY = 50;
const MAX_ENUM_VALUES = 50;
const MAX_APPROVAL_RULES = 200;
const MAX_SLA_DEFAULTS = 200;
const MAX_OUTPUT_FIELDS = 100;
const MAX_EVIDENCE_REQUIREMENTS = 200;
const MAX_EXTERNAL_CAPABILITIES = 64;
const MAX_METERING_RULES = 100;
const MAX_TEXT_LENGTH = 500;
const MAX_PARAMETER_VALUES = 50;

function validateUuid(value: string, what: string): void {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new ServicesError('INVALID_INPUT', `${what} must be a UUID`);
  }
}

function validateIdentifier(value: unknown, what: string, pattern: RegExp, message: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new ServicesError('INVALID_INPUT', `${what} ${message}`);
  }
  return value;
}

function validateOptionalText(value: unknown, what: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > MAX_TEXT_LENGTH) {
    throw new ServicesError('INVALID_INPUT', `${what} must be a string of at most ${MAX_TEXT_LENGTH} characters`);
  }
  return value;
}

function validateOptionalIdempotencyKey(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.trim() === '' || value.length > 200) {
    throw new ServicesError('INVALID_INPUT', 'idempotencyKey must be a non-empty string of at most 200 characters');
  }
  return value.trim();
}

function isPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function validateFieldType(type: unknown, what: string): 'string' | 'number' | 'boolean' | 'date' {
  if (type !== 'string' && type !== 'number' && type !== 'boolean' && type !== 'date') {
    throw new ServicesError('INVALID_INPUT', `${what} type must be "string", "number", "boolean" or "date"`);
  }
  return type;
}

function validateEntityBindings(entities: readonly EntityBinding[]): readonly EntityBinding[] {
  if (!Array.isArray(entities)) {
    throw new ServicesError('INVALID_INPUT', 'entities must be an array');
  }
  if (entities.length > MAX_ENTITIES) {
    throw new ServicesError('INVALID_INPUT', `entities must contain at most ${MAX_ENTITIES} bindings`);
  }
  const seen = new Set<string>();
  const validated: EntityBinding[] = [];
  for (const binding of entities) {
    if (typeof binding !== 'object' || binding === null) {
      throw new ServicesError('INVALID_INPUT', 'each entity binding must be an object');
    }
    const entity = validateIdentifier(binding.entity, 'entity binding name', IDENTIFIER_PATTERN, 'must match the identifier pattern');
    if (seen.has(entity)) {
      throw new ServicesError('INVALID_INPUT', `entity "${entity}" is bound twice; entity bindings must be unique`);
    }
    seen.add(entity);
    if (typeof binding.required !== 'boolean') {
      throw new ServicesError('INVALID_INPUT', `entity binding "${entity}" required must be a boolean`);
    }
    validated.push({ entity, required: binding.required });
  }
  return validated;
}

function validateWorkDefinitionBindings(bindings: readonly WorkDefinitionBinding[]): readonly WorkDefinitionBinding[] {
  if (!Array.isArray(bindings)) {
    throw new ServicesError('INVALID_INPUT', 'workDefinitions must be an array');
  }
  if (bindings.length > MAX_WORK_DEFINITIONS) {
    throw new ServicesError('INVALID_INPUT', `workDefinitions must contain at most ${MAX_WORK_DEFINITIONS} bindings`);
  }
  const seen = new Set<string>();
  const validated: WorkDefinitionBinding[] = [];
  for (const binding of bindings) {
    if (typeof binding !== 'object' || binding === null) {
      throw new ServicesError('INVALID_INPUT', 'each work definition binding must be an object');
    }
    const workType = validateIdentifier(binding.workType, 'work definition workType', IDENTIFIER_PATTERN, 'must match the identifier pattern');
    if (seen.has(workType)) {
      throw new ServicesError('INVALID_INPUT', `work type "${workType}" is bound twice; work definitions must be unique`);
    }
    seen.add(workType);
    validated.push({
      workType,
      ...(validateOptionalText(binding.description, `work definition "${workType}" description`) !== null
        ? { description: binding.description as string }
        : {}),
    });
  }
  return validated;
}

/**
 * Validate the workflow-definition binding shape. The CANONICAL machine
 * check (frozen /workflow code) runs afterwards in
 * `validateWorkflowBindingAgainstMachine`.
 */
function validateWorkflowBindingShape(bindings: readonly WorkflowStepBinding[]): readonly WorkflowStepBinding[] {
  if (!Array.isArray(bindings)) {
    throw new ServicesError('INVALID_INPUT', 'workflowBinding must be an array');
  }
  if (bindings.length === 0) {
    throw new ServicesError('INVALID_INPUT', 'workflowBinding must declare at least one step binding');
  }
  if (bindings.length > MAX_WORKFLOW_BINDINGS) {
    throw new ServicesError('INVALID_INPUT', `workflowBinding must contain at most ${MAX_WORKFLOW_BINDINGS} bindings`);
  }
  const seen = new Set<string>();
  const validated: WorkflowStepBinding[] = [];
  for (const binding of bindings) {
    if (typeof binding !== 'object' || binding === null) {
      throw new ServicesError('INVALID_INPUT', 'each workflow step binding must be an object');
    }
    const step = validateIdentifier(binding.step, 'workflow binding step', IDENTIFIER_PATTERN, 'must match the identifier pattern');
    if (seen.has(step)) {
      throw new ServicesError('INVALID_INPUT', `workflow step "${step}" is bound twice; step bindings must be unique`);
    }
    seen.add(step);
    const from = validateIdentifier(binding.from, 'workflow binding from state', /^[a-z_]+$/, 'must be a lowercase workflow state');
    const to = validateIdentifier(binding.to, 'workflow binding to state', /^[a-z_]+$/, 'must be a lowercase workflow state');
    validated.push({
      step,
      from,
      to,
      ...(validateOptionalText(binding.description, `workflow binding "${step}" description`) !== null
        ? { description: binding.description as string }
        : {}),
    });
  }
  return validated;
}

/**
 * THE horizontal-authority boundary (architecture-lock #31): every
 * binding edge must be a legal transition of the FROZEN canonical
 * Service Work state machine (consumed from /workflow's public
 * interface). A binding that invents a state, remaps a terminal edge or
 * introduces an illegal transition fails closed — vertical/service data
 * can never weaken the horizontal lifecycle authority.
 */
function validateWorkflowBindingAgainstMachine(bindings: readonly WorkflowStepBinding[]): void {
  for (const binding of bindings) {
    if (!isWorkflowState(binding.from) || !isWorkflowState(binding.to)) {
      throw new ServicesError(
        'WORKFLOW_STATE_UNKNOWN',
        `workflow binding "${binding.step}" uses a non-canonical state (${binding.from} -> ${binding.to}); the Service Work state machine is the frozen /workflow authority and cannot be redefined by service data`,
      );
    }
    if (!isLegalTransition(binding.from as WorkStatus, binding.to as WorkStatus)) {
      throw new ServicesError(
        'TRANSITION_ILLEGAL',
        `workflow binding "${binding.step}" declares the illegal transition ${binding.from} -> ${binding.to}; legal transitions are the frozen /workflow authority and cannot be weakened by service data`,
      );
    }
  }
}

function validatePolicyConfiguration(declarations: readonly PolicyConfigurationDeclaration[]): readonly PolicyConfigurationDeclaration[] {
  if (!Array.isArray(declarations)) {
    throw new ServicesError('INVALID_INPUT', 'policyConfiguration must be an array');
  }
  if (declarations.length > MAX_POLICY_DECLARATIONS) {
    throw new ServicesError('INVALID_INPUT', `policyConfiguration must contain at most ${MAX_POLICY_DECLARATIONS} declarations`);
  }
  const seen = new Set<string>();
  const validated: PolicyConfigurationDeclaration[] = [];
  for (const declaration of declarations) {
    if (typeof declaration !== 'object' || declaration === null) {
      throw new ServicesError('INVALID_INPUT', 'each policy configuration declaration must be an object');
    }
    // SCHEMA ONLY (allowed scope): a declaration carrying rule/effect
    // content is a duplicate policy engine — /policies is the sole
    // policy authority and this surface cannot express rules.
    for (const key of Object.keys(declaration)) {
      if (key === 'rules' || key === 'defaultEffect' || key === 'effect' || key === 'conditions') {
        throw new ServicesError(
          'POLICY_RULES_FORBIDDEN',
          `policy configuration declaration carries forbidden key "${key}"; the service definition declares a configuration SCHEMA only and policy rules/effects belong exclusively to /policies`,
        );
      }
    }
    const policyKey = validateIdentifier(declaration.policyKey, 'policyKey', IDENTIFIER_PATTERN, 'must match the identifier pattern');
    if (seen.has(policyKey)) {
      throw new ServicesError('INVALID_INPUT', `policy configuration for "${policyKey}" is declared twice`);
    }
    seen.add(policyKey);
    if (!Array.isArray(declaration.parameters) || declaration.parameters.length === 0) {
      throw new ServicesError('INVALID_INPUT', `policy configuration for "${policyKey}" must declare at least one parameter`);
    }
    if (declaration.parameters.length > MAX_PARAMETERS_PER_POLICY) {
      throw new ServicesError('INVALID_INPUT', `policy configuration for "${policyKey}" must declare at most ${MAX_PARAMETERS_PER_POLICY} parameters`);
    }
    const parameterNames = new Set<string>();
    const parameters: PolicyParameterSchema[] = [];
    for (const parameter of declaration.parameters) {
      if (typeof parameter !== 'object' || parameter === null) {
        throw new ServicesError('INVALID_INPUT', `policy configuration parameter of "${policyKey}" must be an object`);
      }
      for (const key of Object.keys(parameter)) {
        if (key === 'rules' || key === 'effect' || key === 'defaultEffect') {
          throw new ServicesError(
            'POLICY_RULES_FORBIDDEN',
            `policy configuration parameter carries forbidden key "${key}"; parameters are schema declarations only`,
          );
        }
      }
      const name = validateIdentifier(parameter.name, 'policy parameter name', IDENTIFIER_PATTERN, 'must match the identifier pattern');
      if (parameterNames.has(name)) {
        throw new ServicesError('INVALID_INPUT', `policy configuration parameter "${name}" of "${policyKey}" is declared twice`);
      }
      parameterNames.add(name);
      const type = parameter.type;
      if (type !== 'number' && type !== 'string' && type !== 'boolean' && type !== 'enum') {
        throw new ServicesError('INVALID_INPUT', `policy configuration parameter "${name}" of "${policyKey}" type must be "number", "string", "boolean" or "enum"`);
      }
      if (typeof parameter.required !== 'boolean') {
        throw new ServicesError('INVALID_INPUT', `policy configuration parameter "${name}" of "${policyKey}" required must be a boolean`);
      }
      let min: number | undefined;
      let max: number | undefined;
      if (parameter.min !== undefined) {
        if (type !== 'number' || typeof parameter.min !== 'number' || !Number.isFinite(parameter.min)) {
          throw new ServicesError('INVALID_INPUT', `policy configuration parameter "${name}" of "${policyKey}" min requires a numeric schema and a finite number`);
        }
        min = parameter.min;
      }
      if (parameter.max !== undefined) {
        if (type !== 'number' || typeof parameter.max !== 'number' || !Number.isFinite(parameter.max)) {
          throw new ServicesError('INVALID_INPUT', `policy configuration parameter "${name}" of "${policyKey}" max requires a numeric schema and a finite number`);
        }
        max = parameter.max;
      }
      if (min !== undefined && max !== undefined && min > max) {
        throw new ServicesError('INVALID_INPUT', `policy configuration parameter "${name}" of "${policyKey}" has min > max`);
      }
      let values: readonly string[] | undefined;
      if (parameter.values !== undefined) {
        if (type !== 'enum' || !Array.isArray(parameter.values) || parameter.values.length === 0) {
          throw new ServicesError('INVALID_INPUT', `policy configuration parameter "${name}" of "${policyKey}" values require an enum schema and a non-empty array`);
        }
        if (parameter.values.length > MAX_ENUM_VALUES) {
          throw new ServicesError('INVALID_INPUT', `policy configuration parameter "${name}" of "${policyKey}" must declare at most ${MAX_ENUM_VALUES} values`);
        }
        const valueSet = new Set<string>();
        for (const value of parameter.values) {
          if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TEXT_LENGTH) {
            throw new ServicesError('INVALID_INPUT', `policy configuration parameter "${name}" of "${policyKey}" enum values must be non-empty strings`);
          }
          if (valueSet.has(value)) {
            throw new ServicesError('INVALID_INPUT', `policy configuration parameter "${name}" of "${policyKey}" enum value "${value}" is declared twice`);
          }
          valueSet.add(value);
        }
        values = parameter.values;
      } else if (type === 'enum') {
        throw new ServicesError('INVALID_INPUT', `policy configuration parameter "${name}" of "${policyKey}" requires its values for an enum schema`);
      }
      if (parameter.defaultValue !== undefined && !isPrimitive(parameter.defaultValue)) {
        throw new ServicesError('INVALID_INPUT', `policy configuration parameter "${name}" of "${policyKey}" defaultValue must be primitive`);
      }
      if (parameter.defaultValue !== undefined) {
        // Declaration-time validation: a malformed default is an invalid
        // DECLARATION (not a customer out-of-bounds value).
        checkParameterAgainstSchema(policyKey, name, type, min, max, values, parameter.defaultValue, 'INVALID_INPUT');
      }
      parameters.push({
        name,
        type,
        required: parameter.required,
        ...(min !== undefined ? { min } : {}),
        ...(max !== undefined ? { max } : {}),
        ...(values !== undefined ? { values } : {}),
        ...(parameter.defaultValue !== undefined ? { defaultValue: parameter.defaultValue } : {}),
      });
    }
    validated.push({ policyKey, parameters });
  }
  return validated;
}

/** Check one primitive value against one parameter schema (inclusive bounds). */
function checkParameterAgainstSchema(
  policyKey: string,
  parameterName: string,
  type: PolicyParameterSchema['type'],
  min: number | undefined,
  max: number | undefined,
  values: readonly string[] | undefined,
  value: string | number | boolean,
  error: ServiceErrorCode = 'POLICY_PARAMETER_OUT_OF_BOUNDS',
): void {
  switch (type) {
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new ServicesError(error, `policy parameter "${parameterName}" of "${policyKey}" requires a number value`);
      }
      if (min !== undefined && value < min) {
        throw new ServicesError(error, `policy parameter "${parameterName}" of "${policyKey}" value ${value} is below the declared minimum ${min}`);
      }
      if (max !== undefined && value > max) {
        throw new ServicesError(error, `policy parameter "${parameterName}" of "${policyKey}" value ${value} is above the declared maximum ${max}`);
      }
      return;
    }
    case 'string': {
      if (typeof value !== 'string') {
        throw new ServicesError(error, `policy parameter "${parameterName}" of "${policyKey}" requires a string value`);
      }
      if (value.length > MAX_TEXT_LENGTH) {
        throw new ServicesError(error, `policy parameter "${parameterName}" of "${policyKey}" string value exceeds ${MAX_TEXT_LENGTH} characters`);
      }
      return;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') {
        throw new ServicesError(error, `policy parameter "${parameterName}" of "${policyKey}" requires a boolean value`);
      }
      return;
    }
    case 'enum': {
      if (typeof value !== 'string' || values === undefined || !values.includes(value)) {
        throw new ServicesError(error, `policy parameter "${parameterName}" of "${policyKey}" value is not one of the declared enum values`);
      }
      return;
    }
  }
}

function validateApprovalRuleBindings(rules: readonly ApprovalRuleBinding[]): readonly ApprovalRuleBinding[] {
  if (!Array.isArray(rules)) {
    throw new ServicesError('INVALID_INPUT', 'approvalRules must be an array');
  }
  if (rules.length > MAX_APPROVAL_RULES) {
    throw new ServicesError('INVALID_INPUT', `approvalRules must contain at most ${MAX_APPROVAL_RULES} bindings`);
  }
  const seen = new Set<string>();
  const validated: ApprovalRuleBinding[] = [];
  for (const rule of rules) {
    if (typeof rule !== 'object' || rule === null) {
      throw new ServicesError('INVALID_INPUT', 'each approval rule binding must be an object');
    }
    const id = validateIdentifier(rule.id, 'approval rule id', IDENTIFIER_PATTERN, 'must match the identifier pattern');
    if (seen.has(id)) {
      throw new ServicesError('INVALID_INPUT', `approval rule "${id}" is bound twice; ids must be unique`);
    }
    seen.add(id);
    if (typeof rule.threshold !== 'number' || !Number.isInteger(rule.threshold) || rule.threshold < 1) {
      throw new ServicesError('INVALID_INPUT', `approval rule "${id}" threshold must be an integer >= 1`);
    }
    validated.push({ id, threshold: rule.threshold });
  }
  return validated;
}

function validateSlaDefaults(defaults: readonly SlaDefault[]): readonly SlaDefault[] {
  if (!Array.isArray(defaults)) {
    throw new ServicesError('INVALID_INPUT', 'slaDefaults must be an array');
  }
  if (defaults.length > MAX_SLA_DEFAULTS) {
    throw new ServicesError('INVALID_INPUT', `slaDefaults must contain at most ${MAX_SLA_DEFAULTS} entries`);
  }
  const seen = new Set<string>();
  const validated: SlaDefault[] = [];
  for (const entry of defaults) {
    if (typeof entry !== 'object' || entry === null) {
      throw new ServicesError('INVALID_INPUT', 'each SLA default must be an object');
    }
    const workType = validateIdentifier(entry.workType, 'SLA default workType', IDENTIFIER_PATTERN, 'must match the identifier pattern');
    if (seen.has(workType)) {
      throw new ServicesError('INVALID_INPUT', `SLA default for work type "${workType}" is declared twice`);
    }
    seen.add(workType);
    if (typeof entry.deadlineHours !== 'number' || !Number.isInteger(entry.deadlineHours) || entry.deadlineHours <= 0) {
      throw new ServicesError('INVALID_INPUT', `SLA default for work type "${workType}" deadlineHours must be a positive integer`);
    }
    validated.push({ workType, deadlineHours: entry.deadlineHours });
  }
  return validated;
}

function validateOutcomeContract(contract: OutcomeContract): OutcomeContract {
  if (typeof contract !== 'object' || contract === null) {
    throw new ServicesError('INVALID_INPUT', 'outcomeContract must be an object');
  }
  for (const key of Object.keys(contract)) {
    if (key === 'aiVerification' || key === 'model' || key === 'provider') {
      throw new ServicesError(
        'AI_VERIFICATION_FORBIDDEN',
        `outcome contract carries forbidden key "${key}"; outcome verification is ServiceOS business authority and AI execution verification is Zeck's`,
      );
    }
  }
  const outcomeId = validateIdentifier(contract.outcomeId, 'outcome id', IDENTIFIER_PATTERN, 'must match the identifier pattern');
  const verification = contract.verification;
  if (verification !== 'deterministic' && verification !== 'human_approval' && verification !== 'external_record') {
    throw new ServicesError(
      'AI_VERIFICATION_FORBIDDEN',
      `outcome contract verification mode "${String(verification)}" is not a ServiceOS business-verification concept; AI execution verification is Zeck's authority`,
    );
  }
  if (!Array.isArray(contract.outputSchema) || contract.outputSchema.length === 0) {
    throw new ServicesError('INVALID_INPUT', 'outcome contract must declare at least one output field');
  }
  if (contract.outputSchema.length > MAX_OUTPUT_FIELDS) {
    throw new ServicesError('INVALID_INPUT', `outcome contract must declare at most ${MAX_OUTPUT_FIELDS} output fields`);
  }
  const fieldNames = new Set<string>();
  const outputSchema: OutputFieldDefinition[] = [];
  for (const field of contract.outputSchema) {
    if (typeof field !== 'object' || field === null) {
      throw new ServicesError('INVALID_INPUT', 'each output field must be an object');
    }
    const name = validateIdentifier(field.name, 'output field name', IDENTIFIER_PATTERN, 'must match the identifier pattern');
    if (fieldNames.has(name)) {
      throw new ServicesError('INVALID_INPUT', `output field "${name}" is declared twice`);
    }
    fieldNames.add(name);
    if (typeof field.required !== 'boolean') {
      throw new ServicesError('INVALID_INPUT', `output field "${name}" required must be a boolean`);
    }
    outputSchema.push({ name, type: validateFieldType(field.type, `output field "${name}"`), required: field.required });
  }
  if (!Array.isArray(contract.evidenceRequirements)) {
    throw new ServicesError('INVALID_INPUT', 'outcome contract evidenceRequirements must be an array');
  }
  if (contract.evidenceRequirements.length > MAX_EVIDENCE_REQUIREMENTS) {
    throw new ServicesError('INVALID_INPUT', `outcome contract must reference at most ${MAX_EVIDENCE_REQUIREMENTS} evidence requirements`);
  }
  const evidence = contract.evidenceRequirements.map((name) =>
    validateIdentifier(name, 'evidence requirement name', IDENTIFIER_PATTERN, 'must match the identifier pattern'),
  );
  return {
    outcomeId,
    ...(validateOptionalText(contract.description, 'outcome contract description') !== null
      ? { description: contract.description as string }
      : {}),
    outputSchema,
    evidenceRequirements: evidence,
    verification,
  };
}

function validateExternalCapabilities(capabilities: readonly string[]): readonly string[] {
  if (!Array.isArray(capabilities)) {
    throw new ServicesError('INVALID_INPUT', 'requiredExternalCapabilities must be an array');
  }
  if (capabilities.length > MAX_EXTERNAL_CAPABILITIES) {
    throw new ServicesError('INVALID_INPUT', `requiredExternalCapabilities must contain at most ${MAX_EXTERNAL_CAPABILITIES} entries`);
  }
  const seen = new Set<string>();
  const validated: string[] = [];
  for (const capability of capabilities) {
    const name = validateIdentifier(capability, 'external capability', CAPABILITY_CLASS_PATTERN, 'must be a lowercase snake_case capability class name');
    if (seen.has(name)) {
      throw new ServicesError('INVALID_INPUT', `external capability "${name}" is declared twice`);
    }
    seen.add(name);
    validated.push(name);
  }
  return validated;
}

function validatePricing(pricing: PricingMetadata): PricingMetadata {
  if (typeof pricing !== 'object' || pricing === null) {
    throw new ServicesError('INVALID_INPUT', 'pricing must be an object');
  }
  const model = pricing.model;
  if (model !== 'subscription' && model !== 'per_work_item' && model !== 'per_outcome' && model !== 'usage_band' && model !== 'hybrid') {
    throw new ServicesError('INVALID_INPUT', 'pricing model must be a known pricing model');
  }
  if (pricing.amount !== undefined && (typeof pricing.amount !== 'string' || !DECIMAL_PATTERN.test(pricing.amount))) {
    throw new ServicesError('INVALID_INPUT', 'pricing amount must be a decimal string (e.g. "199.00")');
  }
  if (pricing.currency !== undefined && (typeof pricing.currency !== 'string' || !CURRENCY_PATTERN.test(pricing.currency))) {
    throw new ServicesError('INVALID_INPUT', 'pricing currency must be a 3-letter ISO code');
  }
  if (!Array.isArray(pricing.metering)) {
    throw new ServicesError('INVALID_INPUT', 'pricing metering must be an array');
  }
  if (pricing.metering.length > MAX_METERING_RULES) {
    throw new ServicesError('INVALID_INPUT', `pricing must declare at most ${MAX_METERING_RULES} metering rules`);
  }
  const seen = new Set<string>();
  const metering: MeteringRule[] = [];
  for (const rule of pricing.metering) {
    if (typeof rule !== 'object' || rule === null) {
      throw new ServicesError('INVALID_INPUT', 'each metering rule must be an object');
    }
    const metric = validateIdentifier(rule.metric, 'metering metric', IDENTIFIER_PATTERN, 'must match the identifier pattern');
    if (seen.has(metric)) {
      throw new ServicesError('INVALID_INPUT', `metering metric "${metric}" is declared twice`);
    }
    seen.add(metric);
    const unit = validateIdentifier(rule.unit, `metering unit of "${metric}"`, IDENTIFIER_PATTERN, 'must match the identifier pattern');
    if (rule.unitPrice !== undefined && (typeof rule.unitPrice !== 'string' || !DECIMAL_PATTERN.test(rule.unitPrice))) {
      throw new ServicesError('INVALID_INPUT', `metering rule "${metric}" unitPrice must be a decimal string`);
    }
    metering.push({
      metric,
      unit,
      ...(rule.unitPrice !== undefined ? { unitPrice: rule.unitPrice } : {}),
    });
  }
  return {
    model,
    ...(pricing.amount !== undefined ? { amount: pricing.amount } : {}),
    ...(pricing.currency !== undefined ? { currency: pricing.currency } : {}),
    metering,
  };
}

/**
 * Validate the service's Zeck capability REQUIREMENTS through the shared
 * /verticals declaration contract, re-mapping its typed errors onto this
 * module's public error surface (the shared contract validates the shape;
 * the failing surface stays the one the caller invoked).
 */
function validateServiceAiCapabilities(raw: readonly unknown[]): ReturnType<typeof validateZeckCapabilityRequirements> {
  try {
    return validateZeckCapabilityRequirements(raw);
  } catch (error) {
    if (error instanceof VerticalsError) {
      if (error.code === 'AI_SELECTION_FORBIDDEN') {
        throw new ServicesError('AI_SELECTION_FORBIDDEN', error.message);
      }
      throw new ServicesError('INVALID_INPUT', error.message);
    }
    throw error;
  }
}

/** Map an authorization denial reason to the services error surface. */
function denyToError(reason: AuthorizationDenyReason | undefined, tenantId: string): ServicesError {
  switch (reason) {
    case 'TENANT_NOT_FOUND':
      return new ServicesError('TENANT_NOT_FOUND', `service tenant ${tenantId} does not exist`);
    case 'TENANT_SUSPENDED':
      return new ServicesError('TENANT_SUSPENDED', `service tenant ${tenantId} is suspended`);
    case 'ORGANIZATION_NOT_FOUND':
      return new ServicesError('TENANT_NOT_FOUND', `the tenant's organization no longer exists`);
    case 'ORGANIZATION_SUSPENDED':
      return new ServicesError('ORGANIZATION_SUSPENDED', 'the owning organization is suspended');
    case 'MEMBERSHIP_FORBIDDEN':
      return new ServicesError('TENANT_FORBIDDEN', 'the principal has no active membership granting this tenant');
    case 'ROLE_FORBIDDEN':
      return new ServicesError('ROLE_FORBIDDEN', 'the principal role does not grant the required capability');
    default:
      return new ServicesError('TENANT_FORBIDDEN', 'authorization denied');
  }
}

/** Map store errors to the public services error surface. */
function mapStoreError(error: unknown): never {
  if (error instanceof ServicesStoreRuleError) {
    switch (error.rule) {
      case 'version-content-conflict':
        throw new ServicesError('VERSION_CONTENT_CONFLICT', error.message);
      case 'version-not-sequential':
        throw new ServicesError('VERSION_NOT_SEQUENTIAL', error.message);
      case 'version-retired':
        throw new ServicesError('VERSION_RETIRED', error.message);
      case 'service-record-tampered':
        throw new ServicesError('SERVICE_RECORD_TAMPERED', error.message);
      case 'configuration-record-tampered':
        throw new ServicesError('CONFIGURATION_RECORD_TAMPERED', error.message);
      case 'idempotency-input-conflict':
        throw new ServicesError('IDEMPOTENCY_INPUT_CONFLICT', error.message);
    }
  }
  if (error instanceof ServicesStoreMissingError) {
    if (error.what === 'configuration') {
      throw new ServicesError('CONFIGURATION_NOT_FOUND', error.message);
    }
    throw new ServicesError('SERVICE_NOT_FOUND', error.message);
  }
  throw error;
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export function createServicesModule(options: ServicesModuleOptions): ServicesModule {
  if ((options.executor === undefined) === (options.store === undefined)) {
    throw new ServicesError('INVALID_INPUT', 'createServicesModule requires exactly one of executor or store');
  }
  const store = options.store ?? createSqlServicesStore(options.executor as TransactionalExecutor);
  const tenancy = options.tenancy;
  const verticals = options.verticals;
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
    async registerServiceDefinition(principal, input) {
      await requireTenantAccess(principal, input.tenantId, 'write');
      const serviceId = validateIdentifier(
        input.serviceId,
        'serviceId',
        SERVICE_ID_PATTERN,
        'must be a lowercase slug of at most 64 characters (letters, digits, dashes)',
      );
      if (typeof input.version !== 'number' || !Number.isInteger(input.version) || input.version < 1) {
        throw new ServicesError('INVALID_INPUT', 'version must be a positive integer');
      }
      const name = validateIdentifier(input.name, 'name', NAME_PATTERN, 'must be a single-line string of at most 200 characters');
      const description = validateOptionalText(input.description, 'description');
      if (typeof input.vertical !== 'object' || input.vertical === null) {
        throw new ServicesError('INVALID_INPUT', 'vertical must be an object with packageId and version');
      }
      const packageId = validateIdentifier(
        input.vertical.packageId,
        'vertical packageId',
        /^[a-z][a-z0-9-]{1,63}$/,
        'must be a lowercase slug of at most 64 characters',
      );
      if (typeof input.vertical.version !== 'number' || !Number.isInteger(input.vertical.version) || input.vertical.version < 1) {
        throw new ServicesError('INVALID_INPUT', 'vertical version must be a positive integer');
      }
      const entities = validateEntityBindings(input.entities);
      const workDefinitions = validateWorkDefinitionBindings(input.workDefinitions);
      const workflowBinding = validateWorkflowBindingShape(input.workflowBinding);
      const policyConfiguration = validatePolicyConfiguration(input.policyConfiguration);
      const approvalRules = validateApprovalRuleBindings(input.approvalRules);
      const slaDefaults = validateSlaDefaults(input.slaDefaults);
      const outcomeContract = validateOutcomeContract(input.outcomeContract);
      const requiredExternalCapabilities = validateExternalCapabilities(input.requiredExternalCapabilities);
      // AC-4: capability REQUIREMENTS only — the shared /verticals
      // declaration contract rejects any selection field. The shared
      // contract's typed error is re-mapped onto THIS module's public
      // error surface (a service registration failure surfaces as a
      // ServicesError, never the vertical module's error type).
      const requiredAiCapabilities = validateServiceAiCapabilities(input.requiredAiCapabilities);
      const pricing = validatePricing(input.pricing);
      const idempotencyKey = validateOptionalIdempotencyKey(input.idempotencyKey);

      // THE FROZEN CANONICAL MACHINE CHECK: consume /workflow's public
      // contract; a binding can never add states/transitions.
      validateWorkflowBindingAgainstMachine(workflowBinding);

      // Vertical binding resolution through /verticals' public interface
      // (never a second package registry).
      const pkg = await verticals.getVerticalPackage(principal, input.tenantId, packageId, input.vertical.version);
      if (pkg === null) {
        throw new ServicesError(
          'VERTICAL_PACKAGE_NOT_FOUND',
          `vertical package ${packageId} version ${input.vertical.version} is not registered in this tenant`,
        );
      }

      // Cross-validate every reference against the pinned package: a
      // service binds DECLARED semantics — it cannot invent domain
      // vocabulary the vertical does not carry.
      const packageEntityNames = new Set(pkg.entities.map((entity) => entity.name));
      for (const binding of entities) {
        if (!packageEntityNames.has(binding.entity)) {
          throw new ServicesError('ENTITY_UNKNOWN', `entity "${binding.entity}" is not declared by vertical package ${packageId} v${pkg.version}`);
        }
      }
      const packageWorkTypes = new Map(pkg.workTypes.map((workType) => [workType.name, workType]));
      for (const binding of workDefinitions) {
        if (!packageWorkTypes.has(binding.workType)) {
          throw new ServicesError('WORK_TYPE_UNKNOWN', `work type "${binding.workType}" is not declared by vertical package ${packageId} v${pkg.version}`);
        }
      }
      const packageStepNames = new Set(pkg.workflowSteps.map((step) => step.step));
      for (const binding of workflowBinding) {
        if (!packageStepNames.has(binding.step)) {
          throw new ServicesError('WORKFLOW_STEP_UNKNOWN', `workflow step "${binding.step}" is not declared by vertical package ${packageId} v${pkg.version}`);
        }
      }
      const packagePolicyDefaults = new Map(pkg.policyDefaults.map((declaration) => [declaration.policyKey, declaration]));
      for (const declaration of policyConfiguration) {
        const packageDefault = packagePolicyDefaults.get(declaration.policyKey);
        if (packageDefault === undefined) {
          throw new ServicesError('POLICY_KEY_UNKNOWN', `policy key "${declaration.policyKey}" is not declared by vertical package ${packageId} v${pkg.version}`);
        }
        const defaultParameters = new Map(packageDefault.parameters.map((parameter) => [parameter.name, parameter]));
        for (const parameter of declaration.parameters) {
          const packageParameter = defaultParameters.get(parameter.name);
          if (packageParameter === undefined) {
            throw new ServicesError(
              'POLICY_PARAMETER_UNKNOWN',
              `policy parameter "${parameter.name}" of "${declaration.policyKey}" is not declared by vertical package ${packageId} v${pkg.version}`,
            );
          }
          // The parameter IS the same parameter as the vertical default:
          // the schema's type must admit the declared default's type.
          const expected = typeof packageParameter.defaultValue;
          if ((parameter.type === 'number' || parameter.type === 'enum') && expected !== 'number' && expected !== 'string') {
            throw new ServicesError(
              'INVALID_INPUT',
              `policy parameter "${parameter.name}" of "${declaration.policyKey}" has schema type ${parameter.type} but the vertical default is a ${expected}`,
            );
          }
          if (parameter.type === 'boolean' && expected !== 'boolean') {
            throw new ServicesError(
              'INVALID_INPUT',
              `policy parameter "${parameter.name}" of "${declaration.policyKey}" has schema type boolean but the vertical default is a ${expected}`,
            );
          }
          if (parameter.type === 'string' && expected !== 'string') {
            throw new ServicesError(
              'INVALID_INPUT',
              `policy parameter "${parameter.name}" of "${declaration.policyKey}" has schema type string but the vertical default is a ${expected}`,
            );
          }
        }
      }
      const packageApprovalRules = new Map(pkg.approvalMatrix.map((rule) => [rule.id, rule]));
      for (const rule of approvalRules) {
        const packageRule = packageApprovalRules.get(rule.id);
        if (packageRule === undefined) {
          throw new ServicesError('APPROVAL_RULE_UNKNOWN', `approval rule "${rule.id}" is not declared by vertical package ${packageId} v${pkg.version}`);
        }
        // Specialization floor: the service may only strengthen the
        // vertical's approval requirement.
        if (rule.threshold < packageRule.threshold) {
          throw new ServicesError(
            'APPROVAL_WEAKENED',
            `approval rule "${rule.id}" threshold ${rule.threshold} weakens the vertical's requirement of ${packageRule.threshold}; services may only strengthen approval requirements`,
          );
        }
      }
      for (const entry of slaDefaults) {
        if (!packageWorkTypes.has(entry.workType)) {
          throw new ServicesError('WORK_TYPE_UNKNOWN', `SLA default references work type "${entry.workType}" which is not declared by vertical package ${packageId} v${pkg.version}`);
        }
      }
      const packageEvidenceNames = new Set(pkg.evidenceRequirements.map((requirement) => requirement.name));
      for (const requirement of outcomeContract.evidenceRequirements) {
        if (!packageEvidenceNames.has(requirement)) {
          throw new ServicesError('EVIDENCE_UNKNOWN', `evidence requirement "${requirement}" is not declared by vertical package ${packageId} v${pkg.version}`);
        }
      }
      const packageCapabilityClasses = new Set(pkg.integrationBindings.map((binding) => binding.capabilityClass));
      for (const capability of requiredExternalCapabilities) {
        if (!packageCapabilityClasses.has(capability)) {
          throw new ServicesError(
            'CAPABILITY_NOT_DECLARED',
            `external capability "${capability}" is not bound by vertical package ${packageId} v${pkg.version}; a service may only require capabilities its vertical binds`,
          );
        }
      }
      // Specialization floor: the service's SLA deadlines may only tighten
      // the vertical's declared defaults.
      for (const entry of slaDefaults) {
        const packageWorkType = packageWorkTypes.get(entry.workType);
        const packageFloor = packageWorkType?.defaultSlaHours;
        if (packageFloor !== undefined && entry.deadlineHours > packageFloor) {
          throw new ServicesError(
            'SLA_WEAKENED',
            `SLA default for "${entry.workType}" (${entry.deadlineHours}h) weakens the vertical's floor of ${packageFloor}h; services may only tighten SLA deadlines`,
          );
        }
      }
      const packageAiCapabilities = new Set(pkg.zeckCapabilityRequirements.map((requirement) => requirement.capability));
      for (const requirement of requiredAiCapabilities) {
        if (!packageAiCapabilities.has(requirement.capability)) {
          throw new ServicesError(
            'CAPABILITY_NOT_DECLARED',
            `Zeck capability requirement "${requirement.capability}" is not declared by vertical package ${packageId} v${pkg.version}; a service may only require capabilities its vertical declares`,
          );
        }
      }

      const contentHash = computeDefinitionContentHash({
        tenantId: input.tenantId,
        serviceId,
        version: input.version,
        name,
        description,
        verticalPackageId: packageId,
        verticalPackageVersion: pkg.version,
        entities,
        workDefinitions,
        workflowBinding,
        policyConfiguration,
        approvalRules,
        slaDefaults,
        outcomeContract,
        requiredExternalCapabilities,
        requiredAiCapabilities,
        pricing,
      });
      // One clock read: the SAME instant is pinned into the record hash
      // and the persisted row (hash verified on every read).
      const registeredAt = now();
      const recordHash = computeDefinitionRecordHash({
        id: '',
        tenantId: input.tenantId,
        serviceId,
        version: input.version,
        status: 'draft',
        name,
        description,
        verticalPackageId: packageId,
        verticalPackageVersion: pkg.version,
        entities,
        workDefinitions,
        workflowBinding,
        policyConfiguration,
        approvalRules,
        slaDefaults,
        outcomeContract,
        requiredExternalCapabilities,
        requiredAiCapabilities,
        pricing,
        contentHash,
        recordHash: '',
        createdBy: principal.id,
        idempotencyKey,
        createdAt: registeredAt,
        updatedAt: registeredAt,
      });

      const payload: RegisterDefinitionInput = {
        tenantId: input.tenantId,
        serviceId,
        version: input.version,
        name,
        description,
        verticalPackageId: packageId,
        verticalPackageVersion: pkg.version,
        entities,
        workDefinitions,
        workflowBinding,
        policyConfiguration,
        approvalRules,
        slaDefaults,
        outcomeContract,
        requiredExternalCapabilities,
        requiredAiCapabilities,
        pricing,
        contentHash,
        recordHash,
        createdBy: principal.id,
        idempotencyKey,
        now: registeredAt,
      };
      try {
        return await store.registerDefinition(payload);
      } catch (error) {
        return mapStoreError(error);
      }
    },

    async getServiceDefinition(principal, tenantId, serviceId, version) {
      await requireTenantAccess(principal, tenantId, 'read');
      const id = validateIdentifier(serviceId, 'serviceId', SERVICE_ID_PATTERN, 'must be a lowercase slug');
      if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
        throw new ServicesError('INVALID_INPUT', 'version must be a positive integer');
      }
      try {
        const definition = await store.findDefinition(tenantId, id, version);
        if (definition === null) {
          throw new ServicesError('SERVICE_NOT_FOUND', `service definition ${id} v${version} does not exist in this tenant`);
        }
        return definition;
      } catch (error) {
        return mapStoreError(error);
      }
    },

    async listServiceDefinitions(principal, tenantId, serviceId, status) {
      await requireTenantAccess(principal, tenantId, 'read');
      let id: string | undefined;
      if (serviceId !== undefined) {
        id = validateIdentifier(serviceId, 'serviceId', SERVICE_ID_PATTERN, 'must be a lowercase slug');
      }
      if (status !== undefined && status !== 'draft' && status !== 'active' && status !== 'retired') {
        throw new ServicesError('INVALID_INPUT', 'status must be "draft", "active" or "retired"');
      }
      try {
        return await store.listDefinitions(tenantId, id, status);
      } catch (error) {
        return mapStoreError(error);
      }
    },

    async activateServiceDefinition(principal, tenantId, serviceId, version) {
      await requireTenantAccess(principal, tenantId, 'write');
      const id = validateIdentifier(serviceId, 'serviceId', SERVICE_ID_PATTERN, 'must be a lowercase slug');
      if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
        throw new ServicesError('INVALID_INPUT', 'version must be a positive integer');
      }
      try {
        return await store.activateDefinition({ tenantId, serviceId: id, version, now: now() });
      } catch (error) {
        return mapStoreError(error);
      }
    },

    async resolveActiveServiceDefinition(principal, tenantId, serviceId) {
      await requireTenantAccess(principal, tenantId, 'read');
      const id = validateIdentifier(serviceId, 'serviceId', SERVICE_ID_PATTERN, 'must be a lowercase slug');
      try {
        return await store.findActiveDefinition(tenantId, id);
      } catch (error) {
        return mapStoreError(error);
      }
    },

    async registerCustomerConfiguration(principal, input) {
      await requireTenantAccess(principal, input.tenantId, 'write');
      const serviceId = validateIdentifier(input.serviceId, 'serviceId', SERVICE_ID_PATTERN, 'must be a lowercase slug');
      const idempotencyKey = validateOptionalIdempotencyKey(input.idempotencyKey);

      if (!Array.isArray(input.policyParameters)) {
        throw new ServicesError('INVALID_INPUT', 'policyParameters must be an array');
      }
      if (input.policyParameters.length > MAX_POLICY_DECLARATIONS) {
        throw new ServicesError('INVALID_INPUT', `policyParameters must contain at most ${MAX_POLICY_DECLARATIONS} entries`);
      }
      if (!Array.isArray(input.slaAdjustments)) {
        throw new ServicesError('INVALID_INPUT', 'slaAdjustments must be an array');
      }
      if (input.slaAdjustments.length > MAX_SLA_DEFAULTS) {
        throw new ServicesError('INVALID_INPUT', `slaAdjustments must contain at most ${MAX_SLA_DEFAULTS} entries`);
      }
      if (!Array.isArray(input.approvalAdjustments)) {
        throw new ServicesError('INVALID_INPUT', 'approvalAdjustments must be an array');
      }
      if (input.approvalAdjustments.length > MAX_APPROVAL_RULES) {
        throw new ServicesError('INVALID_INPUT', `approvalAdjustments must contain at most ${MAX_APPROVAL_RULES} entries`);
      }

      // Pin the ACTIVE service definition: the customer configures the
      // live service, and the configuration records the version it was
      // validated against (provenance).
      const service = await store.findActiveDefinition(input.tenantId, serviceId);
      if (service === null) {
        throw new ServicesError('SERVICE_NOT_FOUND', `service ${serviceId} has no active definition version in this tenant`);
      }

      // AC-3: every adjustment validated against the service's declared
      // contract BEFORE persistence — weakened content never persists.
      const servicePolicies = new Map(service.policyConfiguration.map((declaration) => [declaration.policyKey, declaration]));
      const seenPolicyKeys = new Set<string>();
      const policyParameters: PolicyParameterValueSet[] = [];
      for (const entry of input.policyParameters) {
        if (typeof entry !== 'object' || entry === null) {
          throw new ServicesError('INVALID_INPUT', 'each policy parameter set must be an object');
        }
        for (const key of Object.keys(entry)) {
          if (key === 'rules' || key === 'effect' || key === 'defaultEffect') {
            throw new ServicesError(
              'POLICY_RULES_FORBIDDEN',
              `policy parameter set carries forbidden key "${key}"; customer configuration supplies VALUES within the service schema only`,
            );
          }
        }
        const policyKey = validateIdentifier(entry.policyKey, 'policyKey', IDENTIFIER_PATTERN, 'must match the identifier pattern');
        if (seenPolicyKeys.has(policyKey)) {
          throw new ServicesError('INVALID_INPUT', `policy parameters for "${policyKey}" are supplied twice`);
        }
        seenPolicyKeys.add(policyKey);
        const declaration = servicePolicies.get(policyKey);
        if (declaration === undefined) {
          throw new ServicesError(
            'POLICY_KEY_UNKNOWN',
            `policy key "${policyKey}" is not configurable by service ${serviceId} v${service.version}`,
          );
        }
        if (typeof entry.values !== 'object' || entry.values === null || Array.isArray(entry.values)) {
          throw new ServicesError('INVALID_INPUT', `policy parameter values of "${policyKey}" must be an object`);
        }
        const values = Object.entries(entry.values);
        if (values.length > MAX_PARAMETER_VALUES) {
          throw new ServicesError('INVALID_INPUT', `policy parameter values of "${policyKey}" must contain at most ${MAX_PARAMETER_VALUES} entries`);
        }
        const schemaParameters = new Map(declaration.parameters.map((parameter) => [parameter.name, parameter]));
        const validatedValues: Record<string, string | number | boolean> = {};
        for (const [name, value] of values) {
          const schema = schemaParameters.get(name);
          if (schema === undefined) {
            throw new ServicesError(
              'POLICY_PARAMETER_UNKNOWN',
              `policy parameter "${name}" of "${policyKey}" is not declared by service ${serviceId} v${service.version}`,
            );
          }
          if (!isPrimitive(value)) {
            throw new ServicesError('INVALID_INPUT', `policy parameter "${name}" of "${policyKey}" must carry a primitive value`);
          }
          checkParameterAgainstSchema(policyKey, name, schema.type, schema.min, schema.max, schema.values, value);
          validatedValues[name] = value;
        }
        // Required parameters MUST be supplied by the configuration.
        for (const schema of declaration.parameters) {
          if (schema.required && !(schema.name in validatedValues)) {
            throw new ServicesError(
              'POLICY_PARAMETER_OUT_OF_BOUNDS',
              `policy parameter "${schema.name}" of "${policyKey}" is required by service ${serviceId} v${service.version} and must be configured`,
            );
          }
        }
        policyParameters.push({ policyKey, values: validatedValues });
      }

      const serviceSla = new Map(service.slaDefaults.map((entry) => [entry.workType, entry.deadlineHours]));
      const seenSlaWorkTypes = new Set<string>();
      const slaAdjustments: SlaAdjustment[] = [];
      for (const adjustment of input.slaAdjustments) {
        if (typeof adjustment !== 'object' || adjustment === null) {
          throw new ServicesError('INVALID_INPUT', 'each SLA adjustment must be an object');
        }
        const workType = validateIdentifier(adjustment.workType, 'SLA adjustment workType', IDENTIFIER_PATTERN, 'must match the identifier pattern');
        if (seenSlaWorkTypes.has(workType)) {
          throw new ServicesError('INVALID_INPUT', `SLA adjustment for "${workType}" is supplied twice`);
        }
        seenSlaWorkTypes.add(workType);
        if (typeof adjustment.deadlineHours !== 'number' || !Number.isInteger(adjustment.deadlineHours) || adjustment.deadlineHours <= 0) {
          throw new ServicesError('INVALID_INPUT', `SLA adjustment for "${workType}" deadlineHours must be a positive integer`);
        }
        const serviceDeadline = serviceSla.get(workType);
        if (serviceDeadline === undefined) {
          throw new ServicesError(
            'WORK_TYPE_UNKNOWN',
            `SLA adjustment references work type "${workType}" which has no SLA default in service ${serviceId} v${service.version}`,
          );
        }
        // Tightening only: a looser deadline weakens the service's
        // declared SLA contract.
        if (adjustment.deadlineHours > serviceDeadline) {
          throw new ServicesError(
            'SLA_WEAKENED',
            `SLA adjustment for "${workType}" (${adjustment.deadlineHours}h) weakens the service's default of ${serviceDeadline}h; customer configuration may only tighten SLA deadlines`,
          );
        }
        slaAdjustments.push({ workType, deadlineHours: adjustment.deadlineHours });
      }

      const serviceApprovals = new Map(service.approvalRules.map((rule) => [rule.id, rule.threshold]));
      const seenApprovalIds = new Set<string>();
      const approvalAdjustments: ApprovalAdjustment[] = [];
      for (const adjustment of input.approvalAdjustments) {
        if (typeof adjustment !== 'object' || adjustment === null) {
          throw new ServicesError('INVALID_INPUT', 'each approval adjustment must be an object');
        }
        const id = validateIdentifier(adjustment.id, 'approval adjustment id', IDENTIFIER_PATTERN, 'must match the identifier pattern');
        if (seenApprovalIds.has(id)) {
          throw new ServicesError('INVALID_INPUT', `approval adjustment "${id}" is supplied twice`);
        }
        seenApprovalIds.add(id);
        if (typeof adjustment.threshold !== 'number' || !Number.isInteger(adjustment.threshold) || adjustment.threshold < 1) {
          throw new ServicesError('INVALID_INPUT', `approval adjustment "${id}" threshold must be an integer >= 1`);
        }
        const serviceThreshold = serviceApprovals.get(id);
        if (serviceThreshold === undefined) {
          throw new ServicesError(
            'APPROVAL_RULE_UNKNOWN',
            `approval adjustment references rule "${id}" which service ${serviceId} v${service.version} does not declare`,
          );
        }
        // Strengthening only: a lower threshold weakens the service's
        // declared approval contract.
        if (adjustment.threshold < serviceThreshold) {
          throw new ServicesError(
            'APPROVAL_WEAKENED',
            `approval adjustment "${id}" threshold ${adjustment.threshold} weakens the service's requirement of ${serviceThreshold}; customer configuration may only strengthen approval thresholds`,
          );
        }
        approvalAdjustments.push({ id, threshold: adjustment.threshold });
      }

      const contentHash = computeConfigurationContentHash({
        tenantId: input.tenantId,
        serviceId,
        serviceVersion: service.version,
        policyParameters,
        slaAdjustments,
        approvalAdjustments,
      });
      // The record hash is computed BY THE STORE over the full allocated
      // identity (the store owns the configuration version; only its
      // allocator can hash it). The module supplies the content hash.
      const registeredAt = now();
      const payload: RegisterConfigurationInput = {
        tenantId: input.tenantId,
        serviceId,
        serviceVersion: service.version,
        policyParameters,
        slaAdjustments,
        approvalAdjustments,
        contentHash,
        createdBy: principal.id,
        idempotencyKey,
        now: registeredAt,
      };
      try {
        return await store.registerConfiguration(payload);
      } catch (error) {
        return mapStoreError(error);
      }
    },

    async getCustomerConfiguration(principal, tenantId, configurationId) {
      await requireTenantAccess(principal, tenantId, 'read');
      validateUuid(configurationId, 'configurationId');
      try {
        const configuration = await store.findConfigurationById(tenantId, configurationId);
        if (configuration === null) {
          throw new ServicesError('CONFIGURATION_NOT_FOUND', `service configuration ${configurationId} does not exist in this tenant`);
        }
        return configuration;
      } catch (error) {
        return mapStoreError(error);
      }
    },

    async listCustomerConfigurations(principal, tenantId, serviceId) {
      await requireTenantAccess(principal, tenantId, 'read');
      let id: string | undefined;
      if (serviceId !== undefined) {
        id = validateIdentifier(serviceId, 'serviceId', SERVICE_ID_PATTERN, 'must be a lowercase slug');
      }
      try {
        return await store.listConfigurations(tenantId, id);
      } catch (error) {
        return mapStoreError(error);
      }
    },

    async activateCustomerConfiguration(principal, tenantId, serviceId, configurationVersion) {
      await requireTenantAccess(principal, tenantId, 'write');
      const id = validateIdentifier(serviceId, 'serviceId', SERVICE_ID_PATTERN, 'must be a lowercase slug');
      if (typeof configurationVersion !== 'number' || !Number.isInteger(configurationVersion) || configurationVersion < 1) {
        throw new ServicesError('INVALID_INPUT', 'configurationVersion must be a positive integer');
      }
      try {
        return await store.activateConfiguration({ tenantId, serviceId: id, configurationVersion, now: now() });
      } catch (error) {
        return mapStoreError(error);
      }
    },

    async resolveActiveCustomerConfiguration(principal, tenantId, serviceId) {
      await requireTenantAccess(principal, tenantId, 'read');
      const id = validateIdentifier(serviceId, 'serviceId', SERVICE_ID_PATTERN, 'must be a lowercase slug');
      try {
        return await store.findActiveConfiguration(tenantId, id);
      } catch (error) {
        return mapStoreError(error);
      }
    },
  };
}

/**
 * Module manifest (registered in the composition root's module registry).
 * The manifest declares identity only; the business contract above is the
 * module's public surface.
 */
export default defineModule({
  name: 'services',
  version: '1.0.0',
  description: 'service definitions and service-package lifecycle',
});
