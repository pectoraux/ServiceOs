/**
 * ServiceOS /organizations store port (WORK-002).
 *
 * The persistence contract for organizations, service tenants, memberships
 * and roles. The authoritative implementation is the SQL store executed
 * through the persistence boundary's `TransactionalExecutor` (multi-statement
 * invariants run client-pinned); tests inject a faithful in-memory
 * implementation.
 *
 * Store contract semantics (mirrored by every implementation):
 * - inserts enforce the schema's unique constraints (`StoreConflictError`
 *   with the constraint name);
 * - `createOrganizationWithTenant` and `updateMembership` are ATOMIC per call
 *   — check + mutate happen with no interleaving gap (SQL: one locked
 *   transaction; in-memory: synchronous critical section);
 * - `updateMembership` enforces the last-active-owner integrity rule
 *   atomically (`StoreRuleError`) so concurrent revocations cannot strip an
 *   organization of all owners;
 * - `listTenantDirectory` is the tenant-scoped read discipline: the tenant
 *   predicate is mandatory in every implementation (lock #15/#16). Removing
 *   it must make the discrimination tests fail.
 * - lookups return `null` for absent rows (missing read ≠ empty result).
 */
import { StoreConflictError } from '../auth/index.js';

/** Atomic store-level rule violation (mirrors a SQL-side guarded update). */
export class StoreRuleError extends Error {
  constructor(message: string, readonly rule: string) {
    super(message);
    this.name = 'StoreRuleError';
  }
}

/** Single-row mutation target absent. */
export class StoreMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreMissingError';
  }
}

export type Role = 'owner' | 'admin' | 'member' | 'viewer';
export type MembershipStatus = 'active' | 'revoked';
export type OrganizationStatus = 'active' | 'suspended';
export type TenantStatus = 'active' | 'suspended';

export interface OrganizationRecord {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly status: OrganizationStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface TenantRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly slug: string;
  readonly displayName: string;
  readonly status: TenantStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface MembershipRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly principalId: string;
  readonly role: Role;
  readonly status: MembershipStatus;
  readonly grantedBy: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateOrganizationInput {
  readonly slug: string;
  readonly displayName: string;
  readonly tenantSlug: string;
  readonly tenantDisplayName: string;
  readonly ownerPrincipalId: string;
  readonly now: Date;
}

export interface CreateOrganizationResult {
  readonly organization: OrganizationRecord;
  readonly tenant: TenantRecord;
  readonly membership: MembershipRecord;
}

export interface CreateTenantInput {
  readonly organizationId: string;
  readonly slug: string;
  readonly displayName: string;
  readonly now: Date;
}

export interface CreateMembershipInput {
  readonly organizationId: string;
  readonly principalId: string;
  readonly role: Role;
  readonly grantedBy: string | null;
  readonly now: Date;
}

export interface MembershipChange {
  readonly role?: Role;
  readonly status?: MembershipStatus;
}

export interface UpdateMembershipOptions {
  /**
   * Reject changes that would leave the organization without any active
   * owner (revocation or owner-role removal of the last active owner).
   */
  readonly requireActiveOwnerRemaining: boolean;
}

export interface MembershipWithOrganization {
  readonly membership: MembershipRecord;
  readonly organization: OrganizationRecord;
}

export interface OrganizationsStore {
  /** Atomically create organization + first service tenant + owner membership. */
  createOrganizationWithTenant(input: CreateOrganizationInput): Promise<CreateOrganizationResult>;
  findOrganizationBySlug(slug: string): Promise<OrganizationRecord | null>;
  findOrganizationById(id: string): Promise<OrganizationRecord | null>;
  findTenantBySlug(slug: string): Promise<TenantRecord | null>;
  findTenantById(id: string): Promise<TenantRecord | null>;
  createTenant(input: CreateTenantInput): Promise<TenantRecord>;
  listTenantsForOrganization(organizationId: string): Promise<TenantRecord[]>;
  createMembership(input: CreateMembershipInput): Promise<MembershipRecord>;
  findMembership(organizationId: string, principalId: string): Promise<MembershipRecord | null>;
  /**
   * Atomically apply a membership change under the last-active-owner rule.
   * Throws `StoreMissingError` when the membership does not exist and
   * `StoreRuleError` (rule `last-active-owner`) when the rule is violated.
   */
  updateMembership(
    organizationId: string,
    principalId: string,
    change: MembershipChange,
    options: UpdateMembershipOptions,
    now: Date,
  ): Promise<MembershipRecord>;
  listOrganizationsForPrincipal(principalId: string): Promise<MembershipWithOrganization[]>;
  listMembershipsForOrganization(organizationId: string): Promise<MembershipRecord[]>;
  /**
   * Tenant-scoped membership directory: members of the organization that owns
   * the given tenant, selected THROUGH the tenant predicate (the isolated
   * customer-domain boundary). The tenant parameter is mandatory and bound
   * in every implementation.
   */
  listTenantDirectory(tenantId: string): Promise<MembershipRecord[]>;
  countActiveOwners(organizationId: string): Promise<number>;
}

