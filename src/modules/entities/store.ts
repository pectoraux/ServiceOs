/**
 * ServiceOS /entities store port (WORK-010).
 *
 * The persistence contract for tenant-bound entity instances (the
 * business implementation of the /entities module declared by
 * architecture.md §6 — "customer/business entities used by service
 * workflows"; WORK-001 deliberately shipped this module as a
 * placeholder whose business implementation belongs to a later Work
 * Order; WORK-010's authorized scope "subcontractor/vendor entities"
 * owns it).
 *
 * Store contract semantics (mirrored by every implementation):
 *
 * - TENANT PREDICATES ARE MANDATORY. Every lookup and list carries the
 *   tenant parameter in its signature and its query; a row in another
 *   tenant is indistinguishable from a missing row (architecture-lock
 *   #15/#16; a missing read stays distinguishable from an empty
 *   result, lock #30).
 *
 * - ENTITY INSTANCES ARE IMMUTABLE IN CONTENT. An instance row is
 *   created once and never rewritten: the entity's LATER states (a
 *   corrected certificate, a re-submitted document) are NEW instances
 *   — the durable audit trail is append-only exactly like the
 *   evidence, interaction and transition ledgers. "Vendor
 *   correction/retry" therefore converges or appends; it never
 *   rewrites history.
 *
 * - CONVERGENCE, NOT DUPLICATION. `createEntityInstance` is idempotent
 *   by durable logical identity: the same (tenant, idempotency key)
 *   with the same content converges on ONE durable row (concurrent
 *   creators receive the same identity); a divergent content under
 *   the same key fails closed with rule `entity-input-conflict`.
 *
 * - READS VERIFY THE PERSISTED RECORD HASH (rule
 *   `entity-record-tampered` when a stored field no longer matches its
 *   persisted integrity hash; stored content that no longer matches
 *   its content hash is likewise tampering).
 */
import { EntitiesError } from './errors.js';

/** A validated entity field value (the vertical declaration's type space). */
export type EntityFieldValue = string | number | boolean;

/** The durable, immutable entity-instance record. */
export interface EntityInstanceRecord {
  readonly id: string;
  readonly tenantId: string;
  /** The vertical package whose declaration defined this instance's type. */
  readonly packageId: string;
  readonly packageVersion: number;
  /** The declared entity type name (e.g. 'Project', 'Subcontractor'). */
  readonly entityType: string;
  /** The validated field values, per the package's entity declaration. */
  readonly fields: Readonly<Record<string, EntityFieldValue>>;
  /** sha256 over the canonical instance CONTENT (the actor-independent fact). */
  readonly contentHash: string;
  /** Integrity hash over the canonical record core (tamper detection on read). */
  readonly recordHash: string;
  readonly createdBy: string;
  readonly idempotencyKey: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type EntitiesStoreRule = 'entity-input-conflict' | 'entity-record-tampered';

export class EntitiesStoreRuleError extends Error {
  constructor(
    message: string,
    readonly rule: EntitiesStoreRule,
  ) {
    super(message);
    this.name = 'EntitiesStoreRuleError';
  }
}

export class EntitiesStoreMissingError extends Error {
  constructor(
    message: string,
    readonly key: string,
  ) {
    super(message);
    this.name = 'EntitiesStoreMissingError';
  }
}

export interface CreateEntityInstanceStoreInput {
  readonly tenantId: string;
  readonly packageId: string;
  readonly packageVersion: number;
  readonly entityType: string;
  readonly fields: Readonly<Record<string, EntityFieldValue>>;
  /** sha256 over the canonical instance content. */
  readonly contentHash: string;
  /** Integrity hash over the canonical record core. */
  readonly recordHash: string;
  readonly createdBy: string;
  readonly idempotencyKey: string | null;
  readonly now: Date;
}

export interface EntityInstanceFilter {
  readonly packageId?: string;
  readonly packageVersion?: number;
  readonly entityType?: string;
}

export interface EntitiesStore {
  /**
   * Atomically create one entity instance. Store rules (enforced in one
   * serialized critical section): same (tenant, idempotency key) with
   * the same content hash → converge on the durable row; divergent
   * content under the same key → `entity-input-conflict`.
   */
  createEntityInstance(input: CreateEntityInstanceStoreInput): Promise<{ instance: EntityInstanceRecord; converged: boolean }>;
  /** Tenant-predicated lookup; null when absent in this tenant. */
  findEntityInstanceById(tenantId: string, instanceId: string): Promise<EntityInstanceRecord | null>;
  /** Tenant-predicated (idempotency key) lookup; null when absent. */
  findEntityInstanceByIdempotencyKey(tenantId: string, idempotencyKey: string): Promise<EntityInstanceRecord | null>;
  /** Tenant-predicated list (creation order, filterable). */
  listEntityInstances(tenantId: string, filter?: EntityInstanceFilter): Promise<EntityInstanceRecord[]>;
}

/** Map a store rule failure onto the module's public error surface. */
export function mapEntitiesStoreRule(rule: EntitiesStoreRule, message: string): EntitiesError {
  switch (rule) {
    case 'entity-input-conflict':
      return new EntitiesError('ENTITY_INPUT_CONFLICT', message);
    case 'entity-record-tampered':
      return new EntitiesError('ENTITY_RECORD_TAMPERED', message);
  }
}
