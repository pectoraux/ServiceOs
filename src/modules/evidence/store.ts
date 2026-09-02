/**
 * ServiceOS /evidence store port contract (WORK-007, module internal —
 * exported through the module's public interface).
 *
 * The authoritative SQL implementation runs through the persistence
 * boundary (executor-pinned transactions); tests inject the faithful
 * in-memory implementation of the SAME port. This is a persistence
 * contract, never a second evidence authority and never an AI
 * evaluator: the durable surface is the immutable attributable
 * evidence ledger plus the immutable outcome-verification decision
 * ledger (architecture-lock #4).
 *
 * Store disciplines (mirrored by the in-memory double):
 *
 * - EVIDENCE (invariants 2/3/6): the durable logical identity is the
 *   (tenant, idempotencyKey) pair; the durable CONTENT identity is the
 *   (tenant, serviceWorkId, contentHash) triple — the evidence FACT
 *   (actor- and key-independent). `attachEvidence` is store-serialized
 *   per (tenant, key) AND per the work's evidence state with the
 *   POST-LOCK IDEMPOTENCY RE-CHECK (the WORK-009 lesson): same key +
 *   identical content converges; the same fact under any other key
 *   converges on the ONE content row; divergent content under the same
 *   key fails closed `evidence-input-conflict`. Rows are IMMUTABLE
 *   (append-only; no update path exists) and every read verifies the
 *   persisted record hash (`evidence-record-tampered`).
 *
 * - VERIFICATIONS (invariants 4/5/6): `recordVerification` is ONE
 *   serialized critical section per (tenant, key) AND per the work's
 *   evidence state. The decision is computed INSIDE the section by the
 *   module-injected PURE evaluator over the SERIALIZED, COMMITTED
 *   evidence rows (the WORK-011 discipline: authority in index.ts,
 *   atomicity in the store) — a verification never observes a torn
 *   evidence state and an attach never slips between the read and the
 *   decision. The recorded content hash pins scope + contract +
 *   evidence snapshot; the verdict is its pure function. Same key +
 *   identical content converges; same key + changed evidence or
 *   changed contract fails closed `verification-input-conflict` (a
 *   re-verification after evidence changes is a NEW logical decision
 *   and uses a new key). Rows are IMMUTABLE; reads verify the record
 *   hash (`verification-record-tampered`).
 *
 * - LOCK ORDER (deadlock-free by construction): the keyed lock first,
 *   the work's evidence-state lock second — every writer takes the
 *   same two locks in the same order.
 */
import type { OutcomeEvaluation, OutcomeVerificationMode } from './contract.js';

// ---------------------------------------------------------------------------
// Public record shapes
// ---------------------------------------------------------------------------

/**
 * ONE attributable business evidence record (the BusinessEvidence
 * domain object): the evidence fact (requirement + provenance +
 * payload + observedAt) durably attributed to a Service Work and,
 * optionally, one of its Work Attempts. IMMUTABLE: rows are append-only
 * and tamper-evident (the record hash is recomputed on every read).
 * This is ServiceOS business evidence — never a copy of a foreign AI
 * execution record and never an execution lifecycle.
 */
export interface EvidenceRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly serviceWorkId: string;
  /** The attempt attribution (validated through /work's public read; null for work-level evidence). */
  readonly workAttemptId: string | null;
  /** The business evidence class this record satisfies. */
  readonly requirement: string;
  readonly provenance: {
    readonly kind: string;
    readonly source: string;
    readonly refs: readonly string[];
  };
  /** The recorded business facts (any JSON value). */
  readonly payload: unknown;
  /** When the underlying business fact was observed (provenance time). */
  readonly observedAt: Date;
  readonly idempotencyKey: string;
  readonly contentHash: string;
  readonly recordHash: string;
  readonly attachedBy: string;
  /** The single timestamp of the immutable evidence row (rows never update). */
  readonly attachedAt: Date;
}

/**
 * ONE business outcome verification decision (the OutcomeVerification
 * domain object): the deterministic mapping of one business outcome
 * contract over the work's evidence state at decision time. IMMUTABLE
 * (append-only decision ledger — REQ-014). `verdict` is
 * 'not_satisfied' with the missing requirements listed whenever any
 * requirement lacks attached evidence — missing evidence can never
 * become an unearned successful outcome.
 */
export interface OutcomeVerificationRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly serviceWorkId: string;
  readonly outcomeId: string;
  readonly verificationMode: OutcomeVerificationMode;
  /** The requirement names the decision evaluated (the validated contract). */
  readonly requirements: readonly string[];
  readonly verdict: 'satisfied' | 'not_satisfied';
  /**
   * The deterministic mapping: per requirement, whether attached
   * evidence of THIS work item satisfied it and which records did.
   */
  readonly requirementResults: readonly {
    readonly requirement: string;
    readonly satisfied: boolean;
    readonly evidenceIds: readonly string[];
  }[];
  readonly idempotencyKey: string;
  /** Hash over scope + contract + the evaluated evidence snapshot (the decision INPUT). */
  readonly contentHash: string;
  readonly recordHash: string;
  readonly decidedBy: string;
  /** The single timestamp of the immutable decision row (rows never update). */
  readonly decidedAt: Date;
}

// ---------------------------------------------------------------------------
// Store inputs (module-validated, hash-carrying)
// ---------------------------------------------------------------------------

export interface AttachEvidenceStoreInput {
  readonly tenantId: string;
  readonly serviceWorkId: string;
  readonly workAttemptId: string | null;
  readonly requirement: string;
  readonly provenance: {
    readonly kind: string;
    readonly source: string;
    readonly refs: readonly string[];
  };
  readonly payload: unknown;
  readonly observedAt: Date;
  readonly idempotencyKey: string;
  readonly contentHash: string;
  readonly attachedBy: string;
  readonly now: Date;
}

export interface RecordVerificationStoreInput {
  readonly tenantId: string;
  readonly serviceWorkId: string;
  readonly outcomeId: string;
  readonly verificationMode: OutcomeVerificationMode;
  readonly requirements: readonly string[];
  readonly idempotencyKey: string;
  readonly decidedBy: string;
  readonly now: Date;
  /**
   * The module-owned PURE evaluator (injected — the WORK-011
   * discipline): called INSIDE the serialized critical section with the
   * committed evidence rows of the work; the decision is computed over
   * exactly the state the section serializes.
   */
  readonly evaluate: (evidence: readonly EvidenceRecord[]) => OutcomeEvaluation;
}

// ---------------------------------------------------------------------------
// Store rules (typed; the module maps them onto the public error surface)
// ---------------------------------------------------------------------------

export type EvidenceStoreRule =
  | 'evidence-input-conflict'
  | 'verification-input-conflict'
  | 'evidence-record-tampered'
  | 'verification-record-tampered';

export class EvidenceStoreRuleError extends Error {
  constructor(
    message: string,
    readonly rule: EvidenceStoreRule,
  ) {
    super(message);
    this.name = 'EvidenceStoreRuleError';
  }
}

export class EvidenceStoreMissingError extends Error {
  constructor(
    readonly kind: 'evidence' | 'verification',
    readonly key: string,
  ) {
    super(`evidence record ${key} not found`);
    this.name = 'EvidenceStoreMissingError';
  }
}

/** Uniqueness arbitration surfaced by ON CONFLICT convergence re-reads. */
export class EvidenceStoreConflictError extends Error {
  constructor(
    message: string,
    readonly constraint: string,
  ) {
    super(message);
    this.name = 'EvidenceStoreConflictError';
  }
}

// ---------------------------------------------------------------------------
// The store port
// ---------------------------------------------------------------------------

export interface EvidenceStore {
  /**
   * Attach one attributable evidence record (immutable). Same (tenant,
   * idempotency key) + identical content converges; the same evidence
   * fact (tenant, work, content) under ANY key converges on the one
   * content row; divergent content under the same key fails closed.
   */
  attachEvidence(input: AttachEvidenceStoreInput): Promise<{ evidence: EvidenceRecord; converged: boolean }>;
  /** Tenant-predicated row lookup; null when absent. */
  findEvidence(tenantId: string, evidenceId: string): Promise<EvidenceRecord | null>;
  /** The evidence record of one (tenant, idempotency key); null when absent. */
  findEvidenceByKey(tenantId: string, idempotencyKey: string): Promise<EvidenceRecord | null>;
  /** The evidence row of one content identity (tenant, work, content hash); null when absent. */
  findEvidenceByContent(tenantId: string, serviceWorkId: string, contentHash: string): Promise<EvidenceRecord | null>;
  /** Tenant-predicated evidence ledger (optionally work/attempt/requirement), attachment order. */
  listEvidence(
    tenantId: string,
    filter?: { serviceWorkId?: string; workAttemptId?: string; requirement?: string },
  ): Promise<EvidenceRecord[]>;
  /**
   * ONE serialized critical section: evaluate the contract through the
   * injected pure evaluator over the work's committed evidence state
   * and record the immutable decision. Same key + identical content
   * converges; same key + changed input fails closed.
   */
  recordVerification(input: RecordVerificationStoreInput): Promise<{
    verification: OutcomeVerificationRecord;
    converged: boolean;
  }>;
  /** Tenant-predicated decision lookup; null when absent. */
  findVerification(tenantId: string, verificationId: string): Promise<OutcomeVerificationRecord | null>;
  /** The decision of one (tenant, idempotency key); null when absent. */
  findVerificationByKey(tenantId: string, idempotencyKey: string): Promise<OutcomeVerificationRecord | null>;
  /** Tenant-predicated decision ledger (optionally work/outcome/verdict), decision order. */
  listVerifications(
    tenantId: string,
    filter?: { serviceWorkId?: string; outcomeId?: string; verdict?: 'satisfied' | 'not_satisfied' },
  ): Promise<OutcomeVerificationRecord[]>;
}
