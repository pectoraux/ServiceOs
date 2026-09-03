/**
 * ServiceOS /entities Construction Subcontractor Compliance flow
 * (WORK-010, module internal — exported through the module's public
 * interface).
 *
 * THE FIRST COMMERCIAL SERVICE (architecture.md §16; vertical-model.md
 * "Construction v1"): pure ORCHESTRATION over the horizontal
 * authorities' PUBLIC interfaces. It owns NO replacement engine and
 * NO second durable state:
 *
 * - Service Work identity + attempts: /work (createWork/createAttempt/
 *   dispatchAttempt/recordAttemptResult — one work identity per flow
 *   artifact, keyed convergence).
 * - Service Work STATE: /workflow exclusively (every transition is an
 *   authorized submitTransition through the ONE deterministic
 *   authority; this flow adds no state machine of its own — invariant
 *   2 "Service Work lifecycle remains owned by /workflow").
 * - Business evidence + the outcome verification decision: /evidence
 *   (attachEvidence/verifyOutcome — the deterministic mapping stays
 *   /evidence' authority; the flow COMPOSES the richer vertical
 *   contract atop it exactly as WORK-007's known-limitations note
 *   anticipated: final compliance requires BOTH the satisfied
 *   evidence verdict AND every deterministic vertical rule
 *   compliant).
 * - Vendor document requests, follow-ups and their durable delivery:
 *   /interactions (createInteraction/dispatchInteraction — durable
 *   intent precedes the side effect; concurrent follow-up workers
 *   converge on ONE contact through the keyed interaction identity —
 *   invariant 5 / AC-5).
 * - Exception escalation: /approvals (requestApproval — an EXPLICIT
 *   human decision terminalizes it; the flow consumes the decision,
 *   never fabricates one).
 * - Zeck-backed document reasoning: /zeck only (submitExecutionIntent
 *   with the package-declared capability REQUIREMENT — invariant 3
 *   "AI functionality flows only through Zeck"; the extracted facts
 *   enter as EVIDENCE with the foreign execution cited as provenance,
 *   and the deterministic rules still decide — invariant 4 / AC-6
 *   "final compliance status is based on ServiceOS business
 *   verification, not merely an AI claim").
 * - Entity instances (Project, Subcontractor, InsuranceCertificate,
 *   License, ComplianceRequirement): the /entities authority surface
 *   of this module.
 *
 * The flow is STATELESS: every durable fact lives in an authority's
 * ledger, every operation is keyed/idempotent, and the compliance
 * status is DERIVED (the newest /evidence verification decision + the
 * deterministic rule outcomes — never a flow-owned status column).
 */
import type { Principal } from '../auth/index.js';
import type { VerticalPackageRecord } from '../verticals/index.js';
import type { ZeckCapabilityRequirement } from '../verticals/index.js';
import type { WorkRecord, WorkAttemptRecord, AttemptOutcome } from '../work/index.js';
import type { WorkStatus } from '../work/index.js';
import type { TransitionRecord } from '../workflow/index.js';
import type {
  EvidenceRecord,
  OutcomeVerificationRecord,
  AttachEvidenceInput,
  OutcomeContractInput,
} from '../evidence/index.js';
import type { InteractionRecord } from '../interactions/index.js';
import type { ZeckIntentRecord, SubmitIntentResult } from '../zeck/index.js';
import type { ApprovalRequestRecord, ApprovalDecisionRecord } from '../approvals/index.js';
import { ConstructionError } from './errors.js';
import {
  CONSTRUCTION_PACKAGE_ID,
  CONSTRUCTION_COMPLIANCE_OUTCOME_ID,
  type ConstructionDocumentKind,
} from './construction-package.js';
import {
  validateInsuranceCompliance,
  validateLicenseCompliance,
  validateW9Compliance,
  complianceEvidenceRequirements,
  type InsuranceValidationResult,
  type LicenseValidationResult,
  type W9ValidationResult,
} from './rules.js';
import { computeCompliancePackageHash } from './content.js';
import type { EntityInstanceRecord, EntitiesModule } from './module.js';

// ---------------------------------------------------------------------------
// The horizontal authorities' consumed surfaces (structural subsets of
// their PUBLIC interfaces — injected at composition, never
// re-implemented here)
// ---------------------------------------------------------------------------

/** /verticals' public read the flow consumes (declaration consultation). */
export interface VerticalPackageReader {
  getVerticalPackage(
    principal: Principal,
    tenantId: string,
    packageId: string,
    version: number,
  ): Promise<VerticalPackageRecord | null>;
}

/** /work's public surface the flow consumes. */
export interface WorkAuthority {
  createWork(
    principal: Principal,
    input: { tenantId: string; workType: string; title: string; idempotencyKey?: string },
  ): Promise<{ work: WorkRecord; converged: boolean }>;
  getWork(principal: Principal, tenantId: string, workId: string): Promise<WorkRecord>;
  listAttempts(principal: Principal, tenantId: string, workId: string): Promise<WorkAttemptRecord[]>;
  createAttempt(
    principal: Principal,
    tenantId: string,
    workId: string,
    input?: { idempotencyKey?: string },
  ): Promise<{ attempt: WorkAttemptRecord; converged: boolean }>;
  dispatchAttempt(
    principal: Principal,
    tenantId: string,
    attemptId: string,
  ): Promise<{ attempt: WorkAttemptRecord; converged: boolean }>;
  recordAttemptResult(
    principal: Principal,
    tenantId: string,
    attemptId: string,
    input: { outcome: AttemptOutcome; result?: string },
  ): Promise<{ attempt: WorkAttemptRecord; converged: boolean }>;
}

/** /workflow's public surface the flow consumes (the ONE transition authority). */
export interface WorkflowAuthority {
  submitTransition(
    principal: Principal,
    tenantId: string,
    workId: string,
    input: { to: WorkStatus; policyKey?: string; idempotencyKey?: string; reason?: string },
  ): Promise<{ transition: TransitionRecord; converged: boolean }>;
  listTransitions(principal: Principal, tenantId: string, workId: string): Promise<TransitionRecord[]>;
}

/** /evidence's public surface the flow consumes. */
export interface EvidenceAuthority {
  attachEvidence(
    principal: Principal,
    input: AttachEvidenceInput,
  ): Promise<{ evidence: EvidenceRecord; converged: boolean }>;
  listEvidence(
    principal: Principal,
    tenantId: string,
    filter?: { serviceWorkId?: string; workAttemptId?: string; requirement?: string },
  ): Promise<EvidenceRecord[]>;
  verifyOutcome(
    principal: Principal,
    input: { tenantId: string; serviceWorkId: string; contract: OutcomeContractInput; idempotencyKey: string },
  ): Promise<{ verification: OutcomeVerificationRecord; converged: boolean }>;
  getLatestOutcomeVerification(
    principal: Principal,
    tenantId: string,
    serviceWorkId: string,
    outcomeId: string,
  ): Promise<OutcomeVerificationRecord>;
  listOutcomeVerifications(
    principal: Principal,
    tenantId: string,
    filter?: { serviceWorkId?: string; outcomeId?: string },
  ): Promise<OutcomeVerificationRecord[]>;
}

/** /interactions' public surface the flow consumes (durable side effects). */
export interface InteractionsAuthority {
  createInteraction(
    principal: Principal,
    tenantId: string,
    input: {
      capability: 'email';
      params: unknown;
      correlation?: Readonly<Record<string, string>>;
      policyKey?: string;
      idempotencyKey?: string;
      retryOfInteractionId?: string;
    },
  ): Promise<{ interaction: InteractionRecord; converged: boolean }>;
  dispatchInteraction(
    principal: Principal,
    tenantId: string,
    interactionId: string,
  ): Promise<{ interaction: InteractionRecord; invoked: boolean; converged: boolean }>;
  listInteractions(
    principal: Principal,
    tenantId: string,
    filter?: { correlation?: { key: string; value: string } },
  ): Promise<InteractionRecord[]>;
}

/** /zeck's public surface the flow consumes (document reasoning only). */
export interface ZeckAuthority {
  submitExecutionIntent(
    principal: Principal,
    input: {
      tenantId: string;
      serviceWorkId: string;
      workAttemptId: string;
      objective: string;
      inputArtifactRefs: readonly string[];
      businessContext: Readonly<Record<string, string>>;
      requiredCapabilities: readonly unknown[];
      businessConstraints: Readonly<Record<string, string>>;
      outputContract: { schemaRef: string; description?: string };
      idempotencyKey: string;
    },
  ): Promise<SubmitIntentResult>;
  listExecutionIntents(
    principal: Principal,
    tenantId: string,
    filter?: { serviceWorkId?: string },
  ): Promise<ZeckIntentRecord[]>;
}

/** /approvals' public surface the flow consumes (exception escalation). */
export interface ApprovalsAuthority {
  requestApproval(
    principal: Principal,
    input: {
      tenantId: string;
      serviceWorkId: string;
      workAttemptId?: string;
      policyKey: string;
      subject: unknown;
      idempotencyKey: string;
    },
  ): Promise<{ request: ApprovalRequestRecord; converged: boolean }>;
  getTerminalApprovalDecision(
    principal: Principal,
    tenantId: string,
    requestId: string,
  ): Promise<ApprovalDecisionRecord>;
  listApprovalRequests(
    principal: Principal,
    tenantId: string,
    filter?: { serviceWorkId?: string },
  ): Promise<ApprovalRequestRecord[]>;
}

// ---------------------------------------------------------------------------
// Options and the flow module
// ---------------------------------------------------------------------------

export interface ConstructionComplianceOptions {
  entities: EntitiesModule;
  verticals: VerticalPackageReader;
  work: WorkAuthority;
  workflow: WorkflowAuthority;
  evidence: EvidenceAuthority;
  interactions: InteractionsAuthority;
  zeck: ZeckAuthority;
  approvals: ApprovalsAuthority;
  /** Clock injection for deterministic proofs. */
  now?: () => Date;
}

export interface ConstructionComplianceFlow {
  onboardSubcontractor(principal: Principal, input: OnboardSubcontractorInput): Promise<OnboardingResult>;
  receiveVendorDocument(principal: Principal, input: ReceiveVendorDocumentInput): Promise<ReceivedDocumentResult>;
  evaluateCompliance(principal: Principal, input: EvaluateComplianceInput): Promise<ComplianceEvaluationResult>;
  chaseMissingDocuments(principal: Principal, input: ChaseInput): Promise<ChaseResult>;
  escalateException(principal: Principal, input: EscalateInput): Promise<EscalationResult>;
  applyExceptionDecision(principal: Principal, input: ApplyDecisionInput): Promise<AppliedDecisionResult>;
  requestDocumentReasoning(principal: Principal, input: ReasoningRequestInput): Promise<ReasoningRequestResult>;
  recordReasonedDocumentFacts(principal: Principal, input: ReasonedFactsInput): Promise<ReceivedDocumentResult>;
  assembleCompliancePackage(principal: Principal, input: AssemblePackageInput): Promise<CompliancePackageResult>;
  getComplianceStatus(principal: Principal, input: { tenantId: string; serviceWorkId: string }): Promise<ComplianceStatus>;
}

// ---------------------------------------------------------------------------
// Public inputs and results
// ---------------------------------------------------------------------------

export interface OnboardSubcontractorInput {
  readonly tenantId: string;
  readonly packageVersion: number;
  readonly projectInstanceId: string;
  readonly subcontractor: {
    readonly name: string;
    readonly contactEmail: string;
    readonly taxId: string;
    readonly trade: string;
  };
  readonly idempotencyKey: string;
}

export interface OnboardingResult {
  readonly serviceWork: WorkRecord;
  readonly attempt: WorkAttemptRecord;
  readonly subcontractor: EntityInstanceRecord;
  readonly requirements: readonly EntityInstanceRecord[];
  readonly collectionRequest: InteractionRecord;
}

export interface ReceiveVendorDocumentInput {
  readonly tenantId: string;
  readonly serviceWorkId: string;
  readonly kind: ConstructionDocumentKind;
  /** The document facts (validated per the entity declaration of the kind). */
  readonly document: Readonly<Record<string, unknown>>;
  readonly receivedAt: Date;
  readonly idempotencyKey: string;
}

export interface ReceivedDocumentResult {
  readonly documentInstance: EntityInstanceRecord | null;
  readonly evidence: EvidenceRecord;
  readonly serviceWork: WorkRecord;
}

export interface EvaluateComplianceInput {
  readonly tenantId: string;
  readonly serviceWorkId: string;
  readonly idempotencyKey: string;
}

export interface ComplianceEvaluationResult {
  readonly verification: OutcomeVerificationRecord;
  readonly verdict: 'satisfied' | 'not_satisfied';
  /** The composed vertical gate: evidence verdict AND every deterministic rule. */
  readonly compliant: boolean;
  readonly insuranceValidation: InsuranceValidationResult | null;
  readonly licenseValidation: LicenseValidationResult | null;
  readonly w9Validation: W9ValidationResult | null;
  readonly missing: readonly string[];
  readonly serviceWork: WorkRecord;
}

export interface ChaseInput {
  readonly tenantId: string;
  readonly serviceWorkId: string;
  /** The follow-up round (>= 1); one durable contact per (work, round). */
  readonly round: number;
  readonly policyKey?: string;
  readonly idempotencyKey?: string;
  readonly reason?: string;
}

export interface ChaseResult {
  readonly followUpWork: WorkRecord;
  readonly followUpAttempt: WorkAttemptRecord;
  readonly chase: InteractionRecord;
  readonly missing: readonly string[];
  readonly round: number;
}

export interface EscalateInput {
  readonly tenantId: string;
  readonly serviceWorkId: string;
  readonly reason: string;
  readonly policyKey?: string;
  readonly idempotencyKey?: string;
}

export interface EscalationResult {
  readonly escalationWork: WorkRecord;
  readonly approvalRequest: ApprovalRequestRecord;
  readonly serviceWork: WorkRecord;
}

export interface ApplyDecisionInput {
  readonly tenantId: string;
  readonly serviceWorkId: string;
  readonly idempotencyKey?: string;
}

export interface AppliedDecisionResult {
  readonly decision: ApprovalDecisionRecord;
  readonly serviceWork: WorkRecord;
}

export interface ReasoningRequestInput {
  readonly tenantId: string;
  readonly serviceWorkId: string;
  readonly kind: 'insurance_certificate';
  readonly idempotencyKey?: string;
}

export interface ReasoningRequestResult {
  readonly intent: ZeckIntentRecord;
  readonly dispatched: boolean;
}

export interface ReasonedFactsInput {
  readonly tenantId: string;
  readonly serviceWorkId: string;
  readonly kind: ConstructionDocumentKind;
  readonly facts: Readonly<Record<string, unknown>>;
  /** Opaque provenance references of the foreign AI execution (cited, never trusted). */
  readonly provenanceRefs: readonly string[];
  readonly observedAt: Date;
  readonly idempotencyKey: string;
}

export interface AssemblePackageInput {
  readonly tenantId: string;
  readonly serviceWorkId: string;
  readonly idempotencyKey?: string;
}

export interface CompliancePackageResult {
  readonly packageDocument: Readonly<Record<string, unknown>>;
  readonly packageHash: string;
  readonly packageEvidence: EvidenceRecord;
}

export interface ComplianceStatus {
  readonly serviceWork: WorkRecord;
  readonly verification: OutcomeVerificationRecord | null;
  readonly missing: readonly string[];
}

// ---------------------------------------------------------------------------
// Validation helpers (fail closed)
// ---------------------------------------------------------------------------

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,200}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateUuid(value: unknown, what: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new ConstructionError('INVALID_INPUT', `${what} must be a UUID`);
  }
  return value;
}

function validateKey(value: unknown, what: string): string {
  if (typeof value !== 'string' || !KEY_PATTERN.test(value)) {
    throw new ConstructionError('INVALID_INPUT', `${what} must be a non-empty string of at most 200 characters matching [A-Za-z0-9_.:-]`);
  }
  return value;
}

function validateDocumentKind(value: unknown): ConstructionDocumentKind {
  if (value !== 'insurance_certificate' && value !== 'w9' && value !== 'license') {
    throw new ConstructionError('INVALID_INPUT', 'kind must be "insurance_certificate", "w9" or "license"');
  }
  return value;
}

/** The entity type each document kind records (null: facts-only document). */
function documentEntityType(kind: ConstructionDocumentKind): string | null {
  switch (kind) {
    case 'insurance_certificate':
      return 'InsuranceCertificate';
    case 'license':
      return 'License';
    case 'w9':
      return null;
  }
}

/** The evidence requirement each document kind satisfies. */
function documentRequirement(kind: ConstructionDocumentKind): string {
  return `construction.${kind}`;
}

/** Read one string field out of an entity record. */
function entityString(instance: EntityInstanceRecord, field: string): string {
  const value = instance.fields[field];
  if (typeof value !== 'string') {
    throw new ConstructionError('INVALID_INPUT', `entity ${instance.entityType} field "${field}" must be a string`);
  }
  return value;
}

/** Read one number field out of an entity record. */
function entityNumber(instance: EntityInstanceRecord, field: string): number {
  const value = instance.fields[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ConstructionError('INVALID_INPUT', `entity ${instance.entityType} field "${field}" must be a finite number`);
  }
  return value;
}

/** Read one boolean field out of an entity record. */
function entityBoolean(instance: EntityInstanceRecord, field: string): boolean {
  const value = instance.fields[field];
  if (typeof value !== 'boolean') {
    throw new ConstructionError('INVALID_INPUT', `entity ${instance.entityType} field "${field}" must be a boolean`);
  }
  return value;
}

const TERMINAL: readonly WorkStatus[] = ['completed', 'cancelled', 'failed', 'expired'];

function requireNonTerminal(work: WorkRecord, what: string): void {
  if (TERMINAL.includes(work.status)) {
    throw new ConstructionError(
      'WORK_STATE_INVALID',
      `service work ${work.id} is in terminal state "${work.status}"; ${what} applies to live work only`,
    );
  }
}

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

export function createConstructionCompliance(options: ConstructionComplianceOptions): ConstructionComplianceFlow {
  const entities = options.entities;
  const verticals = options.verticals;
  const work = options.work;
  const workflow = options.workflow;
  const evidence = options.evidence;
  const interactions = options.interactions;
  const zeck = options.zeck;
  const approvals = options.approvals;
  const now = options.now ?? (() => new Date());

  /** The project's declared compliance-requirement profile. */
  interface Engagement {
    project: EntityInstanceRecord;
    subcontractor: EntityInstanceRecord;
    packageVersion: number;
  }

  /** Resolve the (project, subcontractor) engagement linkage of one work through its evidence ledger. */
  async function resolveEngagement(principal: Principal, tenantId: string, serviceWorkId: string): Promise<Engagement> {
    const rows = await evidence.listEvidence(principal, tenantId, { serviceWorkId, requirement: 'construction.subcontractor_profile' });
    if (rows.length === 0) {
      throw new ConstructionError(
        'SUBCONTRACTOR_NOT_FOUND',
        `service work ${serviceWorkId} carries no subcontractor profile evidence; onboard the subcontractor first`,
      );
    }
    const profile = rows[0] as EvidenceRecord;
    const payload = profile.payload as Record<string, unknown>;
    const subcontractorInstanceId = payload.subcontractorInstanceId;
    const projectInstanceId = payload.projectInstanceId;
    const packageVersion = payload.packageVersion;
    if (typeof subcontractorInstanceId !== 'string' || typeof projectInstanceId !== 'string' || typeof packageVersion !== 'number') {
      throw new ConstructionError('SUBCONTRACTOR_NOT_FOUND', `the profile evidence of work ${serviceWorkId} is malformed`);
    }
    const project = await entities.getEntityInstance(principal, tenantId, projectInstanceId);
    if (project.entityType !== 'Project') {
      throw new ConstructionError('PROJECT_NOT_FOUND', `entity instance ${projectInstanceId} is not a Project`);
    }
    const subcontractor = await entities.getEntityInstance(principal, tenantId, subcontractorInstanceId);
    if (subcontractor.entityType !== 'Subcontractor') {
      throw new ConstructionError('SUBCONTRACTOR_NOT_FOUND', `entity instance ${subcontractorInstanceId} is not a Subcontractor`);
    }
    return { project, subcontractor, packageVersion };
  }

  /** The package-declared Zeck capability requirement for document reasoning (consumed, never re-declared). */
  async function documentReasoningRequirement(principal: Principal, tenantId: string, packageVersion: number): Promise<ZeckCapabilityRequirement> {
    const pkg = await verticals.getVerticalPackage(principal, tenantId, CONSTRUCTION_PACKAGE_ID, packageVersion);
    if (pkg === null) {
      throw new ConstructionError('INVALID_INPUT', `vertical package ${CONSTRUCTION_PACKAGE_ID} v${packageVersion} is not registered in this tenant`);
    }
    const declared = pkg.zeckCapabilityRequirements.find((requirement) => requirement.capability === 'document.reasoning');
    if (declared === undefined) {
      throw new ConstructionError('INVALID_INPUT', `vertical package ${CONSTRUCTION_PACKAGE_ID} v${packageVersion} declares no document.reasoning capability requirement`);
    }
    return declared;
  }

  /**
   * The durable attempt of one keyed logical effort: REUSED when it
   * already exists (a post-dispatch /work retry would create a NEW
   * superseding attempt — correct for real retries, wrong for a
   * convergent replay, whose keyed side effects are already bound to the
   * original attempt identity).
   */
  async function keyedAttempt(principal: Principal, tenantId: string, workId: string, key: string): Promise<WorkAttemptRecord> {
    const attempts = await work.listAttempts(principal, tenantId, workId);
    const existing = attempts.find((entry) => entry.idempotencyKey === key);
    if (existing !== undefined) {
      return existing;
    }
    const { attempt } = await work.createAttempt(principal, tenantId, workId, { idempotencyKey: key });
    await work.dispatchAttempt(principal, tenantId, attempt.id);
    return attempt;
  }

  /** Submit one keyed transition through the ONE authority (convergent). */
  async function transition(
    principal: Principal,
    tenantId: string,
    workId: string,
    to: WorkStatus,
    idempotencyKey: string,
    reason?: string,
  ): Promise<TransitionRecord> {
    const result = await workflow.submitTransition(principal, tenantId, workId, { to, idempotencyKey, ...(reason !== undefined ? { reason } : {}) });
    return result.transition;
  }

  /** Drive a fresh work (draft) through ready -> accepted -> in_progress (keyed, convergent). */
  async function startWork(principal: Principal, tenantId: string, workId: string, key: string): Promise<void> {
    await transition(principal, tenantId, workId, 'ready', `${key}:t-ready`);
    await transition(principal, tenantId, workId, 'accepted', `${key}:t-accepted`);
    await transition(principal, tenantId, workId, 'in_progress', `${key}:t-in-progress`);
  }

  /** The evidence requirement set of this engagement's outcome contract (project-specialized). */
  function requirementSet(project: EntityInstanceRecord): readonly string[] {
    return complianceEvidenceRequirements(entityBoolean(project, 'requireW9'), entityBoolean(project, 'requireLicense'));
  }

  /**
   * The latest evidence of one requirement on one work: the newest by
   * the record's business observation time (observedAt — the provenance
   * instant the fact was observed at), tie-broken by list position
   * (last). Vendor corrections carry a NEWER observation instant, so the
   * corrected state deterministically governs even under a frozen
   * attachment clock.
   */
  async function latestEvidence(principal: Principal, tenantId: string, serviceWorkId: string, requirement: string): Promise<EvidenceRecord | null> {
    const rows = await evidence.listEvidence(principal, tenantId, { serviceWorkId, requirement });
    if (rows.length === 0) return null;
    let latest = rows[0] as EvidenceRecord;
    for (const row of rows) {
      if (row.observedAt.getTime() >= latest.observedAt.getTime()) {
        latest = row;
      }
    }
    return latest;
  }

  return {
    async onboardSubcontractor(principal, raw): Promise<OnboardingResult> {
      if (typeof raw !== 'object' || raw === null) {
        throw new ConstructionError('INVALID_INPUT', 'the onboarding input must be an object');
      }
      const tenantId = validateUuid(raw.tenantId, 'tenantId');
      const packageVersion = raw.packageVersion;
      if (typeof packageVersion !== 'number' || !Number.isInteger(packageVersion) || packageVersion < 1) {
        throw new ConstructionError('INVALID_INPUT', 'packageVersion must be a positive integer');
      }
      const projectInstanceId = validateUuid(raw.projectInstanceId, 'projectInstanceId');
      const key = validateKey(raw.idempotencyKey, 'idempotencyKey');
      if (typeof raw.subcontractor !== 'object' || raw.subcontractor === null) {
        throw new ConstructionError('INVALID_INPUT', 'subcontractor must be an object');
      }
      const sub = raw.subcontractor as Record<string, unknown>;
      for (const field of ['name', 'contactEmail', 'taxId', 'trade'] as const) {
        if (typeof sub[field] !== 'string' || (sub[field] as string).trim() === '') {
          throw new ConstructionError('INVALID_INPUT', `subcontractor.${field} must be a non-empty string`);
        }
      }
      if (!EMAIL_PATTERN.test(sub.contactEmail as string)) {
        throw new ConstructionError('INVALID_INPUT', 'subcontractor.contactEmail must be a valid email address');
      }

      // 1. The project instance (the compliance-requirement owner).
      const project = await entities.getEntityInstance(principal, tenantId, projectInstanceId);
      if (project.entityType !== 'Project' || project.packageId !== CONSTRUCTION_PACKAGE_ID) {
        throw new ConstructionError('PROJECT_NOT_FOUND', `entity instance ${projectInstanceId} is not a Construction Project`);
      }

      // 2. The subcontractor entity (keyed convergence).
      const { instance: subcontractor } = await entities.createEntityInstance(principal, {
        tenantId,
        packageId: CONSTRUCTION_PACKAGE_ID,
        packageVersion,
        entityType: 'Subcontractor',
        fields: {
          name: sub.name as string,
          contactEmail: sub.contactEmail as string,
          taxId: sub.taxId as string,
          trade: sub.trade as string,
        },
        idempotencyKey: `${key}:subcontractor`,
      });

      // 3. The compliance Service Work (one identity per logical onboarding).
      const { work: serviceWork } = await work.createWork(principal, {
        tenantId,
        workType: 'construction.onboard_subcontractor',
        title: `Subcontractor compliance: ${subcontractor.fields.name} @ ${project.fields.name}`,
        idempotencyKey: `${key}:work`,
      });

      // 4. The durable work attempt (the effort record; replay-reused).
      const attempt = await keyedAttempt(principal, tenantId, serviceWork.id, `${key}:attempt-1`);

      // 5. The lifecycle: draft -> ready -> accepted -> in_progress.
      await startWork(principal, tenantId, serviceWork.id, key);

      // 6. The engagement's required documents (derived from the project profile).
      const kinds: ConstructionDocumentKind[] = ['insurance_certificate'];
      if (entityBoolean(project, 'requireW9')) kinds.push('w9');
      if (entityBoolean(project, 'requireLicense')) kinds.push('license');
      const requirements: EntityInstanceRecord[] = [];
      for (const kind of kinds) {
        const { instance } = await entities.createEntityInstance(principal, {
          tenantId,
          packageId: CONSTRUCTION_PACKAGE_ID,
          packageVersion,
          entityType: 'ComplianceRequirement',
          fields: {
            kind,
            scope: kind === 'insurance_certificate' ? 'insurance' : kind === 'w9' ? 'tax' : 'licensing',
            serviceWorkId: serviceWork.id,
            detail: `Required ${kind} for ${subcontractor.fields.name}`,
          },
          idempotencyKey: `${key}:requirement:${kind}`,
        });
        requirements.push(instance);
      }

      // 7. The durable document-collection request (intent BEFORE the
      //    side effect; one keyed contact; dispatch converges).
      const requiredList = kinds.map((kind) => `- ${kind}`).join('\n');
      const { interaction: collectionIntent } = await interactions.createInteraction(principal, tenantId, {
        capability: 'email',
        params: {
          to: [subcontractor.fields.contactEmail as string],
          subject: `Compliance documents required: ${project.fields.name}`,
          body: `Hello ${subcontractor.fields.name},\n\nTo engage on ${project.fields.name}, please submit:\n${requiredList}\n\nThank you.`,
        },
        correlation: {
          serviceWorkId: serviceWork.id,
          projectInstanceId: project.id,
          subcontractorInstanceId: subcontractor.id,
        },
        idempotencyKey: `${key}:collect-request`,
      });
      // Durable dispatch (convergent: a twin already dispatched it means
      // ONE provider contact, never two).
      const { interaction: collectionRequest } = await interactions.dispatchInteraction(
        principal,
        tenantId,
        collectionIntent.id,
      );

      // 8. The profile evidence (the attributable engagement record).
      await evidence.attachEvidence(principal, {
        tenantId,
        serviceWorkId: serviceWork.id,
        workAttemptId: attempt.id,
        requirement: 'construction.subcontractor_profile',
        provenance: {
          kind: 'external_record',
          source: 'construction.onboarding',
          refs: [subcontractor.id, project.id],
        },
        payload: {
          subcontractorInstanceId: subcontractor.id,
          projectInstanceId: project.id,
          packageVersion,
          subcontractor: { ...subcontractor.fields },
          project: { id: project.id, name: project.fields.name },
        },
        observedAt: now(),
        idempotencyKey: `${key}:profile-evidence`,
      });

      // 9. Waiting for the vendor.
      await transition(principal, tenantId, serviceWork.id, 'waiting_information', `${key}:t-waiting-information`, 'compliance documents requested from the vendor');

      const finalWork = await work.getWork(principal, tenantId, serviceWork.id);
      const finalAttempt = (await work.listAttempts(principal, tenantId, serviceWork.id)).find((entry) => entry.id === attempt.id) ?? attempt;
      return { serviceWork: finalWork, attempt: finalAttempt, subcontractor, requirements, collectionRequest };
    },

    async receiveVendorDocument(principal, raw): Promise<ReceivedDocumentResult> {
      if (typeof raw !== 'object' || raw === null) {
        throw new ConstructionError('INVALID_INPUT', 'the receive-document input must be an object');
      }
      const tenantId = validateUuid(raw.tenantId, 'tenantId');
      const serviceWorkId = validateUuid(raw.serviceWorkId, 'serviceWorkId');
      const kind = validateDocumentKind(raw.kind);
      const key = validateKey(raw.idempotencyKey, 'idempotencyKey');
      if (typeof raw.document !== 'object' || raw.document === null || Array.isArray(raw.document)) {
        throw new ConstructionError('INVALID_INPUT', 'document must be an object of document facts');
      }
      if (!(raw.receivedAt instanceof Date) || !Number.isFinite(raw.receivedAt.getTime())) {
        throw new ConstructionError('INVALID_INPUT', 'receivedAt must be a finite Date');
      }
      const document = raw.document as Record<string, unknown>;

      // The work must exist (typed mapping of the authority's own error).
      let current: WorkRecord;
      try {
        current = await work.getWork(principal, tenantId, serviceWorkId);
      } catch (error) {
        if ((error as { code?: string }).code === 'WORK_NOT_FOUND') {
          throw new ConstructionError('WORK_NOT_FOUND', `service work ${serviceWorkId} does not exist in this tenant`);
        }
        throw error;
      }
      const engagement = await resolveEngagement(principal, tenantId, serviceWorkId);

      // 1. The document entity instance (typed documents only; keyed convergence).
      let documentInstance: EntityInstanceRecord | null = null;
      const entityType = documentEntityType(kind);
      if (entityType !== null) {
        const { instance } = await entities.createEntityInstance(principal, {
          tenantId,
          packageId: CONSTRUCTION_PACKAGE_ID,
          packageVersion: engagement.packageVersion,
          entityType,
          fields: document,
          idempotencyKey: `${key}:document-entity`,
        });
        documentInstance = instance;
      }

      // 2. The document evidence (the attributable record; duplicates converge).
      const { evidence: documentEvidence } = await evidence.attachEvidence(principal, {
        tenantId,
        serviceWorkId,
        requirement: documentRequirement(kind),
        provenance: {
          kind: 'external_record',
          source: 'vendor-document-submission',
          refs: documentInstance !== null ? [documentInstance.id] : [serviceWorkId],
        },
        payload: { ...document },
        observedAt: raw.receivedAt,
        idempotencyKey: `${key}:document-evidence`,
      });

      // 3. Resume the work — ONLY on live waiting work (a terminal work
      //    records the late evidence and is never mutated: the stale
      //    attempt cannot regress a decided compliance state).
      if (current.status === 'waiting_information') {
        await transition(principal, tenantId, serviceWorkId, 'in_progress', `${key}:t-resume`, 'vendor submitted a compliance document');
      }

      const finalWork = await work.getWork(principal, tenantId, serviceWorkId);
      return { documentInstance, evidence: documentEvidence, serviceWork: finalWork };
    },

    async evaluateCompliance(principal, raw): Promise<ComplianceEvaluationResult> {
      if (typeof raw !== 'object' || raw === null) {
        throw new ConstructionError('INVALID_INPUT', 'the evaluate-compliance input must be an object');
      }
      const tenantId = validateUuid(raw.tenantId, 'tenantId');
      const serviceWorkId = validateUuid(raw.serviceWorkId, 'serviceWorkId');
      const key = validateKey(raw.idempotencyKey, 'idempotencyKey');

      const current = await work.getWork(principal, tenantId, serviceWorkId);
      const engagement = await resolveEngagement(principal, tenantId, serviceWorkId);
      const asOf = now();

      // 1. The deterministic vertical rules over the LATEST recorded
      //    document facts (missing documents simply leave their
      //    validation unsatisfied — the verdict lists them).
      let insuranceValidation: InsuranceValidationResult | null = null;
      const insuranceEvidence = await latestEvidence(principal, tenantId, serviceWorkId, 'construction.insurance_certificate');
      if (insuranceEvidence !== null) {
        const facts = insuranceEvidence.payload as Record<string, unknown>;
        const gl = facts.glPerOccurrenceUsd;
        const umbrella = facts.umbrellaAggregateUsd;
        const expiresAt = facts.expiresAt;
        const additionalInsured = facts.additionalInsured;
        const certificateHolder = facts.certificateHolder;
        if (typeof gl !== 'number' || typeof umbrella !== 'number' || typeof expiresAt !== 'string') {
          throw new ConstructionError('INVALID_INPUT', 'the insurance-certificate evidence payload is malformed');
        }
        insuranceValidation = validateInsuranceCompliance(
          {
            minGlPerOccurrenceUsd: entityNumber(engagement.project, 'minGlPerOccurrenceUsd'),
            minUmbrellaAggregateUsd: entityNumber(engagement.project, 'minUmbrellaAggregateUsd'),
            expiryLeadDays: entityNumber(engagement.project, 'expiryLeadDays'),
            projectNamedAdditionalInsured: entityBoolean(engagement.project, 'projectNamedAdditionalInsured'),
            projectName: entityString(engagement.project, 'name'),
          },
          {
            glPerOccurrenceUsd: gl,
            umbrellaAggregateUsd: umbrella,
            expiresAt,
            additionalInsured: typeof additionalInsured === 'string' ? additionalInsured : null,
            certificateHolder: typeof certificateHolder === 'string' ? certificateHolder : '',
          },
          asOf,
        );
        // The rule outcome is attributable evidence (always attached —
        // a failure is a durable finding, never hidden).
        await evidence.attachEvidence(principal, {
          tenantId,
          serviceWorkId,
          requirement: 'construction.insurance_validation',
          provenance: {
            kind: 'calculation',
            source: 'construction.compliance-flow',
            refs: [insuranceEvidence.id],
          },
          payload: {
            asOf: asOf.toISOString(),
            compliant: insuranceValidation.compliant,
            findings: insuranceValidation.findings,
          },
          observedAt: asOf,
          idempotencyKey: `${key}:insurance-validation-evidence`,
        });
      }

      let licenseValidation: LicenseValidationResult | null = null;
      if (entityBoolean(engagement.project, 'requireLicense')) {
        const licenseEvidence = await latestEvidence(principal, tenantId, serviceWorkId, 'construction.license');
        if (licenseEvidence !== null) {
          const facts = licenseEvidence.payload as Record<string, unknown>;
          if (typeof facts.licenseNumber !== 'string' || typeof facts.jurisdiction !== 'string' || typeof facts.expiresAt !== 'string' || typeof facts.active !== 'boolean') {
            throw new ConstructionError('INVALID_INPUT', 'the license evidence payload is malformed');
          }
          licenseValidation = validateLicenseCompliance(
            { licenseNumber: facts.licenseNumber, jurisdiction: facts.jurisdiction, expiresAt: facts.expiresAt, active: facts.active },
            asOf,
          );
          await evidence.attachEvidence(principal, {
            tenantId,
            serviceWorkId,
            requirement: 'construction.license_validation',
            provenance: {
              kind: 'calculation',
              source: 'construction.compliance-flow',
              refs: [licenseEvidence.id],
            },
            payload: {
              asOf: asOf.toISOString(),
              compliant: licenseValidation.compliant,
              findings: licenseValidation.findings,
            },
            observedAt: asOf,
            idempotencyKey: `${key}:license-validation-evidence`,
          });
        }
      }

      let w9Validation: W9ValidationResult | null = null;
      if (entityBoolean(engagement.project, 'requireW9')) {
        const w9Evidence = await latestEvidence(principal, tenantId, serviceWorkId, 'construction.w9');
        if (w9Evidence !== null) {
          const facts = w9Evidence.payload as Record<string, unknown>;
          if (typeof facts.taxId !== 'string') {
            throw new ConstructionError('INVALID_INPUT', 'the W-9 evidence payload is malformed');
          }
          w9Validation = validateW9Compliance(entityString(engagement.subcontractor, 'taxId'), facts.taxId);
          await evidence.attachEvidence(principal, {
            tenantId,
            serviceWorkId,
            requirement: 'construction.w9',
            provenance: {
              kind: 'calculation',
              source: 'construction.compliance-flow',
              refs: [w9Evidence.id],
            },
            payload: {
              compliant: w9Validation.compliant,
              findings: w9Validation.findings,
            },
            observedAt: asOf,
            idempotencyKey: `${key}:w9-validation-evidence`,
          });
        }
      }

      // 2. The ServiceOS business verification decision (/evidence's
      //    deterministic mapping — the authoritative ledger record).
      const { verification } = await evidence.verifyOutcome(principal, {
        tenantId,
        serviceWorkId,
        contract: {
          outcomeId: CONSTRUCTION_COMPLIANCE_OUTCOME_ID,
          verification: 'deterministic',
          evidenceRequirements: requirementSet(engagement.project),
        },
        idempotencyKey: `${key}:verification`,
      });

      // 3. The composed vertical gate (WORK-007's anticipated richer
      //    contract): the evidence verdict AND every executed
      //    deterministic rule must be compliant. A fabricated or
      //    foreign claim alone can never compose this gate.
      const rulesCompliant =
        (insuranceValidation === null || insuranceValidation.compliant) &&
        (licenseValidation === null || licenseValidation.compliant) &&
        (w9Validation === null || w9Validation.compliant);
      const compliant = verification.verdict === 'satisfied' && rulesCompliant;
      const missing = verification.requirementResults
        .filter((result) => !result.satisfied)
        .map((result) => result.requirement);

      // 4. The lifecycle: live work enters verification; the composed
      //    gate completes it or reworks it (terminal work is never
      //    mutated — a stale attempt cannot regress a decision).
      if (!TERMINAL.includes(current.status)) {
        if (current.status === 'waiting_information') {
          await transition(principal, tenantId, serviceWorkId, 'in_progress', `${key}:t-resume-evaluation`, 'evaluation requested');
        }
        await transition(principal, tenantId, serviceWorkId, 'verifying', `${key}:t-verifying`, 'compliance evaluation');
        if (compliant) {
          await transition(principal, tenantId, serviceWorkId, 'completed', `${key}:t-completed`, 'verified compliant');
        } else {
          await transition(principal, tenantId, serviceWorkId, 'in_progress', `${key}:t-rework`, 'compliance not satisfied — rework');
        }
      }

      const finalWork = await work.getWork(principal, tenantId, serviceWorkId);
      return {
        verification,
        verdict: verification.verdict,
        compliant,
        insuranceValidation,
        licenseValidation,
        w9Validation,
        missing,
        serviceWork: finalWork,
      };
    },

    async chaseMissingDocuments(principal, raw): Promise<ChaseResult> {
      if (typeof raw !== 'object' || raw === null) {
        throw new ConstructionError('INVALID_INPUT', 'the chase input must be an object');
      }
      const tenantId = validateUuid(raw.tenantId, 'tenantId');
      const serviceWorkId = validateUuid(raw.serviceWorkId, 'serviceWorkId');
      if (typeof raw.round !== 'number' || !Number.isInteger(raw.round) || raw.round < 1) {
        throw new ConstructionError('INVALID_INPUT', 'round must be a positive integer');
      }
      const round = raw.round;
      const key = raw.idempotencyKey === undefined ? `construction.chase:${serviceWorkId}:${round}` : validateKey(raw.idempotencyKey, 'idempotencyKey');
      const policyKey = raw.policyKey === undefined ? undefined : validateKey(raw.policyKey, 'policyKey');

      const current = await work.getWork(principal, tenantId, serviceWorkId);
      requireNonTerminal(current, 'follow-up chasing');

      // 1. Derive the missing requirements from the CURRENT decision
      //    (or the full set before any decision exists).
      let missing: readonly string[];
      let verification: OutcomeVerificationRecord | null = null;
      try {
        verification = await evidence.getLatestOutcomeVerification(principal, tenantId, serviceWorkId, CONSTRUCTION_COMPLIANCE_OUTCOME_ID);
        missing = verification.requirementResults.filter((result) => !result.satisfied).map((result) => result.requirement);
      } catch (error) {
        if ((error as { code?: string }).code === 'VERIFICATION_NOT_FOUND') {
          const engagement = await resolveEngagement(principal, tenantId, serviceWorkId);
          missing = requirementSet(engagement.project);
        } else {
          throw error;
        }
      }
      if (missing.length === 0 && verification !== null) {
        throw new ConstructionError('INVALID_INPUT', `no missing requirements to chase on work ${serviceWorkId}`);
      }

      // 2. The governed follow-up WORK (AC-4: governed follow-up, not a
      //    bare side effect) — one work identity per (work, round).
      const { work: followUpWorkDraft } = await work.createWork(principal, {
        tenantId,
        workType: 'construction.chase_missing_document',
        title: `Chase round ${round}: ${missing.join(', ')}`,
        idempotencyKey: `construction.chase-work:${serviceWorkId}:${round}`,
      });
      await startWork(principal, tenantId, followUpWorkDraft.id, `construction.chase-work:${serviceWorkId}:${round}`);
      const followUpAttempt = await keyedAttempt(
        principal,
        tenantId,
        followUpWorkDraft.id,
        `construction.chase-work:${serviceWorkId}:${round}:attempt-1`,
      );
      const followUpWork = await work.getWork(principal, tenantId, followUpWorkDraft.id);

      // 3. The durable follow-up contact: ONE keyed interaction per
      //    (work, round) — concurrent workers converge on it and the
      //    dispatch claim guarantees exactly one adapter invocation.
      const engagement = await resolveEngagement(principal, tenantId, serviceWorkId);
      const contactEmail = entityString(engagement.subcontractor, 'contactEmail');
      const priorChases = await interactions.listInteractions(principal, tenantId, {
        correlation: { key: 'serviceWorkId', value: serviceWorkId },
      });
      const priorRound = priorChases
        .filter((interaction) => interaction.params !== undefined)
        .filter((interaction) => {
          const roundEntry = interaction.correlation.round;
          return roundEntry === String(round - 1);
        })
        .find((interaction) => interaction.state === 'observed' && interaction.observation?.outcome === 'failed');
      const { interaction: chaseIntent } = await interactions.createInteraction(principal, tenantId, {
        capability: 'email',
        params: {
          to: [contactEmail],
          subject: `Reminder: compliance documents still required (round ${round})`,
          body: `Hello,\n\nThe following compliance evidence is still missing or noncompliant:\n${missing.map((entry) => `- ${entry}`).join('\n')}\n\nPlease submit it.\n\nThank you.`,
        },
        correlation: {
          serviceWorkId,
          followUpWorkId: followUpWork.id,
          round: String(round),
        },
        ...(policyKey !== undefined ? { policyKey } : {}),
        idempotencyKey: key,
        ...(priorRound !== undefined ? { retryOfInteractionId: priorRound.id } : {}),
      });
      // Durable dispatch: concurrent follow-up workers converge on ONE
      // provider contact (the claim CAS + the keyed intent identity).
      const { interaction: chase } = await interactions.dispatchInteraction(principal, tenantId, chaseIntent.id);

      return { followUpWork, followUpAttempt, chase, missing, round };
    },

    async escalateException(principal, raw): Promise<EscalationResult> {
      if (typeof raw !== 'object' || raw === null) {
        throw new ConstructionError('INVALID_INPUT', 'the escalate input must be an object');
      }
      const tenantId = validateUuid(raw.tenantId, 'tenantId');
      const serviceWorkId = validateUuid(raw.serviceWorkId, 'serviceWorkId');
      if (typeof raw.reason !== 'string' || raw.reason.trim() === '' || raw.reason.length > 2000) {
        throw new ConstructionError('INVALID_INPUT', 'reason must be a non-empty string of at most 2000 characters');
      }
      const policyKey = raw.policyKey === undefined ? 'construction.exception' : validateKey(raw.policyKey, 'policyKey');
      const key = raw.idempotencyKey === undefined ? `construction.escalate:${serviceWorkId}` : validateKey(raw.idempotencyKey, 'idempotencyKey');

      const current = await work.getWork(principal, tenantId, serviceWorkId);
      requireNonTerminal(current, 'exception escalation');

      // 1. Route the work toward waiting_approval through the ONE
      //    authority (resume/rework first when needed).
      if (current.status === 'waiting_information' || current.status === 'blocked') {
        await transition(principal, tenantId, serviceWorkId, 'in_progress', `${key}:t-resume`, 'escalation requested');
      } else if (current.status === 'verifying') {
        await transition(principal, tenantId, serviceWorkId, 'in_progress', `${key}:t-rework`, 'escalation requested');
      }
      await transition(principal, tenantId, serviceWorkId, 'waiting_approval', `${key}:t-waiting-approval`, `exception: ${raw.reason}`);

      // 2. The governed escalation work (one identity per compliance work).
      const { work: escalationWorkDraft } = await work.createWork(principal, {
        tenantId,
        workType: 'construction.escalate_exception',
        title: `Escalation: ${raw.reason.slice(0, 180)}`,
        idempotencyKey: `construction.escalation-work:${serviceWorkId}`,
      });
      await startWork(principal, tenantId, escalationWorkDraft.id, `construction.escalation-work:${serviceWorkId}`);
      const escalationWork = await work.getWork(principal, tenantId, escalationWorkDraft.id);

      // 3. The explicit human approval request (policy-gated; deny fails
      //    closed and the request is never created).
      let missing: readonly string[] = [];
      try {
        const verification = await evidence.getLatestOutcomeVerification(principal, tenantId, serviceWorkId, CONSTRUCTION_COMPLIANCE_OUTCOME_ID);
        missing = verification.requirementResults.filter((result) => !result.satisfied).map((result) => result.requirement);
      } catch {
        // No decision yet: the escalation subject carries the reason only.
      }
      const { request: approvalRequest } = await approvals.requestApproval(principal, {
        tenantId,
        serviceWorkId,
        policyKey,
        subject: { reason: raw.reason, missing },
        idempotencyKey: `construction.approval:${serviceWorkId}`,
      });

      const finalWork = await work.getWork(principal, tenantId, serviceWorkId);
      return { escalationWork, approvalRequest, serviceWork: finalWork };
    },

    async applyExceptionDecision(principal, raw): Promise<AppliedDecisionResult> {
      if (typeof raw !== 'object' || raw === null) {
        throw new ConstructionError('INVALID_INPUT', 'the apply-decision input must be an object');
      }
      const tenantId = validateUuid(raw.tenantId, 'tenantId');
      const serviceWorkId = validateUuid(raw.serviceWorkId, 'serviceWorkId');
      const key = raw.idempotencyKey === undefined ? `construction.escalation-apply:${serviceWorkId}` : validateKey(raw.idempotencyKey, 'idempotencyKey');

      // 1. The EXPLICIT human decision (the approvals authority
      //    terminalized it; this flow only consumes it).
      const requests = await approvals.listApprovalRequests(principal, tenantId, { serviceWorkId });
      if (requests.length === 0) {
        throw new ConstructionError('ESCALATION_DECISION_NOT_FOUND', `service work ${serviceWorkId} carries no approval request`);
      }
      const request = requests[requests.length - 1] as ApprovalRequestRecord;
      let decision: ApprovalDecisionRecord;
      try {
        decision = await approvals.getTerminalApprovalDecision(principal, tenantId, request.id);
      } catch (error) {
        if ((error as { code?: string }).code === 'APPROVAL_DECISION_NOT_FOUND') {
          throw new ConstructionError('ESCALATION_NOT_DECIDED', `approval request ${request.id} is still pending; only a terminal human decision applies`);
        }
        throw error;
      }

      // 2. The lifecycle consequence — through the ONE authority only.
      const current = await work.getWork(principal, tenantId, serviceWorkId);
      if (!TERMINAL.includes(current.status)) {
        if (current.status === 'waiting_approval') {
          if (decision.decision === 'approve') {
            await transition(principal, tenantId, serviceWorkId, 'in_progress', `${key}:t-resume-approved`, 'exception approved by human decision');
          } else {
            await transition(principal, tenantId, serviceWorkId, 'failed', `${key}:t-failed`, 'exception rejected by human decision');
          }
        }
      }

      const finalWork = await work.getWork(principal, tenantId, serviceWorkId);
      return { decision, serviceWork: finalWork };
    },

    async requestDocumentReasoning(principal, raw): Promise<ReasoningRequestResult> {
      if (typeof raw !== 'object' || raw === null) {
        throw new ConstructionError('INVALID_INPUT', 'the reasoning-request input must be an object');
      }
      const tenantId = validateUuid(raw.tenantId, 'tenantId');
      const serviceWorkId = validateUuid(raw.serviceWorkId, 'serviceWorkId');
      if (raw.kind !== 'insurance_certificate') {
        throw new ConstructionError('INVALID_INPUT', 'kind must be "insurance_certificate" (the only reasoning-backed document class in v1)');
      }
      const key = raw.idempotencyKey === undefined ? `construction.reasoning:${serviceWorkId}` : validateKey(raw.idempotencyKey, 'idempotencyKey');

      // The document evidence must exist (reasoning extracts facts FROM a
      // submitted document; it never fabricates one).
      const documentEvidence = await latestEvidence(principal, tenantId, serviceWorkId, 'construction.insurance_certificate');
      if (documentEvidence === null) {
        throw new ConstructionError('REASONING_NOT_SUBMITTED', `work ${serviceWorkId} carries no insurance-certificate evidence to reason over`);
      }

      // A real, submittable work attempt carries the execution correlation
      // (replay-reused: duplicate requests converge on the SAME attempt +
      // intent identity, never a superseding attempt).
      const engagement = await resolveEngagement(principal, tenantId, serviceWorkId);
      const attempt = await keyedAttempt(principal, tenantId, serviceWorkId, `${key}:attempt`);

      // The package-DECLARED capability requirement (consumed from
      // /verticals, never re-declared; no model/provider selection —
      // Zeck decides how to satisfy it).
      const requirement = await documentReasoningRequirement(principal, tenantId, engagement.packageVersion);

      const { intent, dispatched } = await zeck.submitExecutionIntent(principal, {
        tenantId,
        serviceWorkId,
        workAttemptId: attempt.id,
        objective: 'Extract the structured insurance-certificate compliance facts (per-occurrence limit, umbrella aggregate limit, expiry, additional insured, certificate holder) from the submitted certificate document.',
        inputArtifactRefs: [documentEvidence.id],
        businessContext: { serviceWorkId, kind: 'insurance_certificate', project: entityString(engagement.project, 'name') },
        requiredCapabilities: [requirement],
        businessConstraints: { privacy: 'process the submitted certificate facts only; no other tenant data' },
        outputContract: {
          schemaRef: 'construction/insurance-certificate-facts/v1',
          description: 'The structured insurance-certificate fact record',
        },
        idempotencyKey: `${key}:zeck-intent`,
      });
      return { intent, dispatched };
    },

    async recordReasonedDocumentFacts(principal, raw): Promise<ReceivedDocumentResult> {
      if (typeof raw !== 'object' || raw === null) {
        throw new ConstructionError('INVALID_INPUT', 'the reasoned-facts input must be an object');
      }
      const tenantId = validateUuid(raw.tenantId, 'tenantId');
      const serviceWorkId = validateUuid(raw.serviceWorkId, 'serviceWorkId');
      const kind = validateDocumentKind(raw.kind);
      const key = validateKey(raw.idempotencyKey, 'idempotencyKey');
      if (typeof raw.facts !== 'object' || raw.facts === null || Array.isArray(raw.facts)) {
        throw new ConstructionError('INVALID_INPUT', 'facts must be an object of extracted document facts');
      }
      if (!Array.isArray(raw.provenanceRefs) || raw.provenanceRefs.length === 0 || raw.provenanceRefs.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
        throw new ConstructionError('INVALID_INPUT', 'provenanceRefs must be a non-empty array of opaque foreign-execution references');
      }
      if (!(raw.observedAt instanceof Date) || !Number.isFinite(raw.observedAt.getTime())) {
        throw new ConstructionError('INVALID_INPUT', 'observedAt must be a finite Date');
      }

      const current = await work.getWork(principal, tenantId, serviceWorkId);
      const engagement = await resolveEngagement(principal, tenantId, serviceWorkId);

      // The extracted facts are recorded as EVIDENCE citing the foreign
      // execution (a claim, never an outcome: the deterministic rules
      // still decide — AC-6).
      let documentInstance: EntityInstanceRecord | null = null;
      const entityType = documentEntityType(kind);
      if (entityType !== null) {
        const { instance } = await entities.createEntityInstance(principal, {
          tenantId,
          packageId: CONSTRUCTION_PACKAGE_ID,
          packageVersion: engagement.packageVersion,
          entityType,
          fields: raw.facts as Record<string, unknown>,
          idempotencyKey: `${key}:document-entity`,
        });
        documentInstance = instance;
      }
      const { evidence: documentEvidence } = await evidence.attachEvidence(principal, {
        tenantId,
        serviceWorkId,
        requirement: documentRequirement(kind),
        provenance: {
          kind: 'external_record',
          source: 'zeck-document-reasoning',
          refs: [...raw.provenanceRefs],
        },
        payload: { ...raw.facts },
        observedAt: raw.observedAt,
        idempotencyKey: `${key}:document-evidence`,
      });
      if (current.status === 'waiting_information') {
        await transition(principal, tenantId, serviceWorkId, 'in_progress', `${key}:t-resume`, 'reasoned document facts recorded');
      }
      const finalWork = await work.getWork(principal, tenantId, serviceWorkId);
      return { documentInstance, evidence: documentEvidence, serviceWork: finalWork };
    },

    async assembleCompliancePackage(principal, raw): Promise<CompliancePackageResult> {
      if (typeof raw !== 'object' || raw === null) {
        throw new ConstructionError('INVALID_INPUT', 'the assemble-package input must be an object');
      }
      const tenantId = validateUuid(raw.tenantId, 'tenantId');
      const serviceWorkId = validateUuid(raw.serviceWorkId, 'serviceWorkId');
      const key = raw.idempotencyKey === undefined ? `construction.package:${serviceWorkId}` : validateKey(raw.idempotencyKey, 'idempotencyKey');

      const current = await work.getWork(principal, tenantId, serviceWorkId);
      const engagement = await resolveEngagement(principal, tenantId, serviceWorkId);

      // 1. The gate: the ServiceOS business verification must be
      //    satisfied AND every executed deterministic rule compliant
      //    (the composed vertical gate — an AI claim alone can never
      //    pass it).
      let verification: OutcomeVerificationRecord;
      try {
        verification = await evidence.getLatestOutcomeVerification(principal, tenantId, serviceWorkId, CONSTRUCTION_COMPLIANCE_OUTCOME_ID);
      } catch (error) {
        if ((error as { code?: string }).code === 'VERIFICATION_NOT_FOUND') {
          throw new ConstructionError(
            'NOT_COMPLIANT',
            `work ${serviceWorkId} carries no compliance verification decision; run evaluateCompliance first`,
          );
        }
        throw error;
      }
      if (verification.verdict !== 'satisfied') {
        const missing = verification.requirementResults.filter((result) => !result.satisfied).map((result) => result.requirement);
        throw new ConstructionError(
          'NOT_COMPLIANT',
          `work ${serviceWorkId} is not verified compliant (missing: ${missing.join(', ') || 'none'})`,
        );
      }
      const rulesCompliant = await allValidationEvidenceCompliant(principal, tenantId, serviceWorkId, evidence);
      if (!rulesCompliant) {
        throw new ConstructionError('NOT_COMPLIANT', `work ${serviceWorkId} carries a noncompliant deterministic rule outcome`);
      }

      // 2. The auditable assembly — every section cited from an
      //    authority ledger (nothing is re-decided here).
      const evidenceRows = await evidence.listEvidence(principal, tenantId, { serviceWorkId });
      const decisions = await evidence.listOutcomeVerifications(principal, tenantId, { serviceWorkId, outcomeId: CONSTRUCTION_COMPLIANCE_OUTCOME_ID });
      const transitions = await workflow.listTransitions(principal, tenantId, serviceWorkId);
      const interactionRows = await interactions.listInteractions(principal, tenantId, {
        correlation: { key: 'serviceWorkId', value: serviceWorkId },
      });
      const intents = await zeck.listExecutionIntents(principal, tenantId, { serviceWorkId });
      const requirements = await entities.listEntityInstances(principal, tenantId, {
        packageId: CONSTRUCTION_PACKAGE_ID,
        packageVersion: engagement.packageVersion,
        entityType: 'ComplianceRequirement',
      });

      const documentRows = evidenceRows.filter((row) => row.requirement !== 'construction.compliance_package');
      const packageCore = {
        vertical: CONSTRUCTION_PACKAGE_ID,
        packageVersion: engagement.packageVersion,
        serviceWorkId,
        workState: current.status,
        project: { id: engagement.project.id, fields: { ...engagement.project.fields } },
        subcontractor: { id: engagement.subcontractor.id, fields: { ...engagement.subcontractor.fields } },
        requirements: requirements
          .filter((instance) => instance.fields.serviceWorkId === serviceWorkId)
          .map((instance) => ({ id: instance.id, kind: instance.fields.kind, contentHash: instance.contentHash })),
        documents: documentRows.map((row) => ({
          id: row.id,
          requirement: row.requirement,
          contentHash: row.contentHash,
          observedAt: row.observedAt.toISOString(),
          provenance: row.provenance,
        })),
        validations: documentRows
          .filter((row) => row.requirement.endsWith('_validation') || row.requirement === 'construction.w9')
          .filter((row) => (row.payload as Record<string, unknown>).compliant !== undefined)
          .map((row) => ({ id: row.id, requirement: row.requirement, compliant: (row.payload as Record<string, unknown>).compliant })),
        verification: {
          id: verification.id,
          verdict: verification.verdict,
          decidedAt: verification.decidedAt.toISOString(),
          requirements: verification.requirementResults.map((result) => ({ requirement: result.requirement, satisfied: result.satisfied })),
        },
        decisions: decisions.map((row) => ({ id: row.id, verdict: row.verdict, decidedAt: row.decidedAt.toISOString() })),
        transitions: transitions.map((row) => ({ id: row.id, from: row.fromState, to: row.toState, ruleId: row.ruleId, at: row.createdAt.toISOString() })),
        interactions: interactionRows.map((row) => ({ id: row.id, capability: row.capability, state: row.state, outcome: row.observation?.outcome ?? null })),
        zeckIntents: intents.map((row) => ({ id: row.id, zeckExecutionId: row.zeckExecutionId, lastSeenEventId: row.lastSeenEventId })),
        assembledAt: now().toISOString(),
      };
      const packageHash = computeCompliancePackageHash(packageCore);
      const packageDocument = { ...packageCore, packageHash };

      // 3. The package record as attributable evidence (the auditable
      //    output — AC-7).
      const { evidence: packageEvidence } = await evidence.attachEvidence(principal, {
        tenantId,
        serviceWorkId,
        requirement: 'construction.compliance_package',
        provenance: {
          kind: 'system_observation',
          source: 'construction.compliance-flow',
          refs: [verification.id, serviceWorkId],
        },
        payload: { packageHash, verificationId: verification.id, verdict: verification.verdict },
        observedAt: now(),
        idempotencyKey: `${key}:package-evidence`,
      });

      return { packageDocument, packageHash, packageEvidence };
    },

    async getComplianceStatus(principal, raw): Promise<ComplianceStatus> {
      if (typeof raw !== 'object' || raw === null) {
        throw new ConstructionError('INVALID_INPUT', 'the status input must be an object');
      }
      const tenantId = validateUuid(raw.tenantId, 'tenantId');
      const serviceWorkId = validateUuid(raw.serviceWorkId, 'serviceWorkId');
      const current = await work.getWork(principal, tenantId, serviceWorkId);
      let verification: OutcomeVerificationRecord | null = null;
      let missing: readonly string[] = [];
      try {
        const latest = await evidence.getLatestOutcomeVerification(principal, tenantId, serviceWorkId, CONSTRUCTION_COMPLIANCE_OUTCOME_ID);
        verification = latest;
        missing = latest.requirementResults.filter((result) => !result.satisfied).map((result) => result.requirement);
      } catch (error) {
        if ((error as { code?: string }).code !== 'VERIFICATION_NOT_FOUND') {
          throw error;
        }
        // No decision yet: a missing read stays distinguishable from an
        // empty result (architecture-lock #30).
      }
      return { serviceWork: current, verification, missing };
    },
  };
}

/**
 * Are the LATEST executed deterministic validation rules on this work
 * compliant? Vendor corrections APPEND (the immutable history is
 * retained); the newest validation outcome per requirement governs —
 * a superseded noncompliant finding can never block a corrected state,
 * and a corrected state can never erase the history.
 */
async function allValidationEvidenceCompliant(
  principal: Principal,
  tenantId: string,
  serviceWorkId: string,
  evidence: EvidenceAuthority,
): Promise<boolean> {
  const rows = await evidence.listEvidence(principal, tenantId, { serviceWorkId });
  const validationRequirements = ['construction.insurance_validation', 'construction.license_validation', 'construction.w9'];
  for (const requirement of validationRequirements) {
    // The LATEST validation-bearing row of this requirement by the
    // record's business observation time (list-position tiebreak) — the
    // W-9 document rows without a compliant flag are inputs, not outcomes.
    const withVerdict = rows.filter(
      (row) => row.requirement === requirement && (row.payload as Record<string, unknown>).compliant !== undefined,
    );
    if (withVerdict.length === 0) continue;
    let latest = withVerdict[0] as EvidenceRecord;
    for (const row of withVerdict) {
      if (row.observedAt.getTime() >= latest.observedAt.getTime()) {
        latest = row;
      }
    }
    if ((latest.payload as Record<string, unknown>).compliant !== true) {
      return false;
    }
  }
  return true;
}
