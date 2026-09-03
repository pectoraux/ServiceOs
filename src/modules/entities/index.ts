/**
 * ServiceOS module: /entities (WORK-010 implementation).
 *
 * The entity-instance authority AND the Construction Subcontractor
 * Compliance service — the first commercial vertical service
 * (architecture.md §16; vertical-model.md "Construction v1"; the
 * WORK-010 activation record).
 *
 * Authority (authority matrix / Work Order frozen scope):
 * - ENTITY INSTANCES ARE OWNED HERE: tenant-bound, immutable,
 *   tamper-evident records of customer/business entities (Project,
 *   Subcontractor, Contract, InsuranceCertificate, License,
 *   ComplianceRequirement), validated against REGISTERED vertical
 *   package declarations consumed through /verticals' public read (a
 *   module other than /entities exporting entity-instance entry
 *   points is an architecture violation — checked structurally).
 * - THE CONSTRUCTION FLOW COMPOSES, NEVER REIMPLEMENTS: the compliance
 *   flow orchestrates Service Work (/work), transitions (/workflow),
 *   evidence and outcome verification (/evidence), vendor interactions
 *   and follow-ups (/interactions), Zeck document reasoning (/zeck —
 *   the sole AI execution authority, consumed through its public
 *   intent surface only) and human exception approvals (/approvals)
 *   through their PUBLIC interfaces. It owns no state machine, no
 *   policy engine, no evidence store, no provider adapter and no AI
 *   surface of its own (Work Order invariant 1: "Construction logic
 *   consumes horizontal authorities and Zeck through public
 *   contracts; it owns no replacement engines").
 * - FINAL COMPLIANCE IS SERVICEOS BUSINESS VERIFICATION (invariant 4 /
 *   AC-6): the composed gate requires BOTH the /evidence deterministic
 *   outcome-verification verdict AND every deterministic vertical rule
 *   outcome; a foreign AI execution result may only CITE provenance on
 *   recorded facts — it can never mark compliance by itself.
 * - AUTOMATED FOLLOW-UP IS DURABLE AND REPLAY-SAFE (invariant 5 /
 *   AC-5): every vendor contact is a keyed /interactions intent
 *   (durable before dispatch, convergent under concurrent workers)
 *   plus a governed chase Service Work — never a bare side effect.
 * - No provider SDKs, no AI model/provider/agent code, no Service Work
 *   lifecycle redefinition (Work Order forbidden surfaces — pinned
 *   structurally by the entities boundary checks).
 */
import { defineModule } from '../../platform/module-registry/index.js';

// The entity-instance authority (module.ts) — the module's core public surface.
export { createEntitiesModule } from './module.js';
export { EntitiesError, createSqlEntitiesStore, EntitiesStoreRuleError, EntitiesStoreMissingError } from './module.js';
export type {
  TenancyAuthorization,
  VerticalPackageReader,
  EntitiesModule,
  EntitiesModuleOptions,
  CreateEntityInstanceInput,
  CreateEntityInstanceStoreInput,
  EntityInstanceFilter,
  EntityInstanceRecord,
  EntitiesStore,
  EntitiesStoreRule,
  EntityFieldValue,
  EntitiesErrorCode,
} from './module.js';
export {
  validateCreateEntityInstanceInput,
  validateCreateEntityInstanceEnvelope,
  validateFieldsAgainstDeclaration,
} from './contract.js';
export type { ValidatedCreateEntityInstanceInput } from './contract.js';

// The content-hashing discipline (canonical serialization is part of
// the convergence contract).
export {
  canonicalJson,
  sha256Canonical,
  computeEntityInstanceContentHash,
  computeEntityInstanceRecordHash,
  computeCompliancePackageHash,
} from './content.js';
export type { EntityInstanceContentCore, HashableEntityInstanceRecord } from './content.js';

// The deterministic construction business rules (PURE — the domain
// authority for insurance/license/W-9 compliance semantics).
export {
  validateInsuranceCompliance,
  validateLicenseCompliance,
  validateW9Compliance,
  complianceEvidenceRequirements,
  INSURANCE_FINDING_CODES,
  LICENSE_FINDING_CODES,
} from './rules.js';
export type {
  InsuranceRequirement,
  InsuranceCertificateFacts,
  InsuranceFinding,
  InsuranceFindingCode,
  InsuranceValidationResult,
  LicenseFacts,
  LicenseFinding,
  LicenseFindingCode,
  LicenseValidationResult,
  W9ValidationResult,
} from './rules.js';

// The Construction vertical package CONTENT (declarative data —
// registered through /verticals' public surface by the operator).
export {
  constructionVerticalPackage,
  CONSTRUCTION_PACKAGE_ID,
  CONSTRUCTION_COMPLIANCE_OUTCOME_ID,
  CONSTRUCTION_EVIDENCE_REQUIREMENTS,
  CONSTRUCTION_WORK_TYPES,
  CONSTRUCTION_DOCUMENT_KINDS,
} from './construction-package.js';
export type { ConstructionDocumentKind } from './construction-package.js';

// The Construction Subcontractor Compliance flow (pure orchestration
// over the horizontal authorities' public interfaces).
export { createConstructionCompliance } from './construction.js';
export { ConstructionError } from './errors.js';
export type { ConstructionErrorCode } from './errors.js';
export type {
  ConstructionComplianceOptions,
  ConstructionComplianceFlow,
  VerticalPackageReader as ConstructionVerticalPackageReader,
  WorkAuthority,
  WorkflowAuthority,
  EvidenceAuthority,
  InteractionsAuthority,
  ZeckAuthority,
  ApprovalsAuthority,
  OnboardSubcontractorInput,
  OnboardingResult,
  ReceiveVendorDocumentInput,
  ReceivedDocumentResult,
  EvaluateComplianceInput,
  ComplianceEvaluationResult,
  ChaseInput,
  ChaseResult,
  EscalateInput,
  EscalationResult,
  ApplyDecisionInput,
  AppliedDecisionResult,
  ReasoningRequestInput,
  ReasoningRequestResult,
  ReasonedFactsInput,
  AssemblePackageInput,
  CompliancePackageResult,
  ComplianceStatus,
} from './construction.js';

/**
 * Module manifest (registered in the composition root's module
 * registry). The manifest declares identity only; the contracts above
 * are the module's public surface.
 */
export default defineModule({
  name: 'entities',
  version: '1.0.0',
  description: 'customer/business entity instances and the construction vertical compliance flow',
});
