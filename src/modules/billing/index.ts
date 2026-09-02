/**
 * ServiceOS module: /billing (WORK-011 implementation).
 *
 * The customer service-economics authority (architecture.md §6, §17;
 * domain-model.md economics; Work Order frozen scope).
 *
 * Authority (authority matrix / Work Order frozen scope):
 * - SERVICE SUBSCRIPTIONS, SERVICE USAGE RECORDS, WORK-BASED METERING,
 *   OUTCOME-LINKED BILLING, THE BILLING LEDGER and MARGIN REPORTING
 *   INPUTS are owned here: versioned durable rows that price and settle
 *   what the customer's services consumed. A module other than /billing
 *   exporting subscription/metering/settlement entry points is an
 *   architecture violation (checked structurally).
 * - ServiceOS OWNS CUSTOMER ECONOMICS; ZECK REMAINS THE AI USAGE/COST
 *   AUTHORITY (Work Order invariant; architecture.md §17): this module
 *   never imports /zeck, never persists an AI usage ledger, never
 *   expresses provider/model/token costs. The ONLY AI-side surface is
 *   `recordCostReference` — a NON-AUTHORITATIVE reference to an
 *   external cost statement published by the AI cost authority: an
 *   opaque pointer plus the reported total, consumed for margin
 *   analysis (AC-3). The input carries a frozen forbidden-key set: any
 *   provider/model/usage-breakdown key fails closed
 *   (AI_COST_BREAKDOWN_FORBIDDEN) — this surface structurally cannot
 *   become a provider-level AI cost ledger.
 * - BILLING BINDS THE SERVICE CATALOG, NEVER REDEFINES IT: a
 *   subscription pins the ACTIVE service-definition version and its
 *   plan is validated against that version's declared pricing metadata
 *   (metering metrics/units); usage is validated against the PINNED
 *   version's metering rules and outcome contract. /services stays the
 *   sole service-definition authority (consumed through its public
 *   interface).
 * - METERING REFERENCES REAL WORK: work-sourced usage validates the
 *   work identity through /work's public read contract (same tenant);
 *   duplicate metering of the same billable work CONVERGES on the
 *   durable usage row (identical content) or fails closed
 *   (USAGE_INPUT_CONFLICT) — duplicate billable work can never
 *   double-charge (Work Order discrimination requirement). Outcome
 *   usage deduplicates on the outcome identity the same way.
 * - SETTLEMENT IS ONE AUTHORIZED LEDGER OUTCOME PER PERIOD: pricing
 *   policy is a PURE function injected into the store's serialized
 *   critical section; the ledger entry and the usage settlement marks
 *   commit atomically; concurrent settlement converges on the single
 *   durable row (unique (tenant, subscription, period)); late usage
 *   after settlement stays metered but is never re-billed into the
 *   settled period.
 * - MARGIN REPORTS ARE DERIVED, NEVER A SECOND AUTHORITY:
 *   `computeMarginReport` reads settled ledger entries plus recorded
 *   cost references and computes revenue/cost/margin per currency on
 *   the fly — nothing margin-shaped is persisted.
 * - AUTHORIZATION REMAINS SEPARATE: consumed from /organizations'
 *   public interface exactly like /work, /policies, /workflow,
 *   /services. Money is exact decimal strings end to end (never binary
 *   floating point).
 */
import { defineModule } from '../../platform/module-registry/index.js';
import type { TransactionalExecutor } from '../../platform/persistence/index.js';
import type { Principal } from '../auth/index.js';
import type { AuthorizationDecision, AuthorizationDenyReason, TenancyAction } from '../organizations/index.js';
import type { ServiceDefinitionRecord } from '../services/index.js';
import { WorkError } from '../work/index.js';
import { createSqlBillingStore } from './sql-store.js';
import {
  computeCostReferenceContentHash,
  computeSubscriptionContentHash,
  computeUsageContentHash,
} from './content.js';
import { BillingError, type BillingErrorCode } from './errors.js';
import { addDecimals, canonicalDecimal, multiplyDecimals, subtractDecimals, validateAmount } from './money.js';
import {
  BillingStoreMissingError,
  BillingStoreRuleError,
  type BillingLedgerRecord,
  type BillingStore,
  type BillingSubscriptionRecord,
  type CostReferenceRecord,
  type CostReferenceSource,
  type CustomerPricingModel,
  type SubscriptionPlan,
  type UsageRecord,
  type UsageSource,
} from './store.js';

// Store port (public contract): the authoritative SQL implementation runs
// through the persistence boundary; tests inject faithful in-memory
// implementations of the same port through this surface.
export { BillingError, BillingStoreMissingError, BillingStoreRuleError, createSqlBillingStore };
export type { BillingErrorCode };
export { StoreConflictError } from './store.js';
export type {
  BillingLedgerRecord,
  BillingStore,
  BillingSubscriptionRecord,
  CostReferenceRecord,
  CostReferenceSource,
  CustomerPricingModel,
  SubscriptionPlan,
  UsageRecord,
  UsageSource,
  UsagePricing,
  WorkRate,
  RegisterSubscriptionStoreInput,
  RecordCostReferenceStoreInput,
  RecordUsageInput,
  SettlePeriodInput,
  ActivateSubscriptionInput,
  CancelSubscriptionInput,
  SubscriptionStoreRule,
  UsageStoreRule,
  LedgerStoreRule,
  CostReferenceStoreRule,
} from './store.js';
export { canonicalJson, sha256Canonical } from './content.js';
export {
  computeSubscriptionContentHash,
  computeSubscriptionRecordHash,
  computeUsageContentHash,
  computeUsageRecordHash,
  computeLedgerContentHash,
  computeLedgerRecordHash,
  computeCostReferenceContentHash,
  computeCostReferenceRecordHash,
} from './content.js';
export {
  addDecimals,
  subtractDecimals,
  multiplyDecimals,
  canonicalDecimal,
  validateAmount,
  MAX_SCALE,
} from './money.js';

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

/** The /services public surface /billing consumes (never re-implemented). */
export interface ServiceCatalog {
  /** The active service-definition version, or null. */
  resolveActiveServiceDefinition(
    principal: Principal,
    tenantId: string,
    serviceId: string,
  ): Promise<ServiceDefinitionRecord | null>;
  /** All definition versions of one service (oldest first). */
  listServiceDefinitions(
    principal: Principal,
    tenantId: string,
    serviceId: string,
    status?: 'draft' | 'active' | 'retired',
  ): Promise<ServiceDefinitionRecord[]>;
}

/** The /work public surface /billing consumes (metering references real work). */
export interface WorkIdentity {
  /** Tenant-predicated work lookup (throws typed WORK_NOT_FOUND when absent). */
  getWork(principal: Principal, tenantId: string, workId: string): Promise<{ id: string; tenantId: string }>;
}

/** The validated input of `registerSubscription`. */
export interface RegisterSubscriptionInput {
  readonly tenantId: string;
  readonly serviceId: string;
  /** The customer pricing plan (validated against the service's declared pricing metadata). */
  readonly plan: {
    readonly model: CustomerPricingModel;
    readonly currency: string;
    readonly recurring?: { readonly amount: string };
    readonly workRates?: readonly { readonly metric: string; readonly unitPrice: string }[];
  };
  readonly idempotencyKey?: string;
}

/** The validated input of `meterWorkUsage` (work-based metering, AC-1). */
export interface MeterWorkInput {
  readonly tenantId: string;
  readonly serviceId: string;
  /** The billable work identity (deduplicated: one usage row per work id). */
  readonly workId: string;
  /** The metering metric (must be declared by the pinned service version). */
  readonly metric: string;
  readonly quantity: string;
  readonly occurredAt?: Date;
  readonly idempotencyKey?: string;
}

/** The validated input of `meterOutcomeUsage` (outcome-linked billing). */
export interface MeterOutcomeInput {
  readonly tenantId: string;
  readonly serviceId: string;
  /** The verified outcome identity (must be the service's declared outcome id). */
  readonly outcomeId: string;
  readonly metric: string;
  readonly quantity: string;
  readonly occurredAt?: Date;
  readonly idempotencyKey?: string;
}

/** The validated input of `recordManualUsage` (keyed usage events). */
export interface RecordManualUsageInput {
  readonly tenantId: string;
  readonly serviceId: string;
  readonly metric: string;
  readonly quantity: string;
  readonly occurredAt?: Date;
  readonly idempotencyKey: string;
}

/** The validated input of `settleBillingPeriod`. */
export interface SettleBillingPeriodInput {
  readonly tenantId: string;
  readonly serviceId: string;
  /** 'YYYY-MM' (UTC). */
  readonly billingPeriod: string;
}

/**
 * The validated input of `recordCostReference` (AC-3): a NON-AUTHORITATIVE
 * reference to an external cost statement. The forbidden-key set below is
 * frozen: this surface cannot carry provider/model/usage breakdowns, so it
 * can never become a provider-level AI usage/cost authority.
 */
export interface RecordCostReferenceInput {
  readonly tenantId: string;
  readonly billingPeriod: string;
  readonly source: CostReferenceSource;
  readonly externalReference: string;
  readonly amount: string;
  readonly currency: string;
  readonly idempotencyKey: string;
}

/** One currency line of the derived margin report. */
export interface MarginReportLine {
  readonly currency: string;
  readonly revenue: string;
  readonly externalCosts: string;
  readonly margin: string;
  readonly settledLedgerCount: number;
  readonly costReferenceCount: number;
}

/** The derived (never persisted) margin report for one period. */
export interface MarginReport {
  readonly billingPeriod: string;
  readonly lines: readonly MarginReportLine[];
}

export interface BillingModuleOptions {
  /** Production wiring: transaction-capable persistence executor. */
  executor?: TransactionalExecutor;
  /** Test seam: inject a faithful in-memory store instead (tests only). */
  store?: BillingStore;
  /** The single authorization chain, injected by the composition root. */
  tenancy: TenancyAuthorization;
  /** The service-definition catalog (consumed public contract). */
  services: ServiceCatalog;
  /** The work identity reader (consumed public contract). */
  work: WorkIdentity;
  /** Clock injection for deterministic proofs. */
  now?: () => Date;
}

export interface BillingModule {
  /**
   * Register one subscription (starts `draft`; one live subscription per
   * (tenant, service)). The plan is validated fail-closed against the
   * ACTIVE service definition's declared pricing metadata: work-rate
   * metrics must match declared metering rules; the pricing model must
   * be self-consistent (subscription/work_based/hybrid components).
   * Duplicate registration with the same idempotency key converges on
   * identical content (typed conflict otherwise).
   */
  registerSubscription(
    principal: Principal,
    input: RegisterSubscriptionInput,
  ): Promise<{ subscription: BillingSubscriptionRecord; converged: boolean }>;
  /** Forward-only activation (draft → active); converges when active. */
  activateSubscription(
    principal: Principal,
    tenantId: string,
    subscriptionId: string,
  ): Promise<{ subscription: BillingSubscriptionRecord; converged: boolean }>;
  /** Terminal cancellation (absorbing; re-cancel converges). */
  cancelSubscription(
    principal: Principal,
    tenantId: string,
    subscriptionId: string,
  ): Promise<{ subscription: BillingSubscriptionRecord; converged: boolean }>;
  /** Tenant-predicated lookup; null when absent. */
  getSubscription(principal: Principal, tenantId: string, subscriptionId: string): Promise<BillingSubscriptionRecord | null>;
  /** Tenant-predicated list (optionally one service). */
  listSubscriptions(principal: Principal, tenantId: string, serviceId?: string): Promise<BillingSubscriptionRecord[]>;
  /** The non-cancelled subscription of one service, or null. */
  resolveActiveSubscription(principal: Principal, tenantId: string, serviceId: string): Promise<BillingSubscriptionRecord | null>;
  /**
   * Meter completed work (AC-1): records ONE durable usage row for the
   * billable work identity — duplicate metering of the same work
   * CONVERGES (identical content) or fails closed (USAGE_INPUT_CONFLICT)
   * so duplicate billable work can never double-charge. The work must
   * exist in this tenant (consumed through /work's public read).
   */
  meterWorkUsage(principal: Principal, input: MeterWorkInput): Promise<{ usage: UsageRecord; converged: boolean }>;
  /**
   * Meter a verified outcome (outcome-linked billing): the outcome must
   * be the service definition's declared outcome; deduplicated on the
   * outcome identity.
   */
  meterOutcomeUsage(principal: Principal, input: MeterOutcomeInput): Promise<{ usage: UsageRecord; converged: boolean }>;
  /** Record one keyed manual usage event (convergence by key). */
  recordManualUsage(principal: Principal, input: RecordManualUsageInput): Promise<{ usage: UsageRecord; converged: boolean }>;
  /** Tenant-predicated usage list (optionally service/period). */
  listUsageRecords(
    principal: Principal,
    tenantId: string,
    filter?: { serviceId?: string; subscriptionId?: string; billingPeriod?: string },
  ): Promise<UsageRecord[]>;
  /**
   * Settle one billing period (concurrency requirement): ONE serialized
   * critical section prices the unsettled usage through the module's
   * pure pricing policy and atomically inserts THE ledger entry for
   * (subscription, period) — concurrent settlement converges on the
   * single durable outcome; re-settling a settled period converges.
   */
  settleBillingPeriod(
    principal: Principal,
    input: SettleBillingPeriodInput,
  ): Promise<{ ledger: BillingLedgerRecord; converged: boolean }>;
  /** The settled ledger entry of one (service, period); null when absent. */
  getLedgerEntry(
    principal: Principal,
    tenantId: string,
    serviceId: string,
    billingPeriod: string,
  ): Promise<BillingLedgerRecord | null>;
  /** Tenant-predicated ledger list (optionally one period). */
  listLedgerEntries(principal: Principal, tenantId: string, billingPeriod?: string): Promise<BillingLedgerRecord[]>;
  /**
   * Record one NON-AUTHORITATIVE external cost reference (AC-3): an
   * opaque pointer to a cost statement published by the external cost
   * authority (the AI cost authority — Zeck). Provider/model/usage
   * breakdown keys fail closed; the row is a margin-analysis input,
   * never a ServiceOS AI cost ledger. Keyed convergence.
   */
  recordCostReference(
    principal: Principal,
    input: RecordCostReferenceInput,
  ): Promise<{ reference: CostReferenceRecord; converged: boolean }>;
  /** Tenant-predicated cost-reference list (optionally one period). */
  listCostReferences(principal: Principal, tenantId: string, billingPeriod?: string): Promise<CostReferenceRecord[]>;
  /**
   * Compute the margin report for one period (margin reporting inputs):
   * settled ledger revenue minus recorded external cost references, per
   * currency. DERIVED on read — nothing margin-shaped is persisted.
   */
  computeMarginReport(principal: Principal, tenantId: string, billingPeriod: string): Promise<MarginReport>;
}

// ---------------------------------------------------------------------------
// Validation (fail closed)
// ---------------------------------------------------------------------------

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SERVICE_ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
const METRIC_PATTERN = /^[a-zA-Z][a-zA-Z0-9_.-]{0,199}$/;
const OUTCOME_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_.-]{0,199}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const SINGLE_LINE_PATTERN = /^[^\n]{1,200}$/;
const MAX_WORK_RATES = 100;

/**
 * The frozen forbidden-key set for cost references: any key that could
 * smuggle a provider/model/token usage breakdown into ServiceOS fails
 * closed (AC-3 boundary — Zeck stays the AI usage/cost authority).
 */
export const COST_REFERENCE_FORBIDDEN_KEYS: readonly string[] = [
  'provider',
  'providerName',
  'providerId',
  'model',
  'modelName',
  'modelId',
  'models',
  'perModel',
  'modelRates',
  'modelRateCard',
  'providerRates',
  'rateCard',
  'tokens',
  'tokenCount',
  'tokenUsage',
  'usage',
  'usageDetail',
  'usageBreakdown',
  'llm',
  'agent',
  'prompt',
  'requests',
  'costBreakdown',
  'unitCosts',
];

function validateUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new BillingError('INVALID_INPUT', `${field} must be a UUID`);
  }
  return value;
}

function validateServiceId(value: unknown): string {
  if (typeof value !== 'string' || !SERVICE_ID_PATTERN.test(value)) {
    throw new BillingError('INVALID_INPUT', 'serviceId must be a lowercase slug of at most 64 characters');
  }
  return value;
}

function validateMetric(value: unknown): string {
  if (typeof value !== 'string' || !METRIC_PATTERN.test(value)) {
    throw new BillingError('INVALID_INPUT', 'metric must be an identifier of at most 200 characters');
  }
  return value;
}

function validateOutcomeId(value: unknown): string {
  if (typeof value !== 'string' || !OUTCOME_ID_PATTERN.test(value)) {
    throw new BillingError('INVALID_INPUT', 'outcomeId must be an identifier of at most 200 characters');
  }
  return value;
}

function validateCurrency(value: unknown, field = 'currency'): string {
  if (typeof value !== 'string' || !CURRENCY_PATTERN.test(value)) {
    throw new BillingError('INVALID_INPUT', `${field} must be a 3-letter ISO currency code`);
  }
  return value;
}

function validateBillingPeriod(value: unknown, field = 'billingPeriod'): string {
  if (typeof value !== 'string' || !PERIOD_PATTERN.test(value)) {
    throw new BillingError('PERIOD_INVALID', `${field} must be a calendar month in the form YYYY-MM`);
  }
  return value;
}

function validateSingleLine(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SINGLE_LINE_PATTERN.test(value)) {
    throw new BillingError('INVALID_INPUT', `${field} must be a single-line string of 1..200 characters`);
  }
  return value;
}

function validateIdempotencyKey(value: unknown, options: { required?: boolean } = {}): string | null {
  if (value === undefined || value === null) {
    if (options.required === true) {
      throw new BillingError('INVALID_INPUT', 'idempotencyKey is required for this registration');
    }
    return null;
  }
  if (typeof value !== 'string' || !SINGLE_LINE_PATTERN.test(value)) {
    throw new BillingError('INVALID_INPUT', 'idempotencyKey must be a single-line string of 1..200 characters');
  }
  return value;
}

function validateQuantity(value: unknown): string {
  if (typeof value !== 'string') {
    throw new BillingError('INVALID_INPUT', 'quantity must be a decimal string (e.g. "1.5")');
  }
  return validateAmount(value, 'quantity');
}

/** Derive the UTC calendar month of an instant ('YYYY-MM'). */
function billingPeriodOf(instant: Date): string {
  return instant.toISOString().slice(0, 7);
}

function validatePlanInput(
  plan: RegisterSubscriptionInput['plan'],
): { model: CustomerPricingModel; currency: string; recurringAmount: string | null; workRates: readonly { metric: string; unitPrice: string }[] } {
  if (typeof plan !== 'object' || plan === null) {
    throw new BillingError('INVALID_INPUT', 'plan must be an object');
  }
  const model = plan.model;
  if (model !== 'subscription' && model !== 'work_based' && model !== 'hybrid') {
    throw new BillingError('INVALID_INPUT', 'plan model must be one of subscription, work_based, hybrid');
  }
  const currency = validateCurrency(plan.currency, 'plan currency');
  const recurringInput = plan.recurring;
  let recurringAmount: string | null = null;
  if (recurringInput !== undefined) {
    if (typeof recurringInput !== 'object' || recurringInput === null) {
      throw new BillingError('INVALID_INPUT', 'plan recurring must be an object with an amount');
    }
    recurringAmount = validateAmount(recurringInput.amount, 'plan recurring amount');
  }
  const ratesInput = plan.workRates;
  let workRates: { metric: string; unitPrice: string }[] = [];
  if (ratesInput !== undefined) {
    if (!Array.isArray(ratesInput)) {
      throw new BillingError('INVALID_INPUT', 'plan workRates must be an array');
    }
    if (ratesInput.length > MAX_WORK_RATES) {
      throw new BillingError('INVALID_INPUT', `plan workRates must contain at most ${MAX_WORK_RATES} rates`);
    }
    const seen = new Set<string>();
    workRates = ratesInput.map((rate) => {
      if (typeof rate !== 'object' || rate === null) {
        throw new BillingError('INVALID_INPUT', 'each work rate must be an object with metric and unitPrice');
      }
      const metric = validateMetric(rate.metric);
      if (seen.has(metric)) {
        throw new BillingError('INVALID_INPUT', `work rate for metric "${metric}" is declared twice`);
      }
      seen.add(metric);
      const unitPrice = validateAmount(rate.unitPrice, `work rate "${metric}" unitPrice`);
      return { metric, unitPrice };
    });
  }
  // Model/component consistency (AC-2): each pricing model is exactly the
  // components it names — a subscription plan carries the recurring fee,
  // a work-based plan carries per-metric rates, a hybrid carries both.
  if (model === 'subscription') {
    if (recurringAmount === null) {
      throw new BillingError('INVALID_INPUT', 'a subscription plan requires a recurring amount');
    }
    if (workRates.length > 0) {
      throw new BillingError('INVALID_INPUT', 'a subscription plan carries no work rates; use work_based or hybrid');
    }
  }
  if (model === 'work_based') {
    if (workRates.length === 0) {
      throw new BillingError('INVALID_INPUT', 'a work_based plan requires at least one work rate');
    }
    if (recurringAmount !== null) {
      throw new BillingError('INVALID_INPUT', 'a work_based plan carries no recurring amount; use subscription or hybrid');
    }
  }
  if (model === 'hybrid') {
    if (recurringAmount === null || workRates.length === 0) {
      throw new BillingError('INVALID_INPUT', 'a hybrid plan requires both a recurring amount and at least one work rate');
    }
  }
  return { model, currency, recurringAmount, workRates };
}

/**
 * Validate the plan against the pinned service definition's declared
 * pricing metadata: a subscription prices ONLY what the service declares
 * as meterable (metric names must match declared metering rules).
 */
function validatePlanAgainstService(
  plan: { model: CustomerPricingModel; workRates: readonly { metric: string; unitPrice: string }[] },
  definition: ServiceDefinitionRecord,
): void {
  const declared = new Map<string, { metric: string; unit: string }>();
  for (const rule of definition.pricing.metering) {
    declared.set(rule.metric, { metric: rule.metric, unit: rule.unit });
  }
  for (const rate of plan.workRates) {
    if (!declared.has(rate.metric)) {
      throw new BillingError(
        'METERING_NOT_DECLARED',
        `work rate metric "${rate.metric}" is not declared by service definition ${definition.serviceId} v${definition.version} pricing metadata`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export function createBillingModule(options: BillingModuleOptions): BillingModule {
  if ((options.executor === undefined) === (options.store === undefined)) {
    throw new BillingError('INVALID_INPUT', 'createBillingModule requires exactly one of executor or store');
  }
  const store = options.store ?? createSqlBillingStore(options.executor as TransactionalExecutor);
  const tenancy = options.tenancy;
  const services = options.services;
  const work = options.work;
  const now = options.now ?? (() => new Date());

  /** Authorization BEFORE any domain data access (single chain). */
  async function requireTenantAccess(principal: Principal, tenantId: string, action: TenancyAction): Promise<void> {
    validateUuid(tenantId, 'tenantId');
    const decision = await tenancy.authorize(principal.id, { tenantId }, action);
    if (!decision.allowed) {
      throw denyToError(decision.reason, tenantId);
    }
  }

  /** The PINNED service definition version of a subscription (billing contract). */
  async function pinnedDefinition(
    principal: Principal,
    tenantId: string,
    serviceId: string,
    version: number,
  ): Promise<ServiceDefinitionRecord> {
    const definitions = await services.listServiceDefinitions(principal, tenantId, serviceId);
    const pinned = definitions.find((definition) => definition.version === version);
    if (pinned === undefined) {
      throw new BillingError(
        'SERVICE_NOT_ACTIVE',
        `service definition ${serviceId} v${version} (pinned by the subscription) is not registered in this tenant`,
      );
    }
    return pinned;
  }

  /** Map store errors onto the public billing error surface. */
  function mapStoreError(error: unknown): never {
    if (error instanceof BillingStoreMissingError) {
      throw new BillingError('SUBSCRIPTION_NOT_FOUND', `subscription ${error.key} not found`);
    }
    if (error instanceof BillingStoreRuleError) {
      switch (error.rule) {
        case 'idempotency-input-conflict':
          throw new BillingError('IDEMPOTENCY_INPUT_CONFLICT', error.message);
        case 'subscription-already-active':
          throw new BillingError('SUBSCRIPTION_ALREADY_ACTIVE', error.message);
        case 'subscription-lifecycle':
          throw new BillingError('SUBSCRIPTION_STATE_ILLEGAL', error.message);
        case 'subscription-record-tampered':
          throw new BillingError('SUBSCRIPTION_RECORD_TAMPERED', error.message);
        case 'usage-input-conflict':
          throw new BillingError('USAGE_INPUT_CONFLICT', error.message);
        case 'usage-record-tampered':
          throw new BillingError('USAGE_RECORD_TAMPERED', error.message);
        case 'ledger-record-tampered':
          throw new BillingError('LEDGER_RECORD_TAMPERED', error.message);
        case 'cost-reference-record-tampered':
          throw new BillingError('COST_REFERENCE_RECORD_TAMPERED', error.message);
        default:
          throw new BillingError('INVALID_INPUT', error.message);
      }
    }
    throw error;
  }

  /**
   * The PURE pricing policy of settlement: the subscription component is
   * the plan's recurring fee; the usage component is the exact-decimal
   * sum of quantity x unit price over the metering metrics the plan
   * prices (metered usage without a rate contributes ZERO charge —
   * metering is measurement, charging follows the plan).
   */
  function pricingPolicyFor(plan: SubscriptionPlan): (usage: readonly UsageRecord[]) => {
    subscriptionCharge: string;
    usageCharge: string;
    totalCharge: string;
  } {
    const rates = new Map<string, string>();
    for (const rate of plan.workRates) {
      rates.set(rate.metric, rate.unitPrice);
    }
    return (usage) => {
      let usageCharge = '0';
      for (const record of usage) {
        const unitPrice = rates.get(record.metric);
        if (unitPrice === undefined) {
          continue;
        }
        usageCharge = addDecimals(usageCharge, multiplyDecimals(unitPrice, record.quantity));
      }
      const subscriptionCharge = plan.recurringAmount ?? '0';
      return {
        subscriptionCharge: canonicalDecimal(subscriptionCharge),
        usageCharge: canonicalDecimal(usageCharge),
        totalCharge: canonicalDecimal(addDecimals(subscriptionCharge, usageCharge)),
      };
    };
  }

  return {
    async registerSubscription(principal, input) {
      await requireTenantAccess(principal, input.tenantId, 'write');
      const serviceId = validateServiceId(input.serviceId);
      const plan = validatePlanInput(input.plan);
      const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);

      // Binding validation through /services' public interface: the plan
      // prices the ACTIVE definition's declared metering surface.
      const active = await services.resolveActiveServiceDefinition(principal, input.tenantId, serviceId);
      if (active === null) {
        throw new BillingError(
          'SERVICE_NOT_ACTIVE',
          `service ${serviceId} has no active definition in this tenant; a subscription binds the active version`,
        );
      }
      validatePlanAgainstService(plan, active);

      const nowInstant = now();
      const contentHash = computeSubscriptionContentHash({
        tenantId: input.tenantId,
        serviceId,
        serviceVersion: active.version,
        plan: { model: plan.model, currency: plan.currency, recurringAmount: plan.recurringAmount, workRates: plan.workRates },
      });
      try {
        return await store.registerSubscription({
          tenantId: input.tenantId,
          serviceId,
          serviceVersion: active.version,
          plan: { model: plan.model, currency: plan.currency, recurringAmount: plan.recurringAmount, workRates: plan.workRates },
          createdBy: principal.id,
          idempotencyKey,
          contentHash,
          now: nowInstant,
        });
      } catch (error) {
        mapStoreError(error);
      }
    },

    async activateSubscription(principal, tenantId, subscriptionId) {
      await requireTenantAccess(principal, tenantId, 'write');
      validateUuid(subscriptionId, 'subscriptionId');
      try {
        return await store.activateSubscription({ tenantId, subscriptionId, now: now() });
      } catch (error) {
        mapStoreError(error);
      }
    },

    async cancelSubscription(principal, tenantId, subscriptionId) {
      await requireTenantAccess(principal, tenantId, 'write');
      validateUuid(subscriptionId, 'subscriptionId');
      try {
        return await store.cancelSubscription({ tenantId, subscriptionId, now: now() });
      } catch (error) {
        mapStoreError(error);
      }
    },

    async getSubscription(principal, tenantId, subscriptionId) {
      await requireTenantAccess(principal, tenantId, 'read');
      validateUuid(subscriptionId, 'subscriptionId');
      try {
        return await store.findSubscription(tenantId, subscriptionId);
      } catch (error) {
        mapStoreError(error);
      }
    },

    async listSubscriptions(principal, tenantId, serviceId) {
      await requireTenantAccess(principal, tenantId, 'read');
      if (serviceId !== undefined) {
        validateServiceId(serviceId);
      }
      try {
        return await store.listSubscriptions(tenantId, serviceId);
      } catch (error) {
        mapStoreError(error);
      }
    },

    async resolveActiveSubscription(principal, tenantId, serviceId) {
      await requireTenantAccess(principal, tenantId, 'read');
      validateServiceId(serviceId);
      try {
        return await store.findLiveSubscription(tenantId, serviceId);
      } catch (error) {
        mapStoreError(error);
      }
    },

    async meterWorkUsage(principal, input) {
      await requireTenantAccess(principal, input.tenantId, 'write');
      const serviceId = validateServiceId(input.serviceId);
      const workId = validateUuid(input.workId, 'workId');
      const metric = validateMetric(input.metric);
      const quantity = validateQuantity(input.quantity);
      const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);
      const occurredAt = input.occurredAt ?? now();

      // The billing relationship must be live.
      const subscription = await store.findLiveSubscription(input.tenantId, serviceId);
      if (subscription === null) {
        throw new BillingError('SUBSCRIPTION_NOT_ACTIVE', `service ${serviceId} has no live subscription in this tenant`);
      }
      // Metering validates against the PINNED version (the billing contract).
      const definition = await pinnedDefinition(principal, input.tenantId, serviceId, subscription.serviceVersion);
      const declared = definition.pricing.metering.find((rule) => rule.metric === metric);
      if (declared === undefined) {
        throw new BillingError(
          'METERING_NOT_DECLARED',
          `metering metric "${metric}" is not declared by service definition ${serviceId} v${subscription.serviceVersion}`,
        );
      }
      // The billable work identity must exist in this tenant — consumed
      // through /work's public read contract (never a second work store).
      try {
        await work.getWork(principal, input.tenantId, workId);
      } catch (error) {
        if (error instanceof WorkError && error.code === 'WORK_NOT_FOUND') {
          throw new BillingError('WORK_NOT_FOUND', `work ${workId} does not exist in this tenant`);
        }
        throw error;
      }

      const nowInstant = now();
      const contentHash = computeUsageContentHash({
        tenantId: input.tenantId,
        subscriptionId: subscription.id,
        serviceId,
        serviceVersion: subscription.serviceVersion,
        source: 'work',
        metric,
        unit: declared.unit,
        quantity,
        workId,
        outcomeId: null,
        occurredAt,
        billingPeriod: billingPeriodOf(occurredAt),
      });
      try {
        return await store.recordUsage({
          tenantId: input.tenantId,
          subscriptionId: subscription.id,
          serviceId,
          serviceVersion: subscription.serviceVersion,
          source: 'work',
          metric,
          unit: declared.unit,
          quantity,
          workId,
          outcomeId: null,
          occurredAt,
          billingPeriod: billingPeriodOf(occurredAt),
          createdBy: principal.id,
          idempotencyKey,
          contentHash,
          now: nowInstant,
        });
      } catch (error) {
        mapStoreError(error);
      }
    },

    async meterOutcomeUsage(principal, input) {
      await requireTenantAccess(principal, input.tenantId, 'write');
      const serviceId = validateServiceId(input.serviceId);
      const outcomeId = validateOutcomeId(input.outcomeId);
      const metric = validateMetric(input.metric);
      const quantity = validateQuantity(input.quantity);
      const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);
      const occurredAt = input.occurredAt ?? now();

      const subscription = await store.findLiveSubscription(input.tenantId, serviceId);
      if (subscription === null) {
        throw new BillingError('SUBSCRIPTION_NOT_ACTIVE', `service ${serviceId} has no live subscription in this tenant`);
      }
      const definition = await pinnedDefinition(principal, input.tenantId, serviceId, subscription.serviceVersion);
      // Outcome-linked billing binds the DECLARED outcome contract.
      if (definition.outcomeContract.outcomeId !== outcomeId) {
        throw new BillingError(
          'OUTCOME_NOT_DECLARED',
          `outcome "${outcomeId}" is not the outcome contract of service definition ${serviceId} v${subscription.serviceVersion}`,
        );
      }
      const declared = definition.pricing.metering.find((rule) => rule.metric === metric);
      if (declared === undefined) {
        throw new BillingError(
          'METERING_NOT_DECLARED',
          `metering metric "${metric}" is not declared by service definition ${serviceId} v${subscription.serviceVersion}`,
        );
      }

      const nowInstant = now();
      const contentHash = computeUsageContentHash({
        tenantId: input.tenantId,
        subscriptionId: subscription.id,
        serviceId,
        serviceVersion: subscription.serviceVersion,
        source: 'outcome',
        metric,
        unit: declared.unit,
        quantity,
        workId: null,
        outcomeId,
        occurredAt,
        billingPeriod: billingPeriodOf(occurredAt),
      });
      try {
        return await store.recordUsage({
          tenantId: input.tenantId,
          subscriptionId: subscription.id,
          serviceId,
          serviceVersion: subscription.serviceVersion,
          source: 'outcome',
          metric,
          unit: declared.unit,
          quantity,
          workId: null,
          outcomeId,
          occurredAt,
          billingPeriod: billingPeriodOf(occurredAt),
          createdBy: principal.id,
          idempotencyKey,
          contentHash,
          now: nowInstant,
        });
      } catch (error) {
        mapStoreError(error);
      }
    },

    async recordManualUsage(principal, input) {
      await requireTenantAccess(principal, input.tenantId, 'write');
      const serviceId = validateServiceId(input.serviceId);
      const metric = validateMetric(input.metric);
      const quantity = validateQuantity(input.quantity);
      const idempotencyKey = validateIdempotencyKey(input.idempotencyKey, { required: true });
      const occurredAt = input.occurredAt ?? now();

      const subscription = await store.findLiveSubscription(input.tenantId, serviceId);
      if (subscription === null) {
        throw new BillingError('SUBSCRIPTION_NOT_ACTIVE', `service ${serviceId} has no live subscription in this tenant`);
      }
      const definition = await pinnedDefinition(principal, input.tenantId, serviceId, subscription.serviceVersion);
      const declared = definition.pricing.metering.find((rule) => rule.metric === metric);
      if (declared === undefined) {
        throw new BillingError(
          'METERING_NOT_DECLARED',
          `metering metric "${metric}" is not declared by service definition ${serviceId} v${subscription.serviceVersion}`,
        );
      }

      const nowInstant = now();
      const contentHash = computeUsageContentHash({
        tenantId: input.tenantId,
        subscriptionId: subscription.id,
        serviceId,
        serviceVersion: subscription.serviceVersion,
        source: 'manual',
        metric,
        unit: declared.unit,
        quantity,
        workId: null,
        outcomeId: null,
        occurredAt,
        billingPeriod: billingPeriodOf(occurredAt),
      });
      try {
        return await store.recordUsage({
          tenantId: input.tenantId,
          subscriptionId: subscription.id,
          serviceId,
          serviceVersion: subscription.serviceVersion,
          source: 'manual',
          metric,
          unit: declared.unit,
          quantity,
          workId: null,
          outcomeId: null,
          occurredAt,
          billingPeriod: billingPeriodOf(occurredAt),
          createdBy: principal.id,
          idempotencyKey,
          contentHash,
          now: nowInstant,
        });
      } catch (error) {
        mapStoreError(error);
      }
    },

    async listUsageRecords(principal, tenantId, filter) {
      await requireTenantAccess(principal, tenantId, 'read');
      if (filter?.serviceId !== undefined) {
        validateServiceId(filter.serviceId);
      }
      if (filter?.subscriptionId !== undefined) {
        validateUuid(filter.subscriptionId, 'subscriptionId');
      }
      if (filter?.billingPeriod !== undefined) {
        validateBillingPeriod(filter.billingPeriod);
      }
      try {
        return await store.listUsage(tenantId, {
          ...(filter?.subscriptionId !== undefined ? { subscriptionId: filter.subscriptionId } : {}),
          ...(filter?.billingPeriod !== undefined ? { billingPeriod: filter.billingPeriod } : {}),
        });
      } catch (error) {
        mapStoreError(error);
      }
    },

    async settleBillingPeriod(principal, input) {
      await requireTenantAccess(principal, input.tenantId, 'write');
      const serviceId = validateServiceId(input.serviceId);
      const billingPeriod = validateBillingPeriod(input.billingPeriod);

      const subscription = await store.findLiveSubscription(input.tenantId, serviceId);
      if (subscription === null) {
        throw new BillingError(
          'SUBSCRIPTION_NOT_ACTIVE',
          `service ${serviceId} has no live subscription in this tenant; settle an active or cancelled subscription`,
        );
      }
      if (subscription.status === 'draft') {
        throw new BillingError('SUBSCRIPTION_NOT_ACTIVE', 'a draft subscription has no billing relationship to settle');
      }

      const nowInstant = now();
      try {
        return await store.settlePeriod({
          tenantId: input.tenantId,
          subscriptionId: subscription.id,
          serviceId,
          billingPeriod,
          currency: subscription.plan.currency,
          settledBy: principal.id,
          // The module's pure pricing policy (never store-owned). The
          // store computes the ledger content/record hashes over the
          // PRICED outcome inside the critical section.
          priceUsage: pricingPolicyFor(subscription.plan),
          now: nowInstant,
        });
      } catch (error) {
        mapStoreError(error);
      }
    },

    async getLedgerEntry(principal, tenantId, serviceId, billingPeriod) {
      await requireTenantAccess(principal, tenantId, 'read');
      validateServiceId(serviceId);
      validateBillingPeriod(billingPeriod);
      const subscription = await store.findLiveSubscription(tenantId, serviceId);
      if (subscription === null) {
        return null;
      }
      try {
        return await store.findLedgerEntry(tenantId, subscription.id, billingPeriod);
      } catch (error) {
        mapStoreError(error);
      }
    },

    async listLedgerEntries(principal, tenantId, billingPeriod) {
      await requireTenantAccess(principal, tenantId, 'read');
      if (billingPeriod !== undefined) {
        validateBillingPeriod(billingPeriod);
      }
      try {
        return await store.listLedgerEntries(tenantId, billingPeriod);
      } catch (error) {
        mapStoreError(error);
      }
    },

    async recordCostReference(principal, input) {
      await requireTenantAccess(principal, input.tenantId, 'write');
      const billingPeriod = validateBillingPeriod(input.billingPeriod);
      const externalReference = validateSingleLine(input.externalReference, 'externalReference');
      // AC-3 boundary: this surface is an opaque reference + reported
      // total. Any provider/model/usage-breakdown key fails closed —
      // ServiceOS never becomes a provider-level AI cost authority.
      if (typeof input !== 'object' || input === null) {
        throw new BillingError('INVALID_INPUT', 'cost reference input must be an object');
      }
      for (const key of Object.keys(input)) {
        if (COST_REFERENCE_FORBIDDEN_KEYS.includes(key)) {
          throw new BillingError(
            'AI_COST_BREAKDOWN_FORBIDDEN',
            `cost reference carries forbidden key "${key}"; ServiceOS consumes opaque external cost statements for margin analysis and never persists a provider/model usage breakdown (Zeck stays the AI usage/cost authority)`,
          );
        }
      }
      if (input.source !== 'ai_authority') {
        throw new BillingError(
          'INVALID_INPUT',
          'cost reference source must be "ai_authority" (the external AI cost authority domain); no provider-specific source exists',
        );
      }
      const amount = validateAmount(input.amount, 'cost reference amount', { allowZero: true });
      const currency = validateCurrency(input.currency, 'cost reference currency');
      const idempotencyKey = validateIdempotencyKey(input.idempotencyKey, { required: true });
      if (idempotencyKey === null) {
        // Unreachable (required above) but keeps the non-null invariant
        // explicit for the store input contract.
        throw new BillingError('INVALID_INPUT', 'cost reference idempotencyKey is required');
      }

      const nowInstant = now();
      const contentHash = computeCostReferenceContentHash({
        tenantId: input.tenantId,
        billingPeriod,
        source: 'ai_authority',
        externalReference,
        amount,
        currency,
      });
      try {
        return await store.recordCostReference({
          tenantId: input.tenantId,
          billingPeriod,
          source: 'ai_authority',
          externalReference,
          amount,
          currency,
          recordedBy: principal.id,
          idempotencyKey,
          contentHash,
          now: nowInstant,
        });
      } catch (error) {
        mapStoreError(error);
      }
    },

    async listCostReferences(principal, tenantId, billingPeriod) {
      await requireTenantAccess(principal, tenantId, 'read');
      if (billingPeriod !== undefined) {
        validateBillingPeriod(billingPeriod);
      }
      try {
        return await store.listCostReferences(tenantId, billingPeriod);
      } catch (error) {
        mapStoreError(error);
      }
    },

    async computeMarginReport(principal, tenantId, billingPeriod) {
      await requireTenantAccess(principal, tenantId, 'read');
      validateBillingPeriod(billingPeriod);
      const [ledger, references] = await Promise.all([
        store.listLedgerEntries(tenantId, billingPeriod).catch(mapStoreError),
        store.listCostReferences(tenantId, billingPeriod).catch(mapStoreError),
      ]);
      const lines = new Map<
        string,
        { currency: string; revenue: string; externalCosts: string; margin: string; settledLedgerCount: number; costReferenceCount: number }
      >();
      for (const entry of ledger) {
        const line = lines.get(entry.currency) ?? {
          currency: entry.currency,
          revenue: '0',
          externalCosts: '0',
          margin: '0',
          settledLedgerCount: 0,
          costReferenceCount: 0,
        };
        line.revenue = addDecimals(line.revenue, entry.totalCharge);
        line.settledLedgerCount += 1;
        lines.set(entry.currency, line);
      }
      for (const reference of references) {
        const line = lines.get(reference.currency) ?? {
          currency: reference.currency,
          revenue: '0',
          externalCosts: '0',
          margin: '0',
          settledLedgerCount: 0,
          costReferenceCount: 0,
        };
        line.externalCosts = addDecimals(line.externalCosts, reference.amount);
        line.costReferenceCount += 1;
        lines.set(reference.currency, line);
      }
      return {
        billingPeriod,
        lines: [...lines.values()]
          .map((line) => ({
            currency: line.currency,
            revenue: line.revenue,
            externalCosts: line.externalCosts,
            // Margin may be negative — reported as an exact signed decimal.
            margin: canonicalDecimal(subtractDecimals(line.revenue, line.externalCosts)),
            settledLedgerCount: line.settledLedgerCount,
            costReferenceCount: line.costReferenceCount,
          }))
          .sort((a, b) => (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0)),
      };
    },
  };
}

function denyToError(reason: AuthorizationDenyReason | undefined, tenantId: string): BillingError {
  switch (reason) {
    case 'TENANT_NOT_FOUND':
      return new BillingError('TENANT_NOT_FOUND', `service tenant ${tenantId} does not exist`);
    case 'TENANT_SUSPENDED':
      return new BillingError('TENANT_SUSPENDED', `service tenant ${tenantId} is suspended`);
    case 'ORGANIZATION_NOT_FOUND':
      return new BillingError('TENANT_NOT_FOUND', `the tenant's organization no longer exists`);
    case 'ORGANIZATION_SUSPENDED':
      return new BillingError('ORGANIZATION_SUSPENDED', 'the owning organization is suspended');
    case 'MEMBERSHIP_FORBIDDEN':
      return new BillingError('TENANT_FORBIDDEN', 'the principal has no active membership granting this tenant');
    case 'ROLE_FORBIDDEN':
      return new BillingError('ROLE_FORBIDDEN', 'the principal role does not grant the required capability');
    default:
      return new BillingError('TENANT_FORBIDDEN', 'authorization denied');
  }
}

export default defineModule({
  name: 'billing',
  version: '0.1.0',
  description: 'customer subscriptions, metering and service economics',
});
