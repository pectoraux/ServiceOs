/**
 * ServiceOS /services content hashing (WORK-009, module internal —
 * exported through the module's public interface).
 *
 * Deterministic hashing disciplines of the service-definition authority
 * (the same discipline /policies and /verticals apply to their records):
 *
 * - `canonicalJson` — key-sorted, undefined-eliding canonical JSON
 *   (structural identity regardless of property insertion order).
 * - `hashDefinitionContent` / `hashConfigurationContent` — sha256 over
 *   the canonical CONTENT (convergence matching for duplicate
 *   registrations of the same version).
 * - `hashServiceRecord` / `hashConfigurationRecord` — sha256 over the
 *   canonical record CORE including the exact clock instant persisted
 *   with the write (one clock read per write: the hash and the row pin
 *   the SAME instant). Recomputed on every read: after-the-fact mutation
 *   of a stored field is DETECTED (typed SERVICE_RECORD_TAMPERED /
 *   CONFIGURATION_RECORD_TAMPERED).
 */
import { createHash } from 'node:crypto';
import type { ServiceConfigurationRecord, ServiceDefinitionRecord } from './store.js';

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

export function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

// ---------------------------------------------------------------------------
// Record-hash core extractors (single source of truth for both the module
// write path and the store read/lifecycle paths)
// ---------------------------------------------------------------------------

export function computeDefinitionContentHash(record: {
  tenantId: string;
  serviceId: string;
  version: number;
  name: string;
  description: string | null;
  verticalPackageId: string;
  verticalPackageVersion: number;
  entities: readonly unknown[];
  workDefinitions: readonly unknown[];
  workflowBinding: readonly unknown[];
  policyConfiguration: readonly unknown[];
  approvalRules: readonly unknown[];
  slaDefaults: readonly unknown[];
  outcomeContract: unknown;
  requiredExternalCapabilities: readonly unknown[];
  requiredAiCapabilities: readonly unknown[];
  pricing: unknown;
}): string {
  // EXPLICIT extraction: the hash covers exactly the content fields (a
  // full record contributes nothing beyond its content — the record and
  // content hashes must never cover each other).
  return sha256Canonical({
    tenantId: record.tenantId,
    serviceId: record.serviceId,
    version: record.version,
    name: record.name,
    description: record.description,
    verticalPackageId: record.verticalPackageId,
    verticalPackageVersion: record.verticalPackageVersion,
    entities: record.entities,
    workDefinitions: record.workDefinitions,
    workflowBinding: record.workflowBinding,
    policyConfiguration: record.policyConfiguration,
    approvalRules: record.approvalRules,
    slaDefaults: record.slaDefaults,
    outcomeContract: record.outcomeContract,
    requiredExternalCapabilities: record.requiredExternalCapabilities,
    requiredAiCapabilities: record.requiredAiCapabilities,
    pricing: record.pricing,
  });
}

/** The record CORE including the current lifecycle state (hash covers it). */
export function computeDefinitionRecordHash(record: ServiceDefinitionRecord): string {
  return sha256Canonical({
    tenantId: record.tenantId,
    serviceId: record.serviceId,
    version: record.version,
    status: record.status,
    name: record.name,
    description: record.description,
    verticalPackageId: record.verticalPackageId,
    verticalPackageVersion: record.verticalPackageVersion,
    entities: record.entities,
    workDefinitions: record.workDefinitions,
    workflowBinding: record.workflowBinding,
    policyConfiguration: record.policyConfiguration,
    approvalRules: record.approvalRules,
    slaDefaults: record.slaDefaults,
    outcomeContract: record.outcomeContract,
    requiredExternalCapabilities: record.requiredExternalCapabilities,
    requiredAiCapabilities: record.requiredAiCapabilities,
    pricing: record.pricing,
    contentHash: record.contentHash,
    createdBy: record.createdBy,
    idempotencyKey: record.idempotencyKey,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  });
}

export function computeConfigurationContentHash(record: {
  tenantId: string;
  serviceId: string;
  serviceVersion: number;
  policyParameters: readonly unknown[];
  slaAdjustments: readonly unknown[];
  approvalAdjustments: readonly unknown[];
}): string {
  // EXPLICIT extraction (see computeDefinitionContentHash).
  return sha256Canonical({
    tenantId: record.tenantId,
    serviceId: record.serviceId,
    serviceVersion: record.serviceVersion,
    policyParameters: record.policyParameters,
    slaAdjustments: record.slaAdjustments,
    approvalAdjustments: record.approvalAdjustments,
  });
}

export function computeConfigurationRecordHash(record: ServiceConfigurationRecord): string {
  return sha256Canonical({
    tenantId: record.tenantId,
    serviceId: record.serviceId,
    serviceVersion: record.serviceVersion,
    configurationVersion: record.configurationVersion,
    status: record.status,
    policyParameters: record.policyParameters,
    slaAdjustments: record.slaAdjustments,
    approvalAdjustments: record.approvalAdjustments,
    contentHash: record.contentHash,
    createdBy: record.createdBy,
    idempotencyKey: record.idempotencyKey,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  });
}
