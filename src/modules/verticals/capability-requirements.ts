/**
 * ServiceOS /verticals Zeck capability-requirement declaration contract
 * (WORK-009, module internal — exported through the module's public
 * interface).
 *
 * THE DECLARATION SHAPE OF "REQUIRED ZECK AI CAPABILITIES" (AC-4;
 * architecture.md §15 "required Zeck AI capabilities, where applicable";
 * zeck-integration-contract.md §2 "requiredCapabilities (capability
 * requirements only; never model/provider selection)").
 *
 * - A capability REQUIREMENT is a provider-neutral name plus optional
 *   quality/latency bounds — the exact payload the future AI Execution
 *   Intent carries (zeck-integration-contract.md). Which model, provider,
 *   agent, prompt or runtime satisfies it is Zeck's authority; this module
 *   cannot even express that choice.
 * - THE FORBIDDEN KEYS ARE FROZEN CODE, NOT DATA: any declaration carrying
 *   a model/provider/agent/prompt-selection field is rejected
 *   fail-closed (`AI_SELECTION_FORBIDDEN`). This is the AC-4 structural
 *   boundary: the declaration surface has no field that could hold a
 *   selection, and the validator rejects smuggled keys.
 * - The requirement NAME is opaque to ServiceOS: Zeck owns the capability
 *   taxonomy; ServiceOS owns the business requirement (zeck-boundary.md:
 *   "If it is about how AI computes, routes, reasons, uses tools or
 *   executes, it belongs in Zeck").
 * - This contract is shared by /verticals (package-level requirements) and
 *   /services (service-level requirements, consumed through /verticals'
 *   public interface — /services never reimplements it).
 */
import { VerticalsError } from './errors.js';

/**
 * Fields that would express AI model/provider/agent/prompt selection. The
 * list is frozen code: extending it is an architecture-level decision, not
 * configuration. Any occurrence — at any nesting level of a declaration
 * entry — fails closed.
 */
export const FORBIDDEN_SELECTION_KEYS: readonly string[] = [
  'model',
  'modelId',
  'modelName',
  'modelVersion',
  'provider',
  'providerId',
  'providerName',
  'agent',
  'agentId',
  'agentName',
  'prompt',
  'systemPrompt',
  'promptTemplate',
  'temperature',
  'topP',
  'maxTokens',
  'apiBase',
  'apiKey',
  'endpoint',
  'runtime',
  'sandbox',
  'toolchain',
];

/**
 * The provider-neutral Zeck capability-requirement declaration. A
 * requirement NAMES a business need for an AI capability; it never selects
 * how Zeck satisfies it.
 */
export interface ZeckCapabilityRequirement {
  /** Provider-neutral requirement name (e.g. 'document.reasoning'). Opaque to ServiceOS. */
  readonly capability: string;
  /** Optional lower bound on execution quality (0..1, inclusive). */
  readonly minQuality?: number;
  /** Optional upper bound on execution latency, in milliseconds (positive integer). */
  readonly maxLatencyMs?: number;
  readonly description?: string;
}

/** Maximum declarations one package/service may carry. */
export const MAX_ZECK_REQUIREMENTS = 64;
const MAX_CAPABILITY_NAME_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 500;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate one requirement declaration. Fails closed on: shape, unknown
 * keys (including every forbidden selection key), unbounded strings and
 * out-of-range bounds. Returns a frozen validated copy.
 */
export function validateZeckCapabilityRequirement(raw: unknown): ZeckCapabilityRequirement {
  if (!isPlainObject(raw)) {
    throw new VerticalsError('INVALID_INPUT', 'each Zeck capability requirement must be an object');
  }
  for (const key of Object.keys(raw)) {
    if (FORBIDDEN_SELECTION_KEYS.includes(key)) {
      throw new VerticalsError(
        'AI_SELECTION_FORBIDDEN',
        `Zeck capability requirement carries forbidden selection field "${key}"; ServiceOS declares capability requirements only and model/provider/agent/prompt selection is Zeck's authority (AC-4)`,
      );
    }
  }
  const { capability, minQuality, maxLatencyMs, description } = raw as Record<string, unknown>;
  if (typeof capability !== 'string' || capability.trim() === '' || capability.length > MAX_CAPABILITY_NAME_LENGTH) {
    throw new VerticalsError(
      'INVALID_INPUT',
      `Zeck capability requirement name must be a non-empty string of at most ${MAX_CAPABILITY_NAME_LENGTH} characters`,
    );
  }
  if (description !== undefined && (typeof description !== 'string' || description.length > MAX_DESCRIPTION_LENGTH)) {
    throw new VerticalsError('INVALID_INPUT', 'Zeck capability requirement description must be a string of at most 500 characters');
  }
  if (minQuality !== undefined) {
    if (typeof minQuality !== 'number' || !Number.isFinite(minQuality) || minQuality < 0 || minQuality > 1) {
      throw new VerticalsError('INVALID_INPUT', 'Zeck capability requirement minQuality must be a finite number in [0, 1]');
    }
  }
  if (maxLatencyMs !== undefined) {
    if (typeof maxLatencyMs !== 'number' || !Number.isInteger(maxLatencyMs) || maxLatencyMs <= 0) {
      throw new VerticalsError('INVALID_INPUT', 'Zeck capability requirement maxLatencyMs must be a positive integer');
    }
  }
  const validated: ZeckCapabilityRequirement = {
    capability: capability.trim(),
    ...(minQuality !== undefined ? { minQuality } : {}),
    ...(maxLatencyMs !== undefined ? { maxLatencyMs } : {}),
    ...(description !== undefined ? { description: description as string } : {}),
  };
  return Object.freeze(validated);
}

/**
 * Validate a full declaration list: bounded count, unique capability names
 * (one requirement per capability), every entry shape-valid. Returns a
 * frozen validated copy.
 */
export function validateZeckCapabilityRequirements(raw: readonly unknown[]): readonly ZeckCapabilityRequirement[] {
  if (raw.length > MAX_ZECK_REQUIREMENTS) {
    throw new VerticalsError(
      'INVALID_INPUT',
      `at most ${MAX_ZECK_REQUIREMENTS} Zeck capability requirements may be declared`,
    );
  }
  const seen = new Set<string>();
  const validated: ZeckCapabilityRequirement[] = [];
  for (const entry of raw) {
    const requirement = validateZeckCapabilityRequirement(entry);
    if (seen.has(requirement.capability)) {
      throw new VerticalsError(
        'INVALID_INPUT',
        `Zeck capability requirement "${requirement.capability}" is declared twice; capability names must be unique`,
      );
    }
    seen.add(requirement.capability);
    validated.push(requirement);
  }
  return Object.freeze(validated);
}
