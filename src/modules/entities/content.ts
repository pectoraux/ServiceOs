/**
 * ServiceOS /entities content hashing (WORK-010, module internal —
 * exported through the module's public interface).
 *
 * The same deterministic hashing discipline /policies, /verticals,
 * /services, /billing, /zeck, /evidence, /approvals and /interactions
 * apply to their records:
 *
 * - `canonicalJson` — key-sorted, undefined-eliding canonical JSON.
 * - ENTITY CONTENT HASH — sha256 over the canonical entity-instance
 *   FACT (tenant, package, entity type, fields). ACTOR-INDEPENDENT:
 *   the same logical instance content reported by any actor hashes
 *   identically. It deliberately EXCLUDES the idempotency key and the
 *   recorder (the record hash keeps those).
 * - ENTITY RECORD HASH — sha256 over the full immutable row core
 *   INCLUDING the creator and the exact creation instant (one clock
 *   read per write: the hash and the row pin the SAME instant).
 *   Recomputed on every read: an after-the-fact mutation of any
 *   stored field is DETECTED (typed `ENTITY_RECORD_TAMPERED`).
 * - COMPLIANCE PACKAGE HASH — sha256 over the canonical DETERMINISTIC
 *   package content (the assembled authority-ledger projection).
 *   VOLATILE ASSEMBLY METADATA (the observation instant) is excluded
 *   from the hashed core, so the same unchanged authority state
 *   assembles to the SAME hash under a moving clock — repeated
 *   assembly is identity-stable, and the hash is recorded in the
 *   package evidence so any later divergence of the underlying state
 *   is observable.
 */
import { createHash } from 'node:crypto';
import type { EntityInstanceRecord } from './store.js';

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

/** The actor-independent entity-instance fact core. */
export interface EntityInstanceContentCore {
  readonly tenantId: string;
  readonly packageId: string;
  readonly packageVersion: number;
  readonly entityType: string;
  readonly fields: unknown;
}

export function computeEntityInstanceContentHash(record: EntityInstanceContentCore): string {
  return sha256Canonical({
    tenantId: record.tenantId,
    packageId: record.packageId,
    packageVersion: record.packageVersion,
    entityType: record.entityType,
    fields: record.fields,
  });
}

/** The full immutable record core (creator + instant included; the surrogate row id is assigned by the store and not hashed). */
export interface HashableEntityInstanceRecord {
  readonly tenantId: string;
  readonly packageId: string;
  readonly packageVersion: number;
  readonly entityType: string;
  readonly fields: unknown;
  readonly contentHash: string;
  readonly createdBy: string;
  readonly idempotencyKey: string | null;
  readonly createdAt: Date;
}

export function computeEntityInstanceRecordHash(record: HashableEntityInstanceRecord): string {
  return sha256Canonical({
    tenantId: record.tenantId,
    packageId: record.packageId,
    packageVersion: record.packageVersion,
    entityType: record.entityType,
    fields: record.fields,
    contentHash: record.contentHash,
    createdBy: record.createdBy,
    idempotencyKey: record.idempotencyKey,
    createdAt: record.createdAt,
  });
}

/** The deterministic compliance-package assembly hash. */
export function computeCompliancePackageHash(packageDocument: unknown): string {
  return sha256Canonical(packageDocument);
}
