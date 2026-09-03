/**
 * ServiceOS /entities Construction vertical package content (WORK-010,
 * module internal — exported through the module's public interface).
 *
 * THE Construction v1 vertical package CONTENT (vertical-model.md
 * "Construction v1"): pure DATA shaped exactly like /verticals'
 * registration input — the tenant registers it through /verticals'
 * public `registerVerticalPackage` surface (this module exports the
 * CONTENT, never a registration entry point; the vertical-registration
 * authority stays /verticals and the structural boundary checks pin
 * that).
 *
 * Entities, work types, workflow steps, policy defaults, approval
 * matrix, evidence requirements, integration bindings, Zeck capability
 * requirements and pricing rules follow the frozen vertical-model.md
 * "Construction v1" block:
 *
 *   Entities: Project, Subcontractor, Contract, InsuranceCertificate,
 *             License, ComplianceRequirement
 *   Work:     OnboardSubcontractor, CollectComplianceDocument,
 *             ValidateInsurance, ValidateLicense, ChaseMissingDocument,
 *             EscalateException, AssembleCompliancePackage
 *
 * The deterministic business RULES themselves live in rules.ts (pure
 * code) and are executed by the compliance flow; this file is the
 * DECLARATION content only (the /verticals contract: packages are
 * data; executable vertical logic arrives with the flow surface).
 */
import type { RegisterVerticalPackageInput } from '../verticals/index.js';

/** The canonical Construction vertical package id. */
export const CONSTRUCTION_PACKAGE_ID = 'construction';

/** The construction compliance outcome identity (the business outcome). */
export const CONSTRUCTION_COMPLIANCE_OUTCOME_ID = 'construction.subcontractor_compliance';

/** The construction evidence-requirement vocabulary (frozen in this package version). */
export const CONSTRUCTION_EVIDENCE_REQUIREMENTS = [
  'construction.subcontractor_profile',
  'construction.insurance_certificate',
  'construction.insurance_validation',
  'construction.w9',
  'construction.w9_validation',
  'construction.license',
  'construction.license_validation',
  'construction.compliance_package',
] as const;

/** The construction work-type vocabulary (frozen in this package version). */
export const CONSTRUCTION_WORK_TYPES = [
  'construction.onboard_subcontractor',
  'construction.collect_compliance_document',
  'construction.validate_insurance',
  'construction.validate_license',
  'construction.chase_missing_document',
  'construction.escalate_exception',
  'construction.assemble_compliance_package',
] as const;

/** The construction document kinds the document-collection workflow collects. */
export const CONSTRUCTION_DOCUMENT_KINDS = ['insurance_certificate', 'w9', 'license'] as const;
export type ConstructionDocumentKind = (typeof CONSTRUCTION_DOCUMENT_KINDS)[number];

/**
 * The Construction v1 vertical package content. `tenantId` is filled by
 * the registering caller; every other section is the frozen v1 content.
 */
export function constructionVerticalPackage(tenantId: string): Omit<RegisterVerticalPackageInput, 'idempotencyKey'> {
  return Object.freeze({
    tenantId,
    packageId: CONSTRUCTION_PACKAGE_ID,
    version: 1,
    name: 'Construction',
    description: 'The Construction industry vertical: subcontractor/vendor compliance as the first commercial service.',
    terminology: Object.freeze({
      project: 'A construction project a general contractor manages subcontractor compliance for.',
      subcontractor: 'A vendor engaged to perform work on a project; the compliance subject.',
      insurance_certificate: 'A Certificate of Insurance (COI) evidencing the subcontractor general liability/umbrella coverage.',
      license: 'A jurisdiction contractor license held by the subcontractor.',
      w9: 'The IRS Form W-9 tax-identification document of the subcontractor.',
      compliance_requirement: 'One required compliance document instance for a (project, subcontractor) engagement.',
      follow_up: 'A governed chase of missing or noncompliant compliance evidence.',
      exception_escalation: 'A human business-approval request raised for a compliance exception.',
      compliance_package: 'The auditable assembled compliance record of a subcontractor engagement.',
    }),
    entities: Object.freeze([
      Object.freeze({
        name: 'Project',
        description: 'A construction project carrying its subcontractor compliance requirements.',
        fields: Object.freeze([
          Object.freeze({ name: 'name', type: 'string', required: true }),
          Object.freeze({ name: 'minGlPerOccurrenceUsd', type: 'number', required: true }),
          Object.freeze({ name: 'minUmbrellaAggregateUsd', type: 'number', required: true }),
          Object.freeze({ name: 'expiryLeadDays', type: 'number', required: true }),
          Object.freeze({ name: 'projectNamedAdditionalInsured', type: 'boolean', required: true }),
          Object.freeze({ name: 'requireW9', type: 'boolean', required: true }),
          Object.freeze({ name: 'requireLicense', type: 'boolean', required: true }),
        ]),
      }),
      Object.freeze({
        name: 'Subcontractor',
        description: 'A vendor engaged on a project; the compliance subject.',
        fields: Object.freeze([
          Object.freeze({ name: 'name', type: 'string', required: true }),
          Object.freeze({ name: 'contactEmail', type: 'string', required: true }),
          Object.freeze({ name: 'taxId', type: 'string', required: true }),
          Object.freeze({ name: 'trade', type: 'string', required: true }),
        ]),
      }),
      Object.freeze({
        name: 'Contract',
        description: 'The engagement contract between the project and the subcontractor.',
        fields: Object.freeze([
          Object.freeze({ name: 'reference', type: 'string', required: true }),
          Object.freeze({ name: 'engagedAt', type: 'date', required: true }),
          Object.freeze({ name: 'active', type: 'boolean', required: true }),
        ]),
      }),
      Object.freeze({
        name: 'InsuranceCertificate',
        description: 'A Certificate of Insurance instance submitted by a subcontractor.',
        fields: Object.freeze([
          Object.freeze({ name: 'glPerOccurrenceUsd', type: 'number', required: true }),
          Object.freeze({ name: 'umbrellaAggregateUsd', type: 'number', required: true }),
          Object.freeze({ name: 'expiresAt', type: 'date', required: true }),
          Object.freeze({ name: 'additionalInsured', type: 'string', required: false }),
          Object.freeze({ name: 'certificateHolder', type: 'string', required: true }),
        ]),
      }),
      Object.freeze({
        name: 'License',
        description: 'A jurisdiction contractor license held by a subcontractor.',
        fields: Object.freeze([
          Object.freeze({ name: 'licenseNumber', type: 'string', required: true }),
          Object.freeze({ name: 'jurisdiction', type: 'string', required: true }),
          Object.freeze({ name: 'expiresAt', type: 'date', required: true }),
          Object.freeze({ name: 'active', type: 'boolean', required: true }),
        ]),
      }),
      Object.freeze({
        name: 'ComplianceRequirement',
        description: 'One required compliance document instance for a (project, subcontractor) engagement.',
        fields: Object.freeze([
          Object.freeze({ name: 'kind', type: 'string', required: true }),
          Object.freeze({ name: 'scope', type: 'string', required: true }),
          Object.freeze({ name: 'serviceWorkId', type: 'string', required: true }),
          Object.freeze({ name: 'detail', type: 'string', required: false }),
        ]),
      }),
    ]),
    workTypes: Object.freeze([
      Object.freeze({ name: 'construction.onboard_subcontractor', description: 'Onboard a subcontractor into a project and request compliance documents.', defaultSlaHours: 72 }),
      Object.freeze({ name: 'construction.collect_compliance_document', description: 'Collect one required compliance document from a vendor.', defaultSlaHours: 120 }),
      Object.freeze({ name: 'construction.validate_insurance', description: 'Validate an insurance certificate against the project requirements deterministically.', defaultSlaHours: 48 }),
      Object.freeze({ name: 'construction.validate_license', description: 'Validate a subcontractor license deterministically.', defaultSlaHours: 48 }),
      Object.freeze({ name: 'construction.chase_missing_document', description: 'Chase a vendor for missing or noncompliant compliance evidence (governed follow-up).', defaultSlaHours: 24 }),
      Object.freeze({ name: 'construction.escalate_exception', description: 'Escalate a compliance exception to a human business approval.', defaultSlaHours: 8 }),
      Object.freeze({ name: 'construction.assemble_compliance_package', description: 'Assemble the auditable compliance package of a subcontractor engagement.', defaultSlaHours: 24 }),
    ]),
    workflowSteps: Object.freeze([
      Object.freeze({ step: 'onboard', description: 'Register the subcontractor and the required document set; request collection.', workType: 'construction.onboard_subcontractor', entity: 'Subcontractor' }),
      Object.freeze({ step: 'collect_document', description: 'Receive and record a submitted compliance document.', workType: 'construction.collect_compliance_document', entity: 'ComplianceRequirement' }),
      Object.freeze({ step: 'await_vendor', description: 'Wait for the vendor to submit the requested documents.', entity: 'Subcontractor' }),
      Object.freeze({ step: 'validate_insurance', description: 'Run the deterministic insurance compliance rule (optionally Zeck document reasoning for extraction).', workType: 'construction.validate_insurance', entity: 'InsuranceCertificate' }),
      Object.freeze({ step: 'validate_license', description: 'Run the deterministic license validation rule.', workType: 'construction.validate_license', entity: 'License' }),
      Object.freeze({ step: 'chase', description: 'Send the governed follow-up for missing/noncompliant evidence.', workType: 'construction.chase_missing_document', entity: 'Subcontractor' }),
      Object.freeze({ step: 'escalate_exception', description: 'Raise the human approval request for a compliance exception.', workType: 'construction.escalate_exception' }),
      Object.freeze({ step: 'assemble_package', description: 'Assemble the auditable compliance package.', workType: 'construction.assemble_compliance_package' }),
    ]),
    policyDefaults: Object.freeze([
      Object.freeze({
        policyKey: 'construction.followup',
        parameters: Object.freeze([
          Object.freeze({ name: 'chaseIntervalHours', defaultValue: 24 }),
          Object.freeze({ name: 'maxChaseRounds', defaultValue: 3 }),
        ]),
      }),
      Object.freeze({
        policyKey: 'construction.exception',
        parameters: Object.freeze([Object.freeze({ name: 'escalateAfterRounds', defaultValue: 3 })]),
      }),
    ]),
    approvalMatrix: Object.freeze([
      Object.freeze({
        id: 'construction.exception-approval',
        workType: 'construction.escalate_exception',
        role: 'member',
        threshold: 1,
      }),
    ]),
    evidenceRequirements: Object.freeze([
      Object.freeze({ name: 'construction.subcontractor_profile', description: 'The subcontractor entity profile backing the engagement.' }),
      Object.freeze({ name: 'construction.insurance_certificate', description: 'The submitted insurance-certificate facts.' }),
      Object.freeze({ name: 'construction.insurance_validation', description: 'The deterministic insurance-compliance rule outcome.' }),
      Object.freeze({ name: 'construction.w9', description: 'The submitted W-9 tax-identification facts.' }),
      Object.freeze({ name: 'construction.w9_validation', description: 'The deterministic W-9 identity-match rule outcome.' }),
      Object.freeze({ name: 'construction.license', description: 'The submitted contractor-license facts.' }),
      Object.freeze({ name: 'construction.license_validation', description: 'The deterministic license-validation rule outcome.' }),
      Object.freeze({ name: 'construction.compliance_package', description: 'The assembled compliance package record.' }),
    ]),
    integrationBindings: Object.freeze([
      Object.freeze({ capabilityClass: 'email', description: 'Vendor document requests, follow-ups and escalation notifications.' }),
    ]),
    zeckCapabilityRequirements: Object.freeze([
      Object.freeze({
        capability: 'document.reasoning',
        description: 'Extract structured compliance facts from unstructured insurance-certificate documents.',
        minQuality: 0.9,
      }),
    ]),
    pricingRules: Object.freeze([
      Object.freeze({
        id: 'construction.onboarding-per-subcontractor',
        description: 'Billed per onboarded subcontractor compliance engagement.',
        model: 'per_work_item',
        amount: '75.00',
        currency: 'USD',
      }),
      Object.freeze({
        id: 'construction.compliant-outcome',
        description: 'Billed per verified-compliant subcontractor engagement.',
        model: 'per_outcome',
        amount: '150.00',
        currency: 'USD',
      }),
    ]),
  });
}
