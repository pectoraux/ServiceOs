/**
 * ServiceOS module: /policies (WORK-014 implementation).
 *
 * The single ServiceOS business-policy authority (architecture-lock #2):
 * versioned business-policy contracts, deterministic policy resolution and
 * evaluation, and revision-bound, attributable policy decision records
 * (architecture.md §6, §13; domain-model BusinessPolicies).
 *
 * Authority (authority matrix / Work Order frozen scope):
 * - POLICY DECISIONS are owned here: `resolvePolicy` and `evaluatePolicy`
 *   are the public policy hooks consumed by the future workflow authority
 *   (WORK-004) and side-effect authorities (WORK-008) — they consume this
 *   public contract instead of reimplementing policy logic (AC-4). A module
 *   other than /policies exporting policy-engine entry points is an
 *   architecture violation (checked structurally).
 * - AUTHORIZATION REMAINS SEPARATE (Work Order invariant): this module
 *   never replaces or re-implements the authorization chain — it CONSUMES
 *   /organizations' `authorize` for its own surface exactly like /work,
 *   and policy evaluation is a separate business gate that composes
 *   alongside (never instead of) authorization. Business mutations must
 *   pass BOTH gates (architecture.md §4).
 * - NO WORKFLOW STATE MACHINE: publication state on a policy version row
 *   (`draft` → `active`, forward-only) is contract VERSIONING; Service Work
 *   state transitions belong exclusively to /workflow (WORK-004).
 * - NO AI/PROVIDER POLICY ENGINE: the evaluator is pure, deterministic,
 *   provider-independent code; AI policy/execution remains Zeck-owned
 *   (zeck-boundary; "ServiceOS decides what a business policy means, Zeck
 *   decides how AI computes/executes").
 * - OVERRIDE PRECEDENCE WITHOUT WEAKENING (AC-3, architecture-lock #33):
 *   the composition is deny-dominates — a customer override may tighten
 *   (deny where the base allows) but can never weaken the base policy or
 *   the frozen floor, and no configuration can grant frozen-denied
 *   capabilities (the floor is code, never data).
 *
 * Decision provenance (AC-5): every durable decision pins the policy
 * id/version each layer consulted, the frozen-floor revision, the input
 * snapshot, its canonical input hash, and an integrity hash over the
 * record core (after-the-fact mutation is detected on read).
 */
import type { TransactionalExecutor } from '../../platform/persistence/index.js';
import { defineModule } from '../../platform/module-registry/index.js';
import type { Principal } from '../auth/index.js';
import type { AuthorizationDecision, AuthorizationDenyReason, TenancyAction } from '../organizations/index.js';
import { createSqlPolicyStore } from './sql-store.js';
import {
  FROZEN_POLICY_REVISION,
  PolicyEvaluationError,
  composeDecision,
  evaluateFrozenFloor,
  evaluateLayer,
  hashDecisionRecord,
  hashPolicyInput,
} from './evaluation.js';
import {
  PolicyStoreMissingError,
  PolicyStoreRuleError,
  type CreatePolicyVersionInput,
  type PolicyContractRecord,
  type PolicyDecisionRecord,
  type PolicyEffect,
  type PolicyInputValue,
  type PolicyLayerProvenance,
  type PolicyRule,
  type PolicyScope,
  type PolicyStore,
  type RecordDecisionInput,
} from './store.js';

// Store port (public contract): the authoritative SQL implementation runs
// through the persistence boundary; tests inject faithful in-memory
// implementations of the same port through this surface.
export { PolicyStoreMissingError, PolicyStoreRuleError, createSqlPolicyStore };
export type {
  CreatePolicyVersionInput,
  PolicyCondition,
  PolicyConditionOperator,
  PolicyContractRecord,
  PolicyDecisionRecord,
  PolicyEffect,
  PolicyInputValue,
  PolicyLayerProvenance,
  PolicyRule,
  PolicyRuleset,
  PolicyScope,
  PolicyStatus,
  PolicyStore,
  PolicyStoreRule,
  RecordDecisionInput,
  ActivatePolicyVersionInput,
} from './store.js';

// The deterministic evaluation engine is /policies-internal code exported
// through the module's public interface (pure functions: canonical hashing
// and the frozen floor are part of the decision-provenance contract).
export {
  FROZEN_POLICY_REVISION,
  FROZEN_DENIED_CAPABILITIES,
  FROZEN_CAPABILITY_ATTRIBUTE,
  evaluateFrozenFloor,
  evaluateLayer,
  composeDecision,
  canonicalJson,
  hashPolicyInput,
  hashDecisionRecord,
  PolicyEvaluationError,
} from './evaluation.js';
export type {
  PolicyInput,
  FrozenFloorEvaluation,
  LayerEvaluation,
  LayerOutcome,
  ComposedDecision,
  DecidingLayer,
} from './evaluation.js';

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

export type PolicyErrorCode =
  | 'INVALID_INPUT'
  | 'TENANT_NOT_FOUND'
  | 'TENANT_SUSPENDED'
  | 'ORGANIZATION_SUSPENDED'
  | 'TENANT_FORBIDDEN'
  | 'ROLE_FORBIDDEN'
  | 'POLICY_VERSION_NOT_FOUND'
  | 'DECISION_NOT_FOUND'
  | 'VERSION_RETIRED'
  | 'DECISION_INPUT_CONFLICT'
  | 'DECISION_RECORD_TAMPERED'
  | 'DECISION_REPLAY_MISMATCH'
  | 'EVALUATION_TYPE_ERROR';

export class PolicyError extends Error {
  constructor(
    readonly code: PolicyErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'PolicyError';
  }
}

/** What policy resolution consulted: the layers that will be pinned. */
export interface PolicyResolution {
  readonly tenantId: string;
  readonly policyKey: string;
  readonly frozenRevision: string;
  /** The active base contract, or null when none exists (fail closed). */
  readonly base: PolicyContractRecord | null;
  /** The active customer override, or null when none exists. */
  readonly customer: PolicyContractRecord | null;
}

export interface PoliciesModuleOptions {
  /** Production wiring: transaction-capable persistence executor. */
  executor?: TransactionalExecutor;
  /** Test seam: inject a faithful in-memory store instead (tests only). */
  store?: PolicyStore;
  /** The single authorization chain, injected by the composition root. */
  tenancy: TenancyAuthorization;
  /** Clock injection for deterministic proofs. */
  now?: () => Date;
}

export interface PoliciesModule {
  /**
   * Create a policy contract version (AC-1: the versioned, provider-
   * independent policy contract). Starts as `draft`; content is immutable.
   * Same logical creation (tenant + idempotency key) converges on one
   * durable identity.
   */
  createPolicyVersion(
    principal: Principal,
    input: {
      tenantId: string;
      policyKey: string;
      scope: PolicyScope;
      rules: readonly PolicyRule[];
      defaultEffect: PolicyEffect;
      idempotencyKey?: string;
    },
  ): Promise<{ contract: PolicyContractRecord; converged: boolean }>;
  getPolicyVersion(principal: Principal, tenantId: string, versionId: string): Promise<PolicyContractRecord>;
  listPolicyVersions(principal: Principal, tenantId: string, policyKey: string, scope?: PolicyScope): Promise<PolicyContractRecord[]>;
  /**
   * Activate a draft version (forward-only; the prior active version of
   * the same identity is retired atomically). Activating the already-active
   * version converges; retired versions are rejected.
   */
  activatePolicyVersion(
    principal: Principal,
    tenantId: string,
    versionId: string,
  ): Promise<{ contract: PolicyContractRecord; converged: boolean }>;
  /**
   * Resolve the effective policy layers for one (tenant, policy key):
   * the active base contract and the active customer override. This is the
   * public resolution surface future authorities consume (AC-4).
   */
  resolvePolicy(principal: Principal, tenantId: string, policyKey: string): Promise<PolicyResolution>;
  /**
   * THE policy hook (AC-2/AC-3/AC-4/AC-5): evaluate the applicable policy
   * deterministically for one gated input and persist the revision-bound,
   * attributable decision record. Composes deny-dominates (frozen floor →
   * customer override → base; fail closed with no base policy). Idempotent
   * by decision identity: the same idempotency key with the same input
   * re-observes the durable decision.
   */
  evaluatePolicy(
    principal: Principal,
    input: {
      tenantId: string;
      policyKey: string;
      action: string;
      attributes: Readonly<Record<string, PolicyInputValue>>;
      idempotencyKey?: string;
    },
  ): Promise<{ decision: PolicyDecisionRecord; converged: boolean }>;
  /**
   * Read a decision record. Verifies the persisted integrity hash: an
   * after-the-fact mutation of the recorded result is detected (typed
   * DECISION_RECORD_TAMPERED).
   */
  getDecision(principal: Principal, tenantId: string, decisionId: string): Promise<PolicyDecisionRecord>;
  /**
   * Verify a decision end-to-end: integrity hash AND replay — re-evaluate
   * the pinned policy versions against the pinned input and confirm the
   * same decision (determinism; typed DECISION_REPLAY_MISMATCH on
   * divergence).
   */
  verifyDecision(principal: Principal, tenantId: string, decisionId: string): Promise<PolicyDecisionRecord>;
}

// ---------------------------------------------------------------------------
// Validation (fail closed)
// ---------------------------------------------------------------------------

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_RULES = 100;
const MAX_ATTRIBUTES = 32;

function validateUuid(value: string, what: string): void {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new PolicyError('INVALID_INPUT', `${what} must be a UUID`);
  }
}

function validateKey(value: string, what: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maxLength) {
    throw new PolicyError('INVALID_INPUT', `${what} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value.trim();
}

function validateOptionalIdempotencyKey(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.trim() === '' || value.length > 200) {
    throw new PolicyError('INVALID_INPUT', 'idempotencyKey must be a non-empty string of at most 200 characters');
  }
  return value.trim();
}

function isPrimitive(value: unknown): value is PolicyInputValue {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function validateRules(rules: readonly PolicyRule[]): readonly PolicyRule[] {
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new PolicyError('INVALID_INPUT', 'rules must be a non-empty array');
  }
  if (rules.length > MAX_RULES) {
    throw new PolicyError('INVALID_INPUT', `rules must contain at most ${MAX_RULES} entries`);
  }
  const seen = new Set<string>();
  const validated: PolicyRule[] = [];
  for (const rule of rules) {
    if (typeof rule !== 'object' || rule === null) {
      throw new PolicyError('INVALID_INPUT', 'each rule must be an object');
    }
    const id = validateKey(rule.id, 'rule id', 100);
    if (seen.has(id)) {
      throw new PolicyError('INVALID_INPUT', `rule id "${id}" is duplicated; rule ids must be unique within a contract`);
    }
    seen.add(id);
    if (rule.description !== undefined && (typeof rule.description !== 'string' || rule.description.length > 500)) {
      throw new PolicyError('INVALID_INPUT', 'rule description must be a string of at most 500 characters');
    }
    if (rule.effect !== 'allow' && rule.effect !== 'deny') {
      throw new PolicyError('INVALID_INPUT', 'rule effect must be "allow" or "deny"');
    }
    validated.push({
      id,
      ...(rule.description !== undefined ? { description: rule.description } : {}),
      when: validateCondition(rule.when),
      effect: rule.effect,
    });
  }
  return validated;
}

function validateCondition(condition: PolicyRule['when']): PolicyRule['when'] {
  if (typeof condition !== 'object' || condition === null) {
    throw new PolicyError('INVALID_INPUT', 'rule condition must be an object');
  }
  if (condition.kind === 'always') {
    return { kind: 'always' };
  }
  if (condition.kind !== 'attribute') {
    throw new PolicyError('INVALID_INPUT', 'rule condition kind must be "always" or "attribute"');
  }
  const name = validateKey(condition.name, 'condition attribute name', 100);
  const operator: string = condition.operator;
  switch (condition.operator) {
    case 'eq':
    case 'ne': {
      if (!isPrimitive(condition.value)) {
        throw new PolicyError('INVALID_INPUT', `operator "${condition.operator}" requires a primitive value`);
      }
      return { kind: 'attribute', name, operator: condition.operator, value: condition.value };
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      if (typeof condition.value !== 'number' || !Number.isFinite(condition.value)) {
        throw new PolicyError('INVALID_INPUT', `operator "${condition.operator}" requires a finite number value`);
      }
      return { kind: 'attribute', name, operator: condition.operator, value: condition.value };
    }
    case 'in': {
      if (!Array.isArray(condition.value) || condition.value.length === 0) {
        throw new PolicyError('INVALID_INPUT', 'operator "in" requires a non-empty array value');
      }
      if (!condition.value.every(isPrimitive)) {
        throw new PolicyError('INVALID_INPUT', 'operator "in" requires primitive array values');
      }
      return { kind: 'attribute', name, operator: 'in', value: [...condition.value] };
    }
    case 'contains': {
      if (typeof condition.value !== 'string' || condition.value === '') {
        throw new PolicyError('INVALID_INPUT', 'operator "contains" requires a non-empty string value');
      }
      return { kind: 'attribute', name, operator: 'contains', value: condition.value };
    }
    default:
      throw new PolicyError('INVALID_INPUT', `unknown condition operator "${operator}"`);
  }
}

function validateAttributes(attributes: Readonly<Record<string, PolicyInputValue>>): Readonly<Record<string, PolicyInputValue>> {
  if (typeof attributes !== 'object' || attributes === null || Array.isArray(attributes)) {
    throw new PolicyError('INVALID_INPUT', 'attributes must be an object');
  }
  const entries = Object.entries(attributes);
  if (entries.length > MAX_ATTRIBUTES) {
    throw new PolicyError('INVALID_INPUT', `attributes must contain at most ${MAX_ATTRIBUTES} entries`);
  }
  const validated: Record<string, PolicyInputValue> = {};
  for (const [key, value] of entries) {
    validateKey(key, 'attribute name', 100);
    if (!isPrimitive(value)) {
      throw new PolicyError('INVALID_INPUT', `attribute "${key}" must be a string, number, boolean or null`);
    }
    if (typeof value === 'string' && value.length > 2000) {
      throw new PolicyError('INVALID_INPUT', `attribute "${key}" string value must be at most 2000 characters`);
    }
    validated[key] = value;
  }
  return validated;
}

/** Map an authorization denial reason to the policy-module error surface. */
function denyToError(reason: AuthorizationDenyReason | undefined, tenantId: string): PolicyError {
  switch (reason) {
    case 'TENANT_NOT_FOUND':
      return new PolicyError('TENANT_NOT_FOUND', `service tenant ${tenantId} does not exist`);
    case 'TENANT_SUSPENDED':
      return new PolicyError('TENANT_SUSPENDED', `service tenant ${tenantId} is suspended`);
    case 'ORGANIZATION_NOT_FOUND':
      return new PolicyError('TENANT_NOT_FOUND', `the tenant's organization no longer exists`);
    case 'ORGANIZATION_SUSPENDED':
      return new PolicyError('ORGANIZATION_SUSPENDED', 'the owning organization is suspended');
    case 'MEMBERSHIP_FORBIDDEN':
      return new PolicyError('TENANT_FORBIDDEN', 'the principal has no active membership granting this tenant');
    case 'ROLE_FORBIDDEN':
      return new PolicyError('ROLE_FORBIDDEN', 'the principal role does not grant the required capability');
    default:
      return new PolicyError('TENANT_FORBIDDEN', 'authorization denied');
  }
}

/** Map store errors to the public policy error surface. */
function mapStoreError(error: unknown): never {
  if (error instanceof PolicyStoreRuleError) {
    switch (error.rule) {
      case 'version-retired':
        throw new PolicyError('VERSION_RETIRED', error.message);
      case 'decision-input-conflict':
        throw new PolicyError('DECISION_INPUT_CONFLICT', error.message);
      case 'decision-record-tampered':
        throw new PolicyError('DECISION_RECORD_TAMPERED', error.message);
    }
  }
  if (error instanceof PolicyStoreMissingError) {
    if (error.what === 'decision') {
      throw new PolicyError('DECISION_NOT_FOUND', error.message);
    }
    throw new PolicyError('POLICY_VERSION_NOT_FOUND', error.message);
  }
  throw error;
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export function createPoliciesModule(options: PoliciesModuleOptions): PoliciesModule {
  if ((options.executor === undefined) === (options.store === undefined)) {
    throw new PolicyError('INVALID_INPUT', 'createPoliciesModule requires exactly one of executor or store');
  }
  const store = options.store ?? createSqlPolicyStore(options.executor as TransactionalExecutor);
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
    async createPolicyVersion(principal, input) {
      await requireTenantAccess(principal, input.tenantId, 'write');
      const policyKey = validateKey(input.policyKey, 'policyKey', 200);
      if (input.scope !== 'base' && input.scope !== 'customer') {
        throw new PolicyError('INVALID_INPUT', 'scope must be "base" or "customer"');
      }
      const rules = validateRules(input.rules);
      if (input.defaultEffect !== 'allow' && input.defaultEffect !== 'deny') {
        throw new PolicyError('INVALID_INPUT', 'defaultEffect must be "allow" or "deny"');
      }
      const idempotencyKey = validateOptionalIdempotencyKey(input.idempotencyKey);
      const payload: CreatePolicyVersionInput = {
        tenantId: input.tenantId,
        policyKey,
        scope: input.scope,
        rules,
        defaultEffect: input.defaultEffect,
        createdBy: principal.id,
        idempotencyKey,
        now: now(),
      };
      try {
        return await store.createPolicyVersion(payload);
      } catch (error) {
        return mapStoreError(error);
      }
    },

    async getPolicyVersion(principal, tenantId, versionId) {
      await requireTenantAccess(principal, tenantId, 'read');
      validateUuid(versionId, 'versionId');
      const contract = await store.findPolicyVersionById(tenantId, versionId);
      if (contract === null) {
        throw new PolicyError('POLICY_VERSION_NOT_FOUND', `policy version ${versionId} does not exist in this tenant`);
      }
      return contract;
    },

    async listPolicyVersions(principal, tenantId, policyKey, scope) {
      await requireTenantAccess(principal, tenantId, 'read');
      const key = validateKey(policyKey, 'policyKey', 200);
      if (scope !== undefined && scope !== 'base' && scope !== 'customer') {
        throw new PolicyError('INVALID_INPUT', 'scope must be "base" or "customer"');
      }
      return store.listPolicyVersions(tenantId, key, scope);
    },

    async activatePolicyVersion(principal, tenantId, versionId) {
      await requireTenantAccess(principal, tenantId, 'write');
      validateUuid(versionId, 'versionId');
      try {
        return await store.activatePolicyVersion({ tenantId, versionId, now: now() });
      } catch (error) {
        return mapStoreError(error);
      }
    },

    async resolvePolicy(principal, tenantId, policyKey) {
      await requireTenantAccess(principal, tenantId, 'read');
      const key = validateKey(policyKey, 'policyKey', 200);
      const [base, customer] = await Promise.all([
        store.findActivePolicyVersion(tenantId, key, 'base'),
        store.findActivePolicyVersion(tenantId, key, 'customer'),
      ]);
      return {
        tenantId,
        policyKey: key,
        frozenRevision: FROZEN_POLICY_REVISION,
        base,
        customer,
      };
    },

    async evaluatePolicy(principal, input) {
      await requireTenantAccess(principal, input.tenantId, 'write');
      const policyKey = validateKey(input.policyKey, 'policyKey', 200);
      const action = validateKey(input.action, 'action', 200);
      const attributes = validateAttributes(input.attributes);
      const idempotencyKey = validateOptionalIdempotencyKey(input.idempotencyKey);
      const inputRecord = { action, attributes };

      // Resolution snapshot: pin exactly what is consulted (AC-5). The
      // decision remains internally consistent even if a new version is
      // activated concurrently — it records the versions it evaluated.
      const [base, customer] = await Promise.all([
        store.findActivePolicyVersion(input.tenantId, policyKey, 'base'),
        store.findActivePolicyVersion(input.tenantId, policyKey, 'customer'),
      ]);

      // Deterministic composition (evaluation.ts): frozen floor → customer
      // override → base; deny dominates; fail closed without a base policy.
      // A type mismatch during evaluation (e.g. ordered comparison on a
      // non-number attribute) fails closed onto the public error surface.
      const { frozen, customerEval, baseEval, composed } = (() => {
        try {
          const frozen = evaluateFrozenFloor(attributes);
          const customerEval = customer === null ? null : evaluateLayer(customer, attributes);
          const baseEval = base === null ? null : evaluateLayer(base, attributes);
          const composed = composeDecision({
            frozen,
            customer: customerEval ?? { outcome: 'no-policy', ruleId: null },
            base: baseEval ?? { outcome: 'no-policy', ruleId: null },
          });
          return { frozen, customerEval, baseEval, composed };
        } catch (error) {
          if (error instanceof PolicyEvaluationError) {
            throw new PolicyError('EVALUATION_TYPE_ERROR', error.message);
          }
          throw error;
        }
      })();

      const layers: PolicyLayerProvenance[] = [
        { layer: 'frozen', policyId: null, version: null, outcome: frozen.outcome, ruleId: frozen.ruleId },
        {
          layer: 'customer',
          policyId: customer?.id ?? null,
          version: customer?.version ?? null,
          outcome: customerEval?.outcome ?? 'no-policy',
          ruleId: customerEval?.ruleId ?? null,
        },
        {
          layer: 'base',
          policyId: base?.id ?? null,
          version: base?.version ?? null,
          outcome: baseEval?.outcome ?? 'no-policy',
          ruleId: baseEval?.ruleId ?? null,
        },
      ];

      const inputHash = hashPolicyInput(inputRecord);
      // One clock read: the SAME instant is pinned into the record hash and
      // the persisted row (the hash is verified against the stored row on
      // every read — a second, different clock read would break it).
      const decidedAt = now();
      const recordHash = hashDecisionRecord({
        tenantId: input.tenantId,
        policyKey,
        outcome: composed.outcome,
        decidingLayer: composed.decidingLayer,
        decidingRuleId: composed.decidingRuleId,
        frozenRevision: FROZEN_POLICY_REVISION,
        layers,
        input: inputRecord,
        inputHash,
        decidedBy: principal.id,
        createdAt: decidedAt.toISOString(),
      });

      const payload: RecordDecisionInput = {
        tenantId: input.tenantId,
        policyKey,
        decidedBy: principal.id,
        idempotencyKey,
        outcome: composed.outcome,
        decidingLayer: composed.decidingLayer,
        decidingRuleId: composed.decidingRuleId,
        frozenRevision: FROZEN_POLICY_REVISION,
        layers,
        input: inputRecord,
        inputHash,
        recordHash,
        now: decidedAt,
      };
      try {
        return await store.recordDecision(payload);
      } catch (error) {
        return mapStoreError(error);
      }
    },

    async getDecision(principal, tenantId, decisionId) {
      await requireTenantAccess(principal, tenantId, 'read');
      validateUuid(decisionId, 'decisionId');
      try {
        const decision = await store.findDecisionById(tenantId, decisionId);
        if (decision === null) {
          throw new PolicyError('DECISION_NOT_FOUND', `decision ${decisionId} does not exist in this tenant`);
        }
        return decision;
      } catch (error) {
        return mapStoreError(error);
      }
    },

    async verifyDecision(principal, tenantId, decisionId) {
      const decision = await this.getDecision(principal, tenantId, decisionId);

      // Replay: re-evaluate the pinned policy versions against the pinned
      // input and re-compose. Any divergence from the recorded decision
      // (e.g. rule content mutated after the fact, or tampering that kept
      // hashes consistent with changed content) fails closed.
      const baseLayer = decision.layers.find((layer) => layer.layer === 'base');
      const customerLayer = decision.layers.find((layer) => layer.layer === 'customer');
      let baseEval: { outcome: 'allow' | 'deny' | 'no-policy'; ruleId: string | null } | null = null;
      let customerEval: { outcome: 'allow' | 'deny' | 'no-policy'; ruleId: string | null } | null = null;
      if (baseLayer !== undefined && baseLayer.policyId !== null) {
        const contract = await store.findPolicyVersionById(tenantId, baseLayer.policyId);
        if (contract === null) {
          throw new PolicyError('DECISION_REPLAY_MISMATCH', `pinned base policy version ${baseLayer.policyId} is missing`);
        }
        try {
          baseEval = evaluateLayer(contract, decision.input.attributes);
        } catch (error) {
          if (error instanceof PolicyEvaluationError) {
            throw new PolicyError('EVALUATION_TYPE_ERROR', error.message);
          }
          throw error;
        }
      }
      if (customerLayer !== undefined && customerLayer.policyId !== null) {
        const contract = await store.findPolicyVersionById(tenantId, customerLayer.policyId);
        if (contract === null) {
          throw new PolicyError('DECISION_REPLAY_MISMATCH', `pinned customer policy version ${customerLayer.policyId} is missing`);
        }
        try {
          customerEval = evaluateLayer(contract, decision.input.attributes);
        } catch (error) {
          if (error instanceof PolicyEvaluationError) {
            throw new PolicyError('EVALUATION_TYPE_ERROR', error.message);
          }
          throw error;
        }
      }
      const replayed = composeDecision({
        frozen: evaluateFrozenFloor(decision.input.attributes),
        customer: customerEval ?? { outcome: 'no-policy', ruleId: null },
        base: baseEval ?? { outcome: 'no-policy', ruleId: null },
      });
      if (
        replayed.outcome !== decision.outcome ||
        replayed.decidingLayer !== decision.decidingLayer ||
        replayed.decidingRuleId !== decision.decidingRuleId
      ) {
        throw new PolicyError(
          'DECISION_REPLAY_MISMATCH',
          `decision ${decisionId} does not replay: recorded ${decision.outcome}/${decision.decidingLayer}, replayed ${replayed.outcome}/${replayed.decidingLayer}`,
        );
      }
      return decision;
    },
  };
}

/**
 * Module manifest (registered in the composition root's module registry).
 * The manifest declares identity only; the business contract above is the
 * module's public surface.
 */
export default defineModule({
  name: 'policies',
  version: '1.0.0',
  description: 'business-policy resolution and enforcement',
});
