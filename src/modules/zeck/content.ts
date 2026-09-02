/**
 * ServiceOS /zeck content hashing (WORK-005, module internal —
 * exported through the module's public interface).
 *
 * Deterministic hashing disciplines of the Zeck integration boundary
 * (the same discipline /policies, /verticals, /services and /billing
 * apply to their records):
 *
 * - `canonicalJson` — key-sorted, undefined-eliding canonical JSON.
 * - content hashes — sha256 over the canonical CONTENT:
 *   intents over the full validated intent payload (the logical AI
 *   Execution Intent — keyed convergence is actor-independent); callback
 *   events over the DELIVERY ENVELOPE as received (eventId, eventType,
 *   execution correlation, occurredAt, raw payload — the replay
 *   identity: identical re-delivery converges, divergence conflicts).
 * - record hashes — sha256 over the canonical record CORE including the
 *   exact clock instant persisted with the write (one clock read per
 *   write: the hash and the row pin the SAME instant). Recomputed on
 *   every read: after-the-fact mutation of a stored field is DETECTED
 *   (typed *_RECORD_TAMPERED).
 *
 * The intent record hash deliberately includes the execution reference
 * and ingestion metadata columns: any after-the-fact tampering of the
 * foreign reference linkage or the last-seen event cursor is detected
 * on read.
 */
import { createHash } from 'node:crypto';
import type { ZeckIntentRecord, ZeckCallbackEventRecord } from './store.js';

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
// Execution intents (the business-side linkage record)
// ---------------------------------------------------------------------------

/**
 * The intent content hash: the canonical CONTENT of the logical AI
 * Execution Intent. Actor-independent (which principal submitted the
 * same logical intent does not change convergence); the record hash
 * keeps the actor.
 */
export function computeIntentContentHash(record: {
  tenantId: string;
  serviceWorkId: string;
  workAttemptId: string;
  objective: string;
  inputArtifactRefs: readonly string[];
  businessContext: unknown;
  requiredCapabilities: unknown;
  businessConstraints: unknown;
  outputContract: unknown;
  idempotencyKey: string;
}): string {
  return sha256Canonical({
    tenantId: record.tenantId,
    serviceWorkId: record.serviceWorkId,
    workAttemptId: record.workAttemptId,
    objective: record.objective,
    inputArtifactRefs: record.inputArtifactRefs,
    businessContext: record.businessContext,
    requiredCapabilities: record.requiredCapabilities,
    businessConstraints: record.businessConstraints,
    outputContract: record.outputContract,
    idempotencyKey: record.idempotencyKey,
  });
}

/** The intent record hash: content + lifecycle/reference/ingestion core.
 * The surrogate row id is deliberately NOT hashed (it is assigned by
 * the store; the integrity core is the tenant-scoped business state). */
export function computeIntentRecordHash(record: ZeckIntentRecord): string {
  return sha256Canonical({
    tenantId: record.tenantId,
    serviceWorkId: record.serviceWorkId,
    workAttemptId: record.workAttemptId,
    objective: record.objective,
    inputArtifactRefs: record.inputArtifactRefs,
    businessContext: record.businessContext,
    requiredCapabilities: record.requiredCapabilities,
    businessConstraints: record.businessConstraints,
    outputContract: record.outputContract,
    idempotencyKey: record.idempotencyKey,
    contentHash: record.contentHash,
    createdBy: record.createdBy,
    zeckExecutionId: record.zeckExecutionId,
    zeckApplicationRef: record.zeckApplicationRef,
    submittedBy: record.submittedBy,
    submittedAt: record.submittedAt,
    lastSeenEventId: record.lastSeenEventId,
    lastSeenAt: record.lastSeenAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

// ---------------------------------------------------------------------------
// Callback events (translated observations; the delivery ledger)
// ---------------------------------------------------------------------------

/**
 * The delivery content hash: the canonical content of ONE callback
 * delivery as received (the replay identity — eventId, event type,
 * execution correlation, occurrence instant, RAW payload). Identical
 * re-delivery converges; divergence for the same event identity fails
 * closed.
 */
export function computeEventDeliveryHash(delivery: {
  tenantId: string;
  eventId: string;
  eventType: string;
  zeckExecutionId: string | null;
  occurredAt: Date;
  rawPayload: unknown;
}): string {
  return sha256Canonical({
    tenantId: delivery.tenantId,
    eventId: delivery.eventId,
    eventType: delivery.eventType,
    zeckExecutionId: delivery.zeckExecutionId,
    occurredAt: delivery.occurredAt,
    rawPayload: delivery.rawPayload,
  });
}

/** The event record hash: the full immutable delivery row core (the
 * surrogate row id is assigned by the store and not hashed). */
export function computeEventRecordHash(record: ZeckCallbackEventRecord): string {
  return sha256Canonical({
    tenantId: record.tenantId,
    eventId: record.eventId,
    eventType: record.eventType,
    zeckExecutionId: record.zeckExecutionId,
    intentId: record.intentId,
    disposition: record.disposition,
    rejectionCode: record.rejectionCode,
    observed: record.observed,
    deliveryHash: record.deliveryHash,
    receivedBy: record.receivedBy,
    receivedAt: record.receivedAt,
  });
}
