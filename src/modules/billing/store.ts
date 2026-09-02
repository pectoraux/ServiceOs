/**
 * ServiceOS /billing store port contract (WORK-011, module internal —
 * exported through the module's public interface).
 *
 * The authoritative SQL implementation runs through the persistence
 * boundary (executor-pinned transactions); tests inject the faithful
 * in-memory implementation of the SAME port. This is a persistence
 * contract, never a second billing authority.
 *
 * Store disciplines (mirrored by the in-memory double):
 *
 * - SUBSCRIPTIONS: the durable identity is (tenant, subscription row id);
 *   registration is store-serialized per (tenant, service) with the
 *   one-live invariant (rule `subscription-already-active` when a
 *   non-cancelled subscription exists for the service); same
 *   (tenant, idempotency key) converges on identical content (rule
 *   `idempotency-input-conflict` on divergence — the post-lock re-check
 *   makes the code identical under a true race). Lifecycle is
 *   forward-only draft → active → cancelled (rule
 *   `subscription-lifecycle` for illegal moves); activating the
 *   already-active subscription converges; cancelling is absorbing
 *   (re-cancelling converges).
 *
 * - USAGE: work-sourced usage is deduplicated by (tenant, work id) —
 *   duplicate metering of the SAME billable work converges on identical
 *   content and fails closed (`usage-input-conflict`) otherwise: the
 *   billable identity is the work item, not the metering call
 *   (duplicate billable work can never double-charge). Outcome-sourced
 *   usage deduplicates on (tenant, outcome id). Manual usage carries a
 *   REQUIRED idempotency key (same convergence/conflict contract).
 *
 * - SETTLEMENT: `settlePeriod` is ONE serialized critical section
 *   (advisory-locked per (tenant, subscription)): it selects the
 *   unsettled usage for (subscription, period), prices it through the
 *   injected PURE pricing function (module-owned pricing policy), and
 *   atomically inserts the ledger entry and marks the usage settled —
 *   concurrent settlement converges on ONE durable ledger outcome (the
 *   unique (tenant, subscription, period) index backstops it). Late
 *   usage recorded after a settled period stays metered but is NEVER
 *   re-billed into the same period (the ledger entry is the single
 *   authoritative outcome).
 *
 * - COST REFERENCES: non-authoritative REFERENCES to external cost
 *   statements (the AI cost authority — Zeck — publishes them; this
 *   table holds opaque pointers + reported totals for margin analysis,
 *   never a usage breakdown). Keyed convergence by (tenant,
 *   idempotency key) with the same conflict contract.
 *
 * - READS verify BOTH persisted hashes (content + record) exactly like
 *   the SQL store (`subscription-record-tampered` /
 *   `usage-record-tampered` / `ledger-record-tampered` /
 *   `cost-reference-record-tampered` on divergence). Lifecycle writes
 *   recompute the record hash over the NEW row state atomically with
 *   the status write (one clock read per write: the hash and the row
 *   pin the SAME instant).
 */
import type { Principal } from '../auth/index.js';

// ---------------------------------------------------------------------------
// Public record shapes
// ---------------------------------------------------------------------------

/** Customer pricing model of a subscription (AC-2). */
export type CustomerPricingModel = 'subscription' | 'work_based' | 'hybrid';

/** The billable usage source. */
export type UsageSource = 'work' | 'outcome' | 'manual';

/**
 * The closed enumeration of external cost-statement sources ServiceOS
 * accepts as NON-AUTHORITATIVE references. `ai_authority` is the AI
 * usage/cost authority (Zeck today) — the value names the AUTHORITY
 * domain, never a provider/model: this surface cannot carry provider
 * breakdowns (Work Order forbidden surface).
 */
export type CostReferenceSource = 'ai_authority';

export interface SubscriptionPlan {
  readonly model: CustomerPricingModel;
  /** Single billing currency of the whole plan (3-letter ISO). */
  readonly currency: string;
  /** The recurring periodic charge (required for subscription/hybrid). */
  readonly recurringAmount: string | null;
  /** Per-metric unit prices (required for work_based/hybrid). */
  readonly workRates: readonly WorkRate[];
}

export interface WorkRate {
  /** A metering metric declared by the pinned service definition's pricing metadata. */
  readonly metric: string;
  /** Price charged per unit of the metric. */
  readonly unitPrice: string;
}

export interface BillingSubscriptionRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly serviceId: string;
  /** The ACTIVE service-definition version pinned at registration. */
  readonly serviceVersion: number;
  readonly status: 'draft' | 'active' | 'cancelled';
  readonly plan: SubscriptionPlan;
  readonly createdBy: string;
  readonly idempotencyKey: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly cancelledAt: Date | null;
  readonly contentHash: string;
  readonly recordHash: string;
}

export interface UsageRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly subscriptionId: string;
  readonly serviceId: string;
  /** The pinned service-definition version the usage was validated against. */
  readonly serviceVersion: number;
  readonly source: UsageSource;
  /** The metering metric (declared by the pinned service version). */
  readonly metric: string;
  /** The unit declared by the pinned service version's metering rule. */
  readonly unit: string;
  readonly quantity: string;
  /** The billable work identity (source `work`). */
  readonly workId: string | null;
  /** The verified outcome identity (source `outcome`). */
  readonly outcomeId: string | null;
  readonly occurredAt: Date;
  /** 'YYYY-MM' derived from occurredAt (UTC). */
  readonly billingPeriod: string;
  /** The ledger entry this usage was settled into (null until settled). */
  readonly settledLedgerId: string | null;
  readonly createdBy: string;
  readonly idempotencyKey: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly contentHash: string;
  readonly recordHash: string;
}

export interface BillingLedgerRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly subscriptionId: string;
  readonly serviceId: string;
  readonly billingPeriod: string;
  readonly currency: string;
  readonly subscriptionCharge: string;
  readonly usageCharge: string;
  readonly totalCharge: string;
  readonly usageCount: number;
  readonly settledAt: Date;
  readonly settledBy: string;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly contentHash: string;
  readonly recordHash: string;
}

export interface CostReferenceRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly billingPeriod: string;
  readonly source: CostReferenceSource;
  /** Opaque pointer to the external authoritative cost statement. */
  readonly externalReference: string;
  /** The reported external cost total for the period (non-authoritative copy for margin analysis). */
  readonly amount: string;
  readonly currency: string;
  readonly recordedBy: string;
  readonly idempotencyKey: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly contentHash: string;
  readonly recordHash: string;
}

// ---------------------------------------------------------------------------
// Store inputs (module-validated, hash-carrying)
// ---------------------------------------------------------------------------

export interface RegisterSubscriptionStoreInput {
  readonly tenantId: string;
  readonly serviceId: string;
  readonly serviceVersion: number;
  readonly plan: SubscriptionPlan;
  readonly createdBy: string;
  readonly idempotencyKey: string | null;
  readonly contentHash: string;
  readonly now: Date;
}

export interface ActivateSubscriptionInput {
  readonly tenantId: string;
  readonly subscriptionId: string;
  readonly now: Date;
}

export interface CancelSubscriptionInput {
  readonly tenantId: string;
  readonly subscriptionId: string;
  readonly now: Date;
}

export interface RecordUsageInput {
  readonly tenantId: string;
  readonly subscriptionId: string;
  readonly serviceId: string;
  readonly serviceVersion: number;
  readonly source: UsageSource;
  readonly metric: string;
  readonly unit: string;
  readonly quantity: string;
  readonly workId: string | null;
  readonly outcomeId: string | null;
  readonly occurredAt: Date;
  readonly billingPeriod: string;
  readonly createdBy: string;
  readonly idempotencyKey: string | null;
  readonly contentHash: string;
  readonly now: Date;
}

/**
 * The pure pricing function the module injects into settlement: prices
 * the atomically-selected usage records for one period into charges.
 * No clock, no IO — deterministic from the plan and the usage set.
 */
export type UsagePricing = (usage: readonly UsageRecord[]) => {
  readonly subscriptionCharge: string;
  readonly usageCharge: string;
  readonly totalCharge: string;
};

export interface SettlePeriodInput {
  readonly tenantId: string;
  readonly subscriptionId: string;
  readonly serviceId: string;
  readonly billingPeriod: string;
  readonly currency: string;
  readonly settledBy: string;
  readonly priceUsage: UsagePricing;
  readonly now: Date;
}

export interface RecordCostReferenceStoreInput {
  readonly tenantId: string;
  readonly billingPeriod: string;
  readonly source: CostReferenceSource;
  readonly externalReference: string;
  readonly amount: string;
  readonly currency: string;
  readonly recordedBy: string;
  readonly idempotencyKey: string;
  readonly contentHash: string;
  readonly now: Date;
}

// ---------------------------------------------------------------------------
// Store rules (typed; the module maps them onto the public error surface)
// ---------------------------------------------------------------------------

export type SubscriptionStoreRule =
  | 'idempotency-input-conflict'
  | 'subscription-already-active'
  | 'subscription-lifecycle'
  | 'subscription-record-tampered';

export type UsageStoreRule =
  | 'idempotency-input-conflict'
  | 'usage-input-conflict'
  | 'usage-record-tampered';

export type LedgerStoreRule = 'ledger-record-tampered';

export type CostReferenceStoreRule =
  | 'idempotency-input-conflict'
  | 'cost-reference-record-tampered';

export class BillingStoreRuleError extends Error {
  constructor(
    message: string,
    readonly rule:
      | SubscriptionStoreRule
      | UsageStoreRule
      | LedgerStoreRule
      | CostReferenceStoreRule,
  ) {
    super(message);
    this.name = 'BillingStoreRuleError';
  }
}

export class BillingStoreMissingError extends Error {
  constructor(
    readonly kind: 'subscription',
    readonly key: string,
  ) {
    super(`subscription ${key} not found`);
    this.name = 'BillingStoreMissingError';
  }
}

/** Uniqueness arbitration surfaced by ON CONFLICT convergence re-reads. */
export class StoreConflictError extends Error {
  constructor(
    message: string,
    readonly constraint: string,
  ) {
    super(message);
    this.name = 'StoreConflictError';
  }
}

// ---------------------------------------------------------------------------
// The store port
// ---------------------------------------------------------------------------

export interface BillingStore {
  /** Register one subscription (starts `draft`). One live per (tenant, service). */
  registerSubscription(input: RegisterSubscriptionStoreInput): Promise<{ subscription: BillingSubscriptionRecord; converged: boolean }>;
  /** Tenant-predicated row lookup; null when absent. */
  findSubscription(tenantId: string, subscriptionId: string): Promise<BillingSubscriptionRecord | null>;
  /** Tenant-predicated list (optionally one service), registration order. */
  listSubscriptions(tenantId: string, serviceId?: string): Promise<BillingSubscriptionRecord[]>;
  /** The non-cancelled subscription of one service, or null. */
  findLiveSubscription(tenantId: string, serviceId: string): Promise<BillingSubscriptionRecord | null>;
  /** Forward-only activation; converges when already active. */
  activateSubscription(input: ActivateSubscriptionInput): Promise<{ subscription: BillingSubscriptionRecord; converged: boolean }>;
  /** Terminal cancellation (absorbing). */
  cancelSubscription(input: CancelSubscriptionInput): Promise<{ subscription: BillingSubscriptionRecord; converged: boolean }>;
  /** Record one usage row (dedup by source reference / idempotency key). */
  recordUsage(input: RecordUsageInput): Promise<{ usage: UsageRecord; converged: boolean }>;
  /** The usage metered for one work id (dedup lookup); null when absent. */
  findWorkUsage(tenantId: string, workId: string): Promise<UsageRecord | null>;
  /** The usage metered for one outcome id (dedup lookup); null when absent. */
  findOutcomeUsage(tenantId: string, outcomeId: string): Promise<UsageRecord | null>;
  /** Tenant-predicated usage list (optionally subscription/period), oldest first. */
  listUsage(tenantId: string, filter?: { subscriptionId?: string; billingPeriod?: string }): Promise<UsageRecord[]>;
  /**
   * ONE serialized critical section: select the unsettled usage for
   * (subscription, period), price it through the injected pure function,
   * atomically insert the ledger entry (content/record hashes computed
   * over the PRICED outcome) and mark the usage settled. Converges on
   * the existing entry when the period is already settled.
   */
  settlePeriod(input: SettlePeriodInput): Promise<{ ledger: BillingLedgerRecord; converged: boolean }>;
  /** The settled ledger entry of one (subscription, period); null when absent. */
  findLedgerEntry(tenantId: string, subscriptionId: string, billingPeriod: string): Promise<BillingLedgerRecord | null>;
  /** Tenant-predicated ledger list (optionally one period), settlement order. */
  listLedgerEntries(tenantId: string, billingPeriod?: string): Promise<BillingLedgerRecord[]>;
  /** Record one non-authoritative external cost reference (keyed). */
  recordCostReference(input: RecordCostReferenceStoreInput): Promise<{ reference: CostReferenceRecord; converged: boolean }>;
  /** Tenant-predicated cost-reference list (optionally one period), oldest first. */
  listCostReferences(tenantId: string, billingPeriod?: string): Promise<CostReferenceRecord[]>;
}
