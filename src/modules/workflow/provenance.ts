/**
 * ServiceOS /workflow provenance hashing (WORK-004, module internal —
 * exported through the module's public interface).
 *
 * Deterministic, provider-independent hashing for the transition ledger's
 * tamper-evidence (AC-5): the same canonicalization discipline as the
 * /policies decision records (WORK-014), implemented in this module so the
 * two authorities stay decoupled (cross-module calls use public interfaces;
 * internal implementation imports are forbidden).
 *
 * - `hashTransitionInput` is the durable SUBMISSION identity: sha256 over
 *   the canonical { workId, to, policyKey } core. It deliberately excludes
 *   the from-state: a keyed re-submission re-observes the original
 *   transition even after the work has progressed further (the recorded
 *   `fromState` is the authoritative one).
 * - `hashTransitionRecord` is the integrity hash over the canonical record
 *   core INCLUDING the evaluated preconditions and the single pinned clock
 *   read; every read recomputes it and fails closed on divergence.
 */
import { createHash } from 'node:crypto';

import type { TransitionPreconditions, TransitionRecord } from './store.js';
import type { WorkStatus } from '../work/index.js';

/**
 * Canonical JSON: object keys sorted, no whitespace, deterministic
 * serialization of primitive-bearing structures (the same discipline as
 * /policies' canonicalJson).
 */
export function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => serialize(entry)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${serialize(v)}`).join(',')}}`;
  }
  throw new Error(`cannot canonicalize value of type ${typeof value}`);
}

/** The canonical submission core: durable input identity of a transition. */
export interface TransitionSubmissionCore {
  readonly workId: string;
  readonly to: WorkStatus;
  readonly policyKey: string | null;
}

/** sha256 over the canonical submission core (the input_hash column). */
export function hashTransitionInput(core: TransitionSubmissionCore): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        workId: core.workId,
        to: core.to,
        policyKey: core.policyKey,
      }),
    )
    .digest('hex');
}

/** The canonical record core: every field the integrity hash covers. */
export interface TransitionRecordCore {
  readonly tenantId: string;
  readonly workId: string;
  readonly seq: number;
  readonly fromState: WorkStatus;
  readonly toState: WorkStatus;
  readonly ruleId: string;
  readonly preconditions: TransitionPreconditions;
  readonly reason: string | null;
  readonly transitionedBy: string;
  readonly idempotencyKey: string | null;
  readonly inputHash: string;
  readonly createdAt: string;
}

/** sha256 over the canonical record core (the record_hash column). */
export function hashTransitionRecord(core: TransitionRecordCore): string {
  return createHash('sha256').update(canonicalJson(core)).digest('hex');
}

/** Recompute the record hash from a durable transition record. */
export function computeTransitionRecordHash(record: TransitionRecord): string {
  return hashTransitionRecord({
    tenantId: record.tenantId,
    workId: record.workId,
    seq: record.seq,
    fromState: record.fromState,
    toState: record.toState,
    ruleId: record.ruleId,
    preconditions: record.preconditions,
    reason: record.reason,
    transitionedBy: record.transitionedBy,
    idempotencyKey: record.idempotencyKey,
    inputHash: record.inputHash,
    createdAt: record.createdAt.toISOString(),
  });
}
