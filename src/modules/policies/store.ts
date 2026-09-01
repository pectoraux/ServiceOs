/**
 * ServiceOS /policies store port (WORK-014).
 *
 * The persistence contract for versioned policy contracts and policy
 * decision records. The authoritative implementation is the SQL store
 * executed through the persistence boundary's `TransactionalExecutor`
 * (client-pinned transactions); tests inject a faithful in-memory
 * implementation of this same port.
 *
 * Store contract semantics (mirrored by every implementation):
 *
 * - TENANT PREDICATES ARE MANDATORY. Every lookup and list carries the
 *   tenant parameter in its signature and its query; a row in another
 *   tenant is indistinguishable from a missing row (architecture-lock
 *   #15/#16; a missing read stays distinguishable from an empty result,
 *   lock #30).
 *
 * - POLICY CONTRACTS ARE VERSIONED AND IMMUTABLE IN CONTENT. A version row
 *   is created as `draft` and its rule set is never updated in place:
 *   `activatePolicyVersion` moves publication state forward only
 *   (`draft` -> `active`; the previously active version of the same
 *   (tenant, policy key, scope) becomes `retired` first — the one-active
 *   partial unique index is per-statement, so retirement precedes
 *   activation, exactly like WORK-003's supersede-then-insert ordering).
 *   A `retired` version can never return to `active` (forward-only).
 *   Activation of an already-active version converges (idempotent).
 *
 * - CONVERGENCE, NOT DUPLICATION. `createPolicyVersion` is idempotent by
 *   durable identity: the same logical creation (tenant + idempotency key)
 *   converges on ONE durable version row (concurrent creators receive the
 *   same identity). Version numbers are per (tenant, policy key, scope),
 *   allocated under a lock so concurrent creations never collide.
 *
 * - DECISIONS ARE DURABLE, IDEMPOTENT AND REVISION-BOUND.
 *   `recordDecision` persists the module-composed decision together with
 *   its provenance (per-layer policy id/version, frozen revision, input
 *   hash, record hash). Re-delivery with the same (tenant, idempotency
 *   key) and the same input hash converges on the existing record; a
 *   divergent input for the same key fails closed with rule
 *   `decision-input-conflict` (a policy gate may never be silently
 *   re-pointed at different input). Decision records are immutable after
 *   write; reads verify the persisted record hash (rule
 *   `decision-record-tampered` when a stored field no longer matches its
 *   persisted integrity hash).
 *
 * - Resolution snapshots are truthful: `findActivePolicyVersion` reads the
 *   currently active version of one (tenant, policy key, scope); the
 *   module pins exactly what it consulted into the decision record.
 */
import type { PolicyInput, PolicyInputValue } from './evaluation.js';

export type { PolicyInput, PolicyInputValue } from './evaluation.js';

/** Where a policy contract applies in the precedence stack. */
export type PolicyScope = 'base' | 'customer';

/**
 * Publication state of a policy version row. This is contract VERSIONING,
 * not the Service Work workflow state machine: `draft` → `active` (forward
 * only, one active per identity), `retired` is terminal.
 */
export type PolicyStatus = 'draft' | 'active' | 'retired';

/** The effect a rule (or a contract's default) yields. */
export type PolicyEffect = 'allow' | 'deny';

export type PolicyConditionOperator =
  | 'eq'
  | 'ne'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'in'
  | 'contains';

export type PolicyCondition =
  | { readonly kind: 'always' }
  | { readonly kind: 'attribute'; readonly name: string; readonly operator: 'eq' | 'ne'; readonly value: PolicyInputValue }
  | {
      readonly kind: 'attribute';
      readonly name: string;
      readonly operator: 'gt' | 'gte' | 'lt' | 'lte';
      readonly value: number;
    }
  | { readonly kind: 'attribute'; readonly name: string; readonly operator: 'in'; readonly value: readonly PolicyInputValue[] }
  | { readonly kind: 'attribute'; readonly name: string; readonly operator: 'contains'; readonly value: string };

export interface PolicyRule {
  /** Stable rule identity within the contract (decision provenance). */
  readonly id: string;
  readonly description?: string;
  readonly when: PolicyCondition;
  readonly effect: PolicyEffect;
}

export interface PolicyRuleset {
  /** Ordered: the first matching rule decides the layer. */
  readonly rules: readonly PolicyRule[];
  /** Layer outcome when no rule matches. */
  readonly defaultEffect: PolicyEffect;
}

/** Durable, immutable-in-content policy version. */
export interface PolicyContractRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly policyKey: string;
  readonly scope: PolicyScope;
  readonly version: number;
  readonly status: PolicyStatus;
  readonly rules: readonly PolicyRule[];
  readonly defaultEffect: PolicyEffect;
  readonly createdBy: string;
  readonly idempotencyKey: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** One precedence layer recorded in a decision's provenance. */
export interface PolicyLayerProvenance {
  readonly layer: 'frozen' | 'customer' | 'base';
  /** The policy version consulted (null for the code-defined floor). */
  readonly policyId: string | null;
  readonly version: number | null;
  readonly outcome: 'allow' | 'deny' | 'no-policy';
  readonly ruleId: string | null;
}

/** Durable, attributable, revision-bound policy decision. */
export interface PolicyDecisionRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly policyKey: string;
  readonly outcome: PolicyEffect;
  readonly decidingLayer: 'frozen' | 'customer' | 'base' | 'default';
  readonly decidingRuleId: string | null;
  readonly frozenRevision: string;
  readonly layers: readonly PolicyLayerProvenance[];
  readonly input: PolicyInput;
  readonly inputHash: string;
  readonly recordHash: string;
  readonly decidedBy: string;
  readonly idempotencyKey: string | null;
  readonly createdAt: Date;
}

// ---------------------------------------------------------------------------
// Store rule errors (atomic, typed)
// ---------------------------------------------------------------------------

export type PolicyStoreRule = 'version-retired' | 'decision-input-conflict' | 'decision-record-tampered';

export class PolicyStoreRuleError extends Error {
  constructor(message: string, readonly rule: PolicyStoreRule) {
    super(message);
    this.name = 'PolicyStoreRuleError';
  }
}

/** Single-row mutation/lookup target absent (scoped by the tenant predicate). */
export class PolicyStoreMissingError extends Error {
  constructor(message: string, readonly what: 'policy-version' | 'decision') {
    super(message);
    this.name = 'PolicyStoreMissingError';
  }
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface CreatePolicyVersionInput {
  readonly tenantId: string;
  readonly policyKey: string;
  readonly scope: PolicyScope;
  readonly rules: readonly PolicyRule[];
  readonly defaultEffect: PolicyEffect;
  readonly createdBy: string;
  readonly idempotencyKey: string | null;
  readonly now: Date;
}

export interface ActivatePolicyVersionInput {
  readonly tenantId: string;
  readonly versionId: string;
  readonly now: Date;
}

export interface RecordDecisionInput {
  readonly tenantId: string;
  readonly policyKey: string;
  readonly decidedBy: string;
  readonly idempotencyKey: string | null;
  readonly outcome: PolicyEffect;
  readonly decidingLayer: 'frozen' | 'customer' | 'base' | 'default';
  readonly decidingRuleId: string | null;
  readonly frozenRevision: string;
  readonly layers: readonly PolicyLayerProvenance[];
  readonly input: PolicyInput;
  readonly inputHash: string;
  readonly recordHash: string;
  readonly now: Date;
}

// ---------------------------------------------------------------------------
// Store port
// ---------------------------------------------------------------------------

export interface PolicyStore {
  /**
   * Atomically create a policy version (`draft`). Same tenant + idempotency
   * key converges on the existing durable identity; version numbers are
   * allocated per (tenant, policy key, scope) under a lock.
   */
  createPolicyVersion(input: CreatePolicyVersionInput): Promise<{ contract: PolicyContractRecord; converged: boolean }>;
  /** Tenant-predicated lookup; null when absent in this tenant. */
  findPolicyVersionById(tenantId: string, versionId: string): Promise<PolicyContractRecord | null>;
  /** Tenant-predicated list of versions for one policy key (optionally one scope), oldest version first. */
  listPolicyVersions(tenantId: string, policyKey: string, scope?: PolicyScope): Promise<PolicyContractRecord[]>;
  /**
   * The currently active version for one (tenant, policy key, scope), or
   * null. Resolution reads exactly what the decision will pin.
   */
  findActivePolicyVersion(tenantId: string, policyKey: string, scope: PolicyScope): Promise<PolicyContractRecord | null>;
  /**
   * Atomically move a version to `active`: the currently active version of
   * the same identity is retired FIRST (one-active partial unique index),
   * then this version is activated. Forward-only: a `retired` version
   * throws rule `version-retired`; activating the already-active version
   * converges.
   */
  activatePolicyVersion(input: ActivatePolicyVersionInput): Promise<{ contract: PolicyContractRecord; converged: boolean }>;
  /**
   * Persist the composed decision with provenance. Same (tenant,
   * idempotency key) + same input hash converges on the durable record;
   * a different input hash for the same key throws rule
   * `decision-input-conflict`. Fresh keys insert.
   */
  recordDecision(input: RecordDecisionInput): Promise<{ decision: PolicyDecisionRecord; converged: boolean }>;
  /**
   * Tenant-predicated decision lookup. Implementations verify the persisted
   * record hash against the stored fields and throw rule
   * `decision-record-tampered` when they diverge (after-the-fact mutation
   * detection).
   */
  findDecisionById(tenantId: string, decisionId: string): Promise<PolicyDecisionRecord | null>;
  /** Tenant-predicated lookup by idempotency key; null when absent. */
  findDecisionByIdempotencyKey(tenantId: string, idempotencyKey: string): Promise<PolicyDecisionRecord | null>;
}
