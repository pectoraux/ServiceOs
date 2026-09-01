/**
 * ServiceOS /notifications provenance hashing (WORK-015, module internal).
 *
 * Deterministic hashing for the notification-request records'
 * tamper-evidence: the same canonicalization discipline as /policies
 * (WORK-014) and /workflow (WORK-004), implemented in this module so the
 * authorities stay decoupled (cross-module calls use public interfaces;
 * internal implementation imports are forbidden).
 *
 * - `hashNotificationInput` is the durable REQUEST identity: sha256 over
 *   the canonical { channel, recipient, content, purpose, correlation }
 *   core. A keyed re-submission of the same logical request converges on
 *   the durable notification; a divergent re-submission fails closed.
 * - `hashNotificationRecord` is the integrity hash over the canonical
 *   record core including the current interaction pointer: every
 *   legitimate pointer write recomputes it and every read verifies it —
 *   after-the-fact mutation of a recorded notification is detected on
 *   read.
 */
import { createHash } from 'node:crypto';

import type { NotificationRecord } from './store.js';

/**
 * Canonical JSON: object keys sorted, no whitespace, deterministic
 * serialization of primitive-bearing structures (the same discipline as
 * /policies and /workflow).
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

/** The canonical request core: durable input identity of a notification. */
export interface NotificationRequestCore {
  readonly channel: string;
  readonly recipient: Readonly<Record<string, string | null>>;
  readonly content: Readonly<Record<string, string | null>>;
  readonly purpose: string | null;
  readonly correlation: Readonly<Record<string, string>>;
}

/** sha256 over the canonical request core (the input_hash column). */
export function hashNotificationInput(core: NotificationRequestCore): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        channel: core.channel,
        recipient: core.recipient,
        content: core.content,
        purpose: core.purpose,
        correlation: core.correlation,
      }),
    )
    .digest('hex');
}

/** The canonical record core: every field the integrity hash covers. */
export interface NotificationRecordCore {
  readonly id: string;
  readonly tenantId: string;
  readonly channel: string;
  readonly recipient: Readonly<Record<string, string | null>>;
  readonly content: Readonly<Record<string, string | null>>;
  readonly purpose: string | null;
  readonly correlation: Readonly<Record<string, string>>;
  readonly requestedBy: string;
  readonly idempotencyKey: string | null;
  readonly inputHash: string;
  readonly currentInteractionId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** sha256 over the canonical record core (the record_hash column). */
export function hashNotificationRecord(core: NotificationRecordCore): string {
  return createHash('sha256').update(canonicalJson(core)).digest('hex');
}

/** The record shape the integrity hash is computed from (recordHash never covers itself). */
export type HashableNotificationRecord = Omit<NotificationRecord, 'recordHash'>;

/** Recompute the record hash from a durable notification record. */
export function computeNotificationRecordHash(record: HashableNotificationRecord): string {
  return hashNotificationRecord({
    id: record.id,
    tenantId: record.tenantId,
    channel: record.channel,
    recipient: record.recipient,
    content: record.content,
    purpose: record.purpose,
    correlation: record.correlation,
    requestedBy: record.requestedBy,
    idempotencyKey: record.idempotencyKey,
    inputHash: record.inputHash,
    currentInteractionId: record.currentInteractionId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  });
}
