/**
 * ServiceOS module: /zeck (WORK-005 implementation).
 *
 * Thin Zeck integration boundary; no AI implementation (architecture.md
 * §6, §10, §11; architecture-lock #5–#7, #19; zeck-boundary.md;
 * zeck-integration-contract.md).
 *
 * Authority (activation record / Work Order frozen scope):
 * - THE ONE PROVIDER-NEUTRAL ZECK PORT (AC-1): `submitExecutionIntent`
 *   is the single ServiceOS entry point that submits an AI Execution
 *   Intent through the injected `ZeckGateway` port. No model/provider
 *   selection, no Zeck SDK, no AI runtime anywhere (the frozen
 *   capability-requirement validator is consumed from /verticals' public
 *   interface — never re-implemented here).
 * - DURABLE CORRELATION (AC-2): the intent's logical identity is the
 *   (tenant, idempotency key) pair; its correlation identity is the
 *   (tenant, work attempt) pair — validated against /work's public read
 *   (real Service Work/Attempt identities; one intent per attempt).
 *   The foreign execution reference is pinned in ONE serialized
 *   critical section (AC-6: duplicate requests converge on one
 *   reference).
 * - NO SHADOW ZECK LIFECYCLE (AC-3; architecture-lock #19): the durable
 *   surface is the business-side linkage + the translated callback
 *   delivery ledger. No execution state, no result authority, no
 *   lifecycle. The authoritative AI execution record stays in Zeck.
 * - NO CREDENTIALS (AC-4): the module accepts no provider credential
 *   input of any kind; the gateway port carries none (checked
 *   structurally by the WORK-005 boundary checks).
 * - TRANSPORT ≠ BUSINESS SUCCESS (AC-5): a Zeck acceptance is a
 *   transport fact; a translated callback is an OBSERVATION. This
 *   module never mutates Service Work state, never records attempt
 *   outcomes, and never imports /workflow — business verification and
 *   transitions belong to the business authorities (WORK-007 and
 *   /workflow, through their own surfaces).
 * - TRUTHFUL UNAVAILABILITY (contract §7): when no gateway is composed
 *   (the production composition of this Work Order) or the gateway
 *   fails, submissions fail closed with typed errors; the intent stays
 *   durable and unreferenced; nothing fabricates success.
 * - Tenancy is resolved server-side through the ONE authorization chain
 *   exactly like /work, /policies, /workflow, /billing: every operation
 *   authorizes BEFORE any store access; denials never touch domain data.
 */
import type { TransactionalExecutor } from '../../platform/persistence/index.js';
import { defineModule } from '../../platform/module-registry/index.js';
import type { Principal } from '../auth/index.js';
import type { AuthorizationDecision, AuthorizationDenyReason, TenancyAction } from '../organizations/index.js';
import type { WorkAttemptRecord, WorkRecord } from '../work/index.js';
import { WorkError } from '../work/index.js';
import { ZeckError } from './errors.js';
import { createSqlZeckStore } from './sql-store.js';
import {
  ZeckStoreMissingError,
  ZeckStoreRuleError,
  type AttachReferenceInput,
  type CallbackDisposition,
  type CallbackRejectionCode,
  type RecordCallbackEventStoreInput,
  type RegisterIntentStoreInput,
  type ZeckCallbackEventRecord,
  type ZeckIntentRecord,
  type ZeckStore,
} from './store.js';
import {
  computeEventDeliveryHash,
  computeIntentContentHash,
} from './content.js';
import {
  ZECK_CALLBACK_EVENT_TYPES,
  isZeckCallbackEventType,
  validateExecutionIntentInput,
  validateResultObservation,
  type SubmitExecutionIntentInput,
  type ValidatedExecutionIntentInput,
  type ZeckExecutionAcceptance,
  type ZeckExecutionRequest,
  type ZeckGateway,
  type ZeckResultObservation,
} from './contract.js';

// ---------------------------------------------------------------------------
// Public re-exports (the module's public surface)
// ---------------------------------------------------------------------------

// The provider-neutral port contract (AC-1) and the input validation
// surface of the AI Execution Intent.
export {
  ZECK_CALLBACK_EVENT_TYPES,
  isZeckCallbackEventType,
  validateExecutionIntentInput,
  validateResultObservation,
} from './contract.js';
export type {
  SubmitExecutionIntentInput,
  ValidatedExecutionIntentInput,
  ZeckCallbackEventType,
  ZeckExecutionAcceptance,
  ZeckExecutionRequest,
  ZeckGateway,
  ZeckOutputContract,
  ZeckResultObservation,
} from './contract.js';

// The store port contract (persistence, never a second authority).
export { ZeckStoreMissingError, ZeckStoreRuleError, createSqlZeckStore };
export type {
  AttachReferenceInput,
  CallbackDisposition,
  CallbackRejectionCode,
  RecordCallbackEventStoreInput,
  RegisterIntentStoreInput,
  ZeckCallbackEventRecord,
  ZeckIntentRecord,
  ZeckStore,
} from './store.js';

// The content-hashing discipline (canonical serialization is part of
// the convergence contract).
export {
  canonicalJson,
  computeEventDeliveryHash,
  computeIntentContentHash,
  computeIntentRecordHash,
  computeEventRecordHash,
  sha256Canonical,
} from './content.js';

// The typed error surface.
export { ZeckError } from './errors.js';
export type { ZeckErrorCode } from './errors.js';

// Contract-conformant test doubles (no real Zeck gateway ships in this
// Work Order; the production boundary composes none and stays closed).
export { createInMemoryZeckGateway, seededAcceptance, freshZeckEventId } from './doubles.js';
export type { RecordedZeckSubmission, ZeckGatewayDouble, ZeckGatewayDoubleOptions } from './doubles.js';

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
 * The /work public surface /zeck consumes (correlation to REAL Service
 * Work/Attempt identities — read-only; /zeck never mutates work state).
 */
export interface WorkCorrelation {
  getWork(principal: Principal, tenantId: string, workId: string): Promise<WorkRecord>;
  listAttempts(principal: Principal, tenantId: string, workId: string): Promise<WorkAttemptRecord[]>;
}

// ---------------------------------------------------------------------------
// Public inputs and results
// ---------------------------------------------------------------------------

/** The callback delivery envelope as it enters the boundary. */
export interface ZeckCallbackInput {
  /** Zeck's event identity (the replay/dedup identity). */
  readonly eventId: string;
  /** The event type as delivered (validated against the frozen enumeration). */
  readonly eventType: string;
  /** The foreign execution identity the delivery correlates to. */
  readonly zeckExecutionId: string;
  /** When the event occurred on the Zeck side. */
  readonly occurredAt: Date;
  /** The result payload as delivered (validated; the raw form is the durable evidence). */
  readonly payload: unknown;
  /** Optional explicit correlation the delivery carries (must match the intent's). */
  readonly correlation?: { readonly serviceWorkId?: string; readonly workAttemptId?: string };
}

export interface SubmitIntentResult {
  /** The durable intent record (including the reference state). */
  readonly intent: ZeckIntentRecord;
  /** True when the logical intent already existed durably (keyed convergence). */
  readonly intentConverged: boolean;
  /**
   * True when THIS call performed the accepted dispatch that attached
   * the execution reference. False on convergence (the reference was
   * already durable — no second external request was made; contract §5).
   */
  readonly dispatched: boolean;
}

export interface IngestCallbackResult {
  readonly event: ZeckCallbackEventRecord;
  /** True when an identical delivery was already recorded (idempotent replay). */
  readonly converged: boolean;
}

export interface ZeckModuleOptions {
  /** Production wiring: transaction-capable persistence executor. */
  executor?: TransactionalExecutor;
  /** Test seam: inject a faithful in-memory store instead (tests only). */
  store?: ZeckStore;
  /** The single authorization chain, injected by the composition root. */
  tenancy: TenancyAuthorization;
  /** /work's public read contract (correlation validation). */
  work: WorkCorrelation;
  /**
   * The ONE provider-neutral Zeck port (AC-1). Absent in this Work
   * Order's production composition: the boundary stays CLOSED and
   * submissions fail closed with ZECK_GATEWAY_UNAVAILABLE (no
   * premature external AI requests, no credentials in ServiceOS).
   */
  gateway?: ZeckGateway;
  /** Clock injection for deterministic proofs. */
  now?: () => Date;
}

export interface ZeckModule {
  /**
   * Submit one AI Execution Intent through the one provider-neutral
   * Zeck port (AC-1). Durable idempotency first (AC-2/AC-6): the
   * intent is registered/serialized under its key; if a reference is
   * already durable the call converges WITHOUT a second external
   * request; otherwise the gateway dispatch happens outside the store
   * transactions and the reference is attached in ONE serialized
   * critical section. Gateway failures are typed and honest (the
   * intent stays durable and unreferenced; retry re-attempts through
   * the same key).
   */
  submitExecutionIntent(principal: Principal, input: SubmitExecutionIntentInput): Promise<SubmitIntentResult>;
  /** Read one execution intent (tamper-evident: hashes verified on read). */
  getExecutionIntent(principal: Principal, tenantId: string, intentId: string): Promise<ZeckIntentRecord>;
  /** The tenant's intents (registration order, filterable by correlation). */
  listExecutionIntents(
    principal: Principal,
    tenantId: string,
    filter?: { serviceWorkId?: string; workAttemptId?: string },
  ): Promise<ZeckIntentRecord[]>;
  /**
   * THE webhook/callback translation surface (AC-5; contract §6):
   * translate one external delivery into a ServiceOS-owned observation.
   * Accepted events are durable observations; rejected deliveries are
   * durable evidence + typed errors (unknown event type, invalid
   * payload, uncorrelated execution, conflicting correlation). Identical
   * replays converge; divergent replays fail closed. A translated
   * result NEVER completes Service Work (the business authorities
   * decide through their own surfaces).
   */
  ingestCallback(principal: Principal, tenantId: string, input: ZeckCallbackInput): Promise<IngestCallbackResult>;
  /** Read one callback delivery record. */
  getCallbackEvent(principal: Principal, tenantId: string, eventId: string): Promise<ZeckCallbackEventRecord>;
  /** The tenant's delivery ledger (delivery order, filterable). */
  listCallbackEvents(
    principal: Principal,
    tenantId: string,
    filter?: { intentId?: string; disposition?: CallbackDisposition },
  ): Promise<ZeckCallbackEventRecord[]>;
}

// ---------------------------------------------------------------------------
// Validation helpers (fail closed)
// ---------------------------------------------------------------------------

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateUuid(value: string, what: string): void {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new ZeckError('INVALID_INPUT', `${what} must be a UUID`);
  }
}

function validateExternalId(value: string, what: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 200) {
    throw new ZeckError('INVALID_INPUT', `${what} must be a non-empty string of at most 200 characters`);
  }
  return value.trim();
}

/** Map an authorization denial reason to the module's error surface. */
function denyToError(reason: AuthorizationDenyReason | undefined, tenantId: string): ZeckError {
  switch (reason) {
    case 'TENANT_NOT_FOUND':
      return new ZeckError('TENANT_NOT_FOUND', `service tenant ${tenantId} does not exist`);
    case 'TENANT_SUSPENDED':
      return new ZeckError('TENANT_SUSPENDED', `service tenant ${tenantId} is suspended`);
    case 'ORGANIZATION_NOT_FOUND':
      return new ZeckError('TENANT_NOT_FOUND', `the tenant's organization no longer exists`);
    case 'ORGANIZATION_SUSPENDED':
      return new ZeckError('ORGANIZATION_SUSPENDED', 'the owning organization is suspended');
    case 'MEMBERSHIP_FORBIDDEN':
      return new ZeckError('TENANT_FORBIDDEN', 'the principal has no active membership granting this tenant');
    case 'ROLE_FORBIDDEN':
      return new ZeckError('ROLE_FORBIDDEN', 'the principal role does not grant the required capability');
    default:
      return new ZeckError('TENANT_FORBIDDEN', 'authorization denied');
  }
}

/** Map store errors onto the public error surface. */
function mapStoreError(error: unknown): never {
  if (error instanceof ZeckStoreMissingError) {
    throw new ZeckError('INTENT_NOT_FOUND', `execution intent ${error.key} not found`);
  }
  if (error instanceof ZeckStoreRuleError) {
    switch (error.rule) {
      case 'idempotency-input-conflict':
        throw new ZeckError('IDEMPOTENCY_INPUT_CONFLICT', error.message);
      case 'attempt-already-linked':
        throw new ZeckError('ATTEMPT_ALREADY_LINKED', error.message);
      case 'reference-conflict':
        throw new ZeckError('REFERENCE_CONFLICT', error.message);
      case 'event-conflict':
        throw new ZeckError('EVENT_CONFLICT', error.message);
      case 'intent-record-tampered':
        throw new ZeckError('INTENT_RECORD_TAMPERED', error.message);
      case 'event-record-tampered':
        throw new ZeckError('EVENT_RECORD_TAMPERED', error.message);
      default:
        throw new ZeckError('INVALID_INPUT', error.message);
    }
  }
  throw error;
}

// ---------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------

export function createZeckModule(options: ZeckModuleOptions): ZeckModule {
  if ((options.executor === undefined) === (options.store === undefined)) {
    throw new ZeckError('INVALID_INPUT', 'createZeckModule requires exactly one of executor or store');
  }
  const store = options.store ?? createSqlZeckStore(options.executor as TransactionalExecutor);
  const tenancy = options.tenancy;
  const work = options.work;
  const gateway = options.gateway;
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
   * Correlation validation against /work's public read: the Service
   * Work must exist in the tenant, the attempt must belong to it, and
   * the attempt must still be submittable ('pending' or 'dispatched' —
   * the retry window). A completed/failed/superseded attempt can never
   * carry a NEW AI execution (the /work retry protocol creates a new
   * attempt). Read-only: /zeck never mutates work state.
   */
  async function requireSubmittableAttempt(
    principal: Principal,
    tenantId: string,
    serviceWorkId: string,
    workAttemptId: string,
  ): Promise<void> {
    let workRecord: WorkRecord;
    try {
      workRecord = await work.getWork(principal, tenantId, serviceWorkId);
    } catch (error) {
      if (error instanceof WorkError && error.code === 'WORK_NOT_FOUND') {
        throw new ZeckError('WORK_NOT_FOUND', `service work ${serviceWorkId} does not exist in this tenant`);
      }
      throw error;
    }
    void workRecord;
    let attempts: WorkAttemptRecord[];
    try {
      attempts = await work.listAttempts(principal, tenantId, serviceWorkId);
    } catch (error) {
      if (error instanceof WorkError && error.code === 'WORK_NOT_FOUND') {
        throw new ZeckError('WORK_NOT_FOUND', `service work ${serviceWorkId} does not exist in this tenant`);
      }
      throw error;
    }
    const attempt = attempts.find((entry) => entry.id === workAttemptId);
    if (attempt === undefined) {
      throw new ZeckError('ATTEMPT_NOT_FOUND', `work attempt ${workAttemptId} does not belong to service work ${serviceWorkId}`);
    }
    if (attempt.status !== 'pending' && attempt.status !== 'dispatched') {
      throw new ZeckError(
        'ATTEMPT_NOT_SUBMITTABLE',
        `work attempt ${workAttemptId} is "${attempt.status}"; a new logical AI execution targets a pending or dispatched attempt (the /work retry protocol creates a new attempt for retries after observed results)`,
      );
    }
  }

  /** The request submitted to the one Zeck port (AC-1). */
  function gatewayRequestFor(input: ValidatedExecutionIntentInput, intentId: string): ZeckExecutionRequest {
    return {
      intentId,
      // The DETERMINISTIC idempotency key: the durable intent identity
      // (concurrent/retried submissions of one logical intent converge
      // on one external execution reference; contract §5).
      idempotencyKey: intentId,
      tenantId: input.tenantId,
      serviceWorkId: input.serviceWorkId,
      workAttemptId: input.workAttemptId,
      objective: input.objective,
      inputArtifactRefs: input.inputArtifactRefs,
      businessContext: input.businessContext,
      requiredCapabilities: input.requiredCapabilities,
      businessConstraints: input.businessConstraints,
      outputContract: input.outputContract,
    };
  }

  async function submitExecutionIntent(principal: Principal, raw: SubmitExecutionIntentInput): Promise<SubmitIntentResult> {
    const input = validateExecutionIntentInput(raw);
    await requireTenantAccess(principal, input.tenantId, 'write');
    // Correlation to REAL work identities (read-only validation).
    await requireSubmittableAttempt(principal, input.tenantId, input.serviceWorkId, input.workAttemptId);

    const contentHash = computeIntentContentHash({
      tenantId: input.tenantId,
      serviceWorkId: input.serviceWorkId,
      workAttemptId: input.workAttemptId,
      objective: input.objective,
      inputArtifactRefs: input.inputArtifactRefs,
      businessContext: input.businessContext,
      requiredCapabilities: input.requiredCapabilities,
      businessConstraints: input.businessConstraints,
      outputContract: input.outputContract,
      idempotencyKey: input.idempotencyKey,
    });

    // 1. Durable intent registration (the serialized logical identity).
    const storeInput: RegisterIntentStoreInput = {
      tenantId: input.tenantId,
      serviceWorkId: input.serviceWorkId,
      workAttemptId: input.workAttemptId,
      objective: input.objective,
      inputArtifactRefs: input.inputArtifactRefs,
      businessContext: input.businessContext,
      requiredCapabilities: input.requiredCapabilities,
      businessConstraints: input.businessConstraints,
      outputContract: input.outputContract,
      idempotencyKey: input.idempotencyKey,
      contentHash,
      createdBy: principal.id,
      now: now(),
    };
    let registered: { intent: ZeckIntentRecord; converged: boolean };
    try {
      registered = await store.registerIntent(storeInput);
    } catch (error) {
      mapStoreError(error);
    }
    const { intent } = registered;
    const { converged: intentConverged } = registered;

    // 2. Durable-reference convergence check FIRST (contract §5: retries
    //    consult the correlation record before any external request).
    if (intent.zeckExecutionId !== null) {
      return { intent, intentConverged: true, dispatched: false };
    }

    // 3. The boundary must be OPEN to dispatch (AC-4: no credentials; the
    //    closed composition is the truthful unavailable state).
    if (gateway === undefined) {
      throw new ZeckError(
        'ZECK_GATEWAY_UNAVAILABLE',
        'the Zeck execution boundary is closed: no gateway is composed; the intent stays durable and unreferenced until a real gateway is registered by the Work Order that owns Zeck connection configuration',
      );
    }

    // 4. Dispatch through the one port (OUTSIDE the store transactions —
    //    external IO never holds durable locks). Honest failure: typed
    //    error, the intent stays durable and unreferenced; retry
    //    re-attempts through the same deterministic key.
    const request = gatewayRequestFor(input, intent.id);
    let acceptance: ZeckExecutionAcceptance;
    try {
      acceptance = await gateway.submitExecution(request);
    } catch (error) {
      if (error instanceof ZeckError) {
        throw error;
      }
      throw new ZeckError('ZECK_GATEWAY_ERROR', `the Zeck gateway rejected or failed the submission: ${(error as Error).message}`, error);
    }
    const acceptedExecutionId = validateExternalId(acceptance.zeckExecutionId, 'the gateway acceptance zeckExecutionId');
    const applicationRef =
      acceptance.applicationRef === null || acceptance.applicationRef === undefined
        ? null
        : validateExternalId(acceptance.applicationRef, 'the gateway acceptance applicationRef');

    // 5. ONE serialized critical section pins the reference (AC-6:
    //    concurrent/retried attaches converge on one execution identity;
    //    divergent identities fail closed).
    const attachInput: AttachReferenceInput = {
      tenantId: input.tenantId,
      intentId: intent.id,
      zeckExecutionId: acceptedExecutionId,
      applicationRef,
      submittedBy: principal.id,
      now: now(),
    };
    try {
      const attached = await store.attachExecutionReference(attachInput);
      return { intent: attached.intent, intentConverged, dispatched: !attached.converged };
    } catch (error) {
      mapStoreError(error);
    }
  }

  async function getExecutionIntent(principal: Principal, tenantId: string, intentId: string): Promise<ZeckIntentRecord> {
    await requireTenantAccess(principal, tenantId, 'read');
    validateUuid(intentId, 'intentId');
    const intent = await store.findIntent(tenantId, intentId);
    if (intent === null) {
      throw new ZeckError('INTENT_NOT_FOUND', `execution intent ${intentId} not found`);
    }
    return intent;
  }

  async function listExecutionIntents(
    principal: Principal,
    tenantId: string,
    filter?: { serviceWorkId?: string; workAttemptId?: string },
  ): Promise<ZeckIntentRecord[]> {
    await requireTenantAccess(principal, tenantId, 'read');
    if (filter?.serviceWorkId !== undefined) validateUuid(filter.serviceWorkId, 'filter.serviceWorkId');
    if (filter?.workAttemptId !== undefined) validateUuid(filter.workAttemptId, 'filter.workAttemptId');
    return store.listIntents(tenantId, filter);
  }

  async function ingestCallback(principal: Principal, tenantId: string, raw: ZeckCallbackInput): Promise<IngestCallbackResult> {
    await requireTenantAccess(principal, tenantId, 'write');
    if (typeof raw !== 'object' || raw === null) {
      throw new ZeckError('INVALID_INPUT', 'the callback input must be an object');
    }
    const eventId = validateExternalId(raw.eventId, 'eventId');
    const eventType = validateExternalId(raw.eventType, 'eventType');
    const zeckExecutionId = validateExternalId(raw.zeckExecutionId, 'zeckExecutionId');
    if (!(raw.occurredAt instanceof Date)) {
      throw new ZeckError('INVALID_INPUT', 'occurredAt must be a Date');
    }
    let correlation: { serviceWorkId?: string; workAttemptId?: string } | null = null;
    if (raw.correlation !== undefined && raw.correlation !== null) {
      if (typeof raw.correlation !== 'object' || Array.isArray(raw.correlation)) {
        throw new ZeckError('INVALID_INPUT', 'correlation must be an object');
      }
      correlation = {};
      if (raw.correlation.serviceWorkId !== undefined) {
        validateUuid(raw.correlation.serviceWorkId, 'correlation.serviceWorkId');
        correlation.serviceWorkId = raw.correlation.serviceWorkId;
      }
      if (raw.correlation.workAttemptId !== undefined) {
        validateUuid(raw.correlation.workAttemptId, 'correlation.workAttemptId');
        correlation.workAttemptId = raw.correlation.workAttemptId;
      }
    }
    // The DELIVERY hash over the envelope as received: the replay
    // identity (identical re-delivery converges; divergence conflicts).
    const deliveryHash = computeEventDeliveryHash({
      tenantId,
      eventId,
      eventType,
      zeckExecutionId,
      occurredAt: raw.occurredAt,
      rawPayload: raw.payload,
    });
    // Pure validation proposals (the correlation decision happens INSIDE
    // the store's serialized critical section).
    let proposedRejection: CallbackRejectionCode | null = null;
    if (!isZeckCallbackEventType(eventType)) {
      proposedRejection = 'unknown_event_type';
    }
    let observed: ZeckResultObservation | null = null;
    if (proposedRejection === null) {
      observed = validateResultObservation(raw.payload);
      if (observed === null) {
        proposedRejection = 'invalid_payload';
      }
    }
    const storeInput: RecordCallbackEventStoreInput = {
      tenantId,
      eventId,
      eventType,
      zeckExecutionId,
      deliveryHash,
      proposedRejection,
      observed,
      correlation,
      receivedBy: principal.id,
      now: now(),
    };
    let recorded: { event: ZeckCallbackEventRecord; converged: boolean };
    try {
      recorded = await store.recordCallbackEvent(storeInput);
    } catch (error) {
      mapStoreError(error);
    }
    const { event, converged } = recorded;
    // Rejections fail closed with typed errors — the durable record IS
    // the evidence (identical replays converge on the same rejection).
    if (event.disposition === 'rejected') {
      switch (event.rejectionCode) {
        case 'unknown_event_type':
          throw new ZeckError(
            'CALLBACK_UNKNOWN_EVENT_TYPE',
            `callback event ${eventId} carries event type "${eventType}" which the boundary does not translate (frozen enumeration: ${ZECK_CALLBACK_EVENT_TYPES.join(', ')}); the delivery is durably recorded as rejected evidence`,
          );
        case 'invalid_payload':
          throw new ZeckError(
            'CALLBACK_INVALID_PAYLOAD',
            `callback event ${eventId} carries a payload that does not conform to the translated result-observation contract; the delivery is durably recorded as rejected evidence`,
          );
        case 'uncorrelated':
          throw new ZeckError(
            'CALLBACK_UNCORRELATED',
            `callback event ${eventId} correlates to execution reference "${zeckExecutionId}" which no intent of this tenant holds; the delivery is durably recorded as rejected evidence`,
          );
        case 'conflicting_correlation':
          throw new ZeckError(
            'CALLBACK_CONFLICTING_CORRELATION',
            `callback event ${eventId} carries correlation that conflicts with the intent's durable Service Work/Attempt correlation; the delivery is durably recorded as rejected evidence`,
          );
        default:
          throw new ZeckError('INVALID_INPUT', `callback event ${eventId} was rejected`);
      }
    }
    return { event, converged };
  }

  async function getCallbackEvent(principal: Principal, tenantId: string, eventId: string): Promise<ZeckCallbackEventRecord> {
    await requireTenantAccess(principal, tenantId, 'read');
    const normalized = validateExternalId(eventId, 'eventId');
    const event = await store.findCallbackEvent(tenantId, normalized);
    if (event === null) {
      throw new ZeckError('EVENT_NOT_FOUND', `callback event ${normalized} not found`);
    }
    return event;
  }

  async function listCallbackEvents(
    principal: Principal,
    tenantId: string,
    filter?: { intentId?: string; disposition?: CallbackDisposition },
  ): Promise<ZeckCallbackEventRecord[]> {
    await requireTenantAccess(principal, tenantId, 'read');
    if (filter?.intentId !== undefined) validateUuid(filter.intentId, 'filter.intentId');
    return store.listCallbackEvents(tenantId, filter);
  }

  return {
    submitExecutionIntent,
    getExecutionIntent,
    listExecutionIntents,
    ingestCallback,
    getCallbackEvent,
    listCallbackEvents,
  };
}

/**
 * Module manifest (registered in the composition root's module registry).
 * The manifest declares identity only; the contracts above are the
 * module's public surface.
 */
export default defineModule({
  name: 'zeck',
  version: '1.0.0',
  description: 'thin Zeck integration boundary; no AI implementation',
});
