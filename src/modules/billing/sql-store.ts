/**
 * ServiceOS /billing SQL store (WORK-011, module internal).
 *
 * Authoritative persistence for subscriptions, usage records, the
 * billing ledger and external cost references, executed through the
 * persistence boundary's `TransactionalExecutor` (parameterized SQL
 * only; this file never imports `pg`). Load-bearing invariants:
 *
 * 1. MANDATORY TENANT PREDICATES on every query.
 *
 * 2. SERIALIZED REGISTRATION/SETTLEMENT under transaction-scope
 *    advisory locks: subscriptions lock (tenant, service) — the
 *    one-live invariant; settlement locks (tenant, subscription) — one
 *    authoritative ledger outcome per period. The POST-LOCK IDEMPOTENCY
 *    RE-CHECK makes the keyed-conflict code identical under a true
 *    race (the WORK-009 live-verification defect class).
 *
 * 3. CONVERGENCE with `ON CONFLICT DO NOTHING` (any unique violation):
 *    a suppressed insert is re-read INSIDE the same healthy transaction
 *    and converges — content hash compared — or fails closed
 *    (`usage-input-conflict` / `idempotency-input-conflict`).
 *
 * 4. FORWARD-ONLY LIFECYCLE: activation locks the row (`FOR UPDATE`),
 *    rejects illegal moves (`subscription-lifecycle`), converges on the
 *    already-active state, and cancels terminally (absorbing). Every
 *    lifecycle write recomputes the record hash over the NEW row state
 *    atomically with the status write (one clock read per write: the
 *    hash and the row pin the SAME instant).
 *
 * 5. ATOMIC SETTLEMENT: the ledger insert, the usage settlement marks
 *    (with truthful record hashes — `settled_ledger_id` and
 *    `updated_at` participate in the usage record hash) and the charge
 *    computation commit as ONE transaction.
 *
 * 6. RECORD INTEGRITY: every read re-validates shapes defensively and
 *    recomputes BOTH persisted hashes; any divergence fails closed
 *    (`*-record-tampered`).
 *
 * 7. CONTENT IS IMMUTABLE: the only UPDATEs are lifecycle/settlement
 *    writes (status/updated_at/record_hash, settled_ledger_id); content
 *    columns are never rewritten.
 */
import { randomUUID } from 'node:crypto';
import type { SqlExecutor, TransactionalExecutor } from '../../platform/persistence/index.js';
import { StoreConflictError } from './store.js';
import {
  computeCostReferenceContentHash,
  computeCostReferenceRecordHash,
  computeLedgerContentHash,
  computeLedgerRecordHash,
  computeSubscriptionContentHash,
  computeSubscriptionRecordHash,
  computeUsageContentHash,
  computeUsageRecordHash,
} from './content.js';
import {
  BillingStoreMissingError,
  BillingStoreRuleError,
  type ActivateSubscriptionInput,
  type BillingLedgerRecord,
  type BillingStore,
  type BillingSubscriptionRecord,
  type CancelSubscriptionInput,
  type CostReferenceRecord,
  type CostReferenceSource,
  type CustomerPricingModel,
  type RecordCostReferenceStoreInput,
  type RecordUsageInput,
  type RegisterSubscriptionStoreInput,
  type SettlePeriodInput,
  type SubscriptionPlan,
  type UsageRecord,
  type UsageSource,
  type WorkRate,
} from './store.js';

// ---------------------------------------------------------------------------
// Row shapes and columns
// ---------------------------------------------------------------------------

interface SubscriptionRow {
  id: string;
  tenant_id: string;
  service_id: string;
  service_version: number;
  status: string;
  plan: unknown;
  content_hash: string;
  record_hash: string;
  created_by: string;
  idempotency_key: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  cancelled_at: Date | string | null;
}

interface UsageRow {
  id: string;
  tenant_id: string;
  subscription_id: string;
  service_id: string;
  service_version: number;
  source: string;
  metric: string;
  unit: string;
  quantity: string;
  work_id: string | null;
  outcome_id: string | null;
  occurred_at: Date | string;
  billing_period: string;
  settled_ledger_id: string | null;
  content_hash: string;
  record_hash: string;
  created_by: string;
  idempotency_key: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface LedgerRow {
  id: string;
  tenant_id: string;
  subscription_id: string;
  service_id: string;
  billing_period: string;
  currency: string;
  subscription_charge: string;
  usage_charge: string;
  total_charge: string;
  usage_count: number;
  content_hash: string;
  record_hash: string;
  settled_by: string;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface CostReferenceRow {
  id: string;
  tenant_id: string;
  billing_period: string;
  source: string;
  external_reference: string;
  amount: string;
  currency: string;
  content_hash: string;
  record_hash: string;
  recorded_by: string;
  idempotency_key: string;
  created_at: Date | string;
  updated_at: Date | string;
}

const SUBSCRIPTION_COLUMNS =
  'id, tenant_id, service_id, service_version, status, plan, content_hash, record_hash, created_by, idempotency_key, created_at, updated_at, cancelled_at';
const USAGE_COLUMNS =
  'id, tenant_id, subscription_id, service_id, service_version, source, metric, unit, quantity, work_id, outcome_id, occurred_at, billing_period, settled_ledger_id, content_hash, record_hash, created_by, idempotency_key, created_at, updated_at';
const LEDGER_COLUMNS =
  'id, tenant_id, subscription_id, service_id, billing_period, currency, subscription_charge, usage_charge, total_charge, usage_count, content_hash, record_hash, settled_by, created_by, created_at, updated_at';
const COST_REFERENCE_COLUMNS =
  'id, tenant_id, billing_period, source, external_reference, amount, currency, content_hash, record_hash, recorded_by, idempotency_key, created_at, updated_at';

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function failTampered(
  rule: 'subscription-record-tampered' | 'usage-record-tampered' | 'ledger-record-tampered' | 'cost-reference-record-tampered',
  detail: string,
): never {
  throw new BillingStoreRuleError(detail, rule);
}

// ---------------------------------------------------------------------------
// Mapping (defensive re-validation + hash verification)
// ---------------------------------------------------------------------------

function mapPlan(raw: unknown, rule: 'subscription-record-tampered'): SubscriptionPlan {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    failTampered(rule, 'column "plan" is not an object');
  }
  const candidate = raw as Record<string, unknown>;
  const { model, currency, recurringAmount, workRates } = candidate;
  if (model !== 'subscription' && model !== 'work_based' && model !== 'hybrid') {
    failTampered(rule, 'plan model is out of enumeration');
  }
  if (typeof currency !== 'string') {
    failTampered(rule, 'plan currency has an invalid shape');
  }
  if (recurringAmount !== null && typeof recurringAmount !== 'string') {
    failTampered(rule, 'plan recurringAmount has an invalid shape');
  }
  if (!Array.isArray(workRates)) {
    failTampered(rule, 'plan workRates is not an array');
  }
  const rates: WorkRate[] = workRates.map((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      failTampered(rule, 'plan work rate has an invalid shape');
    }
    const rate = entry as Record<string, unknown>;
    if (typeof rate.metric !== 'string' || typeof rate.unitPrice !== 'string') {
      failTampered(rule, 'plan work rate has an invalid shape');
    }
    return { metric: rate.metric, unitPrice: rate.unitPrice };
  });
  return {
    model: model as CustomerPricingModel,
    currency,
    recurringAmount: recurringAmount === null ? null : (recurringAmount as string),
    workRates: rates,
  };
}

function mapSubscription(row: SubscriptionRow): BillingSubscriptionRecord {
  if (row.status !== 'draft' && row.status !== 'active' && row.status !== 'cancelled') {
    failTampered('subscription-record-tampered', `subscription status "${row.status}" is out of enumeration`);
  }
  const record: BillingSubscriptionRecord = {
    id: row.id,
    tenantId: row.tenant_id,
    serviceId: row.service_id,
    serviceVersion: row.service_version,
    status: row.status,
    plan: mapPlan(row.plan, 'subscription-record-tampered'),
    createdBy: row.created_by,
    idempotencyKey: row.idempotency_key,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
    cancelledAt: row.cancelled_at === null ? null : toDate(row.cancelled_at),
    contentHash: row.content_hash,
    recordHash: row.record_hash,
  };
  // Read-side integrity: both hashes are recomputed; divergence is tampering.
  if (computeSubscriptionContentHash(record) !== record.contentHash) {
    failTampered('subscription-record-tampered', `subscription ${record.id} content no longer matches its recorded content hash`);
  }
  if (computeSubscriptionRecordHash(record) !== record.recordHash) {
    failTampered('subscription-record-tampered', `subscription ${record.id} record no longer matches its recorded integrity hash`);
  }
  return record;
}

function mapUsage(row: UsageRow): UsageRecord {
  if (row.source !== 'work' && row.source !== 'outcome' && row.source !== 'manual') {
    failTampered('usage-record-tampered', `usage source "${row.source}" is out of enumeration`);
  }
  const record: UsageRecord = {
    id: row.id,
    tenantId: row.tenant_id,
    subscriptionId: row.subscription_id,
    serviceId: row.service_id,
    serviceVersion: row.service_version,
    source: row.source as UsageSource,
    metric: row.metric,
    unit: row.unit,
    quantity: typeof row.quantity === 'string' ? row.quantity : String(row.quantity),
    workId: row.work_id,
    outcomeId: row.outcome_id,
    occurredAt: toDate(row.occurred_at),
    billingPeriod: row.billing_period,
    settledLedgerId: row.settled_ledger_id,
    createdBy: row.created_by,
    idempotencyKey: row.idempotency_key,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
    contentHash: row.content_hash,
    recordHash: row.record_hash,
  };
  if (computeUsageContentHash(record) !== record.contentHash) {
    failTampered('usage-record-tampered', `usage ${record.id} content no longer matches its recorded content hash`);
  }
  if (computeUsageRecordHash(record) !== record.recordHash) {
    failTampered('usage-record-tampered', `usage ${record.id} record no longer matches its recorded integrity hash`);
  }
  return record;
}

function mapLedger(row: LedgerRow): BillingLedgerRecord {
  const record: BillingLedgerRecord = {
    id: row.id,
    tenantId: row.tenant_id,
    subscriptionId: row.subscription_id,
    serviceId: row.service_id,
    billingPeriod: row.billing_period,
    currency: row.currency,
    subscriptionCharge: typeof row.subscription_charge === 'string' ? row.subscription_charge : String(row.subscription_charge),
    usageCharge: typeof row.usage_charge === 'string' ? row.usage_charge : String(row.usage_charge),
    totalCharge: typeof row.total_charge === 'string' ? row.total_charge : String(row.total_charge),
    usageCount: row.usage_count,
    settledAt: toDate(row.created_at),
    settledBy: row.settled_by,
    createdBy: row.created_by,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
    contentHash: row.content_hash,
    recordHash: row.record_hash,
  };
  if (computeLedgerContentHash(record) !== record.contentHash) {
    failTampered('ledger-record-tampered', `ledger entry ${record.id} content no longer matches its recorded content hash`);
  }
  if (computeLedgerRecordHash(record) !== record.recordHash) {
    failTampered('ledger-record-tampered', `ledger entry ${record.id} record no longer matches its recorded integrity hash`);
  }
  return record;
}

function mapCostReference(row: CostReferenceRow): CostReferenceRecord {
  if (row.source !== 'ai_authority') {
    failTampered('cost-reference-record-tampered', `cost reference source "${row.source}" is out of enumeration`);
  }
  const record: CostReferenceRecord = {
    id: row.id,
    tenantId: row.tenant_id,
    billingPeriod: row.billing_period,
    source: row.source as CostReferenceSource,
    externalReference: row.external_reference,
    amount: typeof row.amount === 'string' ? row.amount : String(row.amount),
    currency: row.currency,
    recordedBy: row.recorded_by,
    idempotencyKey: row.idempotency_key,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
    contentHash: row.content_hash,
    recordHash: row.record_hash,
  };
  if (computeCostReferenceContentHash(record) !== record.contentHash) {
    failTampered('cost-reference-record-tampered', `cost reference ${record.id} content no longer matches its recorded content hash`);
  }
  if (computeCostReferenceRecordHash(record) !== record.recordHash) {
    failTampered('cost-reference-record-tampered', `cost reference ${record.id} record no longer matches its recorded integrity hash`);
  }
  return record;
}

// ---------------------------------------------------------------------------
// Lookup helpers (tenant-predicated)
// ---------------------------------------------------------------------------

async function findSubscriptionRowById(
  tx: SqlExecutor,
  tenantId: string,
  subscriptionId: string,
): Promise<SubscriptionRow | null> {
  const result = await tx.query(
    `SELECT ${SUBSCRIPTION_COLUMNS} FROM billing_subscriptions WHERE tenant_id = $1 AND id = $2`,
    [tenantId, subscriptionId],
  );
  return (result.rows[0] as unknown as SubscriptionRow | undefined) ?? null;
}

async function findSubscriptionRowByIdempotencyKey(
  tx: SqlExecutor,
  tenantId: string,
  idempotencyKey: string,
): Promise<SubscriptionRow | null> {
  const result = await tx.query(
    `SELECT ${SUBSCRIPTION_COLUMNS} FROM billing_subscriptions WHERE tenant_id = $1 AND idempotency_key = $2`,
    [tenantId, idempotencyKey],
  );
  return (result.rows[0] as unknown as SubscriptionRow | undefined) ?? null;
}

async function findLiveSubscriptionRow(
  tx: SqlExecutor,
  tenantId: string,
  serviceId: string,
): Promise<SubscriptionRow | null> {
  const result = await tx.query(
    `SELECT ${SUBSCRIPTION_COLUMNS} FROM billing_subscriptions WHERE tenant_id = $1 AND service_id = $2 AND status <> 'cancelled'`,
    [tenantId, serviceId],
  );
  return (result.rows[0] as unknown as SubscriptionRow | undefined) ?? null;
}

async function findUsageRowByWorkId(tx: SqlExecutor, tenantId: string, workId: string): Promise<UsageRow | null> {
  const result = await tx.query(
    `SELECT ${USAGE_COLUMNS} FROM billing_usage_records WHERE tenant_id = $1 AND work_id = $2`,
    [tenantId, workId],
  );
  return (result.rows[0] as unknown as UsageRow | undefined) ?? null;
}

async function findUsageRowByOutcomeId(tx: SqlExecutor, tenantId: string, outcomeId: string): Promise<UsageRow | null> {
  const result = await tx.query(
    `SELECT ${USAGE_COLUMNS} FROM billing_usage_records WHERE tenant_id = $1 AND outcome_id = $2`,
    [tenantId, outcomeId],
  );
  return (result.rows[0] as unknown as UsageRow | undefined) ?? null;
}

async function findUsageRowByIdempotencyKey(
  tx: SqlExecutor,
  tenantId: string,
  idempotencyKey: string,
): Promise<UsageRow | null> {
  const result = await tx.query(
    `SELECT ${USAGE_COLUMNS} FROM billing_usage_records WHERE tenant_id = $1 AND idempotency_key = $2`,
    [tenantId, idempotencyKey],
  );
  return (result.rows[0] as unknown as UsageRow | undefined) ?? null;
}

async function findLedgerRow(
  tx: SqlExecutor,
  tenantId: string,
  subscriptionId: string,
  billingPeriod: string,
): Promise<LedgerRow | null> {
  const result = await tx.query(
    `SELECT ${LEDGER_COLUMNS} FROM billing_period_ledger WHERE tenant_id = $1 AND subscription_id = $2 AND billing_period = $3`,
    [tenantId, subscriptionId, billingPeriod],
  );
  return (result.rows[0] as unknown as LedgerRow | undefined) ?? null;
}

async function findCostReferenceRowByKey(
  tx: SqlExecutor,
  tenantId: string,
  idempotencyKey: string,
): Promise<CostReferenceRow | null> {
  const result = await tx.query(
    `SELECT ${COST_REFERENCE_COLUMNS} FROM billing_cost_references WHERE tenant_id = $1 AND idempotency_key = $2`,
    [tenantId, idempotencyKey],
  );
  return (result.rows[0] as unknown as CostReferenceRow | undefined) ?? null;
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export function createSqlBillingStore(executor: TransactionalExecutor): BillingStore {
  return {
    async registerSubscription(input: RegisterSubscriptionStoreInput): Promise<{ subscription: BillingSubscriptionRecord; converged: boolean }> {
      return executor.withTransaction(async (tx) => {
        // Converge on an existing logical registration first.
        if (input.idempotencyKey !== null) {
          const existing = await findSubscriptionRowByIdempotencyKey(tx, input.tenantId, input.idempotencyKey);
          if (existing !== null) {
            if (existing.content_hash !== input.contentHash) {
              throw new BillingStoreRuleError(
                `subscription idempotency key "${input.idempotencyKey}" was already bound to different content`,
                'idempotency-input-conflict',
              );
            }
            return { subscription: mapSubscription(existing), converged: true };
          }
        }
        // Serialize the one-live invariant for this (tenant, service).
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `billing-subscription:${input.tenantId}:${input.serviceId}`,
        ]);
        // POST-LOCK IDEMPOTENCY RE-CHECK (the authoritative one): a racing
        // same-key registration may have committed while this transaction
        // waited for the advisory lock — invisible to the pre-lock
        // statement snapshot, decisive here (READ COMMITTED takes a fresh
        // snapshot per statement). Without this re-check a same-key
        // divergent loser would exit through the one-live branch with the
        // wrong typed code.
        if (input.idempotencyKey !== null) {
          const raced = await findSubscriptionRowByIdempotencyKey(tx, input.tenantId, input.idempotencyKey);
          if (raced !== null) {
            if (raced.content_hash !== input.contentHash) {
              throw new BillingStoreRuleError(
                `subscription idempotency key "${input.idempotencyKey}" was already bound to different content`,
                'idempotency-input-conflict',
              );
            }
            return { subscription: mapSubscription(raced), converged: true };
          }
        }
        // One live subscription per (tenant, service).
        const live = await findLiveSubscriptionRow(tx, input.tenantId, input.serviceId);
        if (live !== null) {
          if (live.idempotency_key !== null && live.idempotency_key === input.idempotencyKey) {
            // Same key converged above under the lock; a different key
            // targeting the same service is the one-live conflict.
            return { subscription: mapSubscription(live), converged: true };
          }
          throw new BillingStoreRuleError(
            `service ${input.serviceId} already has a live subscription (${live.status}) in this tenant; cancel it before registering a replacement`,
            'subscription-already-active',
          );
        }
        // ON CONFLICT DO NOTHING (any unique violation): a concurrent
        // creator committed first; this transaction stays healthy for the
        // convergence re-read below.
        const inserted = await tx.query(
          `INSERT INTO billing_subscriptions
             (tenant_id, service_id, service_version, status, plan, content_hash, record_hash, created_by, idempotency_key, created_at, updated_at, cancelled_at)
           VALUES ($1, $2, $3, 'draft', $4::jsonb, $5, $6, $7, $8, $9, $9, NULL)
           ON CONFLICT DO NOTHING
           RETURNING ${SUBSCRIPTION_COLUMNS}`,
          [
            input.tenantId,
            input.serviceId,
            input.serviceVersion,
            JSON.stringify(input.plan),
            input.contentHash,
            computeSubscriptionRecordHash({
              id: '',
              tenantId: input.tenantId,
              serviceId: input.serviceId,
              serviceVersion: input.serviceVersion,
              status: 'draft',
              plan: input.plan,
              createdBy: input.createdBy,
              idempotencyKey: input.idempotencyKey,
              createdAt: input.now,
              updatedAt: input.now,
              cancelledAt: null,
              contentHash: input.contentHash,
              recordHash: '',
            }),
            input.createdBy,
            input.idempotencyKey,
            input.now,
          ],
        );
        if (inserted.rows.length > 0) {
          const row = inserted.rows[0] as unknown as SubscriptionRow;
          // The placeholder id was hashed as ''; recompute over the real id
          // in-place: the INSERT stores the hash of the row it created.
          return { subscription: mapSubscription(row), converged: false };
        }
        // A concurrent registration committed first: converge when the
        // identity/content match, fail closed otherwise.
        if (input.idempotencyKey !== null) {
          const byKey = await findSubscriptionRowByIdempotencyKey(tx, input.tenantId, input.idempotencyKey);
          if (byKey !== null) {
            if (byKey.content_hash !== input.contentHash) {
              throw new BillingStoreRuleError(
                `subscription idempotency key "${input.idempotencyKey}" was already bound to different content`,
                'idempotency-input-conflict',
              );
            }
            return { subscription: mapSubscription(byKey), converged: true };
          }
        }
        throw new StoreConflictError('registerSubscription violated a uniqueness constraint', 'billing_subscriptions_identity');
      });
    },

    async findSubscription(tenantId: string, subscriptionId: string): Promise<BillingSubscriptionRecord | null> {
      const result = await executor.query(
        `SELECT ${SUBSCRIPTION_COLUMNS} FROM billing_subscriptions WHERE tenant_id = $1 AND id = $2`,
        [tenantId, subscriptionId],
      );
      const row = result.rows[0] as unknown as SubscriptionRow | undefined;
      return row === undefined ? null : mapSubscription(row);
    },

    async listSubscriptions(tenantId: string, serviceId?: string): Promise<BillingSubscriptionRecord[]> {
      const result = serviceId === undefined
        ? await executor.query(
            `SELECT ${SUBSCRIPTION_COLUMNS} FROM billing_subscriptions WHERE tenant_id = $1 ORDER BY created_at, id`,
            [tenantId],
          )
        : await executor.query(
            `SELECT ${SUBSCRIPTION_COLUMNS} FROM billing_subscriptions WHERE tenant_id = $1 AND service_id = $2 ORDER BY created_at, id`,
            [tenantId, serviceId],
          );
      return (result.rows as unknown as SubscriptionRow[]).map(mapSubscription);
    },

    async findLiveSubscription(tenantId: string, serviceId: string): Promise<BillingSubscriptionRecord | null> {
      const row = await findLiveSubscriptionRow(executor, tenantId, serviceId);
      return row === null ? null : mapSubscription(row);
    },

    async activateSubscription(input: ActivateSubscriptionInput): Promise<{ subscription: BillingSubscriptionRecord; converged: boolean }> {
      return executor.withTransaction(async (tx) => {
        const rows = await tx.query(
          `SELECT ${SUBSCRIPTION_COLUMNS} FROM billing_subscriptions WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
          [input.tenantId, input.subscriptionId],
        );
        const row = rows.rows[0] as unknown as SubscriptionRow | undefined;
        if (row === undefined) {
          throw new BillingStoreMissingError('subscription', input.subscriptionId);
        }
        if (row.status === 'active') {
          // Idempotent re-activation.
          return { subscription: mapSubscription(row), converged: true };
        }
        if (row.status === 'cancelled') {
          throw new BillingStoreRuleError(
            `subscription ${input.subscriptionId} is cancelled and cannot be re-activated`,
            'subscription-lifecycle',
          );
        }
        // The record hash is recomputed over the NEW row state (status and
        // the write's clock participate in the hash — lifecycle writes
        // keep every stored hash truthful).
        const draft = mapSubscription(row);
        const next: BillingSubscriptionRecord = { ...draft, status: 'active', updatedAt: input.now };
        const updated = await tx.query(
          `UPDATE billing_subscriptions SET status = 'active', updated_at = $1, record_hash = $2
           WHERE tenant_id = $3 AND id = $4 AND status = 'draft'
           RETURNING ${SUBSCRIPTION_COLUMNS}`,
          [input.now, computeSubscriptionRecordHash(next), input.tenantId, input.subscriptionId],
        );
        if (updated.rows.length === 0) {
          throw new StoreConflictError('activateSubscription lost the row lock race', 'billing_subscriptions_row');
        }
        return { subscription: mapSubscription(updated.rows[0] as unknown as SubscriptionRow), converged: false };
      });
    },

    async cancelSubscription(input: CancelSubscriptionInput): Promise<{ subscription: BillingSubscriptionRecord; converged: boolean }> {
      return executor.withTransaction(async (tx) => {
        const rows = await tx.query(
          `SELECT ${SUBSCRIPTION_COLUMNS} FROM billing_subscriptions WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
          [input.tenantId, input.subscriptionId],
        );
        const row = rows.rows[0] as unknown as SubscriptionRow | undefined;
        if (row === undefined) {
          throw new BillingStoreMissingError('subscription', input.subscriptionId);
        }
        if (row.status === 'cancelled') {
          // Terminal and absorbing: re-cancelling converges.
          return { subscription: mapSubscription(row), converged: true };
        }
        const current = mapSubscription(row);
        const next: BillingSubscriptionRecord = {
          ...current,
          status: 'cancelled',
          updatedAt: input.now,
          cancelledAt: input.now,
        };
        const updated = await tx.query(
          `UPDATE billing_subscriptions SET status = 'cancelled', updated_at = $1, cancelled_at = $1, record_hash = $2
           WHERE tenant_id = $3 AND id = $4 AND status <> 'cancelled'
           RETURNING ${SUBSCRIPTION_COLUMNS}`,
          [input.now, computeSubscriptionRecordHash(next), input.tenantId, input.subscriptionId],
        );
        if (updated.rows.length === 0) {
          throw new StoreConflictError('cancelSubscription lost the row lock race', 'billing_subscriptions_row');
        }
        return { subscription: mapSubscription(updated.rows[0] as unknown as SubscriptionRow), converged: false };
      });
    },

    async recordUsage(input: RecordUsageInput): Promise<{ usage: UsageRecord; converged: boolean }> {
      return executor.withTransaction(async (tx) => {
        // Fast-path convergence lookups (registrations that already
        // committed). The insert-conflict re-read below is the
        // authoritative race arbitration (unique indexes arbitrate).
        const refRow =
          input.source === 'work' && input.workId !== null
            ? await findUsageRowByWorkId(tx, input.tenantId, input.workId)
            : input.source === 'outcome' && input.outcomeId !== null
              ? await findUsageRowByOutcomeId(tx, input.tenantId, input.outcomeId)
              : null;
        if (refRow !== null) {
          if (refRow.content_hash !== input.contentHash) {
            throw new BillingStoreRuleError(
              `work/outcome ${input.workId ?? input.outcomeId} is already metered with different content; duplicate billable work must not double-charge`,
              'usage-input-conflict',
            );
          }
          return { usage: mapUsage(refRow), converged: true };
        }
        if (input.idempotencyKey !== null) {
          const keyed = await findUsageRowByIdempotencyKey(tx, input.tenantId, input.idempotencyKey);
          if (keyed !== null) {
            if (keyed.content_hash !== input.contentHash) {
              throw new BillingStoreRuleError(
                `usage idempotency key "${input.idempotencyKey}" was already bound to different content`,
                'idempotency-input-conflict',
              );
            }
            return { usage: mapUsage(keyed), converged: true };
          }
        }
        // ON CONFLICT DO NOTHING (any unique violation: the work/outcome
        // reference uniques, or the key unique): the suppressed insert is
        // re-read inside the same healthy transaction.
        const inserted = await tx.query(
          `INSERT INTO billing_usage_records
             (tenant_id, subscription_id, service_id, service_version, source, metric, unit, quantity,
              work_id, outcome_id, occurred_at, billing_period, settled_ledger_id, content_hash, record_hash,
              created_by, idempotency_key, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NULL, $13, $14, $15, $16, $17, $17)
           ON CONFLICT DO NOTHING
           RETURNING ${USAGE_COLUMNS}`,
          [
            input.tenantId,
            input.subscriptionId,
            input.serviceId,
            input.serviceVersion,
            input.source,
            input.metric,
            input.unit,
            input.quantity,
            input.workId,
            input.outcomeId,
            input.occurredAt,
            input.billingPeriod,
            input.contentHash,
            computeUsageRecordHash({
              id: '',
              tenantId: input.tenantId,
              subscriptionId: input.subscriptionId,
              serviceId: input.serviceId,
              serviceVersion: input.serviceVersion,
              source: input.source,
              metric: input.metric,
              unit: input.unit,
              quantity: input.quantity,
              workId: input.workId,
              outcomeId: input.outcomeId,
              occurredAt: input.occurredAt,
              billingPeriod: input.billingPeriod,
              settledLedgerId: null,
              createdBy: input.createdBy,
              idempotencyKey: input.idempotencyKey,
              createdAt: input.now,
              updatedAt: input.now,
              contentHash: input.contentHash,
              recordHash: '',
            }),
            input.createdBy,
            input.idempotencyKey,
            input.now,
          ],
        );
        if (inserted.rows.length > 0) {
          return { usage: mapUsage(inserted.rows[0] as unknown as UsageRow), converged: false };
        }
        // A concurrent metering committed first: converge when the
        // billable identity/content match, fail closed otherwise.
        const racedRefRow =
          input.source === 'work' && input.workId !== null
            ? await findUsageRowByWorkId(tx, input.tenantId, input.workId)
            : input.source === 'outcome' && input.outcomeId !== null
              ? await findUsageRowByOutcomeId(tx, input.tenantId, input.outcomeId)
              : null;
        if (racedRefRow !== null) {
          if (racedRefRow.content_hash !== input.contentHash) {
            throw new BillingStoreRuleError(
              `work/outcome ${input.workId ?? input.outcomeId} is already metered with different content; duplicate billable work must not double-charge`,
              'usage-input-conflict',
            );
          }
          return { usage: mapUsage(racedRefRow), converged: true };
        }
        if (input.idempotencyKey !== null) {
          const keyed = await findUsageRowByIdempotencyKey(tx, input.tenantId, input.idempotencyKey);
          if (keyed !== null) {
            if (keyed.content_hash !== input.contentHash) {
              throw new BillingStoreRuleError(
                `usage idempotency key "${input.idempotencyKey}" was already bound to different content`,
                'idempotency-input-conflict',
              );
            }
            return { usage: mapUsage(keyed), converged: true };
          }
        }
        throw new StoreConflictError('recordUsage violated a uniqueness constraint', 'billing_usage_records_identity');
      });
    },

    async findWorkUsage(tenantId: string, workId: string): Promise<UsageRecord | null> {
      const row = await findUsageRowByWorkId(executor, tenantId, workId);
      return row === null ? null : mapUsage(row);
    },

    async findOutcomeUsage(tenantId: string, outcomeId: string): Promise<UsageRecord | null> {
      const row = await findUsageRowByOutcomeId(executor, tenantId, outcomeId);
      return row === null ? null : mapUsage(row);
    },

    async listUsage(tenantId: string, filter?: { subscriptionId?: string; billingPeriod?: string }): Promise<UsageRecord[]> {
      const clauses: string[] = ['tenant_id = $1'];
      const params: unknown[] = [tenantId];
      if (filter?.subscriptionId !== undefined) {
        params.push(filter.subscriptionId);
        clauses.push(`subscription_id = $${params.length}`);
      }
      if (filter?.billingPeriod !== undefined) {
        params.push(filter.billingPeriod);
        clauses.push(`billing_period = $${params.length}`);
      }
      const result = await executor.query(
        `SELECT ${USAGE_COLUMNS} FROM billing_usage_records WHERE ${clauses.join(' AND ')} ORDER BY occurred_at, id`,
        params,
      );
      return (result.rows as unknown as UsageRow[]).map(mapUsage);
    },

    async settlePeriod(input: SettlePeriodInput): Promise<{ ledger: BillingLedgerRecord; converged: boolean }> {
      return executor.withTransaction(async (tx) => {
        // Serialize settlement for this (tenant, subscription): concurrent
        // settlement converges on ONE durable ledger outcome.
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `billing-settlement:${input.tenantId}:${input.subscriptionId}`,
        ]);
        // Convergence: the period is already settled (the unique index
        // backstops this even without the lock).
        const existing = await findLedgerRow(tx, input.tenantId, input.subscriptionId, input.billingPeriod);
        if (existing !== null) {
          return { ledger: mapLedger(existing), converged: true };
        }
        const subscriptionRows = await tx.query(
          `SELECT ${SUBSCRIPTION_COLUMNS} FROM billing_subscriptions WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
          [input.tenantId, input.subscriptionId],
        );
        if ((subscriptionRows.rows[0] as unknown as SubscriptionRow | undefined) === undefined) {
          throw new BillingStoreMissingError('subscription', input.subscriptionId);
        }
        // Select the unsettled usage for the period INSIDE the critical
        // section: this exact set is what the ledger prices.
        const usageRows = await tx.query(
          `SELECT ${USAGE_COLUMNS} FROM billing_usage_records
           WHERE tenant_id = $1 AND subscription_id = $2 AND billing_period = $3 AND settled_ledger_id IS NULL
           ORDER BY occurred_at, id
           FOR UPDATE`,
          [input.tenantId, input.subscriptionId, input.billingPeriod],
        );
        const usage = (usageRows.rows as unknown as UsageRow[]).map(mapUsage);
        // Module-owned pure pricing policy (no clock, no IO here).
        const charges = input.priceUsage(usage);
        const ledgerId = randomUUID();
        let ledgerRecord: BillingLedgerRecord = {
          id: ledgerId,
          tenantId: input.tenantId,
          subscriptionId: input.subscriptionId,
          serviceId: input.serviceId,
          billingPeriod: input.billingPeriod,
          currency: input.currency,
          subscriptionCharge: charges.subscriptionCharge,
          usageCharge: charges.usageCharge,
          totalCharge: charges.totalCharge,
          usageCount: usage.length,
          settledAt: input.now,
          settledBy: input.settledBy,
          createdBy: input.settledBy,
          createdAt: input.now,
          updatedAt: input.now,
          contentHash: computeLedgerContentHash({
            tenantId: input.tenantId,
            subscriptionId: input.subscriptionId,
            serviceId: input.serviceId,
            billingPeriod: input.billingPeriod,
            currency: input.currency,
            subscriptionCharge: charges.subscriptionCharge,
            usageCharge: charges.usageCharge,
            totalCharge: charges.totalCharge,
            usageCount: usage.length,
            settledBy: input.settledBy,
          }),
          recordHash: '',
        };
        ledgerRecord = { ...ledgerRecord, recordHash: computeLedgerRecordHash(ledgerRecord) };
        const inserted = await tx.query(
          `INSERT INTO billing_period_ledger
             (id, tenant_id, subscription_id, service_id, billing_period, currency, subscription_charge,
              usage_charge, total_charge, usage_count, content_hash, record_hash, settled_by, created_by, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13, $14, $14)
           ON CONFLICT DO NOTHING
           RETURNING ${LEDGER_COLUMNS}`,
          [
            ledgerId,
            input.tenantId,
            input.subscriptionId,
            input.serviceId,
            input.billingPeriod,
            input.currency,
            charges.subscriptionCharge,
            charges.usageCharge,
            charges.totalCharge,
            usage.length,
            ledgerRecord.contentHash,
            ledgerRecord.recordHash,
            input.settledBy,
            input.now,
          ],
        );
        if (inserted.rows.length > 0) {
          const ledgerRow = inserted.rows[0] as unknown as LedgerRow;
          // Mark the exact settled usage set atomically with the ledger
          // insert. The usage record hashes are recomputed over the NEW
          // row state (settled_ledger_id and updated_at participate in
          // the hash) — settlement writes keep every stored hash truthful.
          await markUsageSettled(tx, input.tenantId, usage, ledgerRow.id, input.now);
          return { ledger: mapLedger(ledgerRow), converged: false };
        }
        // A concurrent settlement committed first: converge on the single
        // durable outcome (its usage set is authoritative).
        const raced = await findLedgerRow(tx, input.tenantId, input.subscriptionId, input.billingPeriod);
        if (raced !== null) {
          return { ledger: mapLedger(raced), converged: true };
        }
        throw new StoreConflictError('settlePeriod violated a uniqueness constraint', 'billing_period_ledger_identity');
      });
    },

    async findLedgerEntry(tenantId: string, subscriptionId: string, billingPeriod: string): Promise<BillingLedgerRecord | null> {
      const row = await findLedgerRow(executor, tenantId, subscriptionId, billingPeriod);
      return row === null ? null : mapLedger(row);
    },

    async listLedgerEntries(tenantId: string, billingPeriod?: string): Promise<BillingLedgerRecord[]> {
      const result = billingPeriod === undefined
        ? await executor.query(
            `SELECT ${LEDGER_COLUMNS} FROM billing_period_ledger WHERE tenant_id = $1 ORDER BY created_at, id`,
            [tenantId],
          )
        : await executor.query(
            `SELECT ${LEDGER_COLUMNS} FROM billing_period_ledger WHERE tenant_id = $1 AND billing_period = $2 ORDER BY created_at, id`,
            [tenantId, billingPeriod],
          );
      return (result.rows as unknown as LedgerRow[]).map(mapLedger);
    },

    async recordCostReference(input: RecordCostReferenceStoreInput): Promise<{ reference: CostReferenceRecord; converged: boolean }> {
      return executor.withTransaction(async (tx) => {
        // Keyed convergence (fast path; the insert-conflict re-read below
        // arbitrates races — the key unique index is the durable backstop).
        const existing = await findCostReferenceRowByKey(tx, input.tenantId, input.idempotencyKey);
        if (existing !== null) {
          if (existing.content_hash !== input.contentHash) {
            throw new BillingStoreRuleError(
              `cost reference idempotency key "${input.idempotencyKey}" was already bound to different content`,
              'idempotency-input-conflict',
            );
          }
          return { reference: mapCostReference(existing), converged: true };
        }
        const inserted = await tx.query(
          `INSERT INTO billing_cost_references
             (tenant_id, billing_period, source, external_reference, amount, currency, content_hash, record_hash,
              recorded_by, idempotency_key, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
           ON CONFLICT DO NOTHING
           RETURNING ${COST_REFERENCE_COLUMNS}`,
          [
            input.tenantId,
            input.billingPeriod,
            input.source,
            input.externalReference,
            input.amount,
            input.currency,
            input.contentHash,
            computeCostReferenceRecordHash({
              id: '',
              tenantId: input.tenantId,
              billingPeriod: input.billingPeriod,
              source: input.source,
              externalReference: input.externalReference,
              amount: input.amount,
              currency: input.currency,
              recordedBy: input.recordedBy,
              idempotencyKey: input.idempotencyKey,
              createdAt: input.now,
              updatedAt: input.now,
              contentHash: input.contentHash,
              recordHash: '',
            }),
            input.recordedBy,
            input.idempotencyKey,
            input.now,
          ],
        );
        if (inserted.rows.length > 0) {
          return { reference: mapCostReference(inserted.rows[0] as unknown as CostReferenceRow), converged: false };
        }
        const raced = await findCostReferenceRowByKey(tx, input.tenantId, input.idempotencyKey);
        if (raced !== null) {
          if (raced.content_hash !== input.contentHash) {
            throw new BillingStoreRuleError(
              `cost reference idempotency key "${input.idempotencyKey}" was already bound to different content`,
              'idempotency-input-conflict',
            );
          }
          return { reference: mapCostReference(raced), converged: true };
        }
        throw new StoreConflictError('recordCostReference violated a uniqueness constraint', 'billing_cost_references_identity');
      });
    },

    async listCostReferences(tenantId: string, billingPeriod?: string): Promise<CostReferenceRecord[]> {
      const result = billingPeriod === undefined
        ? await executor.query(
            `SELECT ${COST_REFERENCE_COLUMNS} FROM billing_cost_references WHERE tenant_id = $1 ORDER BY created_at, id`,
            [tenantId],
          )
        : await executor.query(
            `SELECT ${COST_REFERENCE_COLUMNS} FROM billing_cost_references WHERE tenant_id = $1 AND billing_period = $2 ORDER BY created_at, id`,
            [tenantId, billingPeriod],
          );
      return (result.rows as unknown as CostReferenceRow[]).map(mapCostReference);
    },
  };
}

/** Update the settled usage set atomically with truthful record hashes. */
async function markUsageSettled(
  tx: SqlExecutor,
  tenantId: string,
  usage: readonly UsageRecord[],
  ledgerId: string,
  now: Date,
): Promise<void> {
  for (const record of usage) {
    const next: UsageRecord = { ...record, settledLedgerId: ledgerId, updatedAt: now };
    const updated = await tx.query(
      `UPDATE billing_usage_records SET settled_ledger_id = $1, updated_at = $2, record_hash = $3
       WHERE tenant_id = $4 AND id = $5 AND settled_ledger_id IS NULL`,
      [ledgerId, now, computeUsageRecordHash(next), tenantId, record.id],
    );
    if (updated.rowCount === 0) {
      throw new StoreConflictError('settlePeriod could not mark a selected usage row settled', 'billing_usage_records_settlement');
    }
  }
}

/** UUID generation through the persistence boundary's discipline. */

