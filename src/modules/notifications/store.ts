/**
 * ServiceOS /notifications store port (WORK-015).
 *
 * The persistence contract for the ServiceOS notification REQUEST records
 * (delivery requests and their status surface — authority matrix:
 * "/notifications: delivery request/status through owned interface").
 *
 * What this store is NOT:
 * - NOT a second interaction ledger: the external effect and its
 *   observation live in /interactions (this store holds only the request
 *   and a POINTER to the current interaction; delivery status is DERIVED
 *   through the /interactions public contract, never re-recorded here —
 *   architecture.md §2.11 "no second authority").
 * - NOT a delivery state machine: the notification's delivery state is a
 *   projection of the linked interaction's durable state; retries move
 *   the pointer to a NEW interaction identity (the retry protocol) and
 *   the old observations stay authoritative.
 *
 * Store contract semantics (mirrored by every implementation):
 *
 * - MANDATORY TENANT PREDICATES: every lookup and list carries the tenant
 *   parameter in its signature and its query (lock #15/#16).
 * - REQUEST IDENTITY IS IDEMPOTENT: `createNotification` converges on the
 *   durable notification identified by (tenant, idempotency key) when the
 *   submission input matches the recorded input hash; a divergent
 *   re-submission of the same key fails closed
 *   (`notification-input-conflict`).
 * - THE INTERACTION POINTER IS IDEMPOTENT: `setInteractionPointer` writes
 *   the current-interaction pointer (same-value writes converge); every
 *   write recomputes the record integrity hash.
 * - TAMPER-EVIDENT READS: every read recomputes the persisted record
 *   integrity hash from the stored fields and fails closed
 *   (`notification-record-tampered`) on divergence.
 */
import type { NotificationChannel } from './channels.js';

/** Atomic store-level rule violation (mirrors a guarded SQL transaction). */
export type NotificationsStoreRule = 'notification-input-conflict' | 'notification-record-tampered';

export class NotificationsStoreRuleError extends Error {
  constructor(message: string, readonly rule: NotificationsStoreRule) {
    super(message);
    this.name = 'NotificationsStoreRuleError';
  }
}

/** Single-row target absent (scoped by the tenant predicate). */
export class NotificationsStoreMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotificationsStoreMissingError';
  }
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** The notification addressee (address shape per channel). */
export interface NotificationRecipient {
  /** Email address (email channel) or phone number (sms/voice channels). */
  readonly address: string;
  readonly displayName?: string;
}

/** The notification content (subject for email; body for all; message spoken for voice). */
export interface NotificationContent {
  readonly subject?: string;
  readonly body: string;
}

/**
 * One notification request: the durable business meaning (who should be
 * notified, what, via which channel, why) plus the POINTER to the current
 * delivery interaction owned by /interactions. Delivery status is derived
 * from that interaction's durable state — never re-recorded here.
 */
export interface NotificationRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly channel: NotificationChannel;
  readonly recipient: Readonly<Record<string, string | null>>;
  readonly content: Readonly<Record<string, string | null>>;
  /** Inert business meaning of the notification (e.g. "compliance-followup"). */
  readonly purpose: string | null;
  /** Inert reference data (e.g. { workId }) — recorded, not enforced. */
  readonly correlation: Readonly<Record<string, string>>;
  readonly requestedBy: string;
  readonly idempotencyKey: string | null;
  /** Deterministic request identity: sha256 over the canonical request core. */
  readonly inputHash: string;
  /** Integrity hash over the canonical record core (tamper-evident reads). */
  readonly recordHash: string;
  /** The /interactions record currently carrying this notification's effect (null until delivery initiation). */
  readonly currentInteractionId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface CreateNotificationInput {
  readonly tenantId: string;
  readonly channel: NotificationChannel;
  readonly recipient: Readonly<Record<string, string | null>>;
  readonly content: Readonly<Record<string, string | null>>;
  readonly purpose: string | null;
  readonly correlation: Readonly<Record<string, string>>;
  readonly requestedBy: string;
  readonly idempotencyKey: string | null;
  /** sha256 over the canonical request core. */
  readonly inputHash: string;
  readonly now: Date;
}

export interface SetInteractionPointerInput {
  readonly tenantId: string;
  readonly notificationId: string;
  /** The interaction the notification's delivery now flows through (validated module-side through /interactions). */
  readonly interactionId: string;
  readonly now: Date;
}

// ---------------------------------------------------------------------------
// Store port
// ---------------------------------------------------------------------------

export interface NotificationsStore {
  /**
   * Persist the durable notification request. Keyed submissions converge
   * on the durable notification (input-matched); a divergent
   * re-submission of the same key fails closed.
   */
  createNotification(input: CreateNotificationInput): Promise<{ notification: NotificationRecord; converged: boolean }>;
  /** Tenant-predicated lookup; null when absent in this tenant. */
  findNotificationById(tenantId: string, notificationId: string): Promise<NotificationRecord | null>;
  /** Tenant-predicated idempotency-identity lookup. */
  findNotificationByIdempotencyKey(tenantId: string, key: string): Promise<NotificationRecord | null>;
  /** Tenant-predicated list (request order). */
  listNotifications(tenantId: string): Promise<NotificationRecord[]>;
  /**
   * Idempotently point the notification at its current delivery
   * interaction (recomputes the record integrity hash).
   */
  setInteractionPointer(input: SetInteractionPointerInput): Promise<NotificationRecord>;
}
