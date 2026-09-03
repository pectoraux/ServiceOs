/**
 * ServiceOS /entities input validation (WORK-010, module internal —
 * exported through the module's public interface).
 *
 * Fail-closed validation of entity-instance inputs against the
 * REGISTERED vertical package declaration (fetched through /verticals'
 * public read — never a second package registry):
 *
 * - the package must be registered in this tenant (a missing package
 *   is a typed `VERTICAL_PACKAGE_NOT_FOUND`, distinct from an empty
 *   result — architecture-lock #30);
 * - the entity TYPE must be declared by that exact package version
 *   (`ENTITY_TYPE_NOT_DECLARED`);
 * - every provided FIELD must be declared for that entity type
 *   (`FIELD_NOT_DECLARED`);
 * - every declared REQUIRED field must be present
 *   (`FIELD_REQUIRED`);
 * - every value must match the declared field TYPE
 *   (`FIELD_TYPE_MISMATCH`); 'date' fields carry ISO-8601 strings
 *   validated parseable and normalized to `toISOString()` form.
 */
import { EntitiesError, type EntitiesErrorCode } from './errors.js';
import type { EntityDefinition } from '../verticals/index.js';
import type { EntityFieldValue } from './store.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PACKAGE_ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
const ENTITY_TYPE_PATTERN = /^[a-zA-Z][a-zA-Z0-9_.-]{0,199}$/;
const KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,200}$/;

export interface CreateEntityInstanceInput {
  readonly tenantId: string;
  readonly packageId: string;
  readonly packageVersion: number;
  readonly entityType: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly idempotencyKey?: string;
}

/** The validated, frozen canonical form of a create input. */
export interface ValidatedCreateEntityInstanceInput {
  readonly tenantId: string;
  readonly packageId: string;
  readonly packageVersion: number;
  readonly entityType: string;
  readonly fields: Readonly<Record<string, EntityFieldValue>>;
  readonly idempotencyKey: string | null;
}

function fail(code: EntitiesErrorCode, message: string): never {
  throw new EntitiesError(code, message);
}

function validateUuid(value: unknown, what: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    fail('INVALID_INPUT', `${what} must be a UUID`);
  }
  return value;
}

/** Validate the envelope (before the package declaration is consulted). */
export function validateCreateEntityInstanceEnvelope(raw: CreateEntityInstanceInput): {
  tenantId: string;
  packageId: string;
  packageVersion: number;
  entityType: string;
  fields: Readonly<Record<string, unknown>>;
  idempotencyKey: string | null;
} {
  if (typeof raw !== 'object' || raw === null) {
    fail('INVALID_INPUT', 'the create-entity-instance input must be an object');
  }
  const tenantId = validateUuid(raw.tenantId, 'tenantId');
  if (typeof raw.packageId !== 'string' || !PACKAGE_ID_PATTERN.test(raw.packageId)) {
    fail('INVALID_INPUT', 'packageId must be a lowercase slug of at most 64 characters');
  }
  if (typeof raw.packageVersion !== 'number' || !Number.isInteger(raw.packageVersion) || raw.packageVersion < 1) {
    fail('INVALID_INPUT', 'packageVersion must be a positive integer');
  }
  if (typeof raw.entityType !== 'string' || !ENTITY_TYPE_PATTERN.test(raw.entityType)) {
    fail('INVALID_INPUT', 'entityType must match the identifier pattern');
  }
  if (typeof raw.fields !== 'object' || raw.fields === null || Array.isArray(raw.fields)) {
    fail('INVALID_INPUT', 'fields must be an object');
  }
  if (Object.keys(raw.fields).length > 100) {
    fail('INVALID_INPUT', 'fields accepts at most 100 entries');
  }
  let idempotencyKey: string | null = null;
  if (raw.idempotencyKey !== undefined && raw.idempotencyKey !== null) {
    if (typeof raw.idempotencyKey !== 'string' || !KEY_PATTERN.test(raw.idempotencyKey)) {
      fail('INVALID_INPUT', 'idempotencyKey must be a non-empty string of at most 200 characters matching [A-Za-z0-9_.:-]');
    }
    idempotencyKey = raw.idempotencyKey;
  }
  return { tenantId, packageId: raw.packageId, packageVersion: raw.packageVersion, entityType: raw.entityType, fields: raw.fields, idempotencyKey };
}

/** Validate + normalize one field value against its declared type. */
function validateFieldValue(
  entityName: string,
  fieldName: string,
  declaredType: 'string' | 'number' | 'boolean' | 'date',
  value: unknown,
): EntityFieldValue {
  switch (declaredType) {
    case 'string': {
      if (typeof value !== 'string') {
        fail('FIELD_TYPE_MISMATCH', `entity "${entityName}" field "${fieldName}" must be a string`);
      }
      if (value.length > 2000) {
        fail('FIELD_TYPE_MISMATCH', `entity "${entityName}" field "${fieldName}" must stay under 2000 characters`);
      }
      return value;
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        fail('FIELD_TYPE_MISMATCH', `entity "${entityName}" field "${fieldName}" must be a finite number`);
      }
      return value;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') {
        fail('FIELD_TYPE_MISMATCH', `entity "${entityName}" field "${fieldName}" must be a boolean`);
      }
      return value;
    }
    case 'date': {
      if (typeof value !== 'string') {
        fail('FIELD_TYPE_MISMATCH', `entity "${entityName}" field "${fieldName}" must be an ISO-8601 date string`);
      }
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) {
        fail('FIELD_TYPE_MISMATCH', `entity "${entityName}" field "${fieldName}" must be a parseable ISO-8601 date string`);
      }
      // Normalized canonical form (deterministic hashing discipline).
      return parsed.toISOString();
    }
  }
}

/**
 * Validate the fields against the package's entity declaration.
 * Returns the frozen validated field record.
 */
export function validateFieldsAgainstDeclaration(
  entityType: string,
  declaration: EntityDefinition,
  fields: Readonly<Record<string, unknown>>,
): Readonly<Record<string, EntityFieldValue>> {
  const declared = new Map(declaration.fields.map((field) => [field.name, field]));
  for (const name of Object.keys(fields)) {
    if (!declared.has(name)) {
      fail('FIELD_NOT_DECLARED', `field "${name}" is not declared by entity "${entityType}"`);
    }
  }
  const validated: Record<string, EntityFieldValue> = {};
  for (const field of declaration.fields) {
    const present = Object.prototype.hasOwnProperty.call(fields, field.name);
    if (!present) {
      if (field.required) {
        fail('FIELD_REQUIRED', `entity "${entityType}" requires field "${field.name}"`);
      }
      continue;
    }
    validated[field.name] = validateFieldValue(entityType, field.name, field.type, fields[field.name]);
  }
  return Object.freeze(validated);
}

/** The full validation: envelope + declaration consultation result. */
export function validateCreateEntityInstanceInput(
  raw: CreateEntityInstanceInput,
  declaration: EntityDefinition | null,
): ValidatedCreateEntityInstanceInput {
  const envelope = validateCreateEntityInstanceEnvelope(raw);
  if (declaration === null) {
    fail('ENTITY_TYPE_NOT_DECLARED', `entity type "${envelope.entityType}" is not declared by vertical package ${envelope.packageId} v${envelope.packageVersion}`);
  }
  const fields = validateFieldsAgainstDeclaration(envelope.entityType, declaration, envelope.fields);
  return Object.freeze({
    tenantId: envelope.tenantId,
    packageId: envelope.packageId,
    packageVersion: envelope.packageVersion,
    entityType: envelope.entityType,
    fields,
    idempotencyKey: envelope.idempotencyKey,
  });
}
