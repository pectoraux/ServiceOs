/**
 * ServiceOS /entities deterministic construction business rules
 * (WORK-010, module internal — exported through the module's public
 * interface).
 *
 * THE DETERMINISTIC DOMAIN RULES of the Construction Subcontractor
 * Compliance service (architecture.md §2.7 "Deterministic computation
 * is first-class" + §12 "vendor coverage meets project requirement";
 * authority matrix: "deterministic domain rule" stays in ServiceOS).
 *
 * PURE: no IO, no clock, no randomness — the decision instant is an
 * INPUT (`asOf`), so the same facts + the same instant always produce
 * the same verdict. These rules are the ServiceOS business verification
 * INPUT; a Zeck execution may EXTRACT the facts from unstructured
 * documents (document reasoning), but the compliance verdict here is
 * computed deterministically from the recorded facts — never from an
 * AI claim (Work Order invariant 4 / AC-6).
 */
import { ConstructionError } from './errors.js';

// ---------------------------------------------------------------------------
// Insurance certificate validation (AC-3)
// ---------------------------------------------------------------------------

/** The project-side insurance requirement (from the Project entity). */
export interface InsuranceRequirement {
  /** Minimum commercial general liability per-occurrence limit (USD). */
  readonly minGlPerOccurrenceUsd: number;
  /** Minimum umbrella/excess aggregate limit (USD). */
  readonly minUmbrellaAggregateUsd: number;
  /** The certificate must remain valid at least this many days beyond `asOf`. */
  readonly expiryLeadDays: number;
  /** The project must be named as additional insured on the certificate. */
  readonly projectNamedAdditionalInsured: boolean;
  /** The project's exact name (additional-insured matching). */
  readonly projectName: string;
}

/** The certificate facts (from the InsuranceCertificate entity / evidence payload). */
export interface InsuranceCertificateFacts {
  readonly glPerOccurrenceUsd: number;
  readonly umbrellaAggregateUsd: number;
  /** ISO-8601 expiry instant. */
  readonly expiresAt: string;
  readonly additionalInsured: string | null;
  readonly certificateHolder: string;
}

export const INSURANCE_FINDING_CODES = [
  'GL_PER_OCCURRENCE_BELOW_MINIMUM',
  'UMBRELLA_AGGREGATE_BELOW_MINIMUM',
  'CERTIFICATE_EXPIRED',
  'CERTIFICATE_EXPIRING_WITHIN_LEAD_DAYS',
  'ADDITIONAL_INSURED_MISSING',
  'ADDITIONAL_INSURED_MISMATCH',
] as const;

export type InsuranceFindingCode = (typeof INSURANCE_FINDING_CODES)[number];

export interface InsuranceFinding {
  readonly code: InsuranceFindingCode | 'COMPLIANT';
  readonly detail: string;
  readonly expected?: number | string;
  readonly actual?: number | string | null;
}

export interface InsuranceValidationResult {
  readonly requirement: 'construction.insurance_validation';
  readonly compliant: boolean;
  readonly findings: readonly InsuranceFinding[];
}

function parseInstant(value: string, what: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ConstructionError('INVALID_INPUT', `${what} must be a parseable ISO-8601 instant`);
  }
  return parsed;
}

function positiveNumber(value: number, what: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ConstructionError('INVALID_INPUT', `${what} must be a non-negative finite number`);
  }
}

/**
 * THE deterministic insurance compliance rule (AC-3): certificate
 * limits meet the project's minimums, the certificate is unexpired
 * with the required lead time, and the project is named as additional
 * insured. One finding per failed check; compliant only when NO
 * finding fires.
 */
export function validateInsuranceCompliance(
  requirement: InsuranceRequirement,
  certificate: InsuranceCertificateFacts,
  asOf: Date,
): InsuranceValidationResult {
  positiveNumber(requirement.minGlPerOccurrenceUsd, 'requirement.minGlPerOccurrenceUsd');
  positiveNumber(requirement.minUmbrellaAggregateUsd, 'requirement.minUmbrellaAggregateUsd');
  positiveNumber(requirement.expiryLeadDays, 'requirement.expiryLeadDays');
  positiveNumber(certificate.glPerOccurrenceUsd, 'certificate.glPerOccurrenceUsd');
  positiveNumber(certificate.umbrellaAggregateUsd, 'certificate.umbrellaAggregateUsd');
  const expiresAt = parseInstant(certificate.expiresAt, 'certificate.expiresAt');

  const findings: InsuranceFinding[] = [];
  if (certificate.glPerOccurrenceUsd < requirement.minGlPerOccurrenceUsd) {
    findings.push({
      code: 'GL_PER_OCCURRENCE_BELOW_MINIMUM',
      detail: 'the certificate per-occurrence limit is below the project minimum',
      expected: requirement.minGlPerOccurrenceUsd,
      actual: certificate.glPerOccurrenceUsd,
    });
  }
  if (certificate.umbrellaAggregateUsd < requirement.minUmbrellaAggregateUsd) {
    findings.push({
      code: 'UMBRELLA_AGGREGATE_BELOW_MINIMUM',
      detail: 'the certificate aggregate limit is below the project minimum',
      expected: requirement.minUmbrellaAggregateUsd,
      actual: certificate.umbrellaAggregateUsd,
    });
  }
  const leadMs = requirement.expiryLeadDays * 24 * 60 * 60 * 1000;
  if (expiresAt.getTime() <= asOf.getTime()) {
    findings.push({
      code: 'CERTIFICATE_EXPIRED',
      detail: 'the certificate expires at or before the decision instant',
      expected: new Date(asOf.getTime() + leadMs).toISOString(),
      actual: certificate.expiresAt,
    });
  } else if (expiresAt.getTime() <= asOf.getTime() + leadMs) {
    findings.push({
      code: 'CERTIFICATE_EXPIRING_WITHIN_LEAD_DAYS',
      detail: `the certificate expires within the project's ${requirement.expiryLeadDays}-day lead window`,
      expected: new Date(asOf.getTime() + leadMs).toISOString(),
      actual: certificate.expiresAt,
    });
  }
  if (requirement.projectNamedAdditionalInsured) {
    if (certificate.additionalInsured === null || certificate.additionalInsured.trim() === '') {
      findings.push({
        code: 'ADDITIONAL_INSURED_MISSING',
        detail: 'the project requires an additional-insured endorsement and the certificate carries none',
        expected: requirement.projectName,
        actual: null,
      });
    } else if (certificate.additionalInsured.trim() !== requirement.projectName.trim()) {
      findings.push({
        code: 'ADDITIONAL_INSURED_MISMATCH',
        detail: 'the additional-insured endorsement names a different party than the project',
        expected: requirement.projectName,
        actual: certificate.additionalInsured,
      });
    }
  }
  if (findings.length === 0) {
    findings.push({ code: 'COMPLIANT', detail: 'the certificate satisfies every project requirement' });
  }
  return {
    requirement: 'construction.insurance_validation',
    compliant: findings.every((finding) => finding.code === 'COMPLIANT'),
    findings: Object.freeze(findings),
  };
}

// ---------------------------------------------------------------------------
// License validation (AC-3)
// ---------------------------------------------------------------------------

export interface LicenseFacts {
  readonly licenseNumber: string;
  readonly jurisdiction: string;
  /** ISO-8601 expiry instant. */
  readonly expiresAt: string;
  readonly active: boolean;
}

export const LICENSE_FINDING_CODES = [
  'LICENSE_INACTIVE',
  'LICENSE_EXPIRED',
] as const;

export type LicenseFindingCode = (typeof LICENSE_FINDING_CODES)[number];

export interface LicenseFinding {
  readonly code: LicenseFindingCode | 'COMPLIANT';
  readonly detail: string;
  readonly expected?: string;
  readonly actual?: string;
}

export interface LicenseValidationResult {
  readonly requirement: 'construction.license_validation';
  readonly compliant: boolean;
  readonly findings: readonly LicenseFinding[];
}

/**
 * THE deterministic license validation rule (AC-3): the license is
 * active and unexpired at the decision instant.
 */
export function validateLicenseCompliance(facts: LicenseFacts, asOf: Date): LicenseValidationResult {
  if (typeof facts.licenseNumber !== 'string' || facts.licenseNumber.trim() === '') {
    throw new ConstructionError('INVALID_INPUT', 'licenseNumber must be a non-empty string');
  }
  if (typeof facts.jurisdiction !== 'string' || facts.jurisdiction.trim() === '') {
    throw new ConstructionError('INVALID_INPUT', 'jurisdiction must be a non-empty string');
  }
  if (typeof facts.active !== 'boolean') {
    throw new ConstructionError('INVALID_INPUT', 'active must be a boolean');
  }
  const expiresAt = parseInstant(facts.expiresAt, 'license.expiresAt');
  const findings: LicenseFinding[] = [];
  if (!facts.active) {
    findings.push({ code: 'LICENSE_INACTIVE', detail: 'the license is not active in its jurisdiction' });
  }
  if (expiresAt.getTime() <= asOf.getTime()) {
    findings.push({
      code: 'LICENSE_EXPIRED',
      detail: 'the license expires at or before the decision instant',
      actual: facts.expiresAt,
    });
  }
  if (findings.length === 0) {
    findings.push({ code: 'COMPLIANT', detail: 'the license is active and unexpired' });
  }
  return {
    requirement: 'construction.license_validation',
    compliant: findings.every((finding) => finding.code === 'COMPLIANT'),
    findings: Object.freeze(findings),
  };
}

// ---------------------------------------------------------------------------
// W-9 tax-form validation (deterministic identity match)
// ---------------------------------------------------------------------------

export interface W9ValidationResult {
  readonly requirement: 'construction.w9_validation';
  readonly compliant: boolean;
  readonly findings: readonly { code: 'TAX_ID_MISMATCH' | 'COMPLIANT'; detail: string; expected?: string; actual?: string }[];
}

/**
 * THE deterministic W-9 identity rule: the tax id on the submitted W-9
 * matches the subcontractor's recorded tax id.
 */
export function validateW9Compliance(expectedTaxId: string, submittedTaxId: string): W9ValidationResult {
  if (typeof expectedTaxId !== 'string' || expectedTaxId.trim() === '') {
    throw new ConstructionError('INVALID_INPUT', 'expectedTaxId must be a non-empty string');
  }
  if (typeof submittedTaxId !== 'string' || submittedTaxId.trim() === '') {
    throw new ConstructionError('INVALID_INPUT', 'submittedTaxId must be a non-empty string');
  }
  const findings: { code: 'TAX_ID_MISMATCH' | 'COMPLIANT'; detail: string; expected?: string; actual?: string }[] = [];
  if (expectedTaxId.trim() !== submittedTaxId.trim()) {
    findings.push({
      code: 'TAX_ID_MISMATCH',
      detail: 'the tax id on the submitted W-9 does not match the subcontractor record',
      expected: expectedTaxId,
      actual: submittedTaxId,
    });
  } else {
    findings.push({ code: 'COMPLIANT', detail: 'the W-9 tax id matches the subcontractor record' });
  }
  return {
    requirement: 'construction.w9_validation',
    compliant: findings.every((finding) => finding.code === 'COMPLIANT'),
    findings: Object.freeze(findings),
  };
}

// ---------------------------------------------------------------------------
// The compliance outcome contract derivation (AC-6)
// ---------------------------------------------------------------------------

/**
 * The evidence-requirement set the compliance outcome contract depends
 * on, derived from the project's declared requirement profile (the
 * vertical package declares the vocabulary; the project entity
 * specializes which documents are required).
 */
export function complianceEvidenceRequirements(projectRequiresW9: boolean, projectRequiresLicense: boolean): readonly string[] {
  const requirements = ['construction.subcontractor_profile', 'construction.insurance_certificate', 'construction.insurance_validation'];
  if (projectRequiresW9) {
    requirements.push('construction.w9', 'construction.w9_validation');
  }
  if (projectRequiresLicense) {
    requirements.push('construction.license', 'construction.license_validation');
  }
  return Object.freeze(requirements);
}
