/**
 * ServiceOS module: /evidence (WORK-007 implementation).
 *
 * ServiceOS business evidence and outcome-verification records
 * (architecture.md §2.5, §6, §12, §13; architecture-lock #4; WORK-007
 * activation record).
 *
 * Authority (activation record / Work Order frozen scope):
 * - THE BUSINESS EVIDENCE LEDGER (AC-1; invariant 2): `attachEvidence`
 *   is the single ServiceOS entry point that attributes one business
 *   evidence record to a REAL Service Work (and, optionally, one of
 *   its Work Attempts — validated through /work's public read,
 *   read-only: /evidence never mutates work state). Evidence rows are
 *   immutable and append-only; duplicates converge deterministically
 *   (invariant 6: keyed convergence + content convergence — the same
 *   fact under any key converges on ONE durable row).
 * - PROVENANCE IS PRESERVED AND TAMPER-EVIDENT (AC-3; invariant 3):
 *   every record carries its provenance (frozen kind enumeration,
 *   source, opaque durable references preserved verbatim) and BOTH a
 *   content hash (the actor-independent fact) and a record hash (the
 *   full immutable row core); every read recomputes them and fails
 *   closed *_RECORD_TAMPERED on divergence.
 * - THE DETERMINISTIC EVIDENCE MAPPING (AC-4; invariants 4/5):
 *   `verifyOutcome` records ONE business outcome verification decision
 *   — a PURE, deterministic evaluation of a business outcome contract
 *   (the /services-compatible verification subset) over the work's
 *   attached evidence. The verdict is 'satisfied' ONLY when every
 *   contract requirement is satisfied by attached evidence of THIS
 *   work item (evidence of another Work item structurally never
 *   counts); missing evidence yields 'not_satisfied' with the missing
 *   requirements listed — missing evidence can never become an
 *   unearned successful outcome. The decision is computed inside the
 *   store's serialized critical section (the WORK-011 discipline:
 *   authority here, atomicity in the store) and recorded immutably
 *   with its requirement mapping and evidence snapshot hash.
 * - NO AI EVALUATOR (forbidden surface): nothing here evaluates
 *   evidence with a model — AI execution evaluation is Zeck's
 *   authority (fail-closed AI_VERIFICATION_FORBIDDEN on
 *   AI-execution-shaped verification declarations, exactly like
 *   /services). A foreign AI execution observation may be CITED as an
 *   opaque provenance reference, but a foreign execution claim is
 *   never itself a ServiceOS business verdict (AC-2: business outcome
 *   verification is distinct from transport/AI execution success —
 *   this module has no path that consults the AI boundary at all).
 * - NO SERVICE WORK LIFECYCLE (forbidden surface): /evidence records
 *   evidence and verification decisions; it NEVER transitions Service
 *   Work (the workflow authority owns transitions — the flow Work
 *   Orders consume this ledger through its public interface).
 * - Authorization discipline — exactly like /work, /policies,
 *   /workflow, /billing, /zeck: every operation authorizes BEFORE any
 *   domain data access; denials never touch domain data.
 */
import type { TransactionalExecutor } from '../../platform/persistence/index.js';
import { defineModule } from '../../platform/module-registry/index.js';
import type { Principal } from '../auth/index.js';
import type { AuthorizationDecision, AuthorizationDenyReason, TenancyAction } from '../organizations/index.js';
import type { WorkAttemptRecord, WorkRecord } from '../work/index.js';
import { WorkError } from '../work/index.js';
import { EvidenceError } from './errors.js';
import { createSqlEvidenceStore } from './sql-store.js';
import {
  EvidenceStoreMissingError,
  EvidenceStoreRuleError,
  type AttachEvidenceStoreInput,
  type EvidenceRecord,
  type EvidenceStore,
  type OutcomeVerificationRecord,
  type RecordVerificationStoreInput,
} from './store.js';
import { computeEvidenceContentHash } from './content.js';
import {
  evaluateOutcomeContract,
  validateAttachEvidenceInput,
  validateVerifyOutcomeInput,
  type AttachEvidenceInput,
  type OutcomeEvaluation,
  type OutcomeVerdict,
  type ValidatedAttachEvidenceInput,
  type VerifyOutcomeInput,
} from './contract.js';

// ---------------------------------------------------------------------------
// Public re-exports (the module's public surface)
// ---------------------------------------------------------------------------

// The frozen contract vocabulary and the deterministic mapping.
export {
  EVIDENCE_PROVENANCE_KINDS,
  OUTCOME_VERIFICATION_MODES,
  evaluateOutcomeContract,
  isEvidenceProvenanceKind,
  isOutcomeVerificationMode,
  validateAttachEvidenceInput,
  validateOutcomeContract,
  validateVerifyOutcomeInput,
} from './contract.js';
export type {
  AttachEvidenceInput,
  EvidenceProvenance,
  EvidenceProvenanceKind,
  OutcomeContractInput,
  OutcomeEvaluation,
  OutcomeVerificationMode,
  OutcomeVerdict,
  RequirementResult,
  ValidatedAttachEvidenceInput,
  ValidatedOutcomeContract,
  VerifyOutcomeInput,
} from './contract.js';

// The store port contract (persistence, never a second authority).
export { EvidenceStoreMissingError, EvidenceStoreRuleError } from './store.js';
export type {
  AttachEvidenceStoreInput,
  EvidenceRecord,
  EvidenceStore,
  EvidenceStoreRule,
  OutcomeVerificationRecord,
  RecordVerificationStoreInput,
} from './store.js';

// The content-hashing discipline (canonical serialization is part of
// the convergence contract).
export {
  canonicalJson,
  computeEvidenceContentHash,
  computeEvidenceRecordHash,
  computeVerificationContentHash,
  computeVerificationRecordHash,
  sha256Canonical,
} from './content.js';

// The typed error surface.
export { EvidenceError } from './errors.js';
export type { EvidenceErrorCode } from './errors.js';

// ---------------------------------------------------------------------------
// The module's tenancy/authorization dependencies (injected; never
// re-implemented — the single authorization chain)
// ---------------------------------------------------------------------------

export interface TenancyAuthorization {
  authorize(
    principalId: string,
    scope: { organizationId: string } | { tenantId: string },
    action: TenancyAction,
  ): Promise<AuthorizationDecision>;
}

/**
 * The /work public surface /evidence consumes (attribution to REAL
 * Service Work/Attempt identities — read-only; /evidence never mutates
 * work state; NO status gate: late results from any attempt state are
 * recorded as evidence, never as work mutations).
 */
export interface WorkCorrelation {
  getWork(principal: Principal, tenantId: string, workId: string): Promise<WorkRecord>;
  listAttempts(principal: Principal, tenantId: string, workId: string): Promise<WorkAttemptRecord[]>;
}

// ---------------------------------------------------------------------------
// Public inputs and results
// ---------------------------------------------------------------------------

export interface AttachEvidenceResult {
  /** The durable evidence record (immutable). */
  readonly evidence: EvidenceRecord;
  /** True when the logical evidence submission or the evidence fact already existed durably (converged). */
  readonly converged: boolean;
}

export interface VerifyOutcomeResult {
  /** The durable verification decision (immutable). */
  readonly verification: OutcomeVerificationRecord;
  /** True when an identical decision was already recorded (keyed convergence). */
  readonly converged: boolean;
}

export interface EvidenceModuleOptions {
  /** Production wiring: transaction-capable persistence executor. */
  executor?: TransactionalExecutor;
  /** Test seam: inject a faithful in-memory store instead (tests only). */
  store?: EvidenceStore;
  /** The single authorization chain, injected by the composition root. */
  tenancy: TenancyAuthorization;
  /** /work's public read contract (attribution validation). */
  work: WorkCorrelation;
  /** Clock injection for deterministic proofs. */
  now?: () => Date;
}

export interface EvidenceModule {
  /**
   * Attach ONE attributable business evidence record (AC-1). The
   * attribution is validated against /work's public read (the work
   * exists in the tenant; a present attempt belongs to it). The row is
   * immutable; the same logical submission (same key) and the same
   * evidence FACT (same content) converge on ONE durable row; divergent
   * content under the same key fails closed. Provenance is preserved
   * verbatim and every record is tamper-evident.
   */
  attachEvidence(principal: Principal, input: AttachEvidenceInput): Promise<AttachEvidenceResult>;
  /** Read one evidence record (tamper-evident: hashes verified on read). */
  getEvidence(principal: Principal, tenantId: string, evidenceId: string): Promise<EvidenceRecord>;
  /** The tenant's evidence ledger (attachment order, filterable). */
  listEvidence(
    principal: Principal,
    tenantId: string,
    filter?: { serviceWorkId?: string; workAttemptId?: string; requirement?: string },
  ): Promise<EvidenceRecord[]>;
  /**
   * Record ONE business outcome verification decision (AC-2/AC-4): the
   * deterministic evaluation of one business outcome contract over the
   * work's committed evidence state, computed inside the store's
   * serialized critical section. The verdict is 'satisfied' only when
   * every contract requirement is satisfied by THIS work item's
   * attached evidence; missing evidence is 'not_satisfied' with the
   * missing requirements listed. The decision is immutable; identical
   * re-runs converge; a same-key run over a changed evidence state or
   * contract fails closed (re-verification uses a new key). This NEVER
   * transitions Service Work (the workflow authority owns transitions).
   */
  verifyOutcome(principal: Principal, input: VerifyOutcomeInput): Promise<VerifyOutcomeResult>;
  /** Read one verification decision (tamper-evident: hash verified on read). */
  getOutcomeVerification(principal: Principal, tenantId: string, verificationId: string): Promise<OutcomeVerificationRecord>;
  /** The tenant's decision ledger (decision order, filterable). */
  listOutcomeVerifications(
    principal: Principal,
    tenantId: string,
    filter?: { serviceWorkId?: string; outcomeId?: string; verdict?: OutcomeVerdict },
  ): Promise<OutcomeVerificationRecord[]>;
  /**
   * The CURRENT decision for one (work, outcome): the newest recorded
   * verification. VERIFICATION_NOT_FOUND when none exists (a missing
   * read is distinguishable from a genuine empty ledger — lock #30).
   */
  getLatestOutcomeVerification(
    principal: Principal,
    tenantId: string,
    serviceWorkId: string,
    outcomeId: string,
  ): Promise<OutcomeVerificationRecord>;
}

// ---------------------------------------------------------------------------
// Validation helpers (fail closed)
// ---------------------------------------------------------------------------

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateUuid(value: string, what: string): void {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new EvidenceError('INVALID_INPUT', `${what} must be a UUID`);
  }
}

function validateIdentifierArgument(value: string, what: string): void {
  if (typeof value !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,199}$/.test(value)) {
    throw new EvidenceError('INVALID_INPUT', `${what} must match the identifier pattern`);
  }
}

/** Map an authorization denial reason to the module's error surface. */
function denyToError(reason: AuthorizationDenyReason | undefined, tenantId: string): EvidenceError {
  switch (reason) {
    case 'TENANT_NOT_FOUND':
      return new EvidenceError('TENANT_NOT_FOUND', `service tenant ${tenantId} does not exist`);
    case 'TENANT_SUSPENDED':
      return new EvidenceError('TENANT_SUSPENDED', `service tenant ${tenantId} is suspended`);
    case 'ORGANIZATION_NOT_FOUND':
      return new EvidenceError('TENANT_NOT_FOUND', `the tenant's organization no longer exists`);
    case 'ORGANIZATION_SUSPENDED':
      return new EvidenceError('ORGANIZATION_SUSPENDED', 'the owning organization is suspended');
    case 'MEMBERSHIP_FORBIDDEN':
      return new EvidenceError('TENANT_FORBIDDEN', 'the principal has no active membership granting this tenant');
    case 'ROLE_FORBIDDEN':
      return new EvidenceError('ROLE_FORBIDDEN', 'the principal role does not grant the required capability');
    default:
      return new EvidenceError('TENANT_FORBIDDEN', 'authorization denied');
  }
}

/** Map store errors onto the public error surface. */
function mapStoreError(error: unknown): never {
  if (error instanceof EvidenceStoreMissingError) {
    if (error.kind === 'evidence') {
      throw new EvidenceError('EVIDENCE_NOT_FOUND', `evidence record ${error.key} not found`);
    }
    throw new EvidenceError('VERIFICATION_NOT_FOUND', `outcome verification ${error.key} not found`);
  }
  if (error instanceof EvidenceStoreRuleError) {
    switch (error.rule) {
      case 'evidence-input-conflict':
        throw new EvidenceError('EVIDENCE_INPUT_CONFLICT', error.message);
      case 'verification-input-conflict':
        throw new EvidenceError('VERIFICATION_INPUT_CONFLICT', error.message);
      case 'evidence-record-tampered':
        throw new EvidenceError('EVIDENCE_RECORD_TAMPERED', error.message);
      case 'verification-record-tampered':
        throw new EvidenceError('VERIFICATION_RECORD_TAMPERED', error.message);
      default:
        throw new EvidenceError('INVALID_INPUT', error.message);
    }
  }
  throw error;
}

// ---------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------

export function createEvidenceModule(options: EvidenceModuleOptions): EvidenceModule {
  if ((options.executor === undefined) === (options.store === undefined)) {
    throw new EvidenceError('INVALID_INPUT', 'createEvidenceModule requires exactly one of executor or store');
  }
  const store = options.store ?? createSqlEvidenceStore(options.executor as TransactionalExecutor);
  const tenancy = options.tenancy;
  const work = options.work;
  const now = options.now ?? (() => new Date());

  /** Authorization BEFORE any domain data access (single chain). */
  async function requireTenantAccess(principal: Principal, tenantId: string, action: TenancyAction): Promise<void> {
    validateUuid(tenantId, 'tenantId');
    const decision = await tenancy.authorize(principal.id, { tenantId }, action);
    if (!decision.allowed) {
      throw denyToError(decision.reason, tenantId);
    }
  }

  /**
   * Attribution validation against /work's public read: the Service
   * Work must exist in the tenant and a present attempt must belong to
   * it. NO status gate (invariant 2 asks for correct attribution, not
   * lifecycle coupling): late results from any attempt state are
   * recorded as evidence and never mutate work state. Read-only.
   */
  async function requireAttributableWork(
    principal: Principal,
    tenantId: string,
    serviceWorkId: string,
    workAttemptId: string | null,
  ): Promise<void> {
    let workRecord: WorkRecord;
    try {
      workRecord = await work.getWork(principal, tenantId, serviceWorkId);
    } catch (error) {
      if (error instanceof WorkError && error.code === 'WORK_NOT_FOUND') {
        throw new EvidenceError('WORK_NOT_FOUND', `service work ${serviceWorkId} does not exist in this tenant`);
      }
      throw error;
    }
    void workRecord;
    if (workAttemptId === null) {
      return;
    }
    let attempts: WorkAttemptRecord[];
    try {
      attempts = await work.listAttempts(principal, tenantId, serviceWorkId);
    } catch (error) {
      if (error instanceof WorkError && error.code === 'WORK_NOT_FOUND') {
        throw new EvidenceError('WORK_NOT_FOUND', `service work ${serviceWorkId} does not exist in this tenant`);
      }
      throw error;
    }
    const attempt = attempts.find((entry) => entry.id === workAttemptId);
    if (attempt === undefined) {
      throw new EvidenceError('ATTEMPT_NOT_FOUND', `work attempt ${workAttemptId} does not belong to service work ${serviceWorkId}`);
    }
  }

  async function attachEvidence(principal: Principal, raw: AttachEvidenceInput): Promise<AttachEvidenceResult> {
    const input: ValidatedAttachEvidenceInput = validateAttachEvidenceInput(raw);
    await requireTenantAccess(principal, input.tenantId, 'write');
    // Attribution to REAL work identities (read-only validation).
    await requireAttributableWork(principal, input.tenantId, input.serviceWorkId, input.workAttemptId);
    // The actor-independent FACT hash (the WORK-011 discipline: the
    // content hash pins the fact; convergence follows the logical
    // identity regardless of who re-reports; the record hash keeps the
    // recorder).
    const contentHash = computeEvidenceContentHash({
      tenantId: input.tenantId,
      serviceWorkId: input.serviceWorkId,
      workAttemptId: input.workAttemptId,
      requirement: input.requirement,
      provenance: input.provenance,
      payload: input.payload,
      observedAt: input.observedAt,
    });
    const storeInput: AttachEvidenceStoreInput = {
      tenantId: input.tenantId,
      serviceWorkId: input.serviceWorkId,
      workAttemptId: input.workAttemptId,
      requirement: input.requirement,
      provenance: input.provenance,
      payload: input.payload,
      observedAt: input.observedAt,
      idempotencyKey: input.idempotencyKey,
      contentHash,
      attachedBy: principal.id,
      now: now(),
    };
    try {
      const attached = await store.attachEvidence(storeInput);
      return { evidence: attached.evidence, converged: attached.converged };
    } catch (error) {
      mapStoreError(error);
    }
  }

  async function getEvidence(principal: Principal, tenantId: string, evidenceId: string): Promise<EvidenceRecord> {
    await requireTenantAccess(principal, tenantId, 'read');
    validateUuid(evidenceId, 'evidenceId');
    let evidence: EvidenceRecord | null;
    try {
      evidence = await store.findEvidence(tenantId, evidenceId);
    } catch (error) {
      mapStoreError(error);
    }
    if (evidence === null) {
      throw new EvidenceError('EVIDENCE_NOT_FOUND', `evidence record ${evidenceId} not found`);
    }
    return evidence;
  }

  async function listEvidence(
    principal: Principal,
    tenantId: string,
    filter?: { serviceWorkId?: string; workAttemptId?: string; requirement?: string },
  ): Promise<EvidenceRecord[]> {
    await requireTenantAccess(principal, tenantId, 'read');
    if (filter?.serviceWorkId !== undefined) validateUuid(filter.serviceWorkId, 'filter.serviceWorkId');
    if (filter?.workAttemptId !== undefined) validateUuid(filter.workAttemptId, 'filter.workAttemptId');
    if (filter?.requirement !== undefined) validateIdentifierArgument(filter.requirement, 'filter.requirement');
    try {
      return await store.listEvidence(tenantId, filter);
    } catch (error) {
      mapStoreError(error);
    }
  }

  async function verifyOutcome(principal: Principal, raw: VerifyOutcomeInput): Promise<VerifyOutcomeResult> {
    const { tenantId, serviceWorkId, contract, idempotencyKey } = validateVerifyOutcomeInput(raw);
    await requireTenantAccess(principal, tenantId, 'write');
    // The verified work must be REAL (read-only; no lifecycle coupling).
    await requireAttributableWork(principal, tenantId, serviceWorkId, null);
    // The module-owned PURE evaluator, injected into the store's
    // serialized critical section: the decision is computed over
    // exactly the committed evidence state the section serializes
    // (authority here, atomicity in the store — the WORK-011
    // discipline). Verdict and requirement mapping are deterministic
    // functions of the recorded input.
    const evaluate = (evidence: readonly EvidenceRecord[]): OutcomeEvaluation =>
      evaluateOutcomeContract(contract, evidence);
    const storeInput: RecordVerificationStoreInput = {
      tenantId,
      serviceWorkId,
      outcomeId: contract.outcomeId,
      verificationMode: contract.verification,
      requirements: contract.evidenceRequirements,
      idempotencyKey,
      decidedBy: principal.id,
      now: now(),
      evaluate,
    };
    try {
      const recorded = await store.recordVerification(storeInput);
      return { verification: recorded.verification, converged: recorded.converged };
    } catch (error) {
      mapStoreError(error);
    }
  }

  async function getOutcomeVerification(
    principal: Principal,
    tenantId: string,
    verificationId: string,
  ): Promise<OutcomeVerificationRecord> {
    await requireTenantAccess(principal, tenantId, 'read');
    validateUuid(verificationId, 'verificationId');
    let verification: OutcomeVerificationRecord | null;
    try {
      verification = await store.findVerification(tenantId, verificationId);
    } catch (error) {
      mapStoreError(error);
    }
    if (verification === null) {
      throw new EvidenceError('VERIFICATION_NOT_FOUND', `outcome verification ${verificationId} not found`);
    }
    return verification;
  }

  async function listOutcomeVerifications(
    principal: Principal,
    tenantId: string,
    filter?: { serviceWorkId?: string; outcomeId?: string; verdict?: OutcomeVerdict },
  ): Promise<OutcomeVerificationRecord[]> {
    await requireTenantAccess(principal, tenantId, 'read');
    if (filter?.serviceWorkId !== undefined) validateUuid(filter.serviceWorkId, 'filter.serviceWorkId');
    if (filter?.outcomeId !== undefined) validateIdentifierArgument(filter.outcomeId, 'filter.outcomeId');
    try {
      return await store.listVerifications(tenantId, filter);
    } catch (error) {
      mapStoreError(error);
    }
  }

  async function getLatestOutcomeVerification(
    principal: Principal,
    tenantId: string,
    serviceWorkId: string,
    outcomeId: string,
  ): Promise<OutcomeVerificationRecord> {
    await requireTenantAccess(principal, tenantId, 'read');
    validateUuid(serviceWorkId, 'serviceWorkId');
    validateIdentifierArgument(outcomeId, 'outcomeId');
    let decisions: OutcomeVerificationRecord[];
    try {
      decisions = await store.listVerifications(tenantId, { serviceWorkId, outcomeId });
    } catch (error) {
      mapStoreError(error);
    }
    const latest = decisions.length > 0 ? decisions[decisions.length - 1] : null;
    if (latest === null) {
      throw new EvidenceError(
        'VERIFICATION_NOT_FOUND',
        `no outcome verification for outcome "${outcomeId}" of service work ${serviceWorkId} has been recorded`,
      );
    }
    return latest;
  }

  return {
    attachEvidence,
    getEvidence,
    listEvidence,
    verifyOutcome,
    getOutcomeVerification,
    listOutcomeVerifications,
    getLatestOutcomeVerification,
  };
}

/**
 * Module manifest (registered in the composition root's module
 * registry). The manifest declares identity only; the contracts above
 * are the module's public surface.
 */
export default defineModule({
  name: 'evidence',
  version: '1.0.0',
  description: 'ServiceOS business evidence and outcome-verification records',
});
