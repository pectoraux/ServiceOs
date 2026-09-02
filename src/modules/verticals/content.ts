/**
 * ServiceOS /verticals content hashing (WORK-009, module internal —
 * exported through the module's public interface).
 *
 * Deterministic hashing disciplines of the vertical-package authority:
 *
 * - `canonicalJson` — key-sorted, undefined-eliding canonical JSON: two
 *   structurally identical package contents hash identically regardless
 *   of property insertion order (convergence matching requires this).
 * - `hashPackageContent` — sha256 over the canonical CONTENT of a package
 *   version (everything a registration declares, minus provenance). Two
 *   registrations of the same (tenant, package id, version) with equal
 *   content hashes converge; unequal hashes fail closed.
 * - `hashVerticalRecord` — sha256 over the canonical record CORE
 *   (identity + content + provenance + the same single clock instant that
 *   is persisted). Recomputed on every read: an after-the-fact mutation
 *   of a stored field is DETECTED (typed `VERTICAL_RECORD_TAMPERED`).
 *
 * This module-local canonical serializer is the vertical authority's own
 * encoding of its own records (the same discipline /policies applies to
 * its decision records); it is not a shared serialization authority.
 */
import { createHash } from 'node:crypto';
import type { VerticalPackageRecord } from './store.js';

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

/** The canonical CONTENT of a package registration (identity + sections, no provenance). */
export interface PackageContentCore {
  readonly tenantId: string;
  readonly packageId: string;
  readonly version: number;
  readonly name: string;
  readonly description: string | null;
  readonly terminology: Readonly<Record<string, string>>;
  readonly entities: readonly unknown[];
  readonly workTypes: readonly unknown[];
  readonly workflowSteps: readonly unknown[];
  readonly policyDefaults: readonly unknown[];
  readonly approvalMatrix: readonly unknown[];
  readonly evidenceRequirements: readonly unknown[];
  readonly integrationBindings: readonly unknown[];
  readonly zeckCapabilityRequirements: readonly unknown[];
  readonly pricingRules: readonly unknown[];
}

export function hashPackageContent(content: PackageContentCore): string {
  // EXPLICIT extraction: the hash covers exactly the content fields — a
  // full record passed here contributes nothing beyond its content (the
  // record/content hashes must never cover each other).
  const core: PackageContentCore = {
    tenantId: content.tenantId,
    packageId: content.packageId,
    version: content.version,
    name: content.name,
    description: content.description,
    terminology: content.terminology,
    entities: content.entities,
    workTypes: content.workTypes,
    workflowSteps: content.workflowSteps,
    policyDefaults: content.policyDefaults,
    approvalMatrix: content.approvalMatrix,
    evidenceRequirements: content.evidenceRequirements,
    integrationBindings: content.integrationBindings,
    zeckCapabilityRequirements: content.zeckCapabilityRequirements,
    pricingRules: content.pricingRules,
  };
  return createHash('sha256').update(canonicalJson(core)).digest('hex');
}

/** The canonical record CORE (content + provenance + the persisted clock instant). */
export interface VerticalRecordCore extends PackageContentCore {
  readonly contentHash: string;
  readonly createdBy: string;
  readonly idempotencyKey: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function hashVerticalRecord(record: {
  tenantId: string;
  packageId: string;
  version: number;
  name: string;
  description: string | null;
  terminology: Readonly<Record<string, string>>;
  entities: readonly unknown[];
  workTypes: readonly unknown[];
  workflowSteps: readonly unknown[];
  policyDefaults: readonly unknown[];
  approvalMatrix: readonly unknown[];
  evidenceRequirements: readonly unknown[];
  integrationBindings: readonly unknown[];
  zeckCapabilityRequirements: readonly unknown[];
  pricingRules: readonly unknown[];
  contentHash: string;
  createdBy: string;
  idempotencyKey: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}): string {
  const core: VerticalRecordCore = {
    tenantId: record.tenantId,
    packageId: record.packageId,
    version: record.version,
    name: record.name,
    description: record.description,
    terminology: record.terminology,
    entities: record.entities,
    workTypes: record.workTypes,
    workflowSteps: record.workflowSteps,
    policyDefaults: record.policyDefaults,
    approvalMatrix: record.approvalMatrix,
    evidenceRequirements: record.evidenceRequirements,
    integrationBindings: record.integrationBindings,
    zeckCapabilityRequirements: record.zeckCapabilityRequirements,
    pricingRules: record.pricingRules,
    contentHash: record.contentHash,
    createdBy: record.createdBy,
    idempotencyKey: record.idempotencyKey,
    createdAt: record.createdAt instanceof Date ? record.createdAt.toISOString() : record.createdAt,
    updatedAt: record.updatedAt instanceof Date ? record.updatedAt.toISOString() : record.updatedAt,
  };
  return createHash('sha256').update(canonicalJson(core)).digest('hex');
}

/** Convenience: recompute the record hash of a mapped record (read-path verification). */
export function recordHashOf(pkg: VerticalPackageRecord): string {
  return hashVerticalRecord(pkg);
}
