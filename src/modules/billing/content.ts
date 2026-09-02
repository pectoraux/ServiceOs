/**
 * ServiceOS /billing content hashing (WORK-011, module internal —
 * exported through the module's public interface).
 *
 * Deterministic hashing disciplines of the billing authority (the same
 * discipline /policies, /verticals and /services apply to their records):
 *
 * - `canonicalJson` — key-sorted, undefined-eliding canonical JSON.
 * - content hashes — sha256 over the canonical CONTENT (convergence
 *   matching for duplicate registrations of the same logical identity:
 *   subscriptions by idempotency key, usage by source reference, ledger
 *   entries by (subscription, period), cost references by key).
 * - record hashes — sha256 over the canonical record CORE including the
 *   exact clock instant persisted with the write (one clock read per
 *   write: the hash and the row pin the SAME instant). Recomputed on
 *   every read: after-the-fact mutation of a stored field is DETECTED
 *   (typed *_RECORD_TAMPERED).
 *
 * Date fields are hashed through their ISO string (explicit extraction —
 * a raw Date would canonicalize as an empty object).
 */
import { createHash } from 'node:crypto';
import type {
  BillingLedgerRecord,
  BillingSubscriptionRecord,
  CostReferenceRecord,
  UsageRecord,
} from './store.js';

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
// Subscriptions
// ---------------------------------------------------------------------------

export function computeSubscriptionContentHash(record: {
  tenantId: string;
  serviceId: string;
  serviceVersion: number;
  plan: unknown;
}): string {
  // EXPLICIT extraction: the content hash pins the business content of
  // the subscription (what it bills), independent of lifecycle state and
  // of which authorized principal registered it (keyed convergence is
  // actor-independent — the record hash keeps the actor).
  return sha256Canonical({
    tenantId: record.tenantId,
    serviceId: record.serviceId,
    serviceVersion: record.serviceVersion,
    plan: record.plan,
  });
}

export function computeSubscriptionRecordHash(record: BillingSubscriptionRecord): string {
  return sha256Canonical({
    tenantId: record.tenantId,
    serviceId: record.serviceId,
    serviceVersion: record.serviceVersion,
    status: record.status,
    plan: record.plan,
    createdBy: record.createdBy,
    idempotencyKey: record.idempotencyKey,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    cancelledAt: record.cancelledAt === null ? null : record.cancelledAt.toISOString(),
    contentHash: record.contentHash,
  });
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export function computeUsageContentHash(record: {
  tenantId: string;
  subscriptionId: string;
  serviceId: string;
  serviceVersion: number;
  source: string;
  metric: string;
  unit: string;
  quantity: string;
  workId: string | null;
  outcomeId: string | null;
  occurredAt: Date;
  billingPeriod: string;
}): string {
  // The content hash pins the BILLABLE EVENT (what is charged), not the
  // recording actor: duplicate metering of the same billable work by any
  // authorized principal converges — duplicate billable work can never
  // double-charge regardless of who re-reports it (the record hash keeps
  // the actor).
  return sha256Canonical({
    tenantId: record.tenantId,
    subscriptionId: record.subscriptionId,
    serviceId: record.serviceId,
    serviceVersion: record.serviceVersion,
    source: record.source,
    metric: record.metric,
    unit: record.unit,
    quantity: record.quantity,
    workId: record.workId,
    outcomeId: record.outcomeId,
    occurredAt: record.occurredAt.toISOString(),
    billingPeriod: record.billingPeriod,
  });
}

export function computeUsageRecordHash(record: UsageRecord): string {
  return sha256Canonical({
    tenantId: record.tenantId,
    subscriptionId: record.subscriptionId,
    serviceId: record.serviceId,
    serviceVersion: record.serviceVersion,
    source: record.source,
    metric: record.metric,
    unit: record.unit,
    quantity: record.quantity,
    workId: record.workId,
    outcomeId: record.outcomeId,
    occurredAt: record.occurredAt.toISOString(),
    billingPeriod: record.billingPeriod,
    settledLedgerId: record.settledLedgerId,
    createdBy: record.createdBy,
    idempotencyKey: record.idempotencyKey,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    contentHash: record.contentHash,
  });
}

// ---------------------------------------------------------------------------
// Ledger entries
// ---------------------------------------------------------------------------

export function computeLedgerContentHash(record: {
  tenantId: string;
  subscriptionId: string;
  serviceId: string;
  billingPeriod: string;
  currency: string;
  subscriptionCharge: string;
  usageCharge: string;
  totalCharge: string;
  usageCount: number;
  settledBy: string;
}): string {
  return sha256Canonical({
    tenantId: record.tenantId,
    subscriptionId: record.subscriptionId,
    serviceId: record.serviceId,
    billingPeriod: record.billingPeriod,
    currency: record.currency,
    subscriptionCharge: record.subscriptionCharge,
    usageCharge: record.usageCharge,
    totalCharge: record.totalCharge,
    usageCount: record.usageCount,
    settledBy: record.settledBy,
  });
}

export function computeLedgerRecordHash(record: BillingLedgerRecord): string {
  return sha256Canonical({
    tenantId: record.tenantId,
    subscriptionId: record.subscriptionId,
    serviceId: record.serviceId,
    billingPeriod: record.billingPeriod,
    currency: record.currency,
    subscriptionCharge: record.subscriptionCharge,
    usageCharge: record.usageCharge,
    totalCharge: record.totalCharge,
    usageCount: record.usageCount,
    settledAt: record.settledAt.toISOString(),
    settledBy: record.settledBy,
    createdBy: record.createdBy,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    contentHash: record.contentHash,
  });
}

// ---------------------------------------------------------------------------
// Cost references
// ---------------------------------------------------------------------------

export function computeCostReferenceContentHash(record: {
  tenantId: string;
  billingPeriod: string;
  source: string;
  externalReference: string;
  amount: string;
  currency: string;
}): string {
  // The content hash pins the EXTERNAL STATEMENT being referenced, not
  // the recording operator (keyed convergence is actor-independent; the
  // record hash keeps the operator).
  return sha256Canonical({
    tenantId: record.tenantId,
    billingPeriod: record.billingPeriod,
    source: record.source,
    externalReference: record.externalReference,
    amount: record.amount,
    currency: record.currency,
  });
}

export function computeCostReferenceRecordHash(record: CostReferenceRecord): string {
  return sha256Canonical({
    tenantId: record.tenantId,
    billingPeriod: record.billingPeriod,
    source: record.source,
    externalReference: record.externalReference,
    amount: record.amount,
    currency: record.currency,
    recordedBy: record.recordedBy,
    idempotencyKey: record.idempotencyKey,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    contentHash: record.contentHash,
  });
}
