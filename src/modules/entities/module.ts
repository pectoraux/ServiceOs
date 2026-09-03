/**
 * ServiceOS /entities module assembly (WORK-010).
 *
 * The entity-instance AUTHORITY (architecture.md §6: "customer/business
 * entities used by service workflows"; WORK-001 shipped this module as
 * a placeholder whose business implementation belongs to a later Work
 * Order — WORK-010's authorized scope "subcontractor/vendor entities"
 * owns it):
 *
 * - TENANT-BOUND ENTITY INSTANCES: `createEntityInstance` is the single
 *   entry point that persists one entity instance VALIDATED against a
 *   REGISTERED vertical package's entity declaration (consulted
 *   through /verticals' public read — never a second package
 *   registry). Rows are immutable (a corrected entity is a NEW
 *   instance — the audit trail is append-only); keyed submissions
 *   converge; tenant predicates are mandatory; reads are
 *   tamper-evident.
 * - THE MODULE HOLDS NO VERTICAL FLOW LOGIC: the construction
 *   compliance flow (construction.ts) is a separate composed surface
 *   that CONSUMES this authority through its public interface exactly
 *   like it consumes /work, /workflow, /evidence, /interactions, /zeck
 *   and /approvals.
 * - Tenancy is resolved server-side through the ONE authorization
 *   chain (injected by the composition root): every operation calls
 *   /organizations' `authorize` BEFORE any store access; denials never
 *   touch domain data.
 */
import type { TransactionalExecutor } from '../../platform/persistence/index.js';
import type { Principal } from '../auth/index.js';
import type { AuthorizationDecision, AuthorizationDenyReason, TenancyAction } from '../organizations/index.js';
import type { VerticalPackageRecord } from '../verticals/index.js';
import { EntitiesError, type EntitiesErrorCode } from './errors.js';
import { createSqlEntitiesStore } from './sql-store.js';
import { computeEntityInstanceContentHash, computeEntityInstanceRecordHash } from './content.js';
import { validateCreateEntityInstanceInput, validateCreateEntityInstanceEnvelope, type CreateEntityInstanceInput } from './contract.js';
import {
  EntitiesStoreMissingError,
  EntitiesStoreRuleError,
  type CreateEntityInstanceStoreInput,
  type EntityInstanceFilter,
  type EntityInstanceRecord,
  type EntitiesStore,
} from './store.js';

// Re-exports that complete the module's public surface from this assembly
// file (the public interface in index.ts re-exports these).
export { EntitiesError } from './errors.js';
export type { EntitiesErrorCode } from './errors.js';
export type { CreateEntityInstanceInput } from './contract.js';

// The store port (public contract) is re-exported through the module's
// public interface; tests inject faithful in-memory implementations.
export { createSqlEntitiesStore } from './sql-store.js';
export { EntitiesStoreRuleError, EntitiesStoreMissingError } from './store.js';
export type {
  CreateEntityInstanceStoreInput,
  EntityInstanceFilter,
  EntityInstanceRecord,
  EntitiesStore,
  EntitiesStoreRule,
  EntityFieldValue,
} from './store.js';

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

/** /verticals' public read the entity authority consults (declaration resolution). */
export interface VerticalPackageReader {
  getVerticalPackage(
    principal: Principal,
    tenantId: string,
    packageId: string,
    version: number,
  ): Promise<VerticalPackageRecord | null>;
}

export interface EntitiesModuleOptions {
  /** Production wiring: transaction-capable persistence executor. */
  executor?: TransactionalExecutor;
  /** Test seam: inject a faithful in-memory store instead (tests only). */
  store?: EntitiesStore;
  /** The single authorization chain, injected by the composition root. */
  tenancy: TenancyAuthorization;
  /** /verticals' public read (entity-declaration resolution). */
  verticals: VerticalPackageReader;
  /** Clock injection for deterministic proofs. */
  now?: () => Date;
}

export interface EntitiesModule {
  /**
   * Create ONE tenant-bound entity instance validated against the
   * REGISTERED vertical package's entity declaration (AC-1). The same
   * logical submission (tenant + idempotency key + content) converges
   * on ONE durable instance; divergent content under the same key
   * fails closed. Rows are immutable and tamper-evident.
   */
  createEntityInstance(
    principal: Principal,
    input: CreateEntityInstanceInput,
  ): Promise<{ instance: EntityInstanceRecord; converged: boolean }>;
  /** Read one entity instance (tenant-predicated, tamper-evident). */
  getEntityInstance(principal: Principal, tenantId: string, instanceId: string): Promise<EntityInstanceRecord>;
  /** The tenant's instances (creation order, filterable). */
  listEntityInstances(principal: Principal, tenantId: string, filter?: EntityInstanceFilter): Promise<EntityInstanceRecord[]>;
}

// ---------------------------------------------------------------------------
// Validation helpers (fail closed)
// ---------------------------------------------------------------------------

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateUuid(value: string, what: string): void {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new EntitiesError('INVALID_INPUT', `${what} must be a UUID`);
  }
}

/** Map an authorization denial reason to the module's error surface. */
function denyToError(reason: AuthorizationDenyReason | undefined, tenantId: string): EntitiesError {
  switch (reason) {
    case 'TENANT_NOT_FOUND':
      return new EntitiesError('TENANT_NOT_FOUND', `service tenant ${tenantId} does not exist`);
    case 'TENANT_SUSPENDED':
      return new EntitiesError('TENANT_SUSPENDED', `service tenant ${tenantId} is suspended`);
    case 'ORGANIZATION_NOT_FOUND':
      return new EntitiesError('TENANT_NOT_FOUND', `the tenant's organization no longer exists`);
    case 'ORGANIZATION_SUSPENDED':
      return new EntitiesError('ORGANIZATION_SUSPENDED', 'the owning organization is suspended');
    case 'MEMBERSHIP_FORBIDDEN':
      return new EntitiesError('TENANT_FORBIDDEN', 'the principal has no active membership granting this tenant');
    case 'ROLE_FORBIDDEN':
      return new EntitiesError('ROLE_FORBIDDEN', 'the principal role does not grant the required capability');
    default:
      return new EntitiesError('TENANT_FORBIDDEN', 'authorization denied');
  }
}

/** Map store errors onto the public error surface. */
function mapStoreError(error: unknown): never {
  if (error instanceof EntitiesStoreRuleError) {
    const code: EntitiesErrorCode =
      error.rule === 'entity-input-conflict' ? 'ENTITY_INPUT_CONFLICT' : 'ENTITY_RECORD_TAMPERED';
    throw new EntitiesError(code, error.message);
  }
  if (error instanceof EntitiesStoreMissingError) {
    throw new EntitiesError('ENTITY_NOT_FOUND', error.message);
  }
  throw error;
}

// ---------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------

export function createEntitiesModule(options: EntitiesModuleOptions): EntitiesModule {
  if ((options.executor === undefined) === (options.store === undefined)) {
    throw new EntitiesError('INVALID_INPUT', 'createEntitiesModule requires exactly one of executor or store');
  }
  const store = options.store ?? createSqlEntitiesStore(options.executor as TransactionalExecutor);
  const tenancy = options.tenancy;
  const verticals = options.verticals;
  const now = options.now ?? (() => new Date());

  /** Authorization BEFORE any domain data access (single chain). */
  async function requireTenantAccess(principal: Principal, tenantId: string, action: TenancyAction): Promise<void> {
    validateUuid(tenantId, 'tenantId');
    const decision = await tenancy.authorize(principal.id, { tenantId }, action);
    if (!decision.allowed) {
      throw denyToError(decision.reason, tenantId);
    }
  }

  return {
    async createEntityInstance(principal, input) {
      // Envelope validation first (fail closed before any IO).
      const envelope = validateCreateEntityInstanceEnvelope(input);
      await requireTenantAccess(principal, envelope.tenantId, 'write');
      // Declaration resolution through /verticals' public read (the
      // package must be REGISTERED in this tenant — a missing package
      // is typed, never an implicit pass).
      const pkg = await verticals.getVerticalPackage(principal, envelope.tenantId, envelope.packageId, envelope.packageVersion);
      if (pkg === null) {
        throw new EntitiesError(
          'VERTICAL_PACKAGE_NOT_FOUND',
          `vertical package ${envelope.packageId} v${envelope.packageVersion} is not registered in this tenant`,
        );
      }
      const declaration = pkg.entities.find((entity) => entity.name === envelope.entityType) ?? null;
      const validated = validateCreateEntityInstanceInput(input, declaration);
      const contentHash = computeEntityInstanceContentHash({
        tenantId: validated.tenantId,
        packageId: validated.packageId,
        packageVersion: validated.packageVersion,
        entityType: validated.entityType,
        fields: validated.fields,
      });
      // ONE clock read: the hash and the row pin the SAME instant (a
      // moving clock must not diverge them).
      const createdAt = now();
      const payload: CreateEntityInstanceStoreInput = {
        tenantId: validated.tenantId,
        packageId: validated.packageId,
        packageVersion: validated.packageVersion,
        entityType: validated.entityType,
        fields: validated.fields,
        contentHash,
        recordHash: computeEntityInstanceRecordHash({
          tenantId: validated.tenantId,
          packageId: validated.packageId,
          packageVersion: validated.packageVersion,
          entityType: validated.entityType,
          fields: validated.fields,
          contentHash,
          createdBy: principal.id,
          idempotencyKey: validated.idempotencyKey,
          createdAt,
        }),
        createdBy: principal.id,
        idempotencyKey: validated.idempotencyKey,
        now: createdAt,
      };
      try {
        return await store.createEntityInstance(payload);
      } catch (error) {
        return mapStoreError(error);
      }
    },

    async getEntityInstance(principal, tenantId, instanceId) {
      await requireTenantAccess(principal, tenantId, 'read');
      validateUuid(instanceId, 'instanceId');
      try {
        const instance = await store.findEntityInstanceById(tenantId, instanceId);
        if (instance === null) {
          throw new EntitiesError('ENTITY_NOT_FOUND', `entity instance ${instanceId} does not exist in this tenant`);
        }
        return instance;
      } catch (error) {
        return mapStoreError(error);
      }
    },

    async listEntityInstances(principal, tenantId, filter) {
      await requireTenantAccess(principal, tenantId, 'read');
      if (filter !== undefined) {
        if (filter.packageId !== undefined && !/^[a-z][a-z0-9-]{1,63}$/.test(filter.packageId)) {
          throw new EntitiesError('INVALID_INPUT', 'filter.packageId must be a lowercase slug');
        }
        if (filter.packageVersion !== undefined && (!Number.isInteger(filter.packageVersion) || filter.packageVersion < 1)) {
          throw new EntitiesError('INVALID_INPUT', 'filter.packageVersion must be a positive integer');
        }
        if (filter.entityType !== undefined && !/^[a-zA-Z][a-zA-Z0-9_.-]{0,199}$/.test(filter.entityType)) {
          throw new EntitiesError('INVALID_INPUT', 'filter.entityType must match the identifier pattern');
        }
      }
      try {
        return await store.listEntityInstances(tenantId, filter);
      } catch (error) {
        return mapStoreError(error);
      }
    },
  };
}

/**
 * Module manifest: declared once in the module's public interface
 * (index.ts); this assembly file exports the business contract only.
 */
