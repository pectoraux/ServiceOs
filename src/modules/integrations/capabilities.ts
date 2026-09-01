/**
 * ServiceOS /integrations capability contracts (WORK-015, module internal —
 * exported through the module's public interface).
 *
 * The provider-neutral external-effect capability classes
 * (integration-model.md "Initial integration categories", minus Zeck: the
 * AI execution boundary is the /zeck module owned by WORK-005 — /integrations
 * covers the NON-AI external systems only; "duplicated Zeck authority" is a
 * forbidden surface of this Work Order).
 *
 * - THE CAPABILITY TAXONOMY IS FROZEN CODE, NOT DATA: the class list and
 *   the per-class parameter contracts are the ServiceOS-owned contracts
 *   every provider adapter must translate to/from (the "adapter rule":
 *   an adapter translates between an external system and a
 *   ServiceOS-owned contract; it does not own Service Work state).
 * - ONE CONTRACT PER CAPABILITY CLASS (AC-2): each class names exactly one
 *   provider-neutral parameter contract; adapters are selected behind that
 *   contract (registry.ts), never by provider name, from business modules.
 * - VALIDATION IS FAIL-CLOSED: `validateEffectParams` rejects unknown keys,
 *   wrong types, empty required values and unbounded sizes, and returns a
 *   frozen validated copy — the durable interaction intent (persisted by
 *   /interactions) carries only contract-valid parameters.
 */
import { IntegrationsError } from './errors.js';

/**
 * The frozen provider-neutral capability classes. Zeck is deliberately
 * absent (AI execution is the /zeck module's boundary, WORK-005).
 */
export const CAPABILITY_CLASSES = [
  'email',
  'sms',
  'voice',
  'accounting_erp',
  'crm',
  'construction_management',
  'property_management',
  'procurement',
  'payment',
  'document_storage',
  'government_portal',
] as const;

export type CapabilityClass = (typeof CAPABILITY_CLASSES)[number];

export function isCapabilityClass(value: unknown): value is CapabilityClass {
  return typeof value === 'string' && (CAPABILITY_CLASSES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Per-class provider-neutral parameter contracts
// ---------------------------------------------------------------------------

/** Email effect: one message to one or more recipients. */
export interface EmailEffectParams {
  readonly to: readonly string[];
  readonly cc?: readonly string[];
  readonly subject: string;
  readonly body: string;
}

/** SMS effect: one short message to one number. */
export interface SmsEffectParams {
  readonly to: string;
  readonly body: string;
}

/** Voice/telephony effect: one spoken message to one number. */
export interface VoiceEffectParams {
  readonly to: string;
  readonly message: string;
}

/**
 * Business-system record effect (accounting/ERP, CRM, construction
 * management, property management, procurement): one operation against one
 * record type of one named external system.
 */
export interface BusinessSystemEffectParams {
  readonly system: string;
  readonly operation: 'create_record' | 'update_record' | 'post_entry' | 'sync_record';
  readonly recordType: string;
  readonly fields: Readonly<Record<string, string | number | boolean | null>>;
}

/** Payment effect: initiate or refund one payment by business reference. */
export interface PaymentEffectParams {
  readonly operation: 'initiate_payment' | 'refund_payment';
  /** Decimal amount as a string (never a float; provider formatting is the adapter's). */
  readonly amount: string;
  readonly currency: string;
  readonly reference: string;
}

/** Document-storage effect: store or retrieve one document by reference. */
export interface DocumentStorageEffectParams {
  readonly operation: 'store_document' | 'retrieve_document';
  readonly documentType: string;
  readonly contentRef: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

/** Government-portal effect: submit one form or check one submission. */
export interface GovernmentPortalEffectParams {
  readonly portal: string;
  readonly operation: 'submit_form' | 'check_status';
  readonly formType: string;
  readonly fields: Readonly<Record<string, string | number | boolean | null>>;
}

/** The provider-neutral parameter contract of each capability class. */
export interface CapabilityParamsMap {
  readonly email: EmailEffectParams;
  readonly sms: SmsEffectParams;
  readonly voice: VoiceEffectParams;
  readonly accounting_erp: BusinessSystemEffectParams;
  readonly crm: BusinessSystemEffectParams;
  readonly construction_management: BusinessSystemEffectParams;
  readonly property_management: BusinessSystemEffectParams;
  readonly procurement: BusinessSystemEffectParams;
  readonly payment: PaymentEffectParams;
  readonly document_storage: DocumentStorageEffectParams;
  readonly government_portal: GovernmentPortalEffectParams;
}

// ---------------------------------------------------------------------------
// Validation (fail closed; frozen validated copies)
// ---------------------------------------------------------------------------

const MAX_BODY_CHARS = 100_000;
const MAX_SUBJECT_CHARS = 1_000;
const MAX_RECIPIENTS = 50;
const MAX_FIELD_ENTRIES = 100;
const MAX_FIELD_VALUE_CHARS = 10_000;
const MAX_METADATA_ENTRIES = 50;
const AMOUNT_PATTERN = /^\d+(\.\d+)?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(capability: CapabilityClass, what: string): never {
  throw new IntegrationsError('INVALID_PARAMS', `${capability} effect params: ${what}`);
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= max;
}

/** Require exactly these keys present/absent (unknown keys are rejected). */
function requireKeys(capability: CapabilityClass, params: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(params)) {
    if (!allowed.includes(key)) {
      fail(capability, `unknown key "${key}" (allowed: ${allowed.join(', ')})`);
    }
  }
}

function optional(
  capability: CapabilityClass,
  params: Record<string, unknown>,
  key: string,
  max: number,
): string | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (!isBoundedString(value, max)) {
    fail(capability, `${key} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

function requireString(capability: CapabilityClass, params: Record<string, unknown>, key: string, max: number): string {
  const value = params[key];
  if (!isBoundedString(value, max)) {
    fail(capability, `${key} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

function requireStringList(
  capability: CapabilityClass,
  value: unknown,
  key: string,
  maxItems: number,
  maxChars: number,
): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) {
    fail(capability, `${key} must be a non-empty array of at most ${maxItems} addresses`);
  }
  const out: string[] = [];
  for (const entry of value) {
    if (!isBoundedString(entry, maxChars)) {
      fail(capability, `every ${key} entry must be a non-empty string of at most ${maxChars} characters`);
    }
    out.push(entry);
  }
  return out;
}

function requireFields(
  capability: CapabilityClass,
  value: unknown,
  maxEntries: number,
): Record<string, string | number | boolean | null> {
  if (!isPlainObject(value)) {
    fail(capability, 'fields must be an object');
  }
  const entries = Object.entries(value);
  if (entries.length > maxEntries) {
    fail(capability, `fields must carry at most ${maxEntries} entries`);
  }
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, entry] of entries) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(key)) {
      fail(capability, `field key "${key}" must match [A-Za-z0-9_.-]{1,64}`);
    }
    if (typeof entry === 'string') {
      if (entry.length > MAX_FIELD_VALUE_CHARS) {
        fail(capability, `field "${key}" value exceeds ${MAX_FIELD_VALUE_CHARS} characters`);
      }
    } else if (typeof entry !== 'number' && typeof entry !== 'boolean' && entry !== null) {
      fail(capability, `field "${key}" value must be a string, number, boolean or null`);
    }
    out[key] = entry;
  }
  return out;
}

type ValidatedParams = Record<string, unknown>;

/** Validate one email parameter contract. */
function validateEmail(capability: CapabilityClass, params: Record<string, unknown>): ValidatedParams {
  requireKeys(capability, params, ['to', 'cc', 'subject', 'body']);
  const to = requireStringList(capability, params['to'], 'to', MAX_RECIPIENTS, 320);
  let cc: string[] | undefined;
  if (params['cc'] !== undefined) {
    cc = requireStringList(capability, params['cc'], 'cc', MAX_RECIPIENTS, 320);
  }
  const subject = requireString(capability, params, 'subject', MAX_SUBJECT_CHARS);
  const body = requireString(capability, params, 'body', MAX_BODY_CHARS);
  return cc === undefined ? { to, subject, body } : { to, cc, subject, body };
}

/** Validate one SMS parameter contract. */
function validateSms(capability: CapabilityClass, params: Record<string, unknown>): ValidatedParams {
  requireKeys(capability, params, ['to', 'body']);
  return { to: requireString(capability, params, 'to', 32), body: requireString(capability, params, 'body', 1_600) };
}

/** Validate one voice parameter contract. */
function validateVoice(capability: CapabilityClass, params: Record<string, unknown>): ValidatedParams {
  requireKeys(capability, params, ['to', 'message']);
  return { to: requireString(capability, params, 'to', 32), message: requireString(capability, params, 'message', MAX_BODY_CHARS) };
}

const BUSINESS_SYSTEM_OPERATIONS = ['create_record', 'update_record', 'post_entry', 'sync_record'] as const;

/** Validate one business-system record contract. */
function validateBusinessSystem(capability: CapabilityClass, params: Record<string, unknown>): ValidatedParams {
  requireKeys(capability, params, ['system', 'operation', 'recordType', 'fields']);
  const system = requireString(capability, params, 'system', 200);
  const operation = params['operation'];
  if (typeof operation !== 'string' || !(BUSINESS_SYSTEM_OPERATIONS as readonly string[]).includes(operation)) {
    fail(capability, `operation must be one of ${BUSINESS_SYSTEM_OPERATIONS.join(', ')}`);
  }
  const recordType = requireString(capability, params, 'recordType', 200);
  return { system, operation, recordType, fields: requireFields(capability, params['fields'], MAX_FIELD_ENTRIES) };
}

/** Validate one payment contract. */
function validatePayment(capability: CapabilityClass, params: Record<string, unknown>): ValidatedParams {
  requireKeys(capability, params, ['operation', 'amount', 'currency', 'reference']);
  const operation = params['operation'];
  if (operation !== 'initiate_payment' && operation !== 'refund_payment') {
    fail(capability, 'operation must be initiate_payment or refund_payment');
  }
  const amount = requireString(capability, params, 'amount', 32);
  if (!AMOUNT_PATTERN.test(amount)) {
    fail(capability, `amount "${amount}" must be a non-negative decimal string like "12.34"`);
  }
  const currency = requireString(capability, params, 'currency', 3);
  if (!CURRENCY_PATTERN.test(currency)) {
    fail(capability, `currency "${currency}" must be an ISO-4217-style 3-letter code`);
  }
  const reference = requireString(capability, params, 'reference', 200);
  return { operation, amount, currency, reference };
}

const DOCUMENT_OPERATIONS = ['store_document', 'retrieve_document'] as const;

/** Validate one document-storage contract. */
function validateDocumentStorage(capability: CapabilityClass, params: Record<string, unknown>): ValidatedParams {
  requireKeys(capability, params, ['operation', 'documentType', 'contentRef', 'metadata']);
  const operation = params['operation'];
  if (typeof operation !== 'string' || !(DOCUMENT_OPERATIONS as readonly string[]).includes(operation)) {
    fail(capability, `operation must be one of ${DOCUMENT_OPERATIONS.join(', ')}`);
  }
  const documentType = requireString(capability, params, 'documentType', 200);
  const contentRef = requireString(capability, params, 'contentRef', 500);
  let metadata: Record<string, string> | undefined;
  if (params['metadata'] !== undefined) {
    if (!isPlainObject(params['metadata'])) {
      fail(capability, 'metadata must be an object');
    }
    const entries = Object.entries(params['metadata']);
    if (entries.length > MAX_METADATA_ENTRIES) {
      fail(capability, `metadata must carry at most ${MAX_METADATA_ENTRIES} entries`);
    }
    metadata = {};
    for (const [key, value] of entries) {
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(key) || typeof value !== 'string' || value.length > 500) {
        fail(capability, `metadata "${key}" must map to a string of at most 500 characters`);
      }
      metadata[key] = value;
    }
  }
  return metadata === undefined
    ? { operation, documentType, contentRef }
    : { operation, documentType, contentRef, metadata };
}

const PORTAL_OPERATIONS = ['submit_form', 'check_status'] as const;

/** Validate one government-portal contract. */
function validateGovernmentPortal(capability: CapabilityClass, params: Record<string, unknown>): ValidatedParams {
  requireKeys(capability, params, ['portal', 'operation', 'formType', 'fields']);
  const portal = requireString(capability, params, 'portal', 200);
  const operation = params['operation'];
  if (typeof operation !== 'string' || !(PORTAL_OPERATIONS as readonly string[]).includes(operation)) {
    fail(capability, `operation must be one of ${PORTAL_OPERATIONS.join(', ')}`);
  }
  const formType = requireString(capability, params, 'formType', 200);
  return { portal, operation, formType, fields: requireFields(capability, params['fields'], MAX_FIELD_ENTRIES) };
}

/**
 * Validate provider-neutral effect params for one capability class against
 * its frozen ServiceOS contract. Fail closed (INVALID_PARAMS) on unknown
 * keys, wrong shapes, empty required values or unbounded sizes; returns a
 * frozen validated copy safe to persist as durable intent.
 */
export function validateEffectParams(capability: CapabilityClass, params: unknown): Readonly<Record<string, unknown>> {
  if (!isPlainObject(params)) {
    throw new IntegrationsError('INVALID_PARAMS', `${capability} effect params must be an object`);
  }
  let validated: ValidatedParams;
  switch (capability) {
    case 'email':
      validated = validateEmail(capability, params);
      break;
    case 'sms':
      validated = validateSms(capability, params);
      break;
    case 'voice':
      validated = validateVoice(capability, params);
      break;
    case 'accounting_erp':
    case 'crm':
    case 'construction_management':
    case 'property_management':
    case 'procurement':
      validated = validateBusinessSystem(capability, params);
      break;
    case 'payment':
      validated = validatePayment(capability, params);
      break;
    case 'document_storage':
      validated = validateDocumentStorage(capability, params);
      break;
    case 'government_portal':
      validated = validateGovernmentPortal(capability, params);
      break;
  }
  return deepFreeze(validated);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}
