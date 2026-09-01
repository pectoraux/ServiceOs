/**
 * ServiceOS /policies SQL store (WORK-014, module internal).
 *
 * Authoritative persistence for policy contract versions and policy
 * decision records, executed through the persistence boundary's
 * `TransactionalExecutor` (parameterized SQL only; this file never imports
 * `pg`). Load-bearing invariants:
 *
 * 1. MANDATORY TENANT PREDICATES: every lookup/list selects through
 *    `tenant_id = $…`. Removing a predicate must fail the tenant-isolation
 *    discrimination tests.
 *
 * 2. CONVERGENCE: `createPolicyVersion` inserts against the partial unique
 *    idempotency index; a conflict for the same logical identity is mapped
 *    to a converged re-read. `recordDecision` likewise converges on the
 *    partial unique decision idempotency index.
 *
 * 3. SERIALIZED VERSION NUMBERING: `createPolicyVersion` takes a
 *    transaction-scope advisory lock keyed on (tenant, policy key, scope)
 *    before reading MAX(version), so concurrent creations never allocate
 *    the same number (the UNIQUE constraint is the schema backstop).
 *
 * 4. FORWARD-ONLY ACTIVATION: `activatePolicyVersion` locks the version
 *    row, rejects retired versions (rule `version-retired`), converges on
 *    the already-active version, and retires the prior active version
 *    BEFORE activating this one (the one-active partial unique index is
 *    enforced per statement — same ordering lesson as WORK-003).
 *
 * 5. DECISION INTEGRITY: `findDecisionById` recomputes the persisted
 *    record hash from the stored fields and throws rule
 *    `decision-record-tampered` when they diverge — an after-the-fact
 *    mutation of a recorded policy result is detected on read. A stored
 *    input that no longer matches its stored input hash is likewise
 *    tampering. `recordDecision` compares input hashes for the same
 *    idempotency key (rule `decision-input-conflict`).
 */
import { createHash } from 'node:crypto';
import type { SqlExecutor, TransactionalExecutor } from '../../platform/persistence/index.js';
import { StoreConflictError } from '../auth/index.js';
import { canonicalJson, type PolicyInput } from './evaluation.js';
import {
  PolicyStoreMissingError,
  PolicyStoreRuleError,
  type CreatePolicyVersionInput,
  type PolicyCondition,
  type PolicyContractRecord,
  type PolicyDecisionRecord,
  type PolicyEffect,
  type PolicyInputValue,
  type PolicyLayerProvenance,
  type PolicyRule,
  type PolicyScope,
  type PolicyStatus,
  type PolicyStore,
  type RecordDecisionInput,
  type ActivatePolicyVersionInput,
} from './store.js';

interface ContractRow {
  id: string;
  tenant_id: string;
  policy_key: string;
  scope: string;
  version: number;
  status: string;
  rules: unknown;
  default_effect: string;
  created_by: string;
  idempotency_key: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface DecisionRow {
  id: string;
  tenant_id: string;
  policy_key: string;
  outcome: string;
  deciding_layer: string;
  deciding_rule_id: string | null;
  frozen_revision: string;
  layers: unknown;
  input: unknown;
  input_hash: string;
  record_hash: string;
  decided_by: string;
  idempotency_key: string | null;
  created_at: Date | string;
}

const CONTRACT_COLUMNS =
  'id, tenant_id, policy_key, scope, version, status, rules, default_effect, created_by, idempotency_key, created_at, updated_at';
const DECISION_COLUMNS =
  'id, tenant_id, policy_key, outcome, deciding_layer, deciding_rule_id, frozen_revision, layers, input, input_hash, record_hash, decided_by, idempotency_key, created_at';

const UUID_INPUT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function isPolicyStatus(value: string): value is PolicyStatus {
  return value === 'draft' || value === 'active' || value === 'retired';
}

function isPolicyScope(value: string): value is PolicyScope {
  return value === 'base' || value === 'customer';
}

function isEffect(value: unknown): value is PolicyEffect {
  return value === 'allow' || value === 'deny';
}

function isPrimitive(value: unknown): value is PolicyInputValue {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/**
 * Rows are written by this store (validated rule sets) and never mutated in
 * content afterwards; mapping re-validates the shape defensively so a
 * tampered/corrupt row fails closed instead of silently changing meaning.
 */
function mapRules(raw: unknown): readonly PolicyRule[] {
  if (!Array.isArray(raw)) {
    throw new PolicyStoreRuleError('policy contract rules column is not an array', 'decision-record-tampered');
  }
  const rules: PolicyRule[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      throw new PolicyStoreRuleError('policy contract rule is not an object', 'decision-record-tampered');
    }
    const candidate = entry as Record<string, unknown>;
    const id = candidate.id;
    const when = candidate.when as Record<string, unknown> | undefined;
    const effect = candidate.effect;
    if (typeof id !== 'string' || typeof when !== 'object' || !isEffect(effect)) {
      throw new PolicyStoreRuleError('policy contract rule has an invalid shape', 'decision-record-tampered');
    }
    const rule: PolicyRule = {
      id,
      ...(typeof candidate.description === 'string' ? { description: candidate.description } : {}),
      when: when as PolicyCondition,
      effect,
    };
    rules.push(rule);
  }
  return rules;
}

function mapContract(row: ContractRow): PolicyContractRecord {
  if (!isPolicyScope(row.scope) || !isPolicyStatus(row.status) || !isEffect(row.default_effect)) {
    // Closed enumerations are schema-level; a divergent value can only come
    // from out-of-band mutation. Fail closed rather than guess.
    throw new PolicyStoreRuleError(`policy contract ${row.id} has an out-of-enumeration field`, 'decision-record-tampered');
  }
  return {
    id: row.id,
    tenantId: row.tenant_id,
    policyKey: row.policy_key,
    scope: row.scope,
    version: row.version,
    status: row.status,
    rules: mapRules(row.rules),
    defaultEffect: row.default_effect,
    createdBy: row.created_by,
    idempotencyKey: row.idempotency_key,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function mapLayers(raw: unknown): readonly PolicyLayerProvenance[] {
  if (!Array.isArray(raw)) {
    throw new PolicyStoreRuleError('policy decision layers column is not an array', 'decision-record-tampered');
  }
  const layers: PolicyLayerProvenance[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      throw new PolicyStoreRuleError('policy decision layer is not an object', 'decision-record-tampered');
    }
    const candidate = entry as Record<string, unknown>;
    const layer = candidate.layer;
    const policyId = candidate.policyId;
    const version = candidate.version;
    const outcome = candidate.outcome;
    const ruleId = candidate.ruleId;
    if (
      (layer !== 'frozen' && layer !== 'customer' && layer !== 'base') ||
      (policyId !== null && typeof policyId !== 'string') ||
      (version !== null && typeof version !== 'number') ||
      (outcome !== 'allow' && outcome !== 'deny' && outcome !== 'no-policy') ||
      (ruleId !== null && typeof ruleId !== 'string')
    ) {
      throw new PolicyStoreRuleError('policy decision layer has an invalid shape', 'decision-record-tampered');
    }
    layers.push({ layer, policyId, version, outcome, ruleId });
  }
  return layers;
}

function mapInput(raw: unknown): PolicyInput {
  if (typeof raw !== 'object' || raw === null) {
    throw new PolicyStoreRuleError('policy decision input column is not an object', 'decision-record-tampered');
  }
  const candidate = raw as Record<string, unknown>;
  const action = candidate.action;
  const attributes = candidate.attributes;
  if (typeof action !== 'string' || typeof attributes !== 'object' || attributes === null) {
    throw new PolicyStoreRuleError('policy decision input has an invalid shape', 'decision-record-tampered');
  }
  const mapped: Record<string, PolicyInputValue> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (!isPrimitive(value)) {
      throw new PolicyStoreRuleError(`policy decision input attribute "${key}" is not primitive`, 'decision-record-tampered');
    }
    mapped[key] = value;
  }
  return { action, attributes: mapped };
}

function mapDecision(row: DecisionRow): PolicyDecisionRecord {
  if (!isEffect(row.outcome)) {
    throw new PolicyStoreRuleError(`policy decision ${row.id} has an out-of-enumeration outcome`, 'decision-record-tampered');
  }
  if (
    row.deciding_layer !== 'frozen' &&
    row.deciding_layer !== 'customer' &&
    row.deciding_layer !== 'base' &&
    row.deciding_layer !== 'default'
  ) {
    throw new PolicyStoreRuleError(`policy decision ${row.id} has an out-of-enumeration deciding layer`, 'decision-record-tampered');
  }
  const input = mapInput(row.input);
  const decision: PolicyDecisionRecord = {
    id: row.id,
    tenantId: row.tenant_id,
    policyKey: row.policy_key,
    outcome: row.outcome,
    decidingLayer: row.deciding_layer,
    decidingRuleId: row.deciding_rule_id,
    frozenRevision: row.frozen_revision,
    layers: mapLayers(row.layers),
    input,
    inputHash: row.input_hash,
    recordHash: row.record_hash,
    decidedBy: row.decided_by,
    idempotencyKey: row.idempotency_key,
    createdAt: toDate(row.created_at),
  };
  // Integrity verification: every read recomputes the persisted hashes from
  // the stored fields. Any after-the-fact mutation of the recorded result
  // (outcome, provenance, input, identity, attribution) is detected here.
  if (computeInputHash(input) !== decision.inputHash) {
    throw new PolicyStoreRuleError(
      `policy decision ${row.id} input no longer matches its recorded input hash`,
      'decision-record-tampered',
    );
  }
  if (computeRecordHash(decision) !== decision.recordHash) {
    throw new PolicyStoreRuleError(
      `policy decision ${row.id} record no longer matches its recorded integrity hash`,
      'decision-record-tampered',
    );
  }
  return decision;
}

function computeInputHash(input: PolicyInput): string {
  return createHash('sha256').update(canonicalJson({ action: input.action, attributes: input.attributes })).digest('hex');
}

function computeRecordHash(decision: PolicyDecisionRecord): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        tenantId: decision.tenantId,
        policyKey: decision.policyKey,
        outcome: decision.outcome,
        decidingLayer: decision.decidingLayer,
        decidingRuleId: decision.decidingRuleId,
        frozenRevision: decision.frozenRevision,
        layers: decision.layers,
        input: decision.input,
        inputHash: decision.inputHash,
        decidedBy: decision.decidedBy,
        createdAt: decision.createdAt.toISOString(),
      }),
    )
    .digest('hex');
}

/** Map a driver unique-violation to the shared conflict error. */
function mapStoreError(error: unknown, context: string): unknown {
  if (
    error instanceof StoreConflictError ||
    error instanceof PolicyStoreRuleError ||
    error instanceof PolicyStoreMissingError
  ) {
    return error;
  }
  const candidate = error as { code?: string; constraint?: string };
  if (typeof candidate?.code === 'string' && candidate.code === '23505') {
    return new StoreConflictError(`${context} violated a uniqueness constraint`, candidate.constraint ?? 'unknown');
  }
  return error;
}

export function createSqlPolicyStore(executor: TransactionalExecutor): PolicyStore {
  async function insertReturning(
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

  async function findContractRowById(exec: SqlExecutor, tenantId: string, versionId: string): Promise<ContractRow | null> {
    const result = await exec.query(
      `SELECT ${CONTRACT_COLUMNS} FROM policy_contracts WHERE tenant_id = $1 AND id = $2`,
      [tenantId, versionId],
    );
    const row = result.rows[0] as unknown as ContractRow | undefined;
    return row === undefined ? null : row;
  }

  async function findContractRowByIdempotencyKey(
    exec: SqlExecutor,
    tenantId: string,
    idempotencyKey: string,
  ): Promise<ContractRow | null> {
    const result = await exec.query(
      `SELECT ${CONTRACT_COLUMNS} FROM policy_contracts WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenantId, idempotencyKey],
    );
    const row = result.rows[0] as unknown as ContractRow | undefined;
    return row === undefined ? null : row;
  }

  async function findDecisionRowByIdempotencyKey(
    exec: SqlExecutor,
    tenantId: string,
    idempotencyKey: string,
  ): Promise<DecisionRow | null> {
    const result = await exec.query(
      `SELECT ${DECISION_COLUMNS} FROM policy_decisions WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenantId, idempotencyKey],
    );
    const row = result.rows[0] as unknown as DecisionRow | undefined;
    return row === undefined ? null : row;
  }

  return {
    async createPolicyVersion(input: CreatePolicyVersionInput): Promise<{ contract: PolicyContractRecord; converged: boolean }> {
      return executor.withTransaction(async (tx) => {
        // Converge on an existing logical creation first (the partial unique
        // index is the race backstop for actors that slipped past the lock).
        if (input.idempotencyKey !== null) {
          const existing = await findContractRowByIdempotencyKey(tx, input.tenantId, input.idempotencyKey);
          if (existing !== null) {
            return { contract: mapContract(existing), converged: true };
          }
        }
        // Serialize version numbering for this (tenant, policy key, scope).
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `${input.tenantId}:${input.policyKey}:${input.scope}`,
        ]);
        const sequence = await tx.query(
          `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM policy_contracts
           WHERE tenant_id = $1 AND policy_key = $2 AND scope = $3`,
          [input.tenantId, input.policyKey, input.scope],
        );
        const version = (sequence.rows[0] as { next: number }).next;
        try {
          const rows = await insertReturning(
            tx,
            `INSERT INTO policy_contracts (tenant_id, policy_key, scope, version, status, rules, default_effect, created_by, idempotency_key, created_at, updated_at)
             VALUES ($1, $2, $3, $4, 'draft', $5::jsonb, $6, $7, $8, $9, $9)
             RETURNING ${CONTRACT_COLUMNS}`,
            [
              input.tenantId,
              input.policyKey,
              input.scope,
              version,
              JSON.stringify(input.rules),
              input.defaultEffect,
              input.createdBy,
              input.idempotencyKey,
              input.now,
            ],
            'createPolicyVersion',
          );
          return { contract: mapContract(rows[0] as unknown as ContractRow), converged: false };
        } catch (error) {
          const conflict = mapStoreError(error, 'createPolicyVersion');
          if (
            conflict instanceof StoreConflictError &&
            conflict.constraint === 'policy_contracts_tenant_idempotency_key' &&
            input.idempotencyKey !== null
          ) {
            // A concurrent creator of the same logical identity committed
            // first: converge on the durable row.
            const existing = await findContractRowByIdempotencyKey(tx, input.tenantId, input.idempotencyKey);
            if (existing !== null) {
              return { contract: mapContract(existing), converged: true };
            }
          }
          throw conflict;
        }
      });
    },

    async findPolicyVersionById(tenantId: string, versionId: string): Promise<PolicyContractRecord | null> {
      const row = await findContractRowById(executor, tenantId, versionId);
      return row === null ? null : mapContract(row);
    },

    async listPolicyVersions(tenantId: string, policyKey: string, scope?: PolicyScope): Promise<PolicyContractRecord[]> {
      const result =
        scope === undefined
          ? await executor.query(
              `SELECT ${CONTRACT_COLUMNS} FROM policy_contracts WHERE tenant_id = $1 AND policy_key = $2 ORDER BY version ASC`,
              [tenantId, policyKey],
            )
          : await executor.query(
              `SELECT ${CONTRACT_COLUMNS} FROM policy_contracts WHERE tenant_id = $1 AND policy_key = $2 AND scope = $3 ORDER BY version ASC`,
              [tenantId, policyKey, scope],
            );
      return result.rows.map((row) => mapContract(row as unknown as ContractRow));
    },

    async findActivePolicyVersion(tenantId: string, policyKey: string, scope: PolicyScope): Promise<PolicyContractRecord | null> {
      const result = await executor.query(
        `SELECT ${CONTRACT_COLUMNS} FROM policy_contracts
         WHERE tenant_id = $1 AND policy_key = $2 AND scope = $3 AND status = 'active'
         ORDER BY version DESC LIMIT 1`,
        [tenantId, policyKey, scope],
      );
      const row = result.rows[0] as unknown as ContractRow | undefined;
      return row === undefined ? null : mapContract(row);
    },

    async activatePolicyVersion(input: ActivatePolicyVersionInput): Promise<{ contract: PolicyContractRecord; converged: boolean }> {
      return executor.withTransaction(async (tx) => {
        const rows = await tx.query(
          `SELECT ${CONTRACT_COLUMNS} FROM policy_contracts WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
          [input.tenantId, input.versionId],
        );
        const row = rows.rows[0] as unknown as ContractRow | undefined;
        if (row === undefined) {
          throw new PolicyStoreMissingError(
            `policy version ${input.versionId} does not exist in this tenant`,
            'policy-version',
          );
        }
        if (row.status === 'active') {
          // Idempotent re-activation: already the active version.
          return { contract: mapContract(row), converged: true };
        }
        if (row.status === 'retired') {
          // Forward-only: a retired version can never return to active.
          throw new PolicyStoreRuleError(
            `policy version ${input.versionId} is retired and cannot be re-activated`,
            'version-retired',
          );
        }
        // Retire the currently active version of the same identity FIRST
        // (the one-active partial unique index is enforced per statement).
        await tx.query(
          `UPDATE policy_contracts SET status = 'retired', updated_at = $1
           WHERE tenant_id = $2 AND policy_key = $3 AND scope = $4 AND status = 'active'`,
          [input.now, row.tenant_id, row.policy_key, row.scope],
        );
        const updated = await insertReturning(
          tx,
          `UPDATE policy_contracts SET status = 'active', updated_at = $1
           WHERE tenant_id = $2 AND id = $3 AND status = 'draft'
           RETURNING ${CONTRACT_COLUMNS}`,
          [input.now, input.tenantId, input.versionId],
          'activatePolicyVersion',
        );
        return { contract: mapContract(updated[0] as unknown as ContractRow), converged: false };
      });
    },

    async recordDecision(input: RecordDecisionInput): Promise<{ decision: PolicyDecisionRecord; converged: boolean }> {
      return executor.withTransaction(async (tx) => {
        // Convergence / conflict check for re-delivery of the same gated
        // decision (the partial unique index is the race backstop).
        if (input.idempotencyKey !== null) {
          const existing = await findDecisionRowByIdempotencyKey(tx, input.tenantId, input.idempotencyKey);
          if (existing !== null) {
            if (existing.input_hash !== input.inputHash) {
              throw new PolicyStoreRuleError(
                `decision idempotency key "${input.idempotencyKey}" was already bound to a different input`,
                'decision-input-conflict',
              );
            }
            return { decision: mapDecision(existing), converged: true };
          }
        }
        try {
          const rows = await insertReturning(
            tx,
            `INSERT INTO policy_decisions (tenant_id, policy_key, outcome, deciding_layer, deciding_rule_id, frozen_revision, layers, input, input_hash, record_hash, decided_by, idempotency_key, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12, $13)
             RETURNING ${DECISION_COLUMNS}`,
            [
              input.tenantId,
              input.policyKey,
              input.outcome,
              input.decidingLayer,
              input.decidingRuleId,
              input.frozenRevision,
              JSON.stringify(input.layers),
              JSON.stringify(input.input),
              input.inputHash,
              input.recordHash,
              input.decidedBy,
              input.idempotencyKey,
              input.now,
            ],
            'recordDecision',
          );
          return { decision: mapDecision(rows[0] as unknown as DecisionRow), converged: false };
        } catch (error) {
          const conflict = mapStoreError(error, 'recordDecision');
          if (
            conflict instanceof StoreConflictError &&
            conflict.constraint === 'policy_decisions_tenant_idempotency_key' &&
            input.idempotencyKey !== null
          ) {
            // A concurrent evaluation of the same gated decision committed
            // first: converge when the input matches, fail closed otherwise.
            const existing = await findDecisionRowByIdempotencyKey(tx, input.tenantId, input.idempotencyKey);
            if (existing !== null) {
              if (existing.input_hash !== input.inputHash) {
                throw new PolicyStoreRuleError(
                  `decision idempotency key "${input.idempotencyKey}" was already bound to a different input`,
                  'decision-input-conflict',
                );
              }
              return { decision: mapDecision(existing), converged: true };
            }
          }
          throw conflict;
        }
      });
    },

    async findDecisionById(tenantId: string, decisionId: string): Promise<PolicyDecisionRecord | null> {
      const result = await executor.query(
        `SELECT ${DECISION_COLUMNS} FROM policy_decisions WHERE tenant_id = $1 AND id = $2`,
        [tenantId, decisionId],
      );
      const row = result.rows[0] as unknown as DecisionRow | undefined;
      // mapDecision verifies the persisted hashes (tamper detection).
      return row === undefined ? null : mapDecision(row);
    },

    async findDecisionByIdempotencyKey(tenantId: string, idempotencyKey: string): Promise<PolicyDecisionRecord | null> {
      const result = await executor.query(
        `SELECT ${DECISION_COLUMNS} FROM policy_decisions WHERE tenant_id = $1 AND idempotency_key = $2`,
        [tenantId, idempotencyKey],
      );
      const row = result.rows[0] as unknown as DecisionRow | undefined;
      return row === undefined ? null : mapDecision(row);
    },
  };
}
