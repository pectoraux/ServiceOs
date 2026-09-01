/**
 * ServiceOS /notifications SQL store (WORK-015, module internal).
 *
 * Authoritative persistence for the notification REQUEST records,
 * executed through the persistence boundary's `TransactionalExecutor`
 * (parameterized SQL only; this file never imports `pg`). Load-bearing
 * invariants (the same discipline as the /interactions SQL store):
 *
 * 1. NO SECOND INTERACTION LEDGER: this store writes
 *    `notification_requests` only. The external effect, its dispatch and
 *    its observation belong to /interactions; this store holds the
 *    request and the current-interaction POINTER (a reference, written
 *    after the interaction exists — the module coordinates through
 *    /interactions' public contract).
 * 2. MANDATORY TENANT PREDICATES: every lookup/list selects through
 *    `tenant_id = $…`; removing one must fail the tenant-isolation
 *    discrimination tests.
 * 3. CONVERGENCE, NOT DUPLICATION: `createNotification` converges on the
 *    durable notification identified by (tenant, idempotency key) with
 *    ON CONFLICT DO NOTHING against the tenant-scoped partial unique
 *    index (the WORK-014 25P02 lesson — never catch-and-reread inside an
 *    aborted transaction).
 * 4. SERIALIZED POINTER WRITES: `setInteractionPointer` locks the row
 *    (SELECT … FOR UPDATE) before writing, recomputing the record
 *    integrity hash atomically; same-value writes are idempotent.
 * 5. TAMPER-EVIDENT READS: `mapNotification` recomputes the persisted
 *    integrity hash from the stored fields and fails closed with rule
 *    `notification-record-tampered` on divergence.
 */
import type { SqlExecutor, TransactionalExecutor } from '../../platform/persistence/index.js';
import { StoreConflictError } from '../auth/index.js';
import { isNotificationChannel, type NotificationChannel } from './channels.js';
import { canonicalJson, computeNotificationRecordHash } from './provenance.js';
import {
  NotificationsStoreMissingError,
  NotificationsStoreRuleError,
  type CreateNotificationInput,
  type NotificationRecord,
  type NotificationsStore,
  type SetInteractionPointerInput,
} from './store.js';

interface NotificationRow {
  id: string;
  tenant_id: string;
  channel: string;
  recipient: unknown;
  content: unknown;
  purpose: string | null;
  correlation: unknown;
  requested_by: string;
  idempotency_key: string | null;
  input_hash: string;
  record_hash: string;
  current_interaction_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const NOTIFICATION_COLUMNS =
  'id, tenant_id, channel, recipient, content, purpose, correlation, requested_by, idempotency_key, input_hash, record_hash, current_interaction_id, created_at, updated_at';

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toRecipient(value: unknown, id: string): Readonly<Record<string, string | null>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new NotificationsStoreRuleError(`notification ${id} recipient is not an object`, 'notification-record-tampered');
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.address !== 'string') {
    throw new NotificationsStoreRuleError(`notification ${id} recipient.address is missing`, 'notification-record-tampered');
  }
  const out: Record<string, string | null> = { address: candidate.address };
  if (candidate.displayName !== undefined) {
    if (typeof candidate.displayName !== 'string') {
      throw new NotificationsStoreRuleError(`notification ${id} recipient.displayName is not a string`, 'notification-record-tampered');
    }
    out.displayName = candidate.displayName;
  }
  return out;
}

function toContent(value: unknown, id: string): Readonly<Record<string, string | null>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new NotificationsStoreRuleError(`notification ${id} content is not an object`, 'notification-record-tampered');
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.body !== 'string') {
    throw new NotificationsStoreRuleError(`notification ${id} content.body is missing`, 'notification-record-tampered');
  }
  const out: Record<string, string | null> = { body: candidate.body };
  if (candidate.subject !== undefined) {
    if (typeof candidate.subject !== 'string') {
      throw new NotificationsStoreRuleError(`notification ${id} content.subject is not a string`, 'notification-record-tampered');
    }
    out.subject = candidate.subject;
  }
  return out;
}

function toCorrelation(value: unknown, id: string): Readonly<Record<string, string>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new NotificationsStoreRuleError(`notification ${id} correlation is not an object`, 'notification-record-tampered');
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== 'string') {
      throw new NotificationsStoreRuleError(`notification ${id} correlation entry "${key}" is not a string`, 'notification-record-tampered');
    }
    out[key] = entry;
  }
  return out;
}

function mapNotification(row: NotificationRow): NotificationRecord {
  const id = row.id;
  if (!isNotificationChannel(row.channel)) {
    throw new NotificationsStoreRuleError(`notification ${id} channel "${row.channel}" is outside the channel list`, 'notification-record-tampered');
  }
  const notification: NotificationRecord = {
    id,
    tenantId: row.tenant_id,
    channel: row.channel as NotificationChannel,
    recipient: toRecipient(row.recipient, id),
    content: toContent(row.content, id),
    purpose: row.purpose,
    correlation: toCorrelation(row.correlation, id),
    requestedBy: row.requested_by,
    idempotencyKey: row.idempotency_key,
    inputHash: row.input_hash,
    recordHash: row.record_hash,
    currentInteractionId: row.current_interaction_id,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
  // Integrity verification: every read recomputes the persisted record
  // hash from the stored fields — after-the-fact mutation is detected.
  if (computeNotificationRecordHash(notification) !== notification.recordHash) {
    throw new NotificationsStoreRuleError(`notification ${id} record no longer matches its integrity hash`, 'notification-record-tampered');
  }
  return notification;
}

/** Map a driver unique-violation to the shared conflict error. */
function mapStoreError(error: unknown, context: string): unknown {
  if (
    error instanceof StoreConflictError ||
    error instanceof NotificationsStoreRuleError ||
    error instanceof NotificationsStoreMissingError
  ) {
    return error;
  }
  const candidate = error as { code?: string; constraint?: string };
  if (typeof candidate?.code === 'string' && candidate.code === '23505') {
    return new StoreConflictError(`${context} violated a uniqueness constraint`, candidate.constraint ?? 'unknown');
  }
  return error;
}

export function createSqlNotificationsStore(executor: TransactionalExecutor): NotificationsStore {
  /**
   * Parameterized statement helper (the executor-explicit discipline: read
   * paths pass `executor`; every statement inside `withTransaction` passes
   * `tx` — the pinned client; the transaction-scope proofs fail the build
   * if a statement escapes).
   */
  async function query(
    exec: SqlExecutor,
    sql: string,
    params: unknown[],
    context: string,
  ): Promise<Record<string, unknown>[]> {
    try {
      const result = await exec.query(sql, params);
      return result.rows;
    } catch (error) {
      throw mapStoreError(error, context);
    }
  }

  async function findNotificationRowById(
    exec: SqlExecutor,
    tenantId: string,
    notificationId: string,
  ): Promise<NotificationRow | null> {
    const rows = await query(
      exec,
      `SELECT ${NOTIFICATION_COLUMNS} FROM notification_requests WHERE tenant_id = $1 AND id = $2`,
      [tenantId, notificationId],
      'findNotificationById',
    );
    const row = rows[0] as unknown as NotificationRow | undefined;
    return row === undefined ? null : row;
  }

  async function findNotificationRowByKey(
    exec: SqlExecutor,
    tenantId: string,
    idempotencyKey: string,
  ): Promise<NotificationRow | null> {
    const rows = await query(
      exec,
      `SELECT ${NOTIFICATION_COLUMNS} FROM notification_requests WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenantId, idempotencyKey],
      'findNotificationByIdempotencyKey',
    );
    const row = rows[0] as unknown as NotificationRow | undefined;
    return row === undefined ? null : row;
  }

  return {
    async createNotification(input: CreateNotificationInput): Promise<{ notification: NotificationRecord; converged: boolean }> {
      return executor.withTransaction(async (tx) => {
        // Keyed fast-path convergence.
        if (input.idempotencyKey !== null) {
          const existing = await findNotificationRowByKey(tx, input.tenantId, input.idempotencyKey);
          if (existing !== null) {
            const notification = mapNotification(existing);
            if (notification.inputHash !== input.inputHash) {
              throw new NotificationsStoreRuleError(
                `idempotency key "${input.idempotencyKey}" was already used for a different notification input`,
                'notification-input-conflict',
              );
            }
            return { notification, converged: true };
          }
        }

        const base: Omit<NotificationRecord, 'recordHash'> = {
          id: crypto.randomUUID(),
          tenantId: input.tenantId,
          channel: input.channel,
          recipient: input.recipient,
          content: input.content,
          purpose: input.purpose,
          correlation: input.correlation,
          requestedBy: input.requestedBy,
          idempotencyKey: input.idempotencyKey,
          inputHash: input.inputHash,
          currentInteractionId: null,
          createdAt: input.now,
          updatedAt: input.now,
        };
        const record: NotificationRecord = { ...base, recordHash: computeNotificationRecordHash(base) };

        const inserted = await query(
          tx,
          `INSERT INTO notification_requests
             (id, tenant_id, channel, recipient, content, purpose, correlation, requested_by, idempotency_key, input_hash, record_hash, current_interaction_id, created_at, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7::jsonb, $8, $9, $10, $11, NULL, $12, $12)
           ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
           RETURNING ${NOTIFICATION_COLUMNS}`,
          [
            record.id,
            input.tenantId,
            input.channel,
            canonicalJson(input.recipient),
            canonicalJson(input.content),
            input.purpose,
            canonicalJson(input.correlation),
            input.requestedBy,
            input.idempotencyKey,
            input.inputHash,
            record.recordHash,
            input.now,
          ],
          'createNotification',
        );
        if (inserted.length > 0) {
          return { notification: mapNotification(inserted[0] as unknown as NotificationRow), converged: false };
        }
        if (input.idempotencyKey !== null) {
          const existing = await findNotificationRowByKey(tx, input.tenantId, input.idempotencyKey);
          if (existing !== null) {
            const notification = mapNotification(existing);
            if (notification.inputHash !== input.inputHash) {
              throw new NotificationsStoreRuleError(
                `idempotency key "${input.idempotencyKey}" was already used for a different notification input`,
                'notification-input-conflict',
              );
            }
            return { notification, converged: true };
          }
        }
        throw new StoreConflictError('createNotification violated a uniqueness constraint', 'notification_requests_tenant_idempotency_key');
      });
    },

    async findNotificationById(tenantId: string, notificationId: string): Promise<NotificationRecord | null> {
      const row = await findNotificationRowById(executor, tenantId, notificationId);
      return row === null ? null : mapNotification(row);
    },

    async findNotificationByIdempotencyKey(tenantId: string, key: string): Promise<NotificationRecord | null> {
      const row = await findNotificationRowByKey(executor, tenantId, key);
      return row === null ? null : mapNotification(row);
    },

    async listNotifications(tenantId: string): Promise<NotificationRecord[]> {
      const rows = await query(
        executor,
        `SELECT ${NOTIFICATION_COLUMNS} FROM notification_requests WHERE tenant_id = $1 ORDER BY created_at ASC, id ASC`,
        [tenantId],
        'listNotifications',
      );
      return rows.map((row) => mapNotification(row as unknown as NotificationRow));
    },

    async setInteractionPointer(input: SetInteractionPointerInput): Promise<NotificationRecord> {
      return executor.withTransaction(async (tx) => {
        const rows = await query(
          tx,
          `SELECT ${NOTIFICATION_COLUMNS} FROM notification_requests WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
          [input.tenantId, input.notificationId],
          'setInteractionPointer',
        );
        const row = rows[0] as unknown as NotificationRow | undefined;
        if (row === undefined) {
          throw new NotificationsStoreMissingError(`notification ${input.notificationId} does not exist in this tenant`);
        }
        const current = mapNotification(row);
        // Idempotent pointer write: same value converges (the caller
        // coordinates interaction identity through /interactions, whose
        // keyed convergence makes the pointer value stable).
        const updated: NotificationRecord = {
          ...current,
          currentInteractionId: input.interactionId,
          updatedAt: input.now,
        };
        const recordHash = computeNotificationRecordHash(updated);
        await query(
          tx,
          `UPDATE notification_requests
           SET current_interaction_id = $1, record_hash = $2, updated_at = $3
           WHERE tenant_id = $4 AND id = $5`,
          [input.interactionId, recordHash, input.now, input.tenantId, input.notificationId],
          'setInteractionPointer',
        );
        return { ...updated, recordHash };
      });
    },
  };
}
