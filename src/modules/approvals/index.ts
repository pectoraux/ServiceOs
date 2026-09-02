/**
 * ServiceOS module: /approvals (WORK-008 implementation).
 *
 * The ServiceOS business/human approval authority (architecture.md
 * §6, §7, §9, §13; architecture-lock #3: /approvals is the SOLE
 * ServiceOS authority for business/human approval state; WORK-008
 * activation record).
 *
 * Authority (activation record / Work Order frozen scope):
 * - THE EXPLICIT REQUEST LEDGER (AC-1; invariants 1/2):
 *   `requestApproval` is the single ServiceOS entry point that creates
 *   an approval request bound to a REAL Service Work (and, optionally,
 *   one of its Work Attempts — validated through /work's public read,
 *   read-only: /approvals never mutates work state) and to the
 *   applicable business policy (the frozen policyKey, evaluated
 *   through /policies' public hook with the admission decision pinned
 *   onto the request row). A policy deny fails closed: the request is
 *   never created.
 * - THE EXPLICIT HUMAN DECISION AUTHORITY (AC-2/AC-4; invariants
 *   3/5): `decideApproval` is the single decision surface, and it is
 *   HUMAN-ONLY: the deciding principal must be an authenticated human
 *   (kind 'human') with tenant write authorization — a machine
 *   principal, an AI agent output or any agent claim fails closed
 *   typed DECIDER_NOT_HUMAN BEFORE any durable effect. There is no
 *   code path from an AI execution, a Zeck result or a transport
 *   success to a decision: business approval is an explicit human
 *   authority; AI/agent output is never approval.
 * - DURABLE AND AUDITABLE (AC-3; invariant 4): requests and decisions
 *   are durable, attributable and tamper-evident (integrity hashes
 *   recomputed on every read); decision rows are immutable and carry
 *   their decider, reason and instant.
 * - DETERMINISTIC TERMINAL ARBITRATION (invariant 6): simultaneous
 *   approval/rejection converges deterministically to ONE terminal
 *   decision — the store's serialized critical section plus the
 *   one-decision-per-request unique backstop; the loser of a true
 *   approve/reject race fails closed typed APPROVAL_DECISION_CONFLICT
 *   referencing the durable terminal decision; identical verdicts
 *   converge (the durable record is the authority).
 * - NO WORKFLOW STATE MACHINE (forbidden surface): this module never
 *   transitions Service Work (the /workflow authority owns
 *   transitions — WORK-010 wires the WAITING_APPROVAL flow through
 *   its own scope); the approval authority owns APPROVAL state only.
 * - NO ZECK/ESCALATION REPLACEMENT (forbidden surface): Zeck's
 *   optional AI human-escalation execution primitive is untouched;
 *   nothing here imports /zeck or any AI surface. This module also
 *   holds no HTTP surface (WORK-012 owns the control-plane API): the
 *   authenticated human approval surface is the programmatic contract
 *   every authenticated human decision flows through.
 * - Authorization discipline — exactly like /work, /policies,
 *   /workflow, /billing, /zeck, /evidence: every operation authorizes
 *   BEFORE any domain data access; denials never touch domain data.
 */
import type { TransactionalExecutor } from '../../platform/persistence/index.js';
import { defineModule } from '../../platform/module-registry/index.js';
import type { Principal } from '../auth/index.js';
import type { AuthorizationDecision, AuthorizationDenyReason, TenancyAction } from '../organizations/index.js';
import type { PolicyDecisionRecord } from '../policies/index.js';
import type { WorkAttemptRecord, WorkRecord } from '../work/index.js';
import { WorkError } from '../work/index.js';
import { ApprovalError } from './errors.js';
import { createSqlApprovalStore } from './sql-store.js';
import {
  ApprovalStoreMissingError,
  ApprovalStoreRuleError,
  type ApprovalDecisionRecord,
  type ApprovalRequestRecord,
  type ApprovalStore,
  type CreateApprovalRequestStoreInput,
  type DecideApprovalStoreInput,
} from './store.js';
import { computeApprovalDecisionContentHash, computeApprovalRequestContentHash } from './content.js';
import {
  APPROVAL_DECISIONS,
  APPROVAL_REQUEST_STATUSES,
  isApprovalDecisionKind,
  isApprovalRequestStatus,
  validateDecideApprovalInput,
  validateRequestApprovalInput,
  type ApprovalDecisionKind,
  type ApprovalRequestStatus,
  type DecideApprovalInput,
  type RequestApprovalInput,
} from './contract.js';

// ---------------------------------------------------------------------------
// Public re-exports (the module's public surface)
// ---------------------------------------------------------------------------

// The frozen contract vocabulary and validation.
export {
  APPROVAL_DECISIONS,
  APPROVAL_REQUEST_STATUSES,
  isApprovalDecisionKind,
  isApprovalRequestStatus,
  validateDecideApprovalInput,
  validateRequestApprovalInput,
} from './contract.js';
export type {
  ApprovalDecisionKind,
  ApprovalRequestStatus,
  DecideApprovalInput,
  RequestApprovalInput,
  ValidatedDecideApprovalInput,
  ValidatedRequestApprovalInput,
} from './contract.js';

// The store port contract (persistence, never a second authority).
export { ApprovalStoreMissingError, ApprovalStoreRuleError } from './store.js';
export type {
  ApprovalDecisionRecord,
  ApprovalRequestRecord,
  ApprovalStore,
  ApprovalStoreRule,
  CreateApprovalRequestStoreInput,
  DecideApprovalStoreInput,
} from './store.js';

// The content-hashing discipline (canonical serialization is part of
// the convergence contract).
export {
  canonicalJson,
  computeApprovalDecisionContentHash,
  computeApprovalDecisionRecordHash,
  computeApprovalRequestContentHash,
  computeApprovalRequestRecordHash,
  sha256Canonical,
} from './content.js';

// The typed error surface.
export { ApprovalError } from './errors.js';
export type { ApprovalErrorCode } from './errors.js';

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
 * The policy-gate hook consumed from /policies' public interface (the
 * structural subset the workflow authority consumes too). Injected by
 * the composition root; the approval authority never reimplements
 * policy logic — it binds each request to the applicable policy
 * through /policies' evaluation and pins the admission decision.
 */
export interface ApprovalPolicyGate {
  evaluatePolicy(
    principal: Principal,
    input: {
      tenantId: string;
      policyKey: string;
      action: string;
      attributes: Readonly<Record<string, string | number | boolean | null>>;
      idempotencyKey?: string;
    },
  ): Promise<{ decision: PolicyDecisionRecord; converged: boolean }>;
}

/**
 * The /work public surface /approvals consumes (binding validation to
 * REAL Service Work/Attempt identities — read-only; /approvals never
 * mutates work state).
 */
export interface WorkCorrelation {
  getWork(principal: Principal, tenantId: string, workId: string): Promise<WorkRecord>;
  listAttempts(principal: Principal, tenantId: string, workId: string): Promise<WorkAttemptRecord[]>;
}

// ---------------------------------------------------------------------------
// Public results
// ---------------------------------------------------------------------------

export interface RequestApprovalResult {
  /** The durable approval request (pending). */
  readonly request: ApprovalRequestRecord;
  /** True when the logical request submission already existed durably (converged). */
  readonly converged: boolean;
}

export interface DecideApprovalResult {
  /** The request, terminalized by the recorded decision. */
  readonly request: ApprovalRequestRecord;
  /** The durable terminal human decision (immutable). */
  readonly decision: ApprovalDecisionRecord;
  /** True when an identical decision was already recorded (converged). */
  readonly converged: boolean;
}

export interface ApprovalsModuleOptions {
  /** Production wiring: transaction-capable persistence executor. */
  executor?: TransactionalExecutor;
  /** Test seam: inject a faithful in-memory store instead (tests only). */
  store?: ApprovalStore;
  /** The single authorization chain, injected by the composition root. */
  tenancy: TenancyAuthorization;
  /** /work's public read contract (binding validation). */
  work: WorkCorrelation;
  /** /policies' public evaluation hook (the applicable-policy binding). */
  policies: ApprovalPolicyGate;
  /** Clock injection for deterministic proofs. */
  now?: () => Date;
}

export interface ApprovalsModule {
  /**
   * Create ONE explicit approval request (AC-1): bound to a REAL
   * Service Work (and, optionally, one of its attempts — validated
   * through /work's public read) and to the applicable business policy
   * (evaluated through /policies' public hook; deny fails closed and
   * the request is never created; the admission decision is pinned
   * onto the durable row). The same logical submission (same key)
   * converges on one durable request; divergent content under the same
   * key fails closed.
   */
  requestApproval(principal: Principal, input: RequestApprovalInput): Promise<RequestApprovalResult>;
  /** Read one approval request (tamper-evident: hash verified on read). */
  getApprovalRequest(principal: Principal, tenantId: string, requestId: string): Promise<ApprovalRequestRecord>;
  /** The tenant's request ledger (request order, filterable). */
  listApprovalRequests(
    principal: Principal,
    tenantId: string,
    filter?: { serviceWorkId?: string; workAttemptId?: string; status?: ApprovalRequestStatus; requestedBy?: string },
  ): Promise<ApprovalRequestRecord[]>;
  /**
   * Record ONE explicit terminal human decision (AC-2/AC-4; the
   * human-only surface). The deciding principal must be an
   * authenticated HUMAN with tenant write authorization — machine
   * principals and agent claims fail closed DECIDER_NOT_HUMAN before
   * any durable effect. Simultaneous approve/reject converges
   * deterministically to ONE terminal decision (the serialized
   * arbitration): the divergent loser fails closed
   * APPROVAL_DECISION_CONFLICT; identical verdicts converge. This
   * NEVER transitions Service Work (the workflow authority owns
   * transitions).
   */
  decideApproval(principal: Principal, input: DecideApprovalInput): Promise<DecideApprovalResult>;
  /** Read one decision (tamper-evident: hash verified on read). */
  getApprovalDecision(principal: Principal, tenantId: string, decisionId: string): Promise<ApprovalDecisionRecord>;
  /** The tenant's decision ledger (decision order, filterable). */
  listApprovalDecisions(
    principal: Principal,
    tenantId: string,
    filter?: { serviceWorkId?: string; requestId?: string; decidedBy?: string; decision?: ApprovalDecisionKind },
  ): Promise<ApprovalDecisionRecord[]>;
  /**
   * The TERMINAL decision of one request (the review surface): the
   * durable decision that terminalized it. APPROVAL_DECISION_NOT_FOUND
   * when the request is still pending (a pending review is
   * distinguishable from a decided one — architecture-lock #30) and
   * APPROVAL_REQUEST_NOT_FOUND when the request itself is absent.
   */
  getTerminalApprovalDecision(principal: Principal, tenantId: string, requestId: string): Promise<ApprovalDecisionRecord>;
}

// ---------------------------------------------------------------------------
// Validation helpers (fail closed)
// ---------------------------------------------------------------------------

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateUuid(value: string, what: string): void {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new ApprovalError('INVALID_INPUT', `${what} must be a UUID`);
  }
}

function validateIdentifierArgument(value: string, what: string): void {
  if (typeof value !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,199}$/.test(value)) {
    throw new ApprovalError('INVALID_INPUT', `${what} must match the identifier pattern`);
  }
}

/** The frozen policy action of the approval-request admission gate. */
const APPROVAL_POLICY_ACTION = 'approval.request';

/** The namespaced policy idempotency key of one request submission. */
function policyIdempotencyKey(requestKey: string): string {
  return `approval.request:${requestKey}`;
}

/** Map an authorization denial reason to the module's error surface. */
function denyToError(reason: AuthorizationDenyReason | undefined, tenantId: string): ApprovalError {
  switch (reason) {
    case 'TENANT_NOT_FOUND':
      return new ApprovalError('TENANT_NOT_FOUND', `service tenant ${tenantId} does not exist`);
    case 'TENANT_SUSPENDED':
      return new ApprovalError('TENANT_SUSPENDED', `service tenant ${tenantId} is suspended`);
    case 'ORGANIZATION_NOT_FOUND':
      return new ApprovalError('TENANT_NOT_FOUND', `the tenant's organization no longer exists`);
    case 'ORGANIZATION_SUSPENDED':
      return new ApprovalError('ORGANIZATION_SUSPENDED', 'the owning organization is suspended');
    case 'MEMBERSHIP_FORBIDDEN':
      return new ApprovalError('TENANT_FORBIDDEN', 'the principal has no active membership granting this tenant');
    case 'ROLE_FORBIDDEN':
      return new ApprovalError('ROLE_FORBIDDEN', 'the principal role does not grant the required capability');
    default:
      return new ApprovalError('TENANT_FORBIDDEN', 'authorization denied');
  }
}

/** Map store errors onto the public error surface. */
function mapStoreError(error: unknown): never {
  if (error instanceof ApprovalStoreMissingError) {
    if (error.kind === 'request') {
      throw new ApprovalError('APPROVAL_REQUEST_NOT_FOUND', `approval request ${error.key} not found`);
    }
    throw new ApprovalError('APPROVAL_DECISION_NOT_FOUND', `approval decision ${error.key} not found`);
  }
  if (error instanceof ApprovalStoreRuleError) {
    switch (error.rule) {
      case 'approval-request-input-conflict':
        throw new ApprovalError('APPROVAL_REQUEST_INPUT_CONFLICT', error.message);
      case 'approval-decision-input-conflict':
        throw new ApprovalError('APPROVAL_DECISION_INPUT_CONFLICT', error.message);
      case 'approval-decision-conflict':
        throw new ApprovalError('APPROVAL_DECISION_CONFLICT', error.message);
      case 'approval-request-record-tampered':
        throw new ApprovalError('APPROVAL_REQUEST_RECORD_TAMPERED', error.message);
      case 'approval-decision-record-tampered':
        throw new ApprovalError('APPROVAL_DECISION_RECORD_TAMPERED', error.message);
      default:
        throw new ApprovalError('INVALID_INPUT', error.message);
    }
  }
  throw error;
}

// ---------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------

export function createApprovalsModule(options: ApprovalsModuleOptions): ApprovalsModule {
  if ((options.executor === undefined) === (options.store === undefined)) {
    throw new ApprovalError('INVALID_INPUT', 'createApprovalsModule requires exactly one of executor or store');
  }
  const store = options.store ?? createSqlApprovalStore(options.executor as TransactionalExecutor);
  const tenancy = options.tenancy;
  const work = options.work;
  const policies = options.policies;
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
   * Binding validation against /work's public read: the Service Work
   * must exist in the tenant and a present attempt must belong to it.
   * Read-only; NO status gate (activation invariant 2 asks for the
   * binding, not lifecycle coupling): an approval request may be bound
   * to work in any state and deciding never mutates work state.
   */
  async function requireBindableWork(
    principal: Principal,
    tenantId: string,
    serviceWorkId: string,
    workAttemptId: string | null,
  ): Promise<WorkRecord> {
    let workRecord: WorkRecord;
    try {
      workRecord = await work.getWork(principal, tenantId, serviceWorkId);
    } catch (error) {
      if (error instanceof WorkError && error.code === 'WORK_NOT_FOUND') {
        throw new ApprovalError('WORK_NOT_FOUND', `service work ${serviceWorkId} does not exist in this tenant`);
      }
      throw error;
    }
    if (workAttemptId === null) {
      return workRecord;
    }
    let attempts: WorkAttemptRecord[];
    try {
      attempts = await work.listAttempts(principal, tenantId, serviceWorkId);
    } catch (error) {
      if (error instanceof WorkError && error.code === 'WORK_NOT_FOUND') {
        throw new ApprovalError('WORK_NOT_FOUND', `service work ${serviceWorkId} does not exist in this tenant`);
      }
      throw error;
    }
    const attempt = attempts.find((entry) => entry.id === workAttemptId);
    if (attempt === undefined) {
      throw new ApprovalError('ATTEMPT_NOT_FOUND', `work attempt ${workAttemptId} does not belong to service work ${serviceWorkId}`);
    }
    return workRecord;
  }

  async function requestApproval(principal: Principal, raw: RequestApprovalInput): Promise<RequestApprovalResult> {
    const input = validateRequestApprovalInput(raw);
    await requireTenantAccess(principal, input.tenantId, 'write');
    // The binding: REAL work identities (read-only validation).
    const workRecord = await requireBindableWork(principal, input.tenantId, input.serviceWorkId, input.workAttemptId);
    // The request FACT hash (requester/key independent; excludes the
    // policy admission provenance — a same-key retry converges on the
    // durable row, which keeps its original admission decision).
    const contentHash = computeApprovalRequestContentHash({
      tenantId: input.tenantId,
      serviceWorkId: input.serviceWorkId,
      workAttemptId: input.workAttemptId,
      policyKey: input.policyKey,
      subject: input.subject,
    });
    // Keyed fast-path convergence BEFORE the policy gate (the /workflow
    // discipline): a retry of an already-recorded request re-observes
    // the durable row without re-adjudicating the policy.
    const existing = await store.findRequestByKey(input.tenantId, input.idempotencyKey);
    if (existing !== null) {
      if (existing.contentHash !== contentHash) {
        throw new ApprovalError(
          'APPROVAL_REQUEST_INPUT_CONFLICT',
          `approval request idempotency key "${input.idempotencyKey}" was already bound to different content`,
        );
      }
      return { request: existing, converged: true };
    }
    // THE APPLICABLE-POLICY BINDING (AC-1; the approval policy hook,
    // consumed through /policies' public contract): a deny decision
    // fails closed — the request is never created; an allow decision
    // is pinned onto the durable row. The gate is idempotent by the
    // namespaced request key, so gated retries converge too.
    let policyDecision: PolicyDecisionRecord;
    try {
      const outcome = await policies.evaluatePolicy(principal, {
        tenantId: input.tenantId,
        policyKey: input.policyKey,
        action: APPROVAL_POLICY_ACTION,
        attributes: { workType: workRecord.workType },
        idempotencyKey: policyIdempotencyKey(input.idempotencyKey),
      });
      policyDecision = outcome.decision;
    } catch (error) {
      throw new ApprovalError(
        'POLICY_EVALUATION_FAILED',
        `the approval policy gate for key "${input.policyKey}" failed: ${(error as Error).message}`,
        error,
      );
    }
    if (policyDecision.outcome !== 'allow') {
      throw new ApprovalError(
        'POLICY_DENIED',
        `the approval policy gate denied the request for work ${input.serviceWorkId} (decision ${policyDecision.id}, deciding layer ${policyDecision.decidingLayer})`,
      );
    }
    const storeInput: CreateApprovalRequestStoreInput = {
      tenantId: input.tenantId,
      serviceWorkId: input.serviceWorkId,
      workAttemptId: input.workAttemptId,
      policyKey: input.policyKey,
      policyDecisionId: policyDecision.id,
      subject: input.subject,
      idempotencyKey: input.idempotencyKey,
      contentHash,
      requestedBy: principal.id,
      now: now(),
    };
    try {
      const created = await store.createRequest(storeInput);
      return { request: created.request, converged: created.converged };
    } catch (error) {
      mapStoreError(error);
    }
  }

  async function getApprovalRequest(
    principal: Principal,
    tenantId: string,
    requestId: string,
  ): Promise<ApprovalRequestRecord> {
    await requireTenantAccess(principal, tenantId, 'read');
    validateUuid(requestId, 'requestId');
    let request: ApprovalRequestRecord | null;
    try {
      request = await store.findRequest(tenantId, requestId);
    } catch (error) {
      mapStoreError(error);
    }
    if (request === null) {
      throw new ApprovalError('APPROVAL_REQUEST_NOT_FOUND', `approval request ${requestId} not found`);
    }
    return request;
  }

  async function listApprovalRequests(
    principal: Principal,
    tenantId: string,
    filter?: { serviceWorkId?: string; workAttemptId?: string; status?: ApprovalRequestStatus; requestedBy?: string },
  ): Promise<ApprovalRequestRecord[]> {
    await requireTenantAccess(principal, tenantId, 'read');
    if (filter?.serviceWorkId !== undefined) validateUuid(filter.serviceWorkId, 'filter.serviceWorkId');
    if (filter?.workAttemptId !== undefined) validateUuid(filter.workAttemptId, 'filter.workAttemptId');
    if (filter?.status !== undefined && !isApprovalRequestStatus(filter.status)) {
      throw new ApprovalError('INVALID_INPUT', `filter.status must be one of ${APPROVAL_REQUEST_STATUSES.join(', ')}`);
    }
    if (filter?.requestedBy !== undefined) validateUuid(filter.requestedBy, 'filter.requestedBy');
    try {
      return await store.listRequests(tenantId, filter);
    } catch (error) {
      mapStoreError(error);
    }
  }

  async function decideApproval(principal: Principal, raw: DecideApprovalInput): Promise<DecideApprovalResult> {
    const input = validateDecideApprovalInput(raw);
    // THE EXPLICIT HUMAN AUTHORITY (activation invariants 3/5): the
    // deciding principal must be an authenticated HUMAN — BEFORE
    // authorization and BEFORE any domain data access. A machine
    // principal (service account, agent, AI execution surface) can
    // never decide: AI or agent output can never constitute business
    // approval (AC-4).
    if (principal.kind !== 'human') {
      throw new ApprovalError(
        'DECIDER_NOT_HUMAN',
        `business approval is an explicit human authority: principal ${principal.id} is of kind "${principal.kind}" and cannot decide (AI or agent output is never approval)`,
      );
    }
    await requireTenantAccess(principal, input.tenantId, 'write');
    // The decision content hash (scope + request + verdict + reason):
    // the keyed convergence comparison inside the store's serialized
    // critical section.
    const contentHash = computeApprovalDecisionContentHash({
      tenantId: input.tenantId,
      requestId: input.requestId,
      decision: input.decision,
      reason: input.reason,
    });
    const storeInput: DecideApprovalStoreInput = {
      tenantId: input.tenantId,
      requestId: input.requestId,
      decision: input.decision,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      decidedBy: principal.id,
      now: now(),
      contentHash,
    };
    try {
      const decided = await store.decide(storeInput);
      return { request: decided.request, decision: decided.decision, converged: decided.converged };
    } catch (error) {
      mapStoreError(error);
    }
  }

  async function getApprovalDecision(
    principal: Principal,
    tenantId: string,
    decisionId: string,
  ): Promise<ApprovalDecisionRecord> {
    await requireTenantAccess(principal, tenantId, 'read');
    validateUuid(decisionId, 'decisionId');
    let decision: ApprovalDecisionRecord | null;
    try {
      decision = await store.findDecision(tenantId, decisionId);
    } catch (error) {
      mapStoreError(error);
    }
    if (decision === null) {
      throw new ApprovalError('APPROVAL_DECISION_NOT_FOUND', `approval decision ${decisionId} not found`);
    }
    return decision;
  }

  async function listApprovalDecisions(
    principal: Principal,
    tenantId: string,
    filter?: { serviceWorkId?: string; requestId?: string; decidedBy?: string; decision?: ApprovalDecisionKind },
  ): Promise<ApprovalDecisionRecord[]> {
    await requireTenantAccess(principal, tenantId, 'read');
    if (filter?.serviceWorkId !== undefined) validateUuid(filter.serviceWorkId, 'filter.serviceWorkId');
    if (filter?.requestId !== undefined) validateUuid(filter.requestId, 'filter.requestId');
    if (filter?.decidedBy !== undefined) validateUuid(filter.decidedBy, 'filter.decidedBy');
    if (filter?.decision !== undefined && !isApprovalDecisionKind(filter.decision)) {
      throw new ApprovalError('INVALID_INPUT', `filter.decision must be one of ${APPROVAL_DECISIONS.join(', ')}`);
    }
    try {
      return await store.listDecisions(tenantId, filter);
    } catch (error) {
      mapStoreError(error);
    }
  }

  async function getTerminalApprovalDecision(
    principal: Principal,
    tenantId: string,
    requestId: string,
  ): Promise<ApprovalDecisionRecord> {
    await requireTenantAccess(principal, tenantId, 'read');
    validateUuid(requestId, 'requestId');
    let request: ApprovalRequestRecord | null;
    let decision: ApprovalDecisionRecord | null;
    try {
      request = await store.findRequest(tenantId, requestId);
      decision = request === null ? null : await store.findDecisionByRequest(tenantId, requestId);
    } catch (error) {
      mapStoreError(error);
    }
    if (request === null) {
      throw new ApprovalError('APPROVAL_REQUEST_NOT_FOUND', `approval request ${requestId} not found`);
    }
    if (decision === null) {
      // A pending request has NO terminal decision: distinguishable
      // from a decided one and from a missing request (lock #30).
      throw new ApprovalError(
        'APPROVAL_DECISION_NOT_FOUND',
        `approval request ${requestId} is still pending (no terminal decision recorded)`,
      );
    }
    return decision;
  }

  return {
    requestApproval,
    getApprovalRequest,
    listApprovalRequests,
    decideApproval,
    getApprovalDecision,
    listApprovalDecisions,
    getTerminalApprovalDecision,
  };
}

/**
 * Module manifest (registered in the composition root's module
 * registry). The manifest declares identity only; the contracts above
 * are the module's public surface.
 */
export default defineModule({
  name: 'approvals',
  version: '1.0.0',
  description: 'ServiceOS business/human approval requests and decisions',
});
