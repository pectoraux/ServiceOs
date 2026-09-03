/**
 * ServiceOS /entities SQL store (WORK-010, module internal).
 *
 * Authoritative persistence for tenant-bound entity instances, executed
 * through the persistence boundary's `TransactionalExecutor`
 * (parameterized SQL only; this file never imports `pg`). Load-bearing
 * invariants (the house discipline — /evidence, /zeck, /approvals,
 * /verticals):
 *
 * 1. MANDATORY TENANT PREDICATES on every query.
 *
 * 2. SERIALIZED CRITICAL SECTIONS under transaction-scope advisory
 *    locks: instance creation locks (tenant, idempotency key). The
 *    POST-LOCK IDEMPOTENCY RE-CHECK makes the keyed-conflict codes
 *    identical under a true race.
 *
 * 3. CONVERGENCE with `ON CONFLICT DO NOTHING` (any unique violation):
 *    a suppressed insert is re-read INSIDE the same healthy transaction
 *    and converges — content hash compared — or fails closed with the
 *    typed store rule.
 *
 * 4. IMMUTABLE INSTANCES: entity rows are append-only — no UPDATE
 *    statement exists (a corrected/re-submitted entity is a NEW
 *    instance; the durable audit trail never rewrites history).
 *
 * 5. RECORD INTEGRITY: every read re-validates shapes defensively and
 *    recomputes BOTH persisted hashes; divergence fails closed
 *    (`entity-record-tampered`).
 *
 * 6. NULLABLE IDEMPOTENCY KEYS: the public contract permits an
 *    UNKEYED submission (idempotencyKey omitted/NULL) and migration
 *    0012 permits a NULL row key (the partial unique identity index
 *    covers keyed rows only — unkeyed rows carry no convergence
 *    identity, so every unkeyed submission is a distinct logical
 *    instance). The row mapper therefore maps NULL to the record's
 *    null key exactly as the write path pinned it; a non-string,
 *    non-NULL key remains tampering.
 */
import type { TransactionalExecutor } from '../../platform/persistence/index.js';
import { computeEntityInstanceContentHash, computeEntityInstanceRecordHash } from './content.js';
import {
  EntitiesStoreRuleError,
  type CreateEntityInstanceStoreInput,
  type EntityInstanceFilter,
  type EntityInstanceRecord,
  type EntityFieldValue,
  type EntitiesStore,
} from './store.js';

// ---------------------------------------------------------------------------
// Row shapes and columns
// ---------------------------------------------------------------------------

interface EntityInstanceRow {
  id: string;
  tenant_id: string;
  package_id: string;
  package_version: number;
  entity_type: string;
  fields: unknown;
  /** NULL for unkeyed instances (the nullable contract; keyed rows only are unique). */
  idempotency_key: string | null;
  content_hash: string;
  record_hash: string;
  created_by: string;
  created_at: Date | string;
}

const INSTANCE_COLUMNS =
  'id, tenant_id, package_id, package_version, entity_type, fields, idempotency_key, content_hash, record_hash, created_by, created_at';

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function failTampered(detail: string): never {
  throw new EntitiesStoreRuleError(detail, 'entity-record-tampered');
}

function mapFieldValues(raw: unknown): Readonly<Record<string, EntityFieldValue>> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    failTampered('column "fields" is not an object');
  }
  const out: Record<string, EntityFieldValue> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      failTampered(`field "${key}" carries a value outside the declared primitive space`);
    }
    out[key] = value;
  }
  return Object.freeze(out);
}

function mapInstance(row: EntityInstanceRow): EntityInstanceRecord {
  if (typeof row.id !== 'string' || typeof row.tenant_id !== 'string' || typeof row.package_id !== 'string') {
    failTampered('instance row identity columns are malformed');
  }
  if (typeof row.package_version !== 'number' || !Number.isInteger(row.package_version) || row.package_version < 1) {
    failTampered('instance row package_version is malformed');
  }
  if (typeof row.entity_type !== 'string') {
    failTampered('instance row entity_type is malformed');
  }
  // The nullable-key contract: NULL maps to the record's null key
  // (the write path hashed and stored exactly that); a non-string
  // non-NULL value is tampering.
  if (row.idempotency_key !== null && typeof row.idempotency_key !== 'string') {
    failTampered('instance row idempotency_key is malformed');
  }
  const fields = mapFieldValues(row.fields);
  const createdAt = toDate(row.created_at);
  const record: EntityInstanceRecord = {
    id: row.id,
    tenantId: row.tenant_id,
    packageId: row.package_id,
    packageVersion: row.package_version,
    entityType: row.entity_type,
    fields,
    contentHash: row.content_hash,
    recordHash: row.record_hash,
    createdBy: row.created_by,
    idempotencyKey: row.idempotency_key,
    createdAt,
    updatedAt: createdAt,
  };
  // Read-side integrity: both hashes are recomputed; divergence is tampering.
  if (
    computeEntityInstanceContentHash({
      tenantId: record.tenantId,
      packageId: record.packageId,
      packageVersion: record.packageVersion,
      entityType: record.entityType,
      fields: record.fields,
    }) !== record.contentHash
  ) {
    failTampered(`entity instance ${record.id} content no longer matches its recorded content hash`);
  }
  if (
    computeEntityInstanceRecordHash({
      tenantId: record.tenantId,
      packageId: record.packageId,
      packageVersion: record.packageVersion,
      entityType: record.entityType,
      fields: record.fields,
      contentHash: record.contentHash,
      createdBy: record.createdBy,
      idempotencyKey: record.idempotencyKey,
      createdAt: record.createdAt,
    }) !== record.recordHash
  ) {
    failTampered(`entity instance ${record.id} record no longer matches its recorded integrity hash`);
  }
  return record;
}

function keyedInstanceConflict(idempotencyKey: string): never {
  throw new EntitiesStoreRuleError(
    `entity instance idempotency key "${idempotencyKey}" already holds a different entity content; the same logical submission must carry the same content`,
    'entity-input-conflict',
  );
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export function createSqlEntitiesStore(executor: TransactionalExecutor): EntitiesStore {
  return {
    async createEntityInstance(input: CreateEntityInstanceStoreInput): Promise<{ instance: EntityInstanceRecord; converged: boolean }> {
      const recordHash = computeEntityInstanceRecordHash({
        tenantId: input.tenantId,
        packageId: input.packageId,
        packageVersion: input.packageVersion,
        entityType: input.entityType,
        fields: input.fields,
        contentHash: input.contentHash,
        createdBy: input.createdBy,
        idempotencyKey: input.idempotencyKey,
        createdAt: input.now,
      });
      return executor.withTransaction(async (tx) => {
        // Fast converge path: an existing keyed registration decides immediately.
        const existingKey = input.idempotencyKey === null
          ? null
          : await findInstanceByKey(tx, input.tenantId, input.idempotencyKey);
        if (existingKey !== null) {
          if (existingKey.content_hash !== input.contentHash) {
            throw keyedInstanceConflict(input.idempotencyKey as string);
          }
          return { instance: mapInstance(existingKey), converged: true };
        }
        // Serialize this logical registration.
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `entity-key:${input.tenantId}:${input.idempotencyKey ?? 'unkeyed'}`,
        ]);
        // POST-LOCK IDEMPOTENCY RE-CHECK (the authoritative one).
        const racedKey = input.idempotencyKey === null
          ? null
          : await findInstanceByKey(tx, input.tenantId, input.idempotencyKey);
        if (racedKey !== null) {
          if (racedKey.content_hash !== input.contentHash) {
            throw keyedInstanceConflict(input.idempotencyKey as string);
          }
          return { instance: mapInstance(racedKey), converged: true };
        }
        // ON CONFLICT DO NOTHING (any unique violation): a concurrent
        // creator committed first; this transaction stays healthy for
        // the convergence re-read below.
        const inserted = await tx.query(
          `INSERT INTO entity_instances
             (tenant_id, package_id, package_version, entity_type, fields,
              idempotency_key, content_hash, record_hash, created_by, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $10)
           ON CONFLICT DO NOTHING
           RETURNING ${INSTANCE_COLUMNS}`,
          [
            input.tenantId,
            input.packageId,
            input.packageVersion,
            input.entityType,
            JSON.stringify(input.fields),
            input.idempotencyKey,
            input.contentHash,
            recordHash,
            input.createdBy,
            input.now,
          ],
        );
        if (inserted.rows.length > 0) {
          const row = inserted.rows[0] as unknown as EntityInstanceRow;
          return { instance: mapInstance(row), converged: false };
        }
        // A concurrent registration committed first: converge when the
        // key matches, fail closed otherwise.
        const byKey = input.idempotencyKey === null
          ? null
          : await findInstanceByKey(tx, input.tenantId, input.idempotencyKey);
        if (byKey !== null) {
          if (byKey.content_hash !== input.contentHash) {
            throw keyedInstanceConflict(input.idempotencyKey as string);
          }
          return { instance: mapInstance(byKey), converged: true };
        }
        throw new EntitiesStoreRuleError(
          'createEntityInstance violated a uniqueness constraint without a keyed identity',
          'entity-input-conflict',
        );
      });
    },

    async findEntityInstanceById(tenantId: string, instanceId: string): Promise<EntityInstanceRecord | null> {
      const result = await executor.query(
        `SELECT ${INSTANCE_COLUMNS} FROM entity_instances WHERE tenant_id = $1 AND id = $2`,
        [tenantId, instanceId],
      );
      const row = result.rows[0] as unknown as EntityInstanceRow | undefined;
      return row === undefined ? null : mapInstance(row);
    },

    async findEntityInstanceByIdempotencyKey(tenantId: string, idempotencyKey: string): Promise<EntityInstanceRecord | null> {
      const result = await executor.query(
        `SELECT ${INSTANCE_COLUMNS} FROM entity_instances WHERE tenant_id = $1 AND idempotency_key = $2`,
        [tenantId, idempotencyKey],
      );
      const row = result.rows[0] as unknown as EntityInstanceRow | undefined;
      return row === undefined ? null : mapInstance(row);
    },

    async listEntityInstances(tenantId: string, filter?: EntityInstanceFilter): Promise<EntityInstanceRecord[]> {
      const conditions = ['tenant_id = $1'];
      const params: unknown[] = [tenantId];
      if (filter?.packageId !== undefined) {
        params.push(filter.packageId);
        conditions.push(`package_id = $${params.length}`);
      }
      if (filter?.packageVersion !== undefined) {
        params.push(filter.packageVersion);
        conditions.push(`package_version = $${params.length}`);
      }
      if (filter?.entityType !== undefined) {
        params.push(filter.entityType);
        conditions.push(`entity_type = $${params.length}`);
      }
      const result = await executor.query(
        `SELECT ${INSTANCE_COLUMNS} FROM entity_instances WHERE ${conditions.join(' AND ')} ORDER BY created_at ASC, id ASC`,
        params,
      );
      return result.rows.map((row) => mapInstance(row as unknown as EntityInstanceRow));
    },
  };
}

async function findInstanceByKey(
  tx: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
  tenantId: string,
  idempotencyKey: string,
): Promise<EntityInstanceRow | null> {
  const result = await tx.query(
    `SELECT ${INSTANCE_COLUMNS} FROM entity_instances WHERE tenant_id = $1 AND idempotency_key = $2`,
    [tenantId, idempotencyKey],
  );
  const row = result.rows[0] as unknown as EntityInstanceRow | undefined;
  return row === undefined ? null : row;
}
