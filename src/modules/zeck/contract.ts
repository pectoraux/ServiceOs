/**
 * ServiceOS /zeck provider-neutral port contract (WORK-005, module
 * internal — exported through the module's public interface).
 *
 * THE ONE ZECK PORT (AC-1: "ServiceOS can submit an AI Execution Intent
 * through one provider-neutral Zeck port"; zeck-integration-contract.md
 * §2/§3):
 *
 * - `ZeckGateway` is the single provider-neutral port this module (and
 *   therefore ServiceOS) uses to submit AI Execution Intents to Zeck. It
 *   is INJECTED at composition; the /zeck module never imports a Zeck
 *   SDK, never selects a provider, model, agent, tool or runtime, and
 *   never holds provider credentials (AC-4; architecture.md §11). A
 *   conformant gateway is idempotent by the deterministic intent
 *   identity (zeck-integration-contract.md §5): two submissions of one
 *   logical intent converge on ONE external execution reference.
 * - The REQUEST is the ServiceOS-owned AIExecutionIntent payload:
 *   business identity, objective, business context references, capability
 *   REQUIREMENTS (validated through /verticals' frozen declaration
 *   contract — never model/provider selection), authoritative business
 *   constraints and the requested output contract. It carries NO
 *   model/provider choice anywhere (the shape has no such field and the
 *   frozen validator rejects smuggled selection keys).
 * - The ACCEPTANCE is a foreign execution reference: `zeckExecutionId`
 *   is Zeck's identity, not a ServiceOS execution identity
 *   (zeck-boundary.md). Transport acceptance is NOT execution success
 *   and NOT business success (contract §4: the five facts are distinct).
 *
 * This Work Order ships NO real gateway: the production composition
 * injects none, so the boundary stays CLOSED and submissions fail closed
 * with ZECK_GATEWAY_UNAVAILABLE (no premature external AI requests — the
 * /integrations registry discipline applied to the AI boundary). The
 * contract-conformant test double (doubles.ts) pins gateway semantics
 * for every proof.
 */
import { VerticalsError } from '../verticals/index.js';
import type { ZeckCapabilityRequirement } from '../verticals/index.js';
import { validateZeckCapabilityRequirements } from '../verticals/index.js';
import { ZeckError } from './errors.js';

// ---------------------------------------------------------------------------
// The provider-neutral port (AC-1)
// ---------------------------------------------------------------------------

/**
 * The ServiceOS-owned AI Execution Intent request submitted through the
 * one Zeck port. `idempotencyKey` is the DETERMINISTIC intent identity
 * (the durable intent id): concurrent or retried submissions of one
 * logical intent carry the same key and converge on one external
 * execution reference (zeck-integration-contract.md §5).
 */
export interface ZeckExecutionRequest {
  /** Globally unique ServiceOS identity of the logical intent. */
  readonly intentId: string;
  /** The deterministic idempotency key (always equal to `intentId`). */
  readonly idempotencyKey: string;
  readonly tenantId: string;
  readonly serviceWorkId: string;
  readonly workAttemptId: string;
  /** The business objective of the AI execution. */
  readonly objective: string;
  /** Opaque business-context references the execution consumes. */
  readonly inputArtifactRefs: readonly string[];
  /** Bounded business correlation metadata. */
  readonly businessContext: Readonly<Record<string, string>>;
  /** Capability REQUIREMENTS (never model/provider selection). */
  readonly requiredCapabilities: readonly ZeckCapabilityRequirement[];
  /** Authoritative business constraints Zeck must honor. */
  readonly businessConstraints: Readonly<Record<string, string>>;
  /** The requested result contract. */
  readonly outputContract: ZeckOutputContract;
}

/** The result contract ServiceOS expects from the execution. */
export interface ZeckOutputContract {
  /** Opaque pointer to the output schema ServiceOS expects. */
  readonly schemaRef: string;
  readonly description?: string;
}

/**
 * Zeck's acceptance of one AI Execution Intent. This is a TRANSPORT
 * acceptance, never an execution outcome and never a business outcome
 * (AC-5; zeck-integration-contract.md §4). A conformant gateway MUST
 * throw on failure (honest unavailability); it must never fabricate an
 * acceptance.
 */
export interface ZeckExecutionAcceptance {
  /** Zeck's own execution identity (a foreign-system reference). */
  readonly zeckExecutionId: string;
  /** Zeck's application reference, when it issues one. */
  readonly applicationRef: string | null;
  readonly acceptedAt: Date;
}

/**
 * The one provider-neutral Zeck port. Implementations translate this
 * contract to the real Zeck API; they never leak provider specifics
 * back into this shape and never hold credentials inside ServiceOS
 * domain modules.
 */
export interface ZeckGateway {
  /** Observability identity of the connection (never a selection key). */
  readonly connectionName: string;
  /**
   * Submit one AI Execution Intent. Idempotent by the deterministic
   * intent identity: a retried or concurrently duplicated submission of
   * the same logical intent converges on ONE execution reference
   * (returns the same `zeckExecutionId`). A failure MUST throw.
   */
  submitExecution(request: ZeckExecutionRequest): Promise<ZeckExecutionAcceptance>;
}

// ---------------------------------------------------------------------------
// The translated callback observation contract (AC-5; contract §4/§6)
// ---------------------------------------------------------------------------

/**
 * The closed enumeration of event types the boundary TRANSLATES into
 * ServiceOS-owned observations. Zeck's own event vocabulary is its
 * authority; anything outside this enumeration is rejected with durable
 * evidence (`CALLBACK_UNKNOWN_EVENT_TYPE`) — never silently dropped and
 * never guessed at.
 */
export const ZECK_CALLBACK_EVENT_TYPES: readonly string[] = [
  'execution.completed',
  'execution.failed',
] as const;

export type ZeckCallbackEventType = (typeof ZECK_CALLBACK_EVENT_TYPES)[number];

export function isZeckCallbackEventType(value: string): value is ZeckCallbackEventType {
  return (ZECK_CALLBACK_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * The translated result observation: what ServiceOS durably retains from
 * a Zeck result callback. Everything is an opaque reference or a bound
 * scalar; nothing here is treated as a business outcome (AC-5) and no
 * AI usage/cost breakdown is captured (the AI economic ledger stays
 * external — reported cost arrives as an opaque pointer only).
 */
export interface ZeckResultObservation {
  /** Bounded result summary as reported by Zeck (a claim, not an outcome). */
  readonly summary?: string;
  /** Opaque references to result artifacts. */
  readonly artifactRefs: readonly string[];
  /** Opaque references to Zeck-side evidence. */
  readonly evidenceRefs: readonly string[];
  /** Opaque provenance pointer. */
  readonly provenanceRef?: string;
  /** Warnings reported by Zeck. */
  readonly warnings: readonly string[];
  /** Opaque pointer to the external cost statement (non-authoritative). */
  readonly reportedCostRef?: string;
  /** Latency as reported by Zeck (milliseconds, non-negative). */
  readonly reportedLatencyMs?: number;
}

// ---------------------------------------------------------------------------
// Input validation (fail closed; the module's authority)
// ---------------------------------------------------------------------------

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REF_PATTERN = /^[A-Za-z0-9_./:-]{1,500}$/;
const CONTEXT_KEY_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,200}$/;

const MAX_OBJECTIVE_LENGTH = 5000;
const MAX_ARTIFACT_REFS = 64;
const MAX_CONTEXT_ENTRIES = 16;
const MAX_CONSTRAINT_ENTRIES = 16;
const MAX_CALLBACK_REFS = 64;
const MAX_WARNINGS = 32;
const MAX_SUMMARY_LENGTH = 5000;
const MAX_LATENCY_MS = 1000 * 60 * 60 * 24 * 365;

export interface SubmitExecutionIntentInput {
  readonly tenantId: string;
  readonly serviceWorkId: string;
  readonly workAttemptId: string;
  readonly objective: string;
  readonly inputArtifactRefs: readonly string[];
  readonly businessContext: Readonly<Record<string, string>>;
  /** Capability REQUIREMENTS only — validated by /verticals' frozen contract. */
  readonly requiredCapabilities: readonly unknown[];
  readonly businessConstraints: Readonly<Record<string, string>>;
  readonly outputContract: ZeckOutputContract;
  /** REQUIRED: the durable logical identity of this intent (contract §5). */
  readonly idempotencyKey: string;
}

/** The validated, frozen copy of a submit input. */
export interface ValidatedExecutionIntentInput {
  readonly tenantId: string;
  readonly serviceWorkId: string;
  readonly workAttemptId: string;
  readonly objective: string;
  readonly inputArtifactRefs: readonly string[];
  readonly businessContext: Readonly<Record<string, string>>;
  readonly requiredCapabilities: readonly ZeckCapabilityRequirement[];
  readonly businessConstraints: Readonly<Record<string, string>>;
  readonly outputContract: ZeckOutputContract;
  readonly idempotencyKey: string;
}

function fail(code: 'INVALID_INPUT' | 'AI_SELECTION_FORBIDDEN', message: string): never {
  throw new ZeckError(code, message);
}

function validateUuid(value: string, what: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    fail('INVALID_INPUT', `${what} must be a UUID`);
  }
  return value;
}

function validateRef(value: string, what: string): string {
  if (typeof value !== 'string' || !REF_PATTERN.test(value)) {
    fail('INVALID_INPUT', `${what} must match [A-Za-z0-9_./:-]{1,500}`);
  }
  return value;
}

function validateStringMap(
  value: Readonly<Record<string, string>>,
  what: string,
  maxEntries: number,
): Readonly<Record<string, string>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('INVALID_INPUT', `${what} must be an object`);
  }
  const entries = Object.entries(value);
  if (entries.length > maxEntries) {
    fail('INVALID_INPUT', `${what} must carry at most ${maxEntries} entries`);
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of entries) {
    if (!CONTEXT_KEY_PATTERN.test(key)) {
      fail('INVALID_INPUT', `${what} key "${key}" must match [A-Za-z0-9_.-]{1,64}`);
    }
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 2000) {
      fail('INVALID_INPUT', `${what} entry "${key}" must be a non-empty string of at most 2000 characters`);
    }
    out[key] = entry;
  }
  return Object.freeze(out);
}

function validateOutputContract(value: ZeckOutputContract): ZeckOutputContract {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('INVALID_INPUT', 'outputContract must be an object');
  }
  const raw = value as unknown as Record<string, unknown>;
  if (Object.keys(raw).some((key) => key !== 'schemaRef' && key !== 'description')) {
    fail('INVALID_INPUT', 'outputContract accepts only schemaRef and description');
  }
  if (typeof raw.schemaRef !== 'string') {
    fail('INVALID_INPUT', 'outputContract.schemaRef is required');
  }
  validateRef(raw.schemaRef, 'outputContract.schemaRef');
  if (raw.description !== undefined && (typeof raw.description !== 'string' || raw.description.length > 500)) {
    fail('INVALID_INPUT', 'outputContract.description must be a string of at most 500 characters');
  }
  return Object.freeze({
    schemaRef: raw.schemaRef,
    ...(raw.description !== undefined ? { description: raw.description as string } : {}),
  });
}

/**
 * Validate one submit input end to end. Capability REQUIREMENTS are
 * validated through /verticals' frozen shared contract (selection keys
 * rejected as `AI_SELECTION_FORBIDDEN`); everything else is bounded and
 * shape-checked here. Returns a frozen validated copy.
 */
export function validateExecutionIntentInput(raw: SubmitExecutionIntentInput): ValidatedExecutionIntentInput {
  if (typeof raw !== 'object' || raw === null) {
    fail('INVALID_INPUT', 'the execution-intent input must be an object');
  }
  const tenantId = validateUuid(raw.tenantId, 'tenantId');
  const serviceWorkId = validateUuid(raw.serviceWorkId, 'serviceWorkId');
  const workAttemptId = validateUuid(raw.workAttemptId, 'workAttemptId');
  if (typeof raw.objective !== 'string' || raw.objective.trim() === '' || raw.objective.length > MAX_OBJECTIVE_LENGTH) {
    fail('INVALID_INPUT', `objective must be a non-empty string of at most ${MAX_OBJECTIVE_LENGTH} characters`);
  }
  if (!Array.isArray(raw.inputArtifactRefs)) {
    fail('INVALID_INPUT', 'inputArtifactRefs must be an array');
  }
  if (raw.inputArtifactRefs.length > MAX_ARTIFACT_REFS) {
    fail('INVALID_INPUT', `inputArtifactRefs accepts at most ${MAX_ARTIFACT_REFS} references`);
  }
  const inputArtifactRefs = Object.freeze(raw.inputArtifactRefs.map((entry) => validateRef(entry as string, 'each inputArtifactRef')));
  if (typeof raw.idempotencyKey !== 'string' || !KEY_PATTERN.test(raw.idempotencyKey)) {
    fail('INVALID_INPUT', 'idempotencyKey must be a non-empty string of at most 200 characters matching [A-Za-z0-9_.:-]');
  }
  if (!Array.isArray(raw.requiredCapabilities)) {
    fail('INVALID_INPUT', 'requiredCapabilities must be an array of capability-requirement declarations');
  }
  // THE shared frozen declaration validator (owned by /verticals' public
  // interface — never re-implemented here). Selection fields fail closed.
  let requiredCapabilities: readonly ZeckCapabilityRequirement[];
  try {
    requiredCapabilities = validateZeckCapabilityRequirements(raw.requiredCapabilities);
  } catch (error) {
    if (error instanceof VerticalsError && error.code === 'AI_SELECTION_FORBIDDEN') {
      throw new ZeckError(
        'AI_SELECTION_FORBIDDEN',
        error.message,
      );
    }
    throw new ZeckError('INVALID_INPUT', (error as Error).message);
  }
  const outputContract = validateOutputContract(raw.outputContract);
  return Object.freeze({
    tenantId,
    serviceWorkId,
    workAttemptId,
    objective: raw.objective.trim(),
    inputArtifactRefs,
    businessContext: validateStringMap(raw.businessContext, 'businessContext', MAX_CONTEXT_ENTRIES),
    requiredCapabilities,
    businessConstraints: validateStringMap(raw.businessConstraints, 'businessConstraints', MAX_CONSTRAINT_ENTRIES),
    outputContract,
    idempotencyKey: raw.idempotencyKey,
  });
}

/**
 * Validate the TRANSLATED result observation of a callback. Returns a
 * frozen validated copy, or null when the payload does not conform
 * (the delivery is then rejected with durable evidence —
 * `CALLBACK_INVALID_PAYLOAD`). The raw payload is retained in the
 * delivery content hash either way (durable evidence of what arrived).
 */
export function validateResultObservation(raw: unknown): ZeckResultObservation | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const candidate = raw as Record<string, unknown>;
  const allowed = new Set(['summary', 'artifactRefs', 'evidenceRefs', 'provenanceRef', 'warnings', 'reportedCostRef', 'reportedLatencyMs']);
  if (Object.keys(candidate).some((key) => !allowed.has(key))) {
    return null;
  }
  if (candidate.summary !== undefined && (typeof candidate.summary !== 'string' || candidate.summary.length > MAX_SUMMARY_LENGTH)) {
    return null;
  }
  for (const field of ['artifactRefs', 'evidenceRefs', 'warnings'] as const) {
    if (candidate[field] !== undefined && !Array.isArray(candidate[field])) {
      return null;
    }
    if (Array.isArray(candidate[field]) && (candidate[field] as unknown[]).length > MAX_CALLBACK_REFS) {
      return null;
    }
    if (field === 'warnings') continue;
    if (Array.isArray(candidate[field])) {
      for (const entry of candidate[field] as unknown[]) {
        if (typeof entry !== 'string' || !REF_PATTERN.test(entry)) {
          return null;
        }
      }
    }
  }
  if (candidate.warnings !== undefined) {
    for (const entry of candidate.warnings as unknown[]) {
      if (typeof entry !== 'string' || entry.length > 500) {
        return null;
      }
    }
  }
  if (candidate.provenanceRef !== undefined && (typeof candidate.provenanceRef !== 'string' || !REF_PATTERN.test(candidate.provenanceRef))) {
    return null;
  }
  if (candidate.reportedCostRef !== undefined && (typeof candidate.reportedCostRef !== 'string' || !REF_PATTERN.test(candidate.reportedCostRef))) {
    return null;
  }
  if (candidate.reportedLatencyMs !== undefined) {
    if (typeof candidate.reportedLatencyMs !== 'number' || !Number.isFinite(candidate.reportedLatencyMs) || candidate.reportedLatencyMs < 0 || candidate.reportedLatencyMs > MAX_LATENCY_MS) {
      return null;
    }
  }
  const artifactRefs = (candidate.artifactRefs as string[] | undefined) ?? [];
  const evidenceRefs = (candidate.evidenceRefs as string[] | undefined) ?? [];
  const warnings = (candidate.warnings as string[] | undefined) ?? [];
  return Object.freeze({
    ...(candidate.summary !== undefined ? { summary: candidate.summary as string } : {}),
    artifactRefs: Object.freeze([...artifactRefs]),
    evidenceRefs: Object.freeze([...evidenceRefs]),
    ...(candidate.provenanceRef !== undefined ? { provenanceRef: candidate.provenanceRef as string } : {}),
    warnings: Object.freeze([...warnings]),
    ...(candidate.reportedCostRef !== undefined ? { reportedCostRef: candidate.reportedCostRef as string } : {}),
    ...(candidate.reportedLatencyMs !== undefined ? { reportedLatencyMs: candidate.reportedLatencyMs as number } : {}),
  });
}
