/**
 * ServiceOS /approvals content hashing (WORK-008, module internal —
 * exported through the module's public interface).
 *
 * Deterministic hashing disciplines of the business/human approval
 * authority (the same discipline /policies, /verticals, /services,
 * /billing, /zeck and /evidence apply to their records):
 *
 * - `canonicalJson` — key-sorted, undefined-eliding canonical JSON.
 * - REQUEST CONTENT HASH — sha256 over the canonical request FACT
 *   (tenant, work, optional attempt, policyKey, subject). EXCLUDES the
 *   requester and the idempotency key: the same request fact under the
 *   same key converges on the durable row, while a divergent fact under
 *   the same key fails closed APPROVAL_REQUEST_INPUT_CONFLICT. It also
 *   EXCLUDES the pinned policy-decision provenance: a same-key retry
 *   converges on the durable row even if the active policy version
 *   drifted since (the durable row keeps its original admission
 *   provenance — the row is the authority).
 * - REQUEST RECORD HASH — sha256 over the full CURRENT request row
 *   core, INCLUDING the mutable authority state (status, decisionId)
 *   and the admission provenance (policyKey, policyDecisionId,
 *   requester, requestedAt). The row carries exactly one hash at a
 *   time, rewritten only by the module's own single decision path;
 *   recomputed on every read: after-the-fact mutation of any stored
 *   field is DETECTED (typed APPROVAL_REQUEST_RECORD_TAMPERED).
 * - DECISION CONTENT HASH — sha256 over the canonical decision INPUT:
 *   scope (tenant) + the decided request + the verdict + the reason.
 *   Same key + identical content converges; same key + divergent
 *   content fails closed APPROVAL_DECISION_INPUT_CONFLICT.
 * - DECISION RECORD HASH — sha256 over the full immutable decision row
 *   core including the decider and the decision instant.
 */
import { createHash } from 'node:crypto';
import type { ApprovalDecisionRecord, ApprovalRequestRecord } from './store.js';

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
// Approval requests (the authority-state rows)
// ---------------------------------------------------------------------------

/**
 * The request content hash: the canonical CONTENT of the request fact
 * (requester- and key-independent; the record hash keeps both).
 */
export function computeApprovalRequestContentHash(fact: {
  tenantId: string;
  serviceWorkId: string;
  workAttemptId: string | null;
  policyKey: string;
  subject: unknown;
}): string {
  return sha256Canonical({
    tenantId: fact.tenantId,
    serviceWorkId: fact.serviceWorkId,
    workAttemptId: fact.workAttemptId,
    policyKey: fact.policyKey,
    subject: fact.subject,
  });
}

/**
 * The request record hash: the full CURRENT row core (the surrogate row
 * id is assigned by the store and not hashed). Covers the authority
 * state — recomputed on every read, rewritten only by the decision path.
 */
export function computeApprovalRequestRecordHash(record: ApprovalRequestRecord): string {
  return sha256Canonical({
    tenantId: record.tenantId,
    serviceWorkId: record.serviceWorkId,
    workAttemptId: record.workAttemptId,
    policyKey: record.policyKey,
    policyDecisionId: record.policyDecisionId,
    subject: record.subject,
    status: record.status,
    idempotencyKey: record.idempotencyKey,
    contentHash: record.contentHash,
    requestedBy: record.requestedBy,
    requestedAt: record.requestedAt,
    decisionId: record.decisionId,
  });
}

// ---------------------------------------------------------------------------
// Approval decisions (the immutable terminal rows)
// ---------------------------------------------------------------------------

/**
 * The decision content hash: the canonical decision INPUT (scope +
 * decided request + verdict + reason). The terminal outcome is a pure
 * function of this content, so same-key identical content converges and
 * same-key divergence fails closed.
 */
export function computeApprovalDecisionContentHash(input: {
  tenantId: string;
  requestId: string;
  decision: string;
  reason: string | null;
}): string {
  return sha256Canonical({
    tenantId: input.tenantId,
    requestId: input.requestId,
    decision: input.decision,
    reason: input.reason,
  });
}

/**
 * The decision record hash: the full immutable decision row core (the
 * surrogate row id is assigned by the store and not hashed).
 */
export function computeApprovalDecisionRecordHash(record: ApprovalDecisionRecord): string {
  return sha256Canonical({
    tenantId: record.tenantId,
    requestId: record.requestId,
    serviceWorkId: record.serviceWorkId,
    decision: record.decision,
    reason: record.reason,
    idempotencyKey: record.idempotencyKey,
    contentHash: record.contentHash,
    decidedBy: record.decidedBy,
    decidedAt: record.decidedAt,
  });
}
