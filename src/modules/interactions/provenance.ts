/**
 * ServiceOS /interactions provenance hashing (WORK-015, module internal —
 * exported through the module's public interface).
 *
 * Deterministic, provider-independent hashing for the interaction ledger's
 * tamper-evidence: the same canonicalization discipline as /policies
 * (WORK-014) and /workflow (WORK-004), implemented in this module so the
 * authorities stay decoupled (cross-module calls use public interfaces).
 *
 * - `hashInteractionInput` is the durable INTENT identity: sha256 over the
 *   canonical { capability, params, correlation, retryOf, policyKey }
 *   core. A keyed re-submission of the same logical intent converges on
 *   the durable interaction; a divergent re-submission of the same key
 *   fails closed (AC-3).
 * - `hashInteractionRecord` is the integrity hash over the canonical
 *   record core INCLUDING the mutable dispatch/observation state: every
 *   legitimate state write recomputes it, and every read verifies it —
 *   after-the-fact mutation of any recorded field is detected on read
 *   (the "duplicate interaction mutation must be detected" requirement).
 */
import { createHash } from 'node:crypto';

import type { CapabilityClass } from '../integrations/index.js';
import type { InteractionRecord, PolicyProvenance } from './store.js';

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

/** The canonical intent core: durable input identity of an interaction. */
export interface InteractionIntentCore {
  readonly capability: CapabilityClass;
  readonly params: Readonly<Record<string, unknown>>;
  readonly correlation: Readonly<Record<string, string>>;
  readonly retryOf: string | null;
  readonly policyKey: string | null;
}

/** sha256 over the canonical intent core (the input_hash column). */
export function hashInteractionInput(core: InteractionIntentCore): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        capability: core.capability,
        params: core.params,
        correlation: core.correlation,
        retryOf: core.retryOf,
        policyKey: core.policyKey,
      }),
    )
    .digest('hex');
}

/** sha256 over the canonical observation payload (convergence identity). */
export function hashObservation(outcome: string, providerObservation: unknown): string {
  return createHash('sha256').update(canonicalJson({ outcome, providerObservation })).digest('hex');
}

/** The canonical observation core: the serialized observation fields. */
export interface InteractionObservationCore {
  readonly outcome: string;
  readonly failureStage: string | null;
  readonly providerObservation: unknown;
  readonly observedBy: string;
  readonly observedAt: string;
}

/** The canonical record core: every field the integrity hash covers. */
export interface InteractionRecordCore {
  readonly id: string;
  readonly tenantId: string;
  readonly capability: CapabilityClass;
  readonly params: Readonly<Record<string, unknown>>;
  readonly correlation: Readonly<Record<string, string>>;
  readonly retryOfInteractionId: string | null;
  readonly policy: PolicyProvenance | null;
  readonly requestedBy: string;
  readonly idempotencyKey: string | null;
  readonly inputHash: string;
  readonly state: string;
  readonly claim: { readonly claimedBy: string; readonly claimedAt: string } | null;
  readonly dispatch: {
    readonly provider: string;
    readonly providerReference: string | null;
    readonly dispatchedAt: string;
    readonly dispatchedBy: string;
  } | null;
  readonly observation: InteractionObservationCore | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** sha256 over the canonical record core (the record_hash column). */
export function hashInteractionRecord(core: InteractionRecordCore): string {
  return createHash('sha256').update(canonicalJson(core)).digest('hex');
}

/** The record shape the integrity hash is computed from (recordHash never covers itself). */
export type HashableInteractionRecord = Omit<InteractionRecord, 'recordHash'>;

/** Recompute the record hash from a durable interaction record. */
export function computeInteractionRecordHash(record: HashableInteractionRecord): string {
  return hashInteractionRecord({
    id: record.id,
    tenantId: record.tenantId,
    capability: record.capability,
    params: record.params,
    correlation: record.correlation,
    retryOfInteractionId: record.retryOfInteractionId,
    policy: record.policy,
    requestedBy: record.requestedBy,
    idempotencyKey: record.idempotencyKey,
    inputHash: record.inputHash,
    state: record.state,
    claim:
      record.claim === null
        ? null
        : { claimedBy: record.claim.claimedBy, claimedAt: record.claim.claimedAt.toISOString() },
    dispatch:
      record.dispatch === null
        ? null
        : {
            provider: record.dispatch.provider,
            providerReference: record.dispatch.providerReference,
            dispatchedAt: record.dispatch.dispatchedAt.toISOString(),
            dispatchedBy: record.dispatch.dispatchedBy,
          },
    observation:
      record.observation === null
        ? null
        : {
            outcome: record.observation.outcome,
            failureStage: record.observation.failureStage,
            providerObservation: record.observation.providerObservation,
            observedBy: record.observation.observedBy,
            observedAt: record.observation.observedAt.toISOString(),
          },
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  });
}
