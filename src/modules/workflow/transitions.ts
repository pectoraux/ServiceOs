/**
 * ServiceOS /workflow canonical transition table (WORK-004, module internal
 * — exported through the module's public interface).
 *
 * This is the ONE deterministic Service Work transition authority's rule set
 * (architecture.md §7; architecture-lock #1: `/work` + `/workflow` are the
 * sole ServiceOS authority for Service Work identity and business-work state
 * transitions). It is:
 *
 * - FROZEN CODE, NEVER DATA: the canonical machine is the closed enumeration
 *   below. No rule input, configuration, vertical package or provider can
 *   add, remove or reshape a legal transition (Work Order forbidden zone:
 *   vertical-specific semantics). A second transition table elsewhere is an
 *   architecture violation (checked structurally).
 * - DETERMINISTIC: `isLegalTransition(from, to)` is a pure function of the
 *   table; the same (from, to) always yields the same answer.
 * - ZECK-FREE: nothing here consults execution status, models, providers or
 *   any external state (AC-3: Zeck execution status can never directly
 *   mutate Service Work state — foreign results are business INPUTS that
 *   flow through an explicit `submitTransition` decision only).
 *
 * The machine (architecture.md §7), with the two waiting/blocked states able
 * to loop back into in_progress and verifying able to rework into in_progress:
 *
 *   draft -> ready -> accepted -> in_progress
 *     in_progress <-> waiting_information | waiting_approval | blocked
 *     in_progress -> verifying; verifying -> in_progress (rework)
 *     verifying -> completed
 *   COMPLETED and the alternative terminal states CANCELLED/FAILED/EXPIRED
 *   are absorbing: no outgoing transitions exist.
 *
 * Terminal-state entries: the architecture lists CANCELLED/FAILED/EXPIRED as
 * alternative terminal states without source arrows. The deterministic
 * canonical reading encoded here: each is enterable from every NON-terminal
 * state (business cancel/fail/expire decisions are legal from any live
 * state) and from no terminal state (terminal is terminal).
 */
import type { WorkStatus } from '../work/index.js';

/** Every canonical Service Work business state (lowercase, matches the schema). */
export const WORKFLOW_STATES: readonly WorkStatus[] = [
  'draft',
  'ready',
  'accepted',
  'in_progress',
  'waiting_information',
  'waiting_approval',
  'blocked',
  'verifying',
  'completed',
  'cancelled',
  'failed',
  'expired',
];

/** States with no outgoing transitions (absorbing). */
export const TERMINAL_STATES: readonly WorkStatus[] = ['completed', 'cancelled', 'failed', 'expired'];

/** Waiting/blocked states that may loop back into in_progress. */
export const RESUMABLE_STATES: readonly WorkStatus[] = [
  'waiting_information',
  'waiting_approval',
  'blocked',
];

export function isTerminal(state: WorkStatus): boolean {
  return TERMINAL_STATES.includes(state);
}

/**
 * The canonical legal-transition table. Keys are the full state enumeration;
 * every value is a closed, ordered list. `draft` can only move forward to
 * `ready` or exit to a terminal state; `in_progress` reaches the waiting/
 * blocked loop states and `verifying`; only `verifying` reaches `completed`.
 */
export const CANONICAL_TRANSITIONS: Readonly<Record<WorkStatus, readonly WorkStatus[]>> = {
  draft: ['ready', 'cancelled', 'failed', 'expired'],
  ready: ['accepted', 'cancelled', 'failed', 'expired'],
  accepted: ['in_progress', 'cancelled', 'failed', 'expired'],
  in_progress: [
    'waiting_information',
    'waiting_approval',
    'blocked',
    'verifying',
    'cancelled',
    'failed',
    'expired',
  ],
  waiting_information: ['in_progress', 'cancelled', 'failed', 'expired'],
  waiting_approval: ['in_progress', 'cancelled', 'failed', 'expired'],
  blocked: ['in_progress', 'cancelled', 'failed', 'expired'],
  verifying: ['in_progress', 'completed', 'cancelled', 'failed', 'expired'],
  completed: [],
  cancelled: [],
  failed: [],
  expired: [],
};

/** Is (from -> to) a legal canonical transition? Pure table lookup. */
export function isLegalTransition(from: WorkStatus, to: WorkStatus): boolean {
  const targets = CANONICAL_TRANSITIONS[from];
  return targets !== undefined && targets.includes(to);
}

/**
 * The deterministic rule id authorizing a transition: happy-path/loop edges
 * carry `canonical:<from>-><to>`; terminal-entry edges carry
 * `terminal:<to>`. The rule id is recorded in every durable transition row
 * (audit provenance) and is derived, never caller-supplied.
 */
export function transitionRuleId(from: WorkStatus, to: WorkStatus): string {
  if (to === 'cancelled' || to === 'failed' || to === 'expired') {
    return `terminal:${to}`;
  }
  return `canonical:${from}->${to}`;
}

/** One admissible continuation of a state (the read-side hook's unit). */
export interface Continuation {
  readonly to: WorkStatus;
  readonly ruleId: string;
  readonly terminal: boolean;
}

/**
 * The admissible continuations of one state, in canonical order — the
 * deterministic derivation the orchestration hook surfaces (architecture.md
 * §9 "scheduling explicit workflow continuation" consumes this and still
 * submits through the same transition boundary).
 */
export function listLegalTransitions(from: WorkStatus): readonly Continuation[] {
  const targets = CANONICAL_TRANSITIONS[from];
  if (targets === undefined) {
    return [];
  }
  return targets.map((to) => ({ to, ruleId: transitionRuleId(from, to), terminal: isTerminal(to) }));
}

/**
 * Guard: is a state a member of the closed enumeration? Used to fail closed
 * on out-of-enumeration input before any store access.
 */
export function isWorkflowState(value: string): value is WorkStatus {
  return (WORKFLOW_STATES as readonly string[]).includes(value);
}
