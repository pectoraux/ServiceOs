/**
 * ServiceOS /zeck contract-conformant test double (WORK-005, module
 * internal — exported through the module's public interface).
 *
 * The Zeck gateway double pins the ONE PORT's contract semantics
 * (contract.ts; zeck-integration-contract.md §5/§7) so every proof can
 * exercise the boundary end to end without a real Zeck deployment
 * (this Work Order ships none, and AI provider credentials never enter
 * ServiceOS — AC-4):
 *
 * - IDENTITY-IDEMPOTENT DISPATCH: two submissions carrying the same
 *   deterministic intent identity converge on ONE execution reference
 *   (the same `zeckExecutionId`) — the property AC-6 and the crash
 *   recovery of the attach protocol depend on. A conformant real
 *   gateway exhibits the same convergence under Zeck's idempotency
 *   contract.
 * - HONEST FAILURES: `unavailable` mode throws on every submission —
 *   the boundary surfaces ZECK_GATEWAY_ERROR and NEVER fabricates an
 *   acceptance (contract §7: truthful unavailability).
 * - MISBEHAVIOR IS OBSERVABLE: `divergentAcceptances` mode returns a
 *   DIFFERENT execution reference per call for the same intent — the
 *   attach critical section must fail the racing loser closed
 *   (REFERENCE_CONFLICT). A conformant gateway never does this; the
 *   double proves the boundary does not trust the foreign system's
 *   idempotency blindly.
 * - NO CREDENTIALS, NO SELECTION: the double accepts no provider,
 *   model or credential configuration of any kind.
 */
import { randomUUID } from 'node:crypto';
import { ZeckError } from './errors.js';
import type { ZeckExecutionAcceptance, ZeckExecutionRequest, ZeckGateway } from './contract.js';

export interface ZeckGatewayDoubleOptions {
  /** Every submission throws (honest unavailability; default false). */
  readonly unavailable?: boolean;
  /**
   * Each submission of the same intent returns a DIFFERENT execution
   * reference (misbehaving foreign system; default false). The boundary
   * must fail the attach closed instead of converging.
   */
  readonly divergentAcceptances?: boolean;
  /** Deterministic execution-reference prefix (observability in proofs). */
  readonly executionPrefix?: string;
}

/** One recorded gateway submission (the double's observability log). */
export interface RecordedZeckSubmission {
  readonly request: ZeckExecutionRequest;
  readonly acceptance: ZeckExecutionAcceptance | null;
  readonly failure: string | null;
}

export interface ZeckGatewayDouble extends ZeckGateway {
  /** Every submission attempt, in order (acceptance null on failure). */
  readonly submissions: readonly RecordedZeckSubmission[];
  /** How many submissions of one intent identity were accepted. */
  submissionCount(intentId: string): number;
}

export function createInMemoryZeckGateway(options: ZeckGatewayDoubleOptions = {}): ZeckGatewayDouble {
  const submissions: RecordedZeckSubmission[] = [];
  // The foreign-side execution identity per logical intent: one entry
  // per deterministic intent identity (the idempotency contract).
  const executionsByIntent = new Map<string, ZeckExecutionAcceptance>();
  let divergenceCounter = 0;
  return {
    connectionName: 'zeck-double',
    get submissions() {
      return Object.freeze([...submissions]);
    },
    submissionCount(intentId: string): number {
      return submissions.filter((entry) => entry.request.intentId === intentId).length;
    },
    async submitExecution(request: ZeckExecutionRequest): Promise<ZeckExecutionAcceptance> {
      if (options.unavailable === true) {
        const failure = 'the Zeck gateway double is configured unavailable';
        submissions.push({ request, acceptance: null, failure });
        throw new ZeckError('ZECK_GATEWAY_ERROR', failure);
      }
      let acceptance = executionsByIntent.get(request.intentId);
      if (acceptance === undefined || options.divergentAcceptances === true) {
        divergenceCounter += 1;
        acceptance = {
          zeckExecutionId: `${options.executionPrefix ?? 'zeck-exec'}-${divergenceCounter}`,
          applicationRef: null,
          acceptedAt: new Date(),
        };
        if (options.divergentAcceptances !== true) {
          executionsByIntent.set(request.intentId, acceptance);
        }
      }
      submissions.push({ request, acceptance, failure: null });
      return acceptance;
    },
  };
}

/**
 * A DETERMINISTIC direct acceptance for seeding already-referenced
 * states in proofs (the same shape a real gateway returns). Exposed for
 * test setup only; never used by the module itself.
 */
export function seededAcceptance(zeckExecutionId: string): ZeckExecutionAcceptance {
  return { zeckExecutionId, applicationRef: null, acceptedAt: new Date() };
}

/** Fresh opaque event/correlation identities for proofs. */
export function freshZeckEventId(): string {
  return `zeck-event-${randomUUID()}`;
}
