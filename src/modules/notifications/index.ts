/**
 * ServiceOS module: /notifications (WORK-015 implementation).
 *
 * ServiceOS notifications and delivery adapters (architecture.md §6;
 * authority matrix: "delivery request/status through owned interface").
 *
 * Authority (authority matrix / Work Order frozen scope):
 * - THE NOTIFICATION REQUEST/STATUS SURFACE is owned here:
 *  `requestNotification` (durable delivery request),
 *  `dispatchNotification` (delivery initiation),
 *  `retryNotification` (explicit, recoverable failure retry) and the
 *  derived status reads. A module other than /notifications exporting
 *  notification entry points is an architecture violation (checked
 *  structurally).
 * - NO SECOND INTERACTION LEDGER (architecture.md §2.11): the external
 *   effect and its observed result belong to /interactions. This module
 *   CONSUMES /interactions' public contract — delivery creates a durable
 *   interaction intent (capability = the channel, params = recipient +
 *   content, correlation preserved), the pointer on the request names the
 *   current interaction, and the delivery status is DERIVED from that
 *   interaction's durable state (never re-recorded here). A provider
 *   success therefore cannot complete Service Work through this module
 *   either (AC-4).
 * - NO PROVIDER SURFACE (AC-6): this module never imports /integrations —
 *   adapters are selected behind /interactions' provider-neutral sink. No
 *   provider SDK, no provider name, no delivery SDK call (structurally
 *   enforced).
 * - FAILURES ARE EXPLICIT AND RECOVERABLE (AC-5): a delivery failure is
 *   the linked interaction's durable observed-failure record (surfaced as
 *   the derived `failed` status and listed through the status surface);
 *   `retryNotification` creates a NEW interaction identity carrying
 *   retryOf lineage — the original failure stays durable and explicit,
 *   and the retry key is caller-supplied so concurrent identical retries
 *   converge on ONE retry interaction (the /interactions keyed
 *   convergence).
 * - NO POLICY/AUTHORIZATION/WORKFLOW ENGINE (forbidden surfaces): the
 *   authorization chain is /organizations' (injected); the policy gate
 *   runs inside /interactions' intent creation (consumed, never
 *   reimplemented); Service Work state is never touched.
 */
import type { TransactionalExecutor } from '../../platform/persistence/index.js';
import { defineModule } from '../../platform/module-registry/index.js';
import type { Principal } from '../auth/index.js';
import type { AuthorizationDecision, AuthorizationDenyReason, TenancyAction } from '../organizations/index.js';
import type { InteractionRecord } from '../interactions/index.js';
import { isNotificationChannel, type NotificationChannel } from './channels.js';
import { createSqlNotificationsStore } from './sql-store.js';
import { hashNotificationInput } from './provenance.js';
import {
  NotificationsStoreMissingError,
  NotificationsStoreRuleError,
  type CreateNotificationInput,
  type NotificationContent,
  type NotificationRecord,
  type NotificationRecipient,
  type NotificationsStore,
  type NotificationsStoreRule,
  type SetInteractionPointerInput,
} from './store.js';

// Store port (public contract): the authoritative SQL implementation runs
// through the persistence boundary; tests inject faithful in-memory
// implementations of the same port through this surface.
export { createSqlNotificationsStore, NotificationsStoreMissingError, NotificationsStoreRuleError };
export type {
  CreateNotificationInput,
  NotificationContent,
  NotificationRecord,
  NotificationRecipient,
  NotificationsStore,
  NotificationsStoreRule,
  SetInteractionPointerInput,
};

// The notification delivery channels (a projection of the /integrations
// capability taxonomy; the projection is proven by test).
export { NOTIFICATION_CHANNELS, isNotificationChannel } from './channels.js';
export type { NotificationChannel } from './channels.js';

// Deterministic provenance hashing (part of the notification-request contract).
export { canonicalJson, computeNotificationRecordHash, hashNotificationInput, hashNotificationRecord } from './provenance.js';
export type { HashableNotificationRecord, NotificationRecordCore, NotificationRequestCore } from './provenance.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The tenancy authorization decision entry point consumed from
 * /organizations' public interface (injected by the composition root so
 * the authorization chain stays singular — never re-implemented here).
 */
export interface TenancyAuthorization {
  authorize(
    principalId: string,
    scope: { organizationId: string } | { tenantId: string },
    action: TenancyAction,
  ): Promise<AuthorizationDecision>;
}

/**
 * The /interactions public contract this module consumes (structural
 * subset): the single external-effect boundary. Delivery flows through
 * it — durable intent first, dispatch second, observed results recorded
 * there — so this module owns no second effect ledger.
 */
export interface NotificationEffectBoundary {
  createInteraction(
    principal: Principal,
    tenantId: string,
    input: {
      capability: NotificationChannel;
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
  getInteraction(principal: Principal, tenantId: string, interactionId: string): Promise<InteractionRecord>;
}

/**
 * The derived delivery status of a notification request — a PROJECTION of
 * the linked interaction's durable state (never re-recorded):
 *
 * - `requested`: the durable request exists; delivery not yet initiated
 *   (no interaction pointer).
 * - `pending`: the delivery interaction's durable intent exists
 *   (state `intended`), not yet dispatched.
 * - `in_flight`: the interaction is claimed/dispatched (state
 *   `dispatching`/`dispatched`).
 * - `delivered`: the provider result was observed and SUCCEEDED.
 * - `failed`: the provider result was observed and FAILED (or the
 *   dispatch itself failed) — explicit, durable, recoverable through
 *   `retryNotification`.
 */
export type NotificationDeliveryStatus = 'requested' | 'pending' | 'in_flight' | 'delivered' | 'failed';

export type NotificationsErrorCode =
  | 'INVALID_INPUT'
  | 'TENANT_NOT_FOUND'
  | 'TENANT_SUSPENDED'
  | 'ORGANIZATION_SUSPENDED'
  | 'TENANT_FORBIDDEN'
  | 'ROLE_FORBIDDEN'
  | 'NOTIFICATION_NOT_FOUND'
  | 'NOTIFICATION_INPUT_CONFLICT'
  | 'DELIVERY_ALREADY_INITIATED'
  | 'NOTIFICATION_NOT_FAILED'
  | 'NOTIFICATION_RECORD_TAMPERED'
  | 'INTERACTION_RECORD_TAMPERED'
  | 'POLICY_DENIED'
  | 'POLICY_EVALUATION_FAILED'
  | 'ADAPTER_UNAVAILABLE';

export class NotificationsError extends Error {
  constructor(
    readonly code: NotificationsErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'NotificationsError';
  }
}

export interface NotificationsModuleOptions {
  /** Production wiring: transaction-capable persistence executor. */
  executor?: TransactionalExecutor;
  /** Test seam: inject a faithful in-memory store instead (tests only). */
  store?: NotificationsStore;
  /** The single authorization chain, injected by the composition root. */
  tenancy: TenancyAuthorization;
  /** The single external-effect boundary (/interactions' public contract). */
  interactions: NotificationEffectBoundary;
  /** Clock injection for deterministic proofs. */
  now?: () => Date;
}

/** One notification with its DERIVED delivery status and current interaction. */
export interface NotificationView {
  readonly notification: NotificationRecord;
  readonly delivery: NotificationDeliveryStatus;
  readonly interaction: InteractionRecord | null;
}

export interface NotificationsModule {
  /**
   * THE request surface: persist the durable notification request (who
   * to notify, what, via which channel, why). Authorization first;
   * idempotent by (tenant, idempotency key); delivery is NOT initiated
   * here — `dispatchNotification` owns the external effect (the request
   * alone produces no side effect).
   */
  requestNotification(
    principal: Principal,
    tenantId: string,
    input: {
      channel: NotificationChannel;
      recipient: NotificationRecipient;
      content: NotificationContent;
      purpose?: string;
      correlation?: Readonly<Record<string, string>>;
      idempotencyKey?: string;
    },
  ): Promise<{ notification: NotificationRecord; converged: boolean }>;

  /**
   * THE delivery-initiation surface: create the durable interaction
   * intent through /interactions (capability = the channel, params from
   * the request, key `notification:{id}` — crash-convergent), pin the
   * pointer, then dispatch the interaction. Re-invocations converge: the
   * keyed intent, the idempotent pointer and /interactions' claim CAS
   * make repeated or concurrent calls produce ONE logical effect. An
   * optional policyKey gates the intent creation (deny fails closed
   * before any side effect).
   */
  dispatchNotification(
    principal: Principal,
    tenantId: string,
    notificationId: string,
    input?: { policyKey?: string },
  ): Promise<{ view: NotificationView; invoked: boolean }>;

  /**
   * THE failure-recovery surface (AC-5): retry a FAILED delivery with a
   * NEW interaction identity (caller-supplied idempotency key —
   * concurrent identical retries converge on one retry interaction). The
   * failed observation stays durable and explicit; the pointer moves to
   * the retry and the derived status follows it. Fails closed unless the
   * current delivery is observed-FAILED.
   */
  retryNotification(
    principal: Principal,
    tenantId: string,
    notificationId: string,
    input: { idempotencyKey: string; policyKey?: string },
  ): Promise<{ view: NotificationView; invoked: boolean }>;

  /** The status surface: one notification with its DERIVED delivery status. */
  getNotification(principal: Principal, tenantId: string, notificationId: string): Promise<NotificationView>;

  /** The status surface: the tenant's notifications, optionally filtered by derived delivery status. */
  listNotifications(
    principal: Principal,
    tenantId: string,
    filter?: { delivery?: NotificationDeliveryStatus },
  ): Promise<NotificationView[]>;
}

// ---------------------------------------------------------------------------
// Validation (fail closed)
// ---------------------------------------------------------------------------

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateUuid(value: string, what: string): void {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new NotificationsError('INVALID_INPUT', `${what} must be a UUID`);
  }
}

function validateOptionalKey(value: string | undefined, what: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.trim() === '' || value.length > 200) {
    throw new NotificationsError('INVALID_INPUT', `${what} must be a non-empty string of at most 200 characters`);
  }
  return value.trim();
}

const CORRELATION_KEY_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

function validateCorrelation(value: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> {
  if (value === undefined) return {};
  const entries = Object.entries(value);
  if (entries.length > 10) {
    throw new NotificationsError('INVALID_INPUT', 'correlation must carry at most 10 entries');
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of entries) {
    if (!CORRELATION_KEY_PATTERN.test(key)) {
      throw new NotificationsError('INVALID_INPUT', `correlation key "${key}" must match [A-Za-z0-9_.-]{1,64}`);
    }
    if (typeof entry !== 'string' || entry.length > 256) {
      throw new NotificationsError('INVALID_INPUT', `correlation entry "${key}" must be a string of at most 256 characters`);
    }
    out[key] = entry;
  }
  return out;
}

/**
 * Channel-shaped validation (fail closed): email requires an address and
 * a subject; SMS/voice require an address and no subject.
 */
function validateRequestShape(
  channel: NotificationChannel,
  recipient: NotificationRecipient,
  content: NotificationContent,
): { recipient: Readonly<Record<string, string | null>>; content: Readonly<Record<string, string | null>> } {
  if (typeof recipient !== 'object' || recipient === null) {
    throw new NotificationsError('INVALID_INPUT', 'recipient must be an object');
  }
  if (typeof content !== 'object' || content === null) {
    throw new NotificationsError('INVALID_INPUT', 'content must be an object');
  }
  const address = recipient.address;
  if (typeof address !== 'string' || address.trim() === '' || address.length > 320) {
    throw new NotificationsError('INVALID_INPUT', 'recipient.address must be a non-empty string of at most 320 characters');
  }
  const body = content.body;
  if (typeof body !== 'string' || body.length === 0 || body.length > 100_000) {
    throw new NotificationsError('INVALID_INPUT', 'content.body must be a non-empty string of at most 100000 characters');
  }
  const displayName = recipient.displayName;
  if (displayName !== undefined && (typeof displayName !== 'string' || displayName.length > 200)) {
    throw new NotificationsError('INVALID_INPUT', 'recipient.displayName must be a string of at most 200 characters');
  }
  const subject = content.subject;
  if (channel === 'email') {
    if (typeof subject !== 'string' || subject.trim() === '' || subject.length > 1_000) {
      throw new NotificationsError('INVALID_INPUT', 'email notifications require content.subject (1..1000 characters)');
    }
  } else if (subject !== undefined) {
    throw new NotificationsError('INVALID_INPUT', `content.subject applies to email notifications only (channel ${channel})`);
  }
  const recipientOut: Record<string, string | null> =
    displayName === undefined ? { address } : { address, displayName };
  const contentOut: Record<string, string | null> = subject === undefined ? { body } : { subject, body };
  return { recipient: recipientOut, content: contentOut };
}

/** Build the provider-neutral effect params for one notification (channel-shaped). */
function effectParams(
  channel: NotificationChannel,
  recipient: Readonly<Record<string, string | null>>,
  content: Readonly<Record<string, string | null>>,
): Record<string, unknown> {
  const address = recipient.address as string;
  switch (channel) {
    case 'email':
      return { to: [address], subject: content.subject as string, body: content.body as string };
    case 'sms':
      return { to: address, body: content.body as string };
    case 'voice':
      return { to: address, message: content.body as string };
  }
}

/** Map an authorization denial reason to the module error surface. */
function denyToError(reason: AuthorizationDenyReason | undefined, tenantId: string): NotificationsError {
  switch (reason) {
    case 'TENANT_NOT_FOUND':
      return new NotificationsError('TENANT_NOT_FOUND', `service tenant ${tenantId} does not exist`);
    case 'TENANT_SUSPENDED':
      return new NotificationsError('TENANT_SUSPENDED', `service tenant ${tenantId} is suspended`);
    case 'ORGANIZATION_NOT_FOUND':
      return new NotificationsError('TENANT_NOT_FOUND', `the tenant's organization no longer exists`);
    case 'ORGANIZATION_SUSPENDED':
      return new NotificationsError('ORGANIZATION_SUSPENDED', 'the owning organization is suspended');
    case 'MEMBERSHIP_FORBIDDEN':
      return new NotificationsError('TENANT_FORBIDDEN', 'the principal has no active membership granting this tenant');
    case 'ROLE_FORBIDDEN':
      return new NotificationsError('ROLE_FORBIDDEN', 'the principal role does not grant the required capability');
    default:
      return new NotificationsError('TENANT_FORBIDDEN', 'authorization denied');
  }
}

/** Map /interactions and store errors onto this module's typed surface. */
function mapBoundaryError(error: unknown): never {
  const candidate = error as { name?: string; code?: string; rule?: string; message?: string };
  if (candidate?.name === 'InteractionsError' && typeof candidate.code === 'string') {
    switch (candidate.code) {
      case 'POLICY_DENIED':
        throw new NotificationsError('POLICY_DENIED', candidate.message);
      case 'POLICY_EVALUATION_FAILED':
        throw new NotificationsError('POLICY_EVALUATION_FAILED', candidate.message);
      case 'ADAPTER_UNAVAILABLE':
        throw new NotificationsError('ADAPTER_UNAVAILABLE', candidate.message);
      case 'INTERACTION_RECORD_TAMPERED':
        throw new NotificationsError('INTERACTION_RECORD_TAMPERED', candidate.message);
      case 'INTERACTION_INPUT_CONFLICT':
        throw new NotificationsError('DELIVERY_ALREADY_INITIATED', candidate.message);
      default:
        throw error;
    }
  }
  if (candidate?.name === 'NotificationsStoreRuleError') {
    if (candidate.rule === 'notification-input-conflict') {
      throw new NotificationsError('NOTIFICATION_INPUT_CONFLICT', candidate.message);
    }
    if (candidate.rule === 'notification-record-tampered') {
      throw new NotificationsError('NOTIFICATION_RECORD_TAMPERED', candidate.message);
    }
  }
  throw error;
}

/** Derive the delivery status from the linked interaction's durable state. */
function deriveDelivery(interaction: InteractionRecord | null): NotificationDeliveryStatus {
  if (interaction === null) return 'requested';
  switch (interaction.state) {
    case 'intended':
      return 'pending';
    case 'dispatching':
    case 'dispatched':
      return 'in_flight';
    case 'observed':
      return interaction.observation?.outcome === 'succeeded' ? 'delivered' : 'failed';
  }
}

export function createNotificationsModule(options: NotificationsModuleOptions): NotificationsModule {
  if ((options.executor === undefined) === (options.store === undefined)) {
    throw new NotificationsError('INVALID_INPUT', 'createNotificationsModule requires exactly one of executor or store');
  }
  const store = options.store ?? createSqlNotificationsStore(options.executor as TransactionalExecutor);
  const tenancy = options.tenancy;
  const interactions = options.interactions;
  const now = options.now ?? (() => new Date());

  /** Authorization BEFORE any domain data access (single chain). */
  async function requireTenantAccess(principal: Principal, tenantId: string, action: TenancyAction): Promise<void> {
    validateUuid(tenantId, 'tenantId');
    const decision = await tenancy.authorize(principal.id, { tenantId }, action);
    if (!decision.allowed) {
      throw denyToError(decision.reason, tenantId);
    }
  }

  async function loadView(principal: Principal, tenantId: string, notification: NotificationRecord): Promise<NotificationView> {
    if (notification.currentInteractionId === null) {
      return { notification, delivery: 'requested', interaction: null };
    }
    try {
      const interaction = await interactions.getInteraction(principal, tenantId, notification.currentInteractionId);
      return { notification, delivery: deriveDelivery(interaction), interaction };
    } catch (error) {
      // Tamper evidence is load-bearing: surface it, never mask it.
      if ((error as { name?: string })?.name === 'InteractionsError' && (error as { code?: string })?.code === 'INTERACTION_RECORD_TAMPERED') {
        throw new NotificationsError('INTERACTION_RECORD_TAMPERED', (error as Error).message);
      }
      throw error;
    }
  }

  /**
   * The shared delivery flow: create-or-converge the interaction intent
   * through /interactions (durable intent BEFORE dispatch, policy-gated
   * optionally), pin the pointer, then dispatch (exactly one adapter
   * invocation per interaction identity; convergent on retries).
   */
  async function initiateDelivery(
    principal: Principal,
    tenantId: string,
    notification: NotificationRecord,
    input: { intentKey: string; policyKey?: string; retryOfInteractionId?: string },
  ): Promise<{ view: NotificationView; invoked: boolean }> {
    // 1. Durable intent through the single external-effect boundary. The
    //    intent key is derived from the notification identity (initial) or
    //    caller-supplied (retry) — both crash-convergent.
    let interaction: InteractionRecord;
    try {
      const created = await interactions.createInteraction(principal, tenantId, {
        capability: notification.channel,
        params: effectParams(notification.channel, notification.recipient, notification.content),
        correlation: { ...notification.correlation },
        policyKey: input.policyKey,
        idempotencyKey: input.intentKey,
        retryOfInteractionId: input.retryOfInteractionId,
      });
      interaction = created.interaction;
    } catch (error) {
      return mapBoundaryError(error);
    }

    // 2. Pin the pointer (idempotent; the keyed interaction identity is
    //    stable across concurrent initiations).
    try {
      notification = await store.setInteractionPointer({
        tenantId,
        notificationId: notification.id,
        interactionId: interaction.id,
        now: now(),
      });
    } catch (error) {
      return mapBoundaryError(error);
    }

    // 3. Dispatch through the boundary (claim CAS -> adapter ->
    //    acceptance/failure recording; convergent on retries).
    let dispatched: { interaction: InteractionRecord; invoked: boolean; converged: boolean };
    try {
      dispatched = await interactions.dispatchInteraction(principal, tenantId, interaction.id);
    } catch (error) {
      return mapBoundaryError(error);
    }
    const view: NotificationView = {
      notification,
      delivery: deriveDelivery(dispatched.interaction),
      interaction: dispatched.interaction,
    };
    return { view, invoked: dispatched.invoked };
  }

  return {
    async requestNotification(principal, tenantId, input) {
      await requireTenantAccess(principal, tenantId, 'write');
      if (input.channel === undefined || !isNotificationChannel(input.channel)) {
        throw new NotificationsError('INVALID_INPUT', 'channel must be one of email, sms, voice');
      }
      const channel = input.channel;
      const shape = validateRequestShape(channel, input.recipient, input.content);
      const purpose = input.purpose === undefined ? null : input.purpose;
      if (purpose !== null && (typeof purpose !== 'string' || purpose.length > 200)) {
        throw new NotificationsError('INVALID_INPUT', 'purpose must be a string of at most 200 characters');
      }
      const correlation = validateCorrelation(input.correlation);
      const idempotencyKey = validateOptionalKey(input.idempotencyKey, 'idempotencyKey');

      // Durable request identity (keyed convergence comparisons use this).
      const inputHash = hashNotificationInput({
        channel,
        recipient: shape.recipient,
        content: shape.content,
        purpose,
        correlation,
      });

      const payload: CreateNotificationInput = {
        tenantId,
        channel,
        recipient: shape.recipient,
        content: shape.content,
        purpose,
        correlation,
        requestedBy: principal.id,
        idempotencyKey,
        inputHash,
        now: now(),
      };
      try {
        return await store.createNotification(payload);
      } catch (error) {
        return mapBoundaryError(error);
      }
    },

    async dispatchNotification(principal, tenantId, notificationId, input) {
      await requireTenantAccess(principal, tenantId, 'write');
      validateUuid(notificationId, 'notificationId');
      const policyKey = validateOptionalKey(input?.policyKey, 'policyKey');

      let notification: NotificationRecord | null;
      try {
        notification = await store.findNotificationById(tenantId, notificationId);
      } catch (error) {
        return mapBoundaryError(error);
      }
      if (notification === null) {
        throw new NotificationsError('NOTIFICATION_NOT_FOUND', `notification ${notificationId} does not exist in this tenant`);
      }

      return initiateDelivery(principal, tenantId, notification, {
        // The initial delivery intent key is DERIVED from the notification
        // identity: crash- and concurrency-convergent by construction.
        intentKey: `notification:${notification.id}`,
        policyKey: policyKey ?? undefined,
      });
    },

    async retryNotification(principal, tenantId, notificationId, input) {
      await requireTenantAccess(principal, tenantId, 'write');
      validateUuid(notificationId, 'notificationId');
      const retryKey = validateOptionalKey(input.idempotencyKey, 'idempotencyKey');
      if (retryKey === null) {
        throw new NotificationsError('INVALID_INPUT', 'retry requires an idempotencyKey (concurrent identical retries converge on one retry interaction)');
      }
      const policyKey = validateOptionalKey(input.policyKey, 'policyKey');

      let notification: NotificationRecord | null;
      try {
        notification = await store.findNotificationById(tenantId, notificationId);
      } catch (error) {
        return mapBoundaryError(error);
      }
      if (notification === null) {
        throw new NotificationsError('NOTIFICATION_NOT_FOUND', `notification ${notificationId} does not exist in this tenant`);
      }

      // The retry precondition: only a FAILED delivery is retried (the
      // retry protocol: distinct identity after a failed observation).
      const view = await loadView(principal, tenantId, notification);
      if (view.delivery !== 'failed') {
        throw new NotificationsError(
          'NOTIFICATION_NOT_FAILED',
          `notification ${notificationId} delivery is "${view.delivery}"; only failed deliveries are retried`,
        );
      }
      const failedInteraction = view.interaction as InteractionRecord;

      return initiateDelivery(principal, tenantId, notification, {
        // The retry key is CALLER-SUPPLIED: distinct keys are deliberate
        // distinct retries; identical keys converge on one retry
        // interaction (the /interactions keyed convergence).
        intentKey: `notification:${notification.id}:retry:${retryKey}`,
        policyKey: policyKey ?? undefined,
        retryOfInteractionId: failedInteraction.id,
      });
    },

    async getNotification(principal, tenantId, notificationId) {
      await requireTenantAccess(principal, tenantId, 'read');
      validateUuid(notificationId, 'notificationId');
      let notification: NotificationRecord | null;
      try {
        notification = await store.findNotificationById(tenantId, notificationId);
      } catch (error) {
        return mapBoundaryError(error);
      }
      if (notification === null) {
        throw new NotificationsError('NOTIFICATION_NOT_FOUND', `notification ${notificationId} does not exist in this tenant`);
      }
      return loadView(principal, tenantId, notification);
    },

    async listNotifications(principal, tenantId, filter) {
      await requireTenantAccess(principal, tenantId, 'read');
      let rows: NotificationRecord[];
      try {
        rows = await store.listNotifications(tenantId);
      } catch (error) {
        return mapBoundaryError(error);
      }
      const views: NotificationView[] = [];
      for (const notification of rows) {
        const view = await loadView(principal, tenantId, notification);
        if (filter?.delivery === undefined || view.delivery === filter.delivery) {
          views.push(view);
        }
      }
      return views;
    },
  };
}

/**
 * Module manifest (registered in the composition root's module registry).
 * The manifest declares identity only; the contract above is the module's
 * public surface.
 */
export default defineModule({
  name: 'notifications',
  version: '1.0.0',
  description: 'ServiceOS notifications and delivery adapters',
});
