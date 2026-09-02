/**
 * ServiceOS /evidence public contract (WORK-007, module internal —
 * exported through the module's public interface).
 *
 * The frozen domain vocabulary of the ServiceOS business-evidence
 * authority (architecture.md §2.5, §12, §13; architecture-lock #4;
 * WORK-007 activation record):
 *
 * - EVIDENCE PROVENANCE (AC-3; invariant 3): every business evidence
 *   record declares WHERE it came from through a frozen provenance-kind
 *   enumeration (architecture.md §12: deterministic domain data,
 *   external authoritative records, customer approvals, calculations —
 *   plus operator attestation and system observation). The provenance
 *   source and its opaque durable references are preserved verbatim
 *   (architecture-lock #20) and are tamper-evident through the record
 *   integrity hash. NOTHING here evaluates evidence with an AI model
 *   (Work Order forbidden surface; Zeck owns AI execution): an AI
 *   execution observation may be CITED as an opaque provenance
 *   reference, but a foreign execution claim is never itself a
 *   ServiceOS business verdict (AC-2).
 *
 * - BUSINESS OUTCOME CONTRACTS: the verification-relevant subset of the
 *   outcome contract declared by /services (WORK-009): an outcome
 *   identity, a ServiceOS business-verification mode and the evidence
 *   requirement names the outcome depends on. The verification modes
 *   are exactly the business-verification concepts /services declares
 *   ('deterministic' | 'human_approval' | 'external_record'); an AI
 *   execution verification mode fails closed AI_VERIFICATION_FORBIDDEN
 *   exactly like /services' validator (never re-implemented — the same
 *   closed enumeration, the same fail-closed rule).
 *
 * - THE DETERMINISTIC EVIDENCE MAPPING (invariants 4/5/6): one PURE
 *   function maps a contract + the work's attached evidence to a
 *   verdict. A requirement is satisfied iff at least one attached
 *   evidence record of THIS work item carries that requirement name.
 *   Missing evidence can never become an unearned successful outcome
 *   (the verdict is 'not_satisfied' with the missing requirements
 *   listed); evidence belonging to another Work item never counts (the
 *   evaluation scope is the work's own evidence, structurally).
 */
import { EvidenceError } from './errors.js';
import type { EvidenceRecord } from './store.js';

// ---------------------------------------------------------------------------
// Frozen enumerations
// ---------------------------------------------------------------------------

/**
 * The provenance kinds of ServiceOS business evidence (architecture.md
 * §12: what ServiceOS may verify outcomes with). Frozen enumeration;
 * extending it is an architecture-level decision.
 */
export const EVIDENCE_PROVENANCE_KINDS: readonly string[] = [
  'operator_attestation',
  'system_observation',
  'external_record',
  'customer_approval',
  'calculation',
];

export type EvidenceProvenanceKind =
  | 'operator_attestation'
  | 'system_observation'
  | 'external_record'
  | 'customer_approval'
  | 'calculation';

export function isEvidenceProvenanceKind(value: string): value is EvidenceProvenanceKind {
  return EVIDENCE_PROVENANCE_KINDS.includes(value);
}

/**
 * The ServiceOS business-verification modes (exactly /services' frozen
 * outcome-contract enumeration). AI execution verification is Zeck's
 * authority and has NO mode here (fail-closed).
 */
export const OUTCOME_VERIFICATION_MODES: readonly string[] = ['deterministic', 'human_approval', 'external_record'];

export type OutcomeVerificationMode = 'deterministic' | 'human_approval' | 'external_record';

export function isOutcomeVerificationMode(value: string): value is OutcomeVerificationMode {
  return OUTCOME_VERIFICATION_MODES.includes(value);
}

/** The verdict of one business outcome verification. */
export type OutcomeVerdict = 'satisfied' | 'not_satisfied';

/** Keys a business outcome contract may never carry (mirrors /services). */
const FORBIDDEN_CONTRACT_KEYS: readonly string[] = ['aiVerification', 'model', 'provider'];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENTIFIER_PATTERN = /^[a-zA-Z][a-zA-Z0-9_.-]{0,199}$/;
const KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,200}$/;
const REF_PATTERN = /^[A-Za-z0-9_./:@#-]{1,200}$/;

const MAX_REQUIREMENTS = 200;
const MAX_PROVENANCE_REFS = 100;

// ---------------------------------------------------------------------------
// Public input shapes
// ---------------------------------------------------------------------------

/** The evidence provenance: where the business evidence came from. */
export interface EvidenceProvenance {
  /**
   * The frozen provenance kind. `operator_attestation`: a human
   * operator recorded the fact; `system_observation`: a ServiceOS
   * authority observed it durably; `external_record`: an external
   * authoritative record was consulted; `customer_approval`: the
   * customer approved through a business approval surface;
   * `calculation`: a deterministic calculation over recorded inputs.
   */
  readonly kind: EvidenceProvenanceKind;
  /** Who or what produced it (operator id, system component, external system name). */
  readonly source: string;
  /**
   * Opaque durable references backing the evidence (foreign record ids,
   * observation/event identities, artifact references). Preserved
   * verbatim; never dereferenced by this module.
   */
  readonly refs: readonly string[];
}

/** The public attach input: one attributable business evidence record. */
export interface AttachEvidenceInput {
  readonly tenantId: string;
  readonly serviceWorkId: string;
  /** Optional attempt attribution (validated to belong to the work when present). */
  readonly workAttemptId?: string;
  /** The business evidence class this record satisfies (a vertical-declared evidence requirement name). */
  readonly requirement: string;
  readonly provenance: EvidenceProvenance;
  /** The evidence content: the recorded business facts (any JSON value). */
  readonly payload: unknown;
  /** When the underlying business fact was observed (provenance time; distinct from the attach time). */
  readonly observedAt: Date;
  /** The durable logical identity of this evidence submission. */
  readonly idempotencyKey: string;
}

/** The validated canonical form (frozen). */
export interface ValidatedAttachEvidenceInput {
  readonly tenantId: string;
  readonly serviceWorkId: string;
  readonly workAttemptId: string | null;
  readonly requirement: string;
  readonly provenance: Readonly<EvidenceProvenance>;
  readonly payload: unknown;
  readonly observedAt: Date;
  readonly idempotencyKey: string;
}

/**
 * The verification-relevant business outcome contract (the subset of
 * /services' declared outcome contract that the deterministic mapping
 * evaluates).
 */
export interface OutcomeContractInput {
  readonly outcomeId: string;
  readonly verification: OutcomeVerificationMode;
  /** The evidence requirement names the outcome depends on (unique, non-empty). */
  readonly evidenceRequirements: readonly string[];
}

export interface ValidatedOutcomeContract {
  readonly outcomeId: string;
  readonly verification: OutcomeVerificationMode;
  readonly evidenceRequirements: readonly string[];
}

/** The public verify input. */
export interface VerifyOutcomeInput {
  readonly tenantId: string;
  readonly serviceWorkId: string;
  readonly contract: OutcomeContractInput;
  readonly idempotencyKey: string;
}

// ---------------------------------------------------------------------------
// Validation (fail closed)
// ---------------------------------------------------------------------------

function fail(code: 'INVALID_INPUT' | 'AI_VERIFICATION_FORBIDDEN', message: string): never {
  throw new EvidenceError(code, message);
}

function validateUuid(value: unknown, what: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    fail('INVALID_INPUT', `${what} must be a UUID`);
  }
  return value;
}

function validateIdentifier(value: unknown, what: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    fail('INVALID_INPUT', `${what} must match the identifier pattern`);
  }
  return value;
}

function validateProvenance(raw: unknown): Readonly<EvidenceProvenance> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail('INVALID_INPUT', 'provenance must be an object');
  }
  const candidate = raw as Partial<EvidenceProvenance>;
  if (typeof candidate.kind !== 'string' || !isEvidenceProvenanceKind(candidate.kind)) {
    fail('INVALID_INPUT', `provenance kind must be one of ${EVIDENCE_PROVENANCE_KINDS.join(', ')}`);
  }
  if (typeof candidate.source !== 'string' || candidate.source.trim() === '' || candidate.source.length > 200) {
    fail('INVALID_INPUT', 'provenance source must be a non-empty string of at most 200 characters');
  }
  if (!Array.isArray(candidate.refs)) {
    fail('INVALID_INPUT', 'provenance refs must be an array');
  }
  if (candidate.refs.length > MAX_PROVENANCE_REFS) {
    fail('INVALID_INPUT', `provenance refs accept at most ${MAX_PROVENANCE_REFS} references`);
  }
  const refs = candidate.refs.map((entry) => {
    if (typeof entry !== 'string' || !REF_PATTERN.test(entry)) {
      fail('INVALID_INPUT', 'each provenance ref must be a non-empty string of at most 200 characters');
    }
    return entry;
  });
  return Object.freeze({ kind: candidate.kind, source: candidate.source.trim(), refs: Object.freeze([...refs]) });
}

/** Validate one attach input into its canonical frozen form. */
export function validateAttachEvidenceInput(raw: AttachEvidenceInput): ValidatedAttachEvidenceInput {
  if (typeof raw !== 'object' || raw === null) {
    fail('INVALID_INPUT', 'the attach-evidence input must be an object');
  }
  const candidate = raw as Partial<AttachEvidenceInput>;
  const tenantId = validateUuid(candidate.tenantId, 'tenantId');
  const serviceWorkId = validateUuid(candidate.serviceWorkId, 'serviceWorkId');
  const workAttemptId =
    candidate.workAttemptId === undefined || candidate.workAttemptId === null
      ? null
      : validateUuid(candidate.workAttemptId, 'workAttemptId');
  const requirement = validateIdentifier(candidate.requirement, 'requirement');
  const provenance = validateProvenance(candidate.provenance);
  if (candidate.payload === undefined) {
    fail('INVALID_INPUT', 'payload is required (the recorded business facts)');
  }
  if (!(candidate.observedAt instanceof Date)) {
    fail('INVALID_INPUT', 'observedAt must be a Date (when the underlying fact was observed)');
  }
  if (typeof candidate.idempotencyKey !== 'string' || !KEY_PATTERN.test(candidate.idempotencyKey)) {
    fail('INVALID_INPUT', 'idempotencyKey must be a non-empty string of at most 200 characters matching [A-Za-z0-9_.:-]');
  }
  return Object.freeze({
    tenantId,
    serviceWorkId,
    workAttemptId,
    requirement,
    provenance,
    payload: candidate.payload,
    observedAt: candidate.observedAt,
    idempotencyKey: candidate.idempotencyKey,
  });
}

/** Validate one business outcome contract (the /services-compatible subset). */
export function validateOutcomeContract(raw: OutcomeContractInput): ValidatedOutcomeContract {
  if (typeof raw !== 'object' || raw === null) {
    fail('INVALID_INPUT', 'the outcome contract must be an object');
  }
  for (const key of Object.keys(raw)) {
    if (FORBIDDEN_CONTRACT_KEYS.includes(key)) {
      fail(
        'AI_VERIFICATION_FORBIDDEN',
        `outcome contract carries forbidden key "${key}"; outcome verification is ServiceOS business authority and AI execution verification is Zeck's`,
      );
    }
  }
  const candidate = raw as Partial<OutcomeContractInput>;
  const outcomeId = validateIdentifier(candidate.outcomeId, 'outcomeId');
  const verification = candidate.verification;
  if (typeof verification !== 'string' || !isOutcomeVerificationMode(verification)) {
    fail(
      'AI_VERIFICATION_FORBIDDEN',
      `outcome contract verification mode "${String(verification)}" is not a ServiceOS business-verification concept; AI execution verification is Zeck's authority`,
    );
  }
  if (!Array.isArray(candidate.evidenceRequirements) || candidate.evidenceRequirements.length === 0) {
    fail('INVALID_INPUT', 'outcome contract evidenceRequirements must be a non-empty array');
  }
  if (candidate.evidenceRequirements.length > MAX_REQUIREMENTS) {
    fail('INVALID_INPUT', `outcome contract must reference at most ${MAX_REQUIREMENTS} evidence requirements`);
  }
  const seen = new Set<string>();
  const evidenceRequirements = candidate.evidenceRequirements.map((name) => {
    const requirement = validateIdentifier(name, 'evidence requirement name');
    if (seen.has(requirement)) {
      fail('INVALID_INPUT', `evidence requirement "${requirement}" is declared twice`);
    }
    seen.add(requirement);
    return requirement;
  });
  return Object.freeze({ outcomeId, verification, evidenceRequirements: Object.freeze([...evidenceRequirements]) });
}

/** Validate one verify input. */
export function validateVerifyOutcomeInput(raw: VerifyOutcomeInput): {
  tenantId: string;
  serviceWorkId: string;
  contract: ValidatedOutcomeContract;
  idempotencyKey: string;
} {
  if (typeof raw !== 'object' || raw === null) {
    fail('INVALID_INPUT', 'the verify-outcome input must be an object');
  }
  const candidate = raw as Partial<VerifyOutcomeInput>;
  const tenantId = validateUuid(candidate.tenantId, 'tenantId');
  const serviceWorkId = validateUuid(candidate.serviceWorkId, 'serviceWorkId');
  if (candidate.contract === undefined || candidate.contract === null) {
    fail('INVALID_INPUT', 'contract is required (the business outcome contract to evaluate)');
  }
  const contract = validateOutcomeContract(candidate.contract);
  if (typeof candidate.idempotencyKey !== 'string' || !KEY_PATTERN.test(candidate.idempotencyKey)) {
    fail('INVALID_INPUT', 'idempotencyKey must be a non-empty string of at most 200 characters matching [A-Za-z0-9_.:-]');
  }
  return Object.freeze({ tenantId, serviceWorkId, contract, idempotencyKey: candidate.idempotencyKey });
}

// ---------------------------------------------------------------------------
// The deterministic evidence mapping (PURE)
// ---------------------------------------------------------------------------

/** One requirement's mapping result: which attached evidence satisfied it. */
export interface RequirementResult {
  readonly requirement: string;
  readonly satisfied: boolean;
  /** The attached evidence records carrying this requirement (attachment order). */
  readonly evidenceIds: readonly string[];
}

/** The pure evaluation of one contract over one work item's evidence. */
export interface OutcomeEvaluation {
  readonly verdict: OutcomeVerdict;
  readonly requirementResults: readonly RequirementResult[];
  /**
   * The exact evidence set the verdict was computed over (identity +
   * content hash per record, attachment order) — the deterministic
   * mapping is reproducible: the same snapshot + the same contract
   * always produce the same verdict.
   */
  readonly evidenceSnapshot: readonly { readonly id: string; readonly contentHash: string }[];
}

/**
 * THE deterministic evidence mapping (AC-1..AC-4; invariants 4/5):
 *
 * A requirement is satisfied iff at least one attached evidence record
 * of THIS work item carries that requirement name. The verdict is
 * 'satisfied' iff every contract requirement is satisfied; otherwise
 * 'not_satisfied' with the missing requirements listed — missing
 * evidence can never become an unearned successful outcome.
 *
 * PURE: no IO, no clock, no randomness. Injected into the store's
 * critical section so the decision is computed over the SERIALIZED,
 * COMMITTED evidence state (the WORK-011 discipline: the authority
 * stays in the module, the atomicity in the store).
 */
export function evaluateOutcomeContract(
  contract: ValidatedOutcomeContract,
  evidence: readonly EvidenceRecord[],
): OutcomeEvaluation {
  const requirementResults: RequirementResult[] = [];
  for (const requirement of contract.evidenceRequirements) {
    const evidenceIds = evidence
      .filter((record) => record.requirement === requirement)
      .map((record) => record.id);
    requirementResults.push({
      requirement,
      satisfied: evidenceIds.length > 0,
      evidenceIds: Object.freeze([...evidenceIds]),
    });
  }
  const verdict: OutcomeVerdict = requirementResults.every((result) => result.satisfied)
    ? 'satisfied'
    : 'not_satisfied';
  return {
    verdict,
    requirementResults: Object.freeze(requirementResults),
    evidenceSnapshot: Object.freeze(
      evidence.map((record) => Object.freeze({ id: record.id, contentHash: record.contentHash })),
    ),
  };
}
