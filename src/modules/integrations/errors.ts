/**
 * ServiceOS /integrations typed error surface (WORK-015, module internal —
 * exported through the module's public interface).
 *
 * The /integrations authority's own failure vocabulary: capability-class
 * and adapter-registry rule violations. Provider-side outcomes NEVER appear
 * here — a provider outcome is an OBSERVED RESULT recorded through
 * /interactions' public contract, never an exception from this module.
 */
export type IntegrationsErrorCode =
  /** A capability value outside the frozen class taxonomy. */
  | 'INVALID_CAPABILITY'
  /** Effect params that fail the class's provider-neutral contract. */
  | 'INVALID_PARAMS'
  /** Registry mutation after composition sealed it. */
  | 'REGISTRY_SEALED'
  /** Two adapters registered for one capability class. */
  | 'DUPLICATE_ADAPTER'
  /** Dispatch for a capability class with no registered adapter. */
  | 'ADAPTER_NOT_REGISTERED';

export class IntegrationsError extends Error {
  constructor(
    readonly code: IntegrationsErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'IntegrationsError';
  }
}
