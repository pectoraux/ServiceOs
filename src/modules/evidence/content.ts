/**
 * ServiceOS /evidence content hashing (WORK-007, module internal —
 * exported through the module's public interface).
 *
 * Deterministic hashing disciplines of the business-evidence authority
 * (the same discipline /policies, /verticals, /services, /billing and
 * /zeck apply to their records):
 *
 * - `canonicalJson` — key-sorted, undefined-eliding canonical JSON.
 * - EVIDENCE CONTENT HASH — sha256 over the canonical evidence FACT
 *   (tenant, work, optional attempt, requirement, provenance, payload,
 *   observedAt). ACTOR-INDEPENDENT (the WORK-011 discipline: the
 *   content hash pins the FACT — convergence follows the logical
 *   identity regardless of who re-reports it; the record hash keeps
 *   the recorder). Deliberately EXCLUDES the idempotency key: the same
 *   fact re-attached under a different key converges on ONE durable
 *   row (invariant 6: duplicate evidence attachment converges
 *   deterministically — the (tenant, work, content) unique identity).
 * - EVIDENCE RECORD HASH — sha256 over the full immutable evidence row
 *   core INCLUDING the recorder and the exact attach instant (one
 *   clock read per write: the hash and the row pin the SAME instant).
 *   Recomputed on every read: after-the-fact mutation of any stored
 *   field is DETECTED (typed *_RECORD_TAMPERED).
 * - VERIFICATION CONTENT HASH — sha256 over the verification INPUT:
 *   scope + the validated contract + the exact evidence snapshot the
 *   decision was computed over ({id, contentHash} per record,
 *   attachment order). The verdict is a deterministic function of this
 *   content, so identical content under the same key always converges
 *   on the identical recorded decision; changed evidence or a changed
 *   contract under the same key fails closed
 *   VERIFICATION_INPUT_CONFLICT (a re-verification after evidence
 *   changes is a NEW logical decision and uses a new key).
 * - VERIFICATION RECORD HASH — sha256 over the full immutable decision
 *   row core including the verdict, the requirement mapping, the
 *   decider and the decision instant.
 */
import { createHash } from 'node:crypto';
import type { EvidenceRecord, OutcomeVerificationRecord } from './store.js';

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

// ---------------------------------------------------------------------------
// Evidence records (the immutable attributable fact rows)
// ---------------------------------------------------------------------------

/**
 * The evidence content hash: the canonical CONTENT of the evidence
 * FACT. Actor- and key-independent (convergence follows the fact, not
 * the submitter; the record hash keeps both).
 */
export function computeEvidenceContentHash(fact: {
  tenantId: string;
  serviceWorkId: string;
  workAttemptId: string | null;
  requirement: string;
  provenance: { readonly kind: string; readonly source: string; readonly refs: readonly string[] };
  payload: unknown;
  observedAt: Date;
}): string {
  return sha256Canonical({
    tenantId: fact.tenantId,
    serviceWorkId: fact.serviceWorkId,
    workAttemptId: fact.workAttemptId,
    requirement: fact.requirement,
    provenance: fact.provenance,
    payload: fact.payload,
    observedAt: fact.observedAt,
  });
}

/**
 * The evidence record hash: the full immutable evidence row core
 * (the surrogate row id is assigned by the store and not hashed).
 */
export function computeEvidenceRecordHash(record: EvidenceRecord): string {
  return sha256Canonical({
    tenantId: record.tenantId,
    serviceWorkId: record.serviceWorkId,
    workAttemptId: record.workAttemptId,
    requirement: record.requirement,
    provenance: record.provenance,
    payload: record.payload,
    observedAt: record.observedAt,
    idempotencyKey: record.idempotencyKey,
    contentHash: record.contentHash,
    attachedBy: record.attachedBy,
    attachedAt: record.attachedAt,
  });
}

// ---------------------------------------------------------------------------
// Outcome verifications (the immutable decision rows)
// ---------------------------------------------------------------------------

/**
 * The verification content hash: the canonical verification INPUT —
 * scope + validated contract + the exact evidence snapshot the
 * decision was computed over. The verdict is a pure function of this
 * content, so same-key identical content converges and same-key
 * divergence fails closed.
 */
export function computeVerificationContentHash(input: {
  tenantId: string;
  serviceWorkId: string;
  outcomeId: string;
  verificationMode: string;
  requirements: readonly string[];
  evidenceSnapshot: readonly { readonly id: string; readonly contentHash: string }[];
}): string {
  return sha256Canonical({
    tenantId: input.tenantId,
    serviceWorkId: input.serviceWorkId,
    outcomeId: input.outcomeId,
    verificationMode: input.verificationMode,
    requirements: input.requirements,
    evidenceSnapshot: input.evidenceSnapshot,
  });
}

/**
 * The verification record hash: the full immutable decision row core
 * (the surrogate row id is assigned by the store and not hashed).
 */
export function computeVerificationRecordHash(record: OutcomeVerificationRecord): string {
  return sha256Canonical({
    tenantId: record.tenantId,
    serviceWorkId: record.serviceWorkId,
    outcomeId: record.outcomeId,
    verificationMode: record.verificationMode,
    requirements: record.requirements,
    idempotencyKey: record.idempotencyKey,
    contentHash: record.contentHash,
    verdict: record.verdict,
    requirementResults: record.requirementResults,
    decidedBy: record.decidedBy,
    decidedAt: record.decidedAt,
  });
}
