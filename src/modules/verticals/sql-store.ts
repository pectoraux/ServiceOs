/**
 * ServiceOS /verticals SQL store (WORK-009, module internal).
 *
 * Authoritative persistence for versioned vertical-package registrations,
 * executed through the persistence boundary's `TransactionalExecutor`
 * (parameterized SQL only; this file never imports `pg`). Load-bearing
 * invariants:
 *
 * 1. MANDATORY TENANT PREDICATES: every lookup/list selects through
 *    `tenant_id = $…`. Removing a predicate must fail the tenant-isolation
 *    discrimination tests.
 *
 * 2. SERIALIZED VERSION SEQUENCING: `registerPackage` takes a
 *    transaction-scope advisory lock keyed on (tenant, package id) before
 *    reading MAX(version), so the caller-supplied version is checked
 *    against the sequence atomically: new = max+1 (or first), duplicate of
 *    an existing version converges iff the content hash matches, otherwise
 *    `version-content-conflict`; a version ahead of the sequence or a gap
 *    fails closed with `version-not-sequential`.
 *
 * 3. CONVERGENCE: inserts use `ON CONFLICT DO NOTHING` (no target — any
 *    unique violation) so a concurrent creator that committed first keeps
 *    THIS transaction healthy (DO NOTHING, unlike a raised 23505, does not
 *    abort; the convergence re-read below runs inside the same
 *    transaction). Same (tenant, idempotency key) converges on the durable
 *    row (content hash compared; divergence fails closed with
 *    `idempotency-input-conflict`).
 *
 * 4. RECORD INTEGRITY: `mapPackage` recomputes BOTH persisted hashes from
 *    the stored fields — the content hash over the canonical package
 *    content, the record hash over the canonical record core — and throws
 *    rule `vertical-record-tampered` when either diverges. An
 *    after-the-fact mutation of a registered package is detected on read.
 *
 * 5. CONTENT IS IMMUTABLE: this store never UPDATEs package content
 *    columns; the only writes are the registration INSERTs.
 */
import type { SqlExecutor, TransactionalExecutor } from '../../platform/persistence/index.js';
import { StoreConflictError } from '../auth/index.js';
import { canonicalJson, hashPackageContent, hashVerticalRecord } from './content.js';
import {
  VerticalsStoreRuleError,
  type EntityDefinition,
  type EntityFieldDefinition,
  type ApprovalRuleDeclaration,
  type EvidenceRequirementDeclaration,
  type IntegrationBindingDeclaration,
  type PolicyDefaultDeclaration,
  type PolicyParameterDefault,
  type PricingRuleDeclaration,
  type RegisterPackageInput,
  type VerticalPackageRecord,
  type VerticalsStore,
  type WorkTypeDefinition,
  type WorkflowStepDefinition,
} from './store.js';
import type { ZeckCapabilityRequirement } from './capability-requirements.js';

interface PackageRow {
  id: string;
  tenant_id: string;
  package_id: string;
  version: number;
  name: string;
  description: string | null;
  terminology: unknown;
  entities: unknown;
  work_types: unknown;
  workflow_steps: unknown;
  policy_defaults: unknown;
  approval_matrix: unknown;
  evidence_requirements: unknown;
  integration_bindings: unknown;
  required_ai_capabilities: unknown;
  pricing_rules: unknown;
  content_hash: string;
  record_hash: string;
  created_by: string;
  idempotency_key: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const PACKAGE_COLUMNS =
  'id, tenant_id, package_id, version, name, description, terminology, entities, work_types, workflow_steps, policy_defaults, approval_matrix, evidence_requirements, integration_bindings, required_ai_capabilities, pricing_rules, content_hash, record_hash, created_by, idempotency_key, created_at, updated_at';

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function failTampered(detail: string): never {
  throw new VerticalsStoreRuleError(detail, 'vertical-record-tampered');
}

function asArray(raw: unknown, column: string): readonly unknown[] {
  if (!Array.isArray(raw)) failTampered(`package column "${column}" is not an array`);
  return raw;
}

function asRecord(raw: unknown, column: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    failTampered(`package column "${column}" is not an object`);
  }
  return raw as Record<string, unknown>;
}

function optionalString(raw: unknown): string | undefined {
  return typeof raw === 'string' ? raw : undefined;
}

function mapTerminology(raw: unknown): Readonly<Record<string, string>> {
  const source = asRecord(raw, 'terminology');
  const mapped: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== 'string') failTampered('package terminology value is not a string');
    mapped[key] = value;
  }
  return mapped;
}

function mapEntityField(raw: unknown): EntityFieldDefinition {
  if (typeof raw !== 'object' || raw === null) failTampered('package entity field is not an object');
  const candidate = raw as Record<string, unknown>;
  const { name, type, required } = candidate;
  if (typeof name !== 'string' || typeof required !== 'boolean') {
    failTampered('package entity field has an invalid shape');
  }
  if (type !== 'string' && type !== 'number' && type !== 'boolean' && type !== 'date') {
    failTampered('package entity field type is out of enumeration');
  }
  return { name, type, required };
}

function mapEntities(raw: unknown): readonly EntityDefinition[] {
  return asArray(raw, 'entities').map((entry) => {
    const candidate = asRecord(entry, 'entities entry');
    const { name, description, fields } = candidate;
    if (typeof name !== 'string' || !Array.isArray(fields)) {
      failTampered('package entity definition has an invalid shape');
    }
    return {
      name,
      ...(typeof description === 'string' ? { description } : {}),
      fields: fields.map(mapEntityField),
    };
  });
}

function mapWorkTypes(raw: unknown): readonly WorkTypeDefinition[] {
  return asArray(raw, 'work_types').map((entry) => {
    const candidate = asRecord(entry, 'work_types entry');
    const { name, description, defaultSlaHours } = candidate;
    if (typeof name !== 'string') failTampered('package work type has an invalid shape');
    if (defaultSlaHours !== undefined && typeof defaultSlaHours !== 'number') {
      failTampered('package work type defaultSlaHours is not a number');
    }
    return {
      name,
      ...(optionalString(description) !== undefined ? { description: description as string } : {}),
      ...(defaultSlaHours !== undefined ? { defaultSlaHours } : {}),
    };
  });
}

function mapWorkflowSteps(raw: unknown): readonly WorkflowStepDefinition[] {
  return asArray(raw, 'workflow_steps').map((entry) => {
    const candidate = asRecord(entry, 'workflow_steps entry');
    const { step, description, workType, entity } = candidate;
    if (typeof step !== 'string') failTampered('package workflow step has an invalid shape');
    return {
      step,
      ...(optionalString(description) !== undefined ? { description: description as string } : {}),
      ...(optionalString(workType) !== undefined ? { workType: workType as string } : {}),
      ...(optionalString(entity) !== undefined ? { entity: entity as string } : {}),
    };
  });
}

function mapPolicyDefaults(raw: unknown): readonly PolicyDefaultDeclaration[] {
  return asArray(raw, 'policy_defaults').map((entry) => {
    const candidate = asRecord(entry, 'policy_defaults entry');
    const { policyKey, parameters } = candidate;
    if (typeof policyKey !== 'string' || !Array.isArray(parameters)) {
      failTampered('package policy default has an invalid shape');
    }
    const mappedParameters: PolicyParameterDefault[] = parameters.map((parameter) => {
      const p = asRecord(parameter, 'policy default parameter');
      const { name, defaultValue } = p;
      if (
        typeof name !== 'string' ||
        (typeof defaultValue !== 'string' && typeof defaultValue !== 'number' && typeof defaultValue !== 'boolean')
      ) {
        failTampered('package policy default parameter has an invalid shape');
      }
      return { name, defaultValue };
    });
    return { policyKey, parameters: mappedParameters };
  });
}

function mapApprovalMatrix(raw: unknown): readonly ApprovalRuleDeclaration[] {
  return asArray(raw, 'approval_matrix').map((entry) => {
    const candidate = asRecord(entry, 'approval_matrix entry');
    const { id, workType, role, threshold } = candidate;
    if (typeof id !== 'string' || typeof role !== 'string' || typeof threshold !== 'number') {
      failTampered('package approval rule has an invalid shape');
    }
    return {
      id,
      ...(optionalString(workType) !== undefined ? { workType: workType as string } : {}),
      role,
      threshold,
    };
  });
}

function mapEvidenceRequirements(raw: unknown): readonly EvidenceRequirementDeclaration[] {
  return asArray(raw, 'evidence_requirements').map((entry) => {
    const candidate = asRecord(entry, 'evidence_requirements entry');
    const { name, description } = candidate;
    if (typeof name !== 'string') failTampered('package evidence requirement has an invalid shape');
    return {
      name,
      ...(optionalString(description) !== undefined ? { description: description as string } : {}),
    };
  });
}

function mapIntegrationBindings(raw: unknown): readonly IntegrationBindingDeclaration[] {
  return asArray(raw, 'integration_bindings').map((entry) => {
    const candidate = asRecord(entry, 'integration_bindings entry');
    const { capabilityClass, description } = candidate;
    if (typeof capabilityClass !== 'string') failTampered('package integration binding has an invalid shape');
    return {
      capabilityClass,
      ...(optionalString(description) !== undefined ? { description: description as string } : {}),
    };
  });
}

function mapZeckRequirements(raw: unknown): readonly ZeckCapabilityRequirement[] {
  return asArray(raw, 'required_ai_capabilities').map((entry) => {
    const candidate = asRecord(entry, 'required_ai_capabilities entry');
    const { capability, minQuality, maxLatencyMs, description } = candidate;
    if (typeof capability !== 'string') failTampered('package Zeck capability requirement has an invalid shape');
    if (
      (minQuality !== undefined && typeof minQuality !== 'number') ||
      (maxLatencyMs !== undefined && typeof maxLatencyMs !== 'number')
    ) {
      failTampered('package Zeck capability requirement bound is not a number');
    }
    return {
      capability,
      ...(minQuality !== undefined ? { minQuality } : {}),
      ...(maxLatencyMs !== undefined ? { maxLatencyMs } : {}),
      ...(optionalString(description) !== undefined ? { description: description as string } : {}),
    };
  });
}

function mapPricingRules(raw: unknown): readonly PricingRuleDeclaration[] {
  return asArray(raw, 'pricing_rules').map((entry) => {
    const candidate = asRecord(entry, 'pricing_rules entry');
    const { id, description, model, amount, currency } = candidate;
    if (typeof id !== 'string') failTampered('package pricing rule has an invalid shape');
    if (
      model !== 'subscription' &&
      model !== 'per_work_item' &&
      model !== 'per_outcome' &&
      model !== 'usage_band' &&
      model !== 'hybrid'
    ) {
      failTampered('package pricing rule model is out of enumeration');
    }
    return {
      id,
      ...(optionalString(description) !== undefined ? { description: description as string } : {}),
      model,
      ...(optionalString(amount) !== undefined ? { amount: amount as string } : {}),
      ...(optionalString(currency) !== undefined ? { currency: currency as string } : {}),
    };
  });
}

/**
 * Rows are written by this store (validated content) and never mutated in
 * content afterwards; mapping re-validates the shape defensively so a
 * tampered/corrupt row fails closed instead of silently changing meaning,
 * and verifies BOTH persisted hashes (content + record).
 */
function mapPackage(row: PackageRow): VerticalPackageRecord {
  const record: VerticalPackageRecord = {
    id: row.id,
    tenantId: row.tenant_id,
    packageId: row.package_id,
    version: row.version,
    name: row.name,
    description: row.description,
    terminology: mapTerminology(row.terminology),
    entities: mapEntities(row.entities),
    workTypes: mapWorkTypes(row.work_types),
    workflowSteps: mapWorkflowSteps(row.workflow_steps),
    policyDefaults: mapPolicyDefaults(row.policy_defaults),
    approvalMatrix: mapApprovalMatrix(row.approval_matrix),
    evidenceRequirements: mapEvidenceRequirements(row.evidence_requirements),
    integrationBindings: mapIntegrationBindings(row.integration_bindings),
    zeckCapabilityRequirements: mapZeckRequirements(row.required_ai_capabilities),
    pricingRules: mapPricingRules(row.pricing_rules),
    contentHash: row.content_hash,
    recordHash: row.record_hash,
    createdBy: row.created_by,
    idempotencyKey: row.idempotency_key,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
  if (hashPackageContent(record) !== record.contentHash) {
    failTampered(`package ${row.package_id} v${row.version} content no longer matches its recorded content hash`);
  }
  if (hashVerticalRecord(record) !== record.recordHash) {
    failTampered(`package ${row.package_id} v${row.version} record no longer matches its recorded integrity hash`);
  }
  return record;
}

export function createSqlVerticalsStore(executor: TransactionalExecutor): VerticalsStore {
  async function findRowByIdempotencyKey(
    exec: SqlExecutor,
    tenantId: string,
    idempotencyKey: string,
  ): Promise<PackageRow | null> {
    const result = await exec.query(
      `SELECT ${PACKAGE_COLUMNS} FROM verticals_packages WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenantId, idempotencyKey],
    );
    const row = result.rows[0] as unknown as PackageRow | undefined;
    return row === undefined ? null : row;
  }

  return {
    async registerPackage(input: RegisterPackageInput): Promise<{ pkg: VerticalPackageRecord; converged: boolean }> {
      return executor.withTransaction(async (tx) => {
        // Converge on an existing logical registration first.
        if (input.idempotencyKey !== null) {
          const existing = await findRowByIdempotencyKey(tx, input.tenantId, input.idempotencyKey);
          if (existing !== null) {
            if (existing.content_hash !== input.contentHash) {
              throw new VerticalsStoreRuleError(
                `vertical package idempotency key "${input.idempotencyKey}" was already bound to different content`,
                'idempotency-input-conflict',
              );
            }
            return { pkg: mapPackage(existing), converged: true };
          }
        }
        // Serialize version sequencing for this (tenant, package id).
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `verticals:${input.tenantId}:${input.packageId}`,
        ]);
        // POST-LOCK IDEMPOTENCY RE-CHECK (the authoritative one): the
        // pre-lock lookup above is only a fast path for registrations that
        // had ALREADY committed. A racing same-key registration may have
        // committed while this transaction waited for the advisory lock —
        // invisible to the pre-lock statement snapshot, decisive here
        // (READ COMMITTED takes a fresh snapshot per statement). Without
        // this re-check a same-key divergent loser would exit through the
        // version-sequence branch with `version-content-conflict`,
        // violating the store contract's `idempotency-input-conflict` for
        // same-key divergence inside the serialized critical section.
        if (input.idempotencyKey !== null) {
          const raced = await findRowByIdempotencyKey(tx, input.tenantId, input.idempotencyKey);
          if (raced !== null) {
            if (raced.content_hash !== input.contentHash) {
              throw new VerticalsStoreRuleError(
                `vertical package idempotency key "${input.idempotencyKey}" was already bound to different content`,
                'idempotency-input-conflict',
              );
            }
            return { pkg: mapPackage(raced), converged: true };
          }
        }
        const sequence = await tx.query(
          `SELECT COALESCE(MAX(version), 0) AS max FROM verticals_packages WHERE tenant_id = $1 AND package_id = $2`,
          [input.tenantId, input.packageId],
        );
        const max = (sequence.rows[0] as { max: number }).max;
        if (input.version <= max) {
          // Duplicate registration of an existing version: deterministic
          // convergence (same content) or rejection (different content).
          const existing = await tx.query(
            `SELECT ${PACKAGE_COLUMNS} FROM verticals_packages WHERE tenant_id = $1 AND package_id = $2 AND version = $3`,
            [input.tenantId, input.packageId, input.version],
          );
          const row = existing.rows[0] as unknown as PackageRow | undefined;
          if (row === undefined) {
            throw new VerticalsStoreRuleError(
              `vertical package ${input.packageId} version ${input.version} is behind the registered sequence (max ${max}) and missing; versions must be contiguous`,
              'version-not-sequential',
            );
          }
          if (row.content_hash !== input.contentHash) {
            throw new VerticalsStoreRuleError(
              `vertical package ${input.packageId} version ${input.version} is already registered with different content`,
              'version-content-conflict',
            );
          }
          return { pkg: mapPackage(row), converged: true };
        }
        if (input.version !== max + 1) {
          throw new VerticalsStoreRuleError(
            `vertical package ${input.packageId} version ${input.version} skips the sequence (next is ${max + 1})`,
            'version-not-sequential',
          );
        }
        // INSERT ... ON CONFLICT DO NOTHING (any unique violation): a
        // concurrent creator of the same logical identity committed first;
        // DO NOTHING keeps this transaction healthy for the convergence
        // re-read below.
        const inserted = await tx.query(
          `INSERT INTO verticals_packages
             (tenant_id, package_id, version, name, description, terminology, entities, work_types, workflow_steps,
              policy_defaults, approval_matrix, evidence_requirements, integration_bindings,
              required_ai_capabilities, pricing_rules, content_hash, record_hash, created_by, idempotency_key, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb,
                   $13::jsonb, $14::jsonb, $15::jsonb, $16, $17, $18, $19, $20, $20)
           ON CONFLICT DO NOTHING
           RETURNING ${PACKAGE_COLUMNS}`,
          [
            input.tenantId,
            input.packageId,
            input.version,
            input.name,
            input.description,
            canonicalJson(input.terminology),
            JSON.stringify(input.entities),
            JSON.stringify(input.workTypes),
            JSON.stringify(input.workflowSteps),
            JSON.stringify(input.policyDefaults),
            JSON.stringify(input.approvalMatrix),
            JSON.stringify(input.evidenceRequirements),
            JSON.stringify(input.integrationBindings),
            JSON.stringify(input.zeckCapabilityRequirements),
            JSON.stringify(input.pricingRules),
            input.contentHash,
            input.recordHash,
            input.createdBy,
            input.idempotencyKey,
            input.now,
          ],
        );
        if (inserted.rows.length > 0) {
          return { pkg: mapPackage(inserted.rows[0] as unknown as PackageRow), converged: false };
        }
        // A concurrent registration committed first: converge when the
        // identity/content match, fail closed otherwise.
        if (input.idempotencyKey !== null) {
          const byKey = await findRowByIdempotencyKey(tx, input.tenantId, input.idempotencyKey);
          if (byKey !== null) {
            if (byKey.content_hash !== input.contentHash) {
              throw new VerticalsStoreRuleError(
                `vertical package idempotency key "${input.idempotencyKey}" was already bound to different content`,
                'idempotency-input-conflict',
              );
            }
            return { pkg: mapPackage(byKey), converged: true };
          }
        }
        const byIdentity = await tx.query(
          `SELECT ${PACKAGE_COLUMNS} FROM verticals_packages WHERE tenant_id = $1 AND package_id = $2 AND version = $3`,
          [input.tenantId, input.packageId, input.version],
        );
        const twin = byIdentity.rows[0] as unknown as PackageRow | undefined;
        if (twin !== undefined) {
          if (twin.content_hash !== input.contentHash) {
            throw new VerticalsStoreRuleError(
              `vertical package ${input.packageId} version ${input.version} is already registered with different content`,
              'version-content-conflict',
            );
          }
          return { pkg: mapPackage(twin), converged: true };
        }
        throw new StoreConflictError(
          'registerPackage violated a uniqueness constraint',
          'verticals_packages_identity',
        );
      });
    },

    async findPackageById(tenantId: string, rowId: string): Promise<VerticalPackageRecord | null> {
      const result = await executor.query(
        `SELECT ${PACKAGE_COLUMNS} FROM verticals_packages WHERE tenant_id = $1 AND id = $2`,
        [tenantId, rowId],
      );
      const row = result.rows[0] as unknown as PackageRow | undefined;
      return row === undefined ? null : mapPackage(row);
    },

    async findPackage(tenantId: string, packageId: string, version: number): Promise<VerticalPackageRecord | null> {
      const result = await executor.query(
        `SELECT ${PACKAGE_COLUMNS} FROM verticals_packages WHERE tenant_id = $1 AND package_id = $2 AND version = $3`,
        [tenantId, packageId, version],
      );
      const row = result.rows[0] as unknown as PackageRow | undefined;
      return row === undefined ? null : mapPackage(row);
    },

    async listPackages(tenantId: string, packageId?: string): Promise<VerticalPackageRecord[]> {
      const result =
        packageId === undefined
          ? await executor.query(
              `SELECT ${PACKAGE_COLUMNS} FROM verticals_packages WHERE tenant_id = $1 ORDER BY package_id ASC, version ASC`,
              [tenantId],
            )
          : await executor.query(
              `SELECT ${PACKAGE_COLUMNS} FROM verticals_packages WHERE tenant_id = $1 AND package_id = $2 ORDER BY version ASC`,
              [tenantId, packageId],
            );
      return result.rows.map((row) => mapPackage(row as unknown as PackageRow));
    },
  };
}
