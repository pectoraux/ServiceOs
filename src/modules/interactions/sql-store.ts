/**
 * ServiceOS /interactions SQL store (WORK-015, module internal).
 *
 * Authoritative persistence for the provider-neutral external interaction
 * ledger, executed through the persistence boundary's
 * `TransactionalExecutor` (parameterized SQL only; this file never imports
 * `pg`). Load-bearing invariants:
 *
 * 1. THE BUSINESS SIDE-EFFECT BOUNDARY. This store owns every external
 *    effect's durable lifecycle (intended -> dispatching -> dispatched ->
 *    observed) and NOTHING else: no Service Work state is written here
 *    (the /workflow authority owns the status column; the WORK-004 checks
 *    reject any other writer), no provider is called from here (the module
 *    invokes the injected provider-neutral sink between the claim and the
 *    completion writes), and no business outcome is derived here — a
 *    provider success is just an observation row. The transaction-scope
 *    discipline from the PR #28 review applies throughout: the `query`
 *    helper takes its executor EXPLICITLY and every statement inside
 *    `withTransaction` passes `tx` (the pinned transaction client); reads
 *    pass the pooled `executor`. The transaction-scope proofs fail the
 *    build if any statement escapes.
 *
 * 2. MANDATORY TENANT PREDICATES: every lookup/list selects through
 *    `tenant_id = $…`. Removing a predicate must fail the tenant-isolation
 *    discrimination tests (a row in another tenant is indistinguishable
 *    from a missing row).
 *
 * 3. CONVERGENCE, NOT DUPLICATION: `createInteraction` converges on the
 *    durable interaction identified by (tenant, idempotency key) — the
 *    keyed lookup runs inside the transaction and the insert uses
 *    `ON CONFLICT … DO NOTHING` against the tenant-scoped partial unique
 *    index, so a concurrent creator of the same logical intent keeps a
 *    healthy transaction and converges by re-reading (a raised 23505
 *    would abort it with 25P02 — the WORK-014 lesson).
 *
 * 4. SERIALIZED STATE TRANSITIONS: every mutation (`claimDispatch`,
 *    `completeDispatch`, `recordDispatchFailure`, `recordObservation`)
 *    locks the row (`SELECT … FOR UPDATE`) BEFORE comparing the expected
 *    state, then UPDATEs with the state predicate re-asserted and
 *    recomputes the record integrity hash — one atomic unit per
 *    transition. Concurrent dispatchers of the same interaction
 *    serialize on the row lock; every loser fails closed with the typed
 *    rule carrying the observed state (never a lost update, never a
 *    double transition).
 *
 * 5. TAMPER-EVIDENT READS: `mapInteraction` recomputes the record
 *    integrity hash from the stored fields and fails closed with rule
 *    `interaction-record-tampered` on divergence — after-the-fact mutation
 *    of any recorded field (capability, params, states, provenance,
 *    observation) is detected on every read. Divergent RE-observation of
 *    an already-observed interaction fails closed
 *    (`observation-conflict`) — duplicate interaction mutation is
 *    detected; identical re-observation converges.
 *
 * 6. RETRY LINEAGE IS VALIDATED IN TRANSACTION: an interaction that
 *    declares `retryOf` must point at an observed FAILURE of the SAME
 *    tenant (the retry protocol precondition: retries create a distinct
 *    identity after a failed observation; they never rewrite it).
 */
import type { SqlExecutor, TransactionalExecutor } from '../../platform/persistence/index.js';
import { StoreConflictError } from '../auth/index.js';
import { isCapabilityClass, type CapabilityClass } from '../integrations/index.js';
import { canonicalJson, computeInteractionRecordHash, hashObservation } from './provenance.js';
import {
  InteractionsStoreMissingError,
  InteractionsStoreRuleError,
  type ClaimDispatchInput,
  type CompleteDispatchInput,
  type CreateInteractionInput,
  type InteractionClaim,
  type InteractionDispatch,
  type InteractionFilter,
  type InteractionObservation,
  type InteractionOutcome,
  type InteractionRecord,
  type InteractionState,
  type PolicyProvenance,
  type ReclaimDispatchInput,
  type RecordDispatchFailureInput,
  type RecordObservationInput,
  type InteractionsStore,
  type InteractionsStoreRule,
} from './store.js';

interface InteractionRow {
  id: string;
  tenant_id: string;
  capability: string;
  params: unknown;
  correlation: unknown;
  retry_of_interaction_id: string | null;
  policy_key: string | null;
  policy_decision_id: string | null;
  requested_by: string;
  idempotency_key: string | null;
  input_hash: string;
  record_hash: string;
  state: string;
  claim_claimed_by: string | null;
  claim_claimed_at: Date | string | null;
  provider: string | null;
  provider_reference: string | null;
  dispatched_at: Date | string | null;
  dispatched_by: string | null;
  outcome: string | null;
  failure_stage: string | null;
  observed_by: string | null;
  observed_at: Date | string | null;
  provider_observation: unknown;
  created_at: Date | string;
  updated_at: Date | string;
}

const INTERACTION_COLUMNS = `id, tenant_id, capability, params, correlation, retry_of_interaction_id, policy_key, policy_decision_id, requested_by, idempotency_key, input_hash, record_hash, state, claim_claimed_by, claim_claimed_at, provider, provider_reference, dispatched_at, dispatched_by, outcome, failure_stage, observed_by, observed_at, provider_observation, created_at, updated_at`;

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function isInteractionState(value: string): value is InteractionState {
  return value === 'intended' || value === 'dispatching' || value === 'dispatched' || value === 'observed';
}

function isOutcome(value: string): value is InteractionOutcome {
  return value === 'succeeded' || value === 'failed';
}

function isFailureStage(value: string): value is 'dispatch' | 'provider' {
  return value === 'dispatch' || value === 'provider';
}

function tampered(id: string, what: string): InteractionsStoreRuleError {
  return new InteractionsStoreRuleError(`interaction ${id} record no longer matches its integrity hash (${what})`, 'interaction-record-tampered');
}

/** Guarded capability mapping: out-of-taxonomy rows fail closed. */
function toCapability(value: string, id: string): CapabilityClass {
  if (!isCapabilityClass(value)) {
    throw tampered(id, `capability "${value}" is outside the frozen taxonomy`);
  }
  return value;
}

function toParams(value: unknown, id: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw tampered(id, 'params is not an object');
  }
  return value as Readonly<Record<string, unknown>>;
}

function toCorrelation(value: unknown, id: string): Readonly<Record<string, string>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw tampered(id, 'correlation is not an object');
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== 'string') {
      throw tampered(id, `correlation entry "${key}" is not a string`);
    }
    out[key] = entry;
  }
  return out;
}

function toPolicy(row: InteractionRow, id: string): PolicyProvenance | null {
  if (row.policy_key === null && row.policy_decision_id === null) return null;
  if (typeof row.policy_key !== 'string' || typeof row.policy_decision_id !== 'string') {
    throw tampered(id, 'policy provenance has one column set without the other');
  }
  return { policyKey: row.policy_key, decisionId: row.policy_decision_id };
}

function mapInteraction(row: InteractionRow): InteractionRecord {
  const id = row.id;
  const state = row.state;
  if (!isInteractionState(state)) {
    throw tampered(id, `state "${state}" is outside the interaction lifecycle`);
  }
  // Column-group consistency (fail closed, mirroring the schema's
  // lifecycle shape CHECKs): a partial or orphan group — a claim with one
  // column set, a partial acceptance, a provider reference without its
  // provider, observation columns without an outcome, a failure stage on
  // a non-failed outcome — is an inconsistent row, detected at the read
  // boundary as tampering rather than silently dropped from the record
  // (which would blind the integrity hash to those columns).
  if ((row.claim_claimed_by !== null) !== (row.claim_claimed_at !== null)) {
    throw tampered(id, 'claim columns are inconsistent');
  }
  const hasProvider = row.provider !== null;
  if (hasProvider !== (row.dispatched_at !== null) || hasProvider !== (row.dispatched_by !== null)) {
    throw tampered(id, 'dispatch acceptance columns are inconsistent');
  }
  if (row.provider_reference !== null && !hasProvider) {
    throw tampered(id, 'provider_reference is set without a provider');
  }
  const hasOutcome = row.outcome !== null;
  if (
    hasOutcome !== (row.observed_by !== null) ||
    hasOutcome !== (row.observed_at !== null) ||
    hasOutcome !== (row.provider_observation !== null)
  ) {
    throw tampered(id, 'observation columns are inconsistent');
  }
  if (row.failure_stage !== null && row.outcome !== 'failed') {
    throw tampered(id, `failure stage "${row.failure_stage}" is set on outcome "${row.outcome}"`);
  }
  const claim: InteractionClaim | null =
    row.claim_claimed_by !== null && row.claim_claimed_at !== null
      ? { claimedBy: row.claim_claimed_by, claimedAt: toDate(row.claim_claimed_at) }
      : null;
  const dispatch: InteractionDispatch | null =
    hasProvider
      ? {
          provider: row.provider as string,
          providerReference: row.provider_reference,
          dispatchedAt: toDate(row.dispatched_at as Date | string),
          dispatchedBy: row.dispatched_by as string,
        }
      : null;
  let observation: InteractionObservation | null = null;
  if (hasOutcome) {
    if (!isOutcome(row.outcome as string)) {
      throw tampered(id, `outcome "${row.outcome}" is outside the outcome list`);
    }
    const failureStage =
      row.failure_stage === null ? null : isFailureStage(row.failure_stage) ? row.failure_stage : null;
    if (row.failure_stage !== null && failureStage === null) {
      throw tampered(id, `failure stage "${row.failure_stage}" is invalid`);
    }
    observation = {
      outcome: row.outcome as InteractionOutcome,
      failureStage,
      providerObservation: row.provider_observation,
      observedBy: row.observed_by as string,
      observedAt: toDate(row.observed_at as Date | string),
    };
  }
  const interaction: InteractionRecord = {
    id,
    tenantId: row.tenant_id,
    capability: toCapability(row.capability, id),
    params: toParams(row.params, id),
    correlation: toCorrelation(row.correlation, id),
    retryOfInteractionId: row.retry_of_interaction_id,
    policy: toPolicy(row, id),
    requestedBy: row.requested_by,
    idempotencyKey: row.idempotency_key,
    inputHash: row.input_hash,
    recordHash: row.record_hash,
    state,
    claim,
    dispatch,
    observation,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
  // Integrity verification: every read recomputes the persisted record
  // hash from the stored fields. Any after-the-fact mutation of the
  // recorded interaction (capability, params, lineage, provenance,
  // states, observation) is detected here.
  if (computeInteractionRecordHash(interaction) !== interaction.recordHash) {
    throw tampered(id, 'record hash mismatch');
  }
  return interaction;
}

/** Map a driver unique-violation to the shared conflict error. */
function mapStoreError(error: unknown, context: string): unknown {
  if (
    error instanceof StoreConflictError ||
    error instanceof InteractionsStoreRuleError ||
    error instanceof InteractionsStoreMissingError
  ) {
    return error;
  }
  const candidate = error as { code?: string; constraint?: string };
  if (typeof candidate?.code === 'string' && candidate.code === '23505') {
    return new StoreConflictError(`${context} violated a uniqueness constraint`, candidate.constraint ?? 'unknown');
  }
  return error;
}

export function createSqlInteractionsStore(executor: TransactionalExecutor): InteractionsStore {
  /**
   * Parameterized statement helper. The FIRST parameter is the executor
   * the statement runs on, passed EXPLICITLY at every call site: read
   * paths pass `executor` (the pool); every statement inside
   * `withTransaction` passes `tx` (the pinned client) — the discipline
   * fixed in the PR #28 review; the transaction-scope proofs fail the
   * build if a statement escapes.
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

  async function findInteractionRowById(
    exec: SqlExecutor,
    tenantId: string,
    interactionId: string,
  ): Promise<InteractionRow | null> {
    const rows = await query(
      exec,
      `SELECT ${INTERACTION_COLUMNS} FROM interaction_effects WHERE tenant_id = $1 AND id = $2`,
      [tenantId, interactionId],
      'findInteractionById',
    );
    const row = rows[0] as unknown as InteractionRow | undefined;
    return row === undefined ? null : row;
  }

  async function findInteractionRowByKey(
    exec: SqlExecutor,
    tenantId: string,
    idempotencyKey: string,
  ): Promise<InteractionRow | null> {
    const rows = await query(
      exec,
      `SELECT ${INTERACTION_COLUMNS} FROM interaction_effects WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenantId, idempotencyKey],
      'findInteractionByIdempotencyKey',
    );
    const row = rows[0] as unknown as InteractionRow | undefined;
    return row === undefined ? null : row;
  }

  /** Lock the interaction row and map it (hash verified on read). */
  async function lockInteractionRow(
    tx: SqlExecutor,
    tenantId: string,
    interactionId: string,
    context: string,
  ): Promise<InteractionRow> {
    const rows = await query(
      tx,
      `SELECT ${INTERACTION_COLUMNS} FROM interaction_effects WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenantId, interactionId],
      context,
    );
    const row = rows[0] as unknown as InteractionRow | undefined;
    if (row === undefined) {
      throw new InteractionsStoreMissingError(`interaction ${interactionId} does not exist in this tenant`, 'interaction');
    }
    return row;
  }

  /**
   * The one state-write helper: assert the expected source state (under
   * the row lock), recompute the record hash over the post-write record,
   * and UPDATE with the state predicate re-asserted — one atomic unit.
   */
  async function writeState(
    tx: SqlExecutor,
    input: { tenantId: string; interactionId: string; now: Date },
    expectedState: InteractionState,
    next: (current: InteractionRecord) => InteractionRecord,
    context: string,
  ): Promise<InteractionRecord> {
    const row = await lockInteractionRow(tx, input.tenantId, input.interactionId, context);
    const current = mapInteraction(row);
    if (current.state !== expectedState) {
      throw new InteractionsStoreRuleError(
        `interaction ${input.interactionId} is in state "${current.state}", not the expected "${expectedState}"`,
        expectedState === 'intended'
          ? 'dispatch-claim-conflict'
          : expectedState === 'dispatching'
            ? 'dispatch-completion-conflict'
            : 'observation-state-invalid',
      );
    }
    // The post-write record: every legitimate state write advances
    // updated_at to THIS write's now — the record hash is computed over
    // the post-write record INCLUDING the new updated_at, so the stored
    // hash and the stored row stay consistent (a moving clock must never
    // poison the next read's integrity verification).
    const updated: InteractionRecord = { ...next(current), updatedAt: input.now };
    const recordHash = computeInteractionRecordHash(updated);
    await query(
      tx,
      `UPDATE interaction_effects
       SET state = $1, claim_claimed_by = $2, claim_claimed_at = $3,
           provider = $4, provider_reference = $5, dispatched_at = $6, dispatched_by = $7,
           outcome = $8, failure_stage = $9, observed_by = $10, observed_at = $11, provider_observation = $12::jsonb,
           record_hash = $13, updated_at = $14
       WHERE tenant_id = $15 AND id = $16 AND state = $17`,
      [
        updated.state,
        updated.claim?.claimedBy ?? null,
        updated.claim?.claimedAt ?? null,
        updated.dispatch?.provider ?? null,
        updated.dispatch?.providerReference ?? null,
        updated.dispatch?.dispatchedAt ?? null,
        updated.dispatch?.dispatchedBy ?? null,
        updated.observation?.outcome ?? null,
        updated.observation?.failureStage ?? null,
        updated.observation?.observedBy ?? null,
        updated.observation?.observedAt ?? null,
        updated.observation === null ? null : canonicalJson(updated.observation.providerObservation),
        recordHash,
        input.now,
        input.tenantId,
        input.interactionId,
        expectedState,
      ],
      context,
    );
    return { ...updated, recordHash };
  }

  /** Converge a keyed re-submission on the durable interaction, or fail closed. */
  function convergeOrConflict(
    row: InteractionRow,
    input: CreateInteractionInput,
  ): { interaction: InteractionRecord; converged: boolean } {
    const interaction = mapInteraction(row);
    if (interaction.inputHash !== input.inputHash) {
      throw new InteractionsStoreRuleError(
        `idempotency key "${input.idempotencyKey}" was already used for a different interaction input`,
        'interaction-input-conflict',
      );
    }
    return { interaction, converged: true };
  }

  return {
    async createInteraction(input: CreateInteractionInput): Promise<{ interaction: InteractionRecord; converged: boolean }> {
      return executor.withTransaction(async (tx) => {
        // Keyed fast-path convergence: a retry re-observes the durable
        // interaction before anything else.
        if (input.idempotencyKey !== null) {
          const existing = await findInteractionRowByKey(tx, input.tenantId, input.idempotencyKey);
          if (existing !== null) {
            return convergeOrConflict(existing, input);
          }
        }

        // Retry lineage (validated in transaction, before the insert): the
        // retry target must be an observed FAILURE of the same tenant.
        if (input.retryOfInteractionId !== null) {
          const target = await findInteractionRowById(tx, input.tenantId, input.retryOfInteractionId);
          if (target === null) {
            throw new InteractionsStoreMissingError(
              `retry target ${input.retryOfInteractionId} does not exist in this tenant`,
              'retry-target',
            );
          }
          const targetRecord = mapInteraction(target);
          if (targetRecord.state !== 'observed' || targetRecord.observation?.outcome !== 'failed') {
            throw new InteractionsStoreRuleError(
              `retry target ${input.retryOfInteractionId} is not an observed failure (state ${targetRecord.state}); only failed observations are retried`,
              'retry-target-invalid',
            );
          }
        }

        const correlation = input.correlation ?? {};
        const base: Omit<InteractionRecord, 'recordHash'> = {
          id: crypto.randomUUID(),
          tenantId: input.tenantId,
          capability: input.capability,
          params: input.params,
          correlation,
          retryOfInteractionId: input.retryOfInteractionId,
          policy: input.policy,
          requestedBy: input.requestedBy,
          idempotencyKey: input.idempotencyKey,
          inputHash: input.inputHash,
          state: 'intended',
          claim: null,
          dispatch: null,
          observation: null,
          createdAt: input.now,
          updatedAt: input.now,
        };
        const record: InteractionRecord = { ...base, recordHash: computeInteractionRecordHash(base) };

        // ON CONFLICT DO NOTHING against the tenant-scoped keyed partial
        // unique index: a concurrent creator of the same logical intent
        // keeps a healthy transaction and converges by re-reading.
        const inserted = await query(
          tx,
          `INSERT INTO interaction_effects
             (id, tenant_id, capability, params, correlation, retry_of_interaction_id, policy_key, policy_decision_id,
              requested_by, idempotency_key, input_hash, record_hash, state, created_at, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, 'intended', $13, $13)
           ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
           RETURNING ${INTERACTION_COLUMNS}`,
          [
            record.id,
            input.tenantId,
            input.capability,
            canonicalJson(input.params),
            canonicalJson(correlation),
            input.retryOfInteractionId,
            input.policy?.policyKey ?? null,
            input.policy?.decisionId ?? null,
            input.requestedBy,
            input.idempotencyKey,
            input.inputHash,
            record.recordHash,
            input.now,
          ],
          'createInteraction',
        );
        if (inserted.length > 0) {
          return { interaction: mapInteraction(inserted[0] as unknown as InteractionRow), converged: false };
        }
        if (input.idempotencyKey !== null) {
          const existing = await findInteractionRowByKey(tx, input.tenantId, input.idempotencyKey);
          if (existing !== null) {
            return convergeOrConflict(existing, input);
          }
        }
        throw new StoreConflictError('createInteraction violated a uniqueness constraint', 'interaction_effects_tenant_idempotency_key');
      });
    },

    async findInteractionById(tenantId: string, interactionId: string): Promise<InteractionRecord | null> {
      const row = await findInteractionRowById(executor, tenantId, interactionId);
      return row === null ? null : mapInteraction(row);
    },

    async findInteractionByIdempotencyKey(tenantId: string, key: string): Promise<InteractionRecord | null> {
      const row = await findInteractionRowByKey(executor, tenantId, key);
      return row === null ? null : mapInteraction(row);
    },

    async listInteractions(tenantId: string, filter?: InteractionFilter): Promise<InteractionRecord[]> {
      const predicates: string[] = ['tenant_id = $1'];
      const params: unknown[] = [tenantId];
      let slot = 1;
      if (filter?.state !== undefined) {
        slot += 1;
        predicates.push(`state = $${slot}`);
        params.push(filter.state);
      }
      if (filter?.capability !== undefined) {
        slot += 1;
        predicates.push(`capability = $${slot}`);
        params.push(filter.capability);
      }
      if (filter?.outcome !== undefined) {
        slot += 1;
        predicates.push(`outcome = $${slot}`);
        params.push(filter.outcome);
      }
      if (filter?.retryOfInteractionId !== undefined) {
        slot += 1;
        predicates.push(`retry_of_interaction_id = $${slot}`);
        params.push(filter.retryOfInteractionId);
      }
      if (filter?.correlation !== undefined) {
        slot += 1;
        predicates.push(`correlation ->> $${slot} = $${slot + 1}`);
        params.push(filter.correlation.key, filter.correlation.value);
      }
      const rows = await query(
        executor,
        `SELECT ${INTERACTION_COLUMNS} FROM interaction_effects WHERE ${predicates.join(' AND ')} ORDER BY created_at ASC, id ASC`,
        params,
        'listInteractions',
      );
      return rows.map((row) => mapInteraction(row as unknown as InteractionRow));
    },

    async listRecoverableDispatches(tenantId: string): Promise<InteractionRecord[]> {
      const rows = await query(
        executor,
        `SELECT ${INTERACTION_COLUMNS} FROM interaction_effects WHERE tenant_id = $1 AND state = 'dispatching' ORDER BY claim_claimed_at ASC, id ASC`,
        [tenantId],
        'listRecoverableDispatches',
      );
      return rows.map((row) => mapInteraction(row as unknown as InteractionRow));
    },

    async claimDispatch(input: ClaimDispatchInput): Promise<InteractionRecord> {
      return executor.withTransaction(async (tx) => {
        return writeState(
          tx,
          input,
          'intended',
          (current) => ({
            ...current,
            state: 'dispatching' as InteractionState,
            claim: { claimedBy: input.claimedBy, claimedAt: input.now },
          }),
          'claimDispatch',
        );
      });
    },

    async reclaimDispatch(input: ReclaimDispatchInput): Promise<InteractionRecord> {
      return executor.withTransaction(async (tx) => {
        // Recovery re-claim: the state STAYS dispatching; only the claim
        // attribution is refreshed (the re-dispatch converges at the
        // provider by durable identity — no duplicate business effect).
        const rows = await query(
          tx,
          `SELECT ${INTERACTION_COLUMNS} FROM interaction_effects WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
          [input.tenantId, input.interactionId],
          'reclaimDispatch',
        );
        const row = rows[0] as unknown as InteractionRow | undefined;
        if (row === undefined) {
          throw new InteractionsStoreMissingError(
            `interaction ${input.interactionId} does not exist in this tenant`,
            'interaction',
          );
        }
        const current = mapInteraction(row);
        if (current.state !== 'dispatching') {
          throw new InteractionsStoreRuleError(
            `interaction ${input.interactionId} is in state "${current.state}", not the claimed "dispatching"`,
            'dispatch-reclaim-conflict',
          );
        }
        const updated: InteractionRecord = {
          ...current,
          claim: { claimedBy: input.reclaimedBy, claimedAt: input.now },
          updatedAt: input.now,
        };
        const recordHash = computeInteractionRecordHash(updated);
        await query(
          tx,
          `UPDATE interaction_effects
           SET claim_claimed_by = $1, claim_claimed_at = $2, record_hash = $3, updated_at = $4
           WHERE tenant_id = $5 AND id = $6 AND state = 'dispatching'`,
          [input.reclaimedBy, input.now, recordHash, input.now, input.tenantId, input.interactionId],
          'reclaimDispatch',
        );
        return { ...updated, recordHash };
      });
    },

    async completeDispatch(input: CompleteDispatchInput): Promise<InteractionRecord> {
      return executor.withTransaction(async (tx) => {
        return writeState(
          tx,
          input,
          'dispatching',
          (current) => ({
            ...current,
            state: 'dispatched' as InteractionState,
            dispatch: {
              provider: input.provider,
              providerReference: input.providerReference,
              dispatchedAt: input.now,
              dispatchedBy: input.dispatchedBy,
            },
          }),
          'completeDispatch',
        );
      });
    },

    async recordDispatchFailure(input: RecordDispatchFailureInput): Promise<InteractionRecord> {
      return executor.withTransaction(async (tx) => {
        return writeState(
          tx,
          input,
          'dispatching',
          (current) => ({
            ...current,
            state: 'observed' as InteractionState,
            observation: {
              outcome: 'failed' as InteractionOutcome,
              failureStage: 'dispatch' as const,
              providerObservation: { error: input.error },
              observedBy: input.dispatchedBy,
              observedAt: input.now,
            },
          }),
          'recordDispatchFailure',
        );
      });
    },

    async recordObservation(input: RecordObservationInput): Promise<{ interaction: InteractionRecord; converged: boolean }> {
      return executor.withTransaction(async (tx) => {
        // The row lock serializes competing observations; identical
        // re-observation converges, divergent fails closed.
        const row = await lockInteractionRow(tx, input.tenantId, input.interactionId, 'recordObservation');
        const current = mapInteraction(row);
        if (current.state === 'observed' && current.observation !== null) {
          const existingIdentity = hashObservation(current.observation.outcome, current.observation.providerObservation);
          const incomingIdentity = hashObservation(input.outcome, input.providerObservation);
          if (existingIdentity === incomingIdentity) {
            return { interaction: current, converged: true };
          }
          throw new InteractionsStoreRuleError(
            `interaction ${input.interactionId} already carries a different observed result (outcome ${current.observation.outcome}); duplicate interaction mutation is rejected`,
            'observation-conflict',
          );
        }
        if (current.state !== 'dispatched') {
          throw new InteractionsStoreRuleError(
            `interaction ${input.interactionId} is in state "${current.state}"; results are observed on dispatched interactions only`,
            'observation-state-invalid',
          );
        }
        const updated: InteractionRecord = {
          ...current,
          state: 'observed',
          updatedAt: input.now,
          observation: {
            outcome: input.outcome,
            failureStage: input.outcome === 'failed' ? 'provider' : null,
            providerObservation: input.providerObservation,
            observedBy: input.observedBy,
            observedAt: input.now,
          },
        };
        const recordHash = computeInteractionRecordHash(updated);
        await query(
          tx,
          `UPDATE interaction_effects
           SET state = 'observed', outcome = $1, failure_stage = $2, observed_by = $3, observed_at = $4,
               provider_observation = $5::jsonb, record_hash = $6, updated_at = $4
           WHERE tenant_id = $7 AND id = $8 AND state = 'dispatched'`,
          [
            input.outcome,
            input.outcome === 'failed' ? 'provider' : null,
            input.observedBy,
            input.now,
            canonicalJson(input.providerObservation),
            recordHash,
            input.tenantId,
            input.interactionId,
          ],
          'recordObservation',
        );
        return { interaction: { ...updated, recordHash }, converged: false };
      });
    },
  };
}
