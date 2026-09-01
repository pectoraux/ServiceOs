/**
 * ServiceOS /policies deterministic evaluation engine (WORK-014, module
 * internal — exported through the module's public interface).
 *
 * This is the ONE business-policy evaluator in ServiceOS
 * (architecture-lock #2: `/policies` is the sole ServiceOS authority for
 * business-policy resolution). It is provider-independent by construction:
 *
 * - PURE: no clock, no randomness, no I/O, no model/provider/agent call of
 *   any kind. The same (rules, defaultEffect, input) always produce the
 *   same layer outcome (AC-2).
 * - COMPOSITION: a policy decision is composed from three layers with
 *   deny-dominates semantics — the frozen floor, the tenant's active base
 *   (service/vertical default) contract, and the tenant's active customer
 *   override. A more specific layer may TIGHTEN (deny where broader layers
 *   allow) but can never WEAKEN (an allow in the customer layer cannot
 *   defeat a deny from the base layer or the frozen floor) — AC-3 and
 *   architecture-lock #33.
 * - FAIL CLOSED: with no active base policy the decision is `deny`
 *   (a policy gate with no policy never grants anything).
 *
 * The frozen floor encodes authority/security invariants from the frozen
 * v1.0 architecture in policy-input terms: capabilities that no
 * customer/vertical configuration may ever grant (authorization replacement,
 * policy-gate bypass, AI authority inside ServiceOS, AI credentials,
 * cross-tenant data access, audit tampering, governance rewrite). These are
 * CODE — not database rows — so no configuration can weaken them; the frozen
 * revision identifier is pinned to the architecture version.
 *
 * Decision provenance (AC-5): every evaluation records the exact rule that
 * decided each layer (rule id), the policy id/version consulted per layer,
 * the frozen revision, and a deterministic hash of the canonical input.
 */
import { createHash } from 'node:crypto';

import type { PolicyRule, PolicyRuleset } from './store.js';

// ---------------------------------------------------------------------------
// Frozen floor
// ---------------------------------------------------------------------------

/**
 * The frozen-floor revision, pinned to the frozen architecture version.
 * Recorded in every decision record (provenance: which frozen revision
 * bound the decision).
 */
export const FROZEN_POLICY_REVISION = 'frozen-v1.0';

/**
 * Capabilities that customer/vertical configuration can never grant. Each
 * encodes a frozen authority/security invariant:
 *
 * - `authorization-bypass` — /organizations owns the single authorization
 *   chain; policy can never replace or bypass it (authority matrix).
 * - `policy-gate-bypass` — external side effects require the policy gate
 *   (architecture.md §13); the gate itself can never be waived.
 * - `ai-authority` — Zeck is the sole AI execution authority; ServiceOS may
 *   not become an AI authority through configuration (architecture-lock #6/#7).
 * - `ai-credentials` — AI provider secrets never reside in ServiceOS
 *   (architecture-lock #17).
 * - `cross-tenant-data` — tenant ownership is resolved server-side and
 *   cross-tenant access fails closed (architecture-lock #15/#16).
 * - `audit-rewrite` — the /audit trail is append-only; no policy may
 *   authorize rewriting it (authority matrix).
 * - `governance-rewrite` — frozen architecture and Work Orders cannot be
 *   rewritten in place (architecture-lock #21/#23/#24).
 */
export const FROZEN_DENIED_CAPABILITIES: readonly string[] = [
  'authorization-bypass',
  'policy-gate-bypass',
  'ai-authority',
  'ai-credentials',
  'cross-tenant-data',
  'audit-rewrite',
  'governance-rewrite',
];

/** The attribute name the frozen floor consults (reserved). */
export const FROZEN_CAPABILITY_ATTRIBUTE = 'capability';

/**
 * Frozen floor outcome. `deny` means a frozen invariant vetoed the input
 * (absolute: no layer can override it); `allow` means the floor expresses
 * no opinion (the floor never grants, it only vetoes).
 */
export interface FrozenFloorEvaluation {
  readonly outcome: 'allow' | 'deny';
  readonly ruleId: string | null;
}

export function evaluateFrozenFloor(attributes: Readonly<Record<string, PolicyInputValue>>): FrozenFloorEvaluation {
  const capability = attributes[FROZEN_CAPABILITY_ATTRIBUTE];
  if (typeof capability === 'string' && FROZEN_DENIED_CAPABILITIES.includes(capability)) {
    return { outcome: 'deny', ruleId: `frozen:denied-capability:${capability}` };
  }
  return { outcome: 'allow', ruleId: null };
}

// ---------------------------------------------------------------------------
// Deterministic layer evaluation
// ---------------------------------------------------------------------------

/** Primitive, JSON-serializable policy attribute values. */
export type PolicyInputValue = string | number | boolean | null;

export interface PolicyInput {
  /** Opaque business action being gated (e.g. 'side-effect:email.send'). */
  readonly action: string;
  /** Flat, primitive-valued input attributes (deterministic evaluation). */
  readonly attributes: Readonly<Record<string, PolicyInputValue>>;
}

/** One layer's evaluation outcome. `no-policy` = no active contract. */
export type LayerOutcome = 'allow' | 'deny' | 'no-policy';

export interface LayerEvaluation {
  readonly outcome: LayerOutcome;
  readonly ruleId: string | null;
}

export class PolicyEvaluationError extends Error {
  constructor(message: string, readonly code: 'TYPE_MISMATCH') {
    super(message);
    this.name = 'PolicyEvaluationError';
  }
}

/**
 * Evaluate one ruleset deterministically: rules are evaluated in declared
 * order; the FIRST matching rule decides the layer; when no rule matches,
 * the contract's default effect decides. A ruleset always yields allow/deny.
 */
export function evaluateLayer(
  ruleset: PolicyRuleset,
  attributes: Readonly<Record<string, PolicyInputValue>>,
): LayerEvaluation {
  for (const rule of ruleset.rules) {
    if (matches(rule.when, attributes)) {
      return { outcome: rule.effect, ruleId: rule.id };
    }
  }
  return { outcome: ruleset.defaultEffect, ruleId: null };
}

/** Deterministic condition matching (documented absence semantics). */
function matches(condition: PolicyRule['when'], attributes: Readonly<Record<string, PolicyInputValue>>): boolean {
  if (condition.kind === 'always') {
    return true;
  }
  const value = attributes[condition.name];
  if (value === undefined) {
    // An absent attribute never matches any operator: rules about an
    // attribute presuppose its presence. (Deterministic and conservative:
    // the contract's default effect governs inputs that omit it.)
    return false;
  }
  switch (condition.operator) {
    case 'eq':
      return value === condition.value;
    case 'ne':
      return value !== condition.value;
    case 'in':
      return condition.value.includes(value as string | number | boolean);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      if (typeof value !== 'number' || typeof condition.value !== 'number') {
        // Fail closed: an ordered comparison on a non-number attribute is a
        // contract/caller type drift, not a policy outcome.
        throw new PolicyEvaluationError(
          `ordered comparison "${condition.operator}" requires a number for attribute "${condition.name}"`,
          'TYPE_MISMATCH',
        );
      }
      if (condition.operator === 'gt') return value > condition.value;
      if (condition.operator === 'gte') return value >= condition.value;
      if (condition.operator === 'lt') return value < condition.value;
      return value <= condition.value;
    }
    case 'contains': {
      if (typeof value !== 'string' || typeof condition.value !== 'string') {
        throw new PolicyEvaluationError(
          `substring comparison "contains" requires a string for attribute "${condition.name}"`,
          'TYPE_MISMATCH',
        );
      }
      return value.includes(condition.value);
    }
  }
}

// ---------------------------------------------------------------------------
// Decision composition (deny-dominates, precedence, fail closed)
// ---------------------------------------------------------------------------

export type DecidingLayer = 'frozen' | 'customer' | 'base' | 'default';

export interface ComposedDecision {
  readonly outcome: 'allow' | 'deny';
  readonly decidingLayer: DecidingLayer;
  readonly decidingRuleId: string | null;
}

export interface ComposableLayer {
  readonly outcome: LayerOutcome;
  readonly ruleId: string | null;
}

/**
 * Compose the policy decision from the three evaluated layers.
 *
 * Precedence (strictest rule first — deny dominates):
 *   1. frozen floor deny  -> DENY (decided by 'frozen'; absolute)
 *   2. customer deny      -> DENY (decided by 'customer'; tightening)
 *   3. base deny          -> DENY (decided by 'base'; an override allow
 *                                  cannot weaken the base deny — AC-3)
 *   4. no active base     -> DENY (decided by 'default'; fail closed — a
 *      customer override alone can never open a gate that has no base
 *      policy: grants require the service-defined baseline)
 *   5. customer allow     -> ALLOW (decided by 'customer'; most specific)
 *   6. base allow         -> ALLOW (decided by 'base')
 *
 * Determinism: the composition is a pure function of the layer outcomes.
 */
export function composeDecision(input: {
  frozen: FrozenFloorEvaluation;
  customer: ComposableLayer;
  base: ComposableLayer;
}): ComposedDecision {
  if (input.frozen.outcome === 'deny') {
    return { outcome: 'deny', decidingLayer: 'frozen', decidingRuleId: input.frozen.ruleId };
  }
  if (input.customer.outcome === 'deny') {
    return { outcome: 'deny', decidingLayer: 'customer', decidingRuleId: input.customer.ruleId };
  }
  if (input.base.outcome === 'deny') {
    return { outcome: 'deny', decidingLayer: 'base', decidingRuleId: input.base.ruleId };
  }
  if (input.base.outcome === 'no-policy') {
    // Fail closed: with no active base policy there is no baseline to
    // specialize. Deny-only customer overrides still applied above
    // (tightening); an override alone never grants.
    return { outcome: 'deny', decidingLayer: 'default', decidingRuleId: null };
  }
  if (input.customer.outcome === 'allow') {
    return { outcome: 'allow', decidingLayer: 'customer', decidingRuleId: input.customer.ruleId };
  }
  // base.outcome === 'allow' (and customer absent or no-policy).
  return { outcome: 'allow', decidingLayer: 'base', decidingRuleId: input.base.ruleId };
}

// ---------------------------------------------------------------------------
// Canonical hashing (input revision + decision-record integrity)
// ---------------------------------------------------------------------------

/** Canonical JSON for policy hashing: recursively object-key-sorted. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * The deterministic input revision: SHA-256 over the canonical (action,
 * attributes) pair. Two structurally identical inputs hash identically
 * regardless of attribute insertion order (AC-5 "relevant input revision").
 */
export function hashPolicyInput(input: PolicyInput): string {
  return createHash('sha256').update(canonicalJson({ action: input.action, attributes: input.attributes })).digest('hex');
}

/**
 * The decision-record integrity hash: SHA-256 over the canonical core of the
 * decision record. Persisted with every decision; recomputed on read so any
 * after-the-fact mutation of a recorded result is DETECTED (Work Order
 * discrimination requirement).
 */
export function hashDecisionRecord(core: {
  tenantId: string;
  policyKey: string;
  outcome: 'allow' | 'deny';
  decidingLayer: DecidingLayer;
  decidingRuleId: string | null;
  frozenRevision: string;
  layers: readonly unknown[];
  input: PolicyInput;
  inputHash: string;
  decidedBy: string;
  createdAt: string;
}): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        tenantId: core.tenantId,
        policyKey: core.policyKey,
        outcome: core.outcome,
        decidingLayer: core.decidingLayer,
        decidingRuleId: core.decidingRuleId,
        frozenRevision: core.frozenRevision,
        layers: core.layers,
        input: core.input,
        inputHash: core.inputHash,
        decidedBy: core.decidedBy,
        createdAt: core.createdAt,
      }),
    )
    .digest('hex');
}
