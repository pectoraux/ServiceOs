/**
 * ServiceOS module: /organizations (WORK-002 implementation).
 *
 * organizations, tenants, memberships and roles (architecture.md §6).
 *
 * Authority (authority-matrix):
 * - Organization/membership records are owned here; other modules read and
 *   change them only through this public contract.
 * - Tenant scope is resolved SERVER-SIDE here + the authorization contract:
 *   `authorize` is the single authorization decision entry point in
 *   ServiceOS, and `createAuthorizationGuard` is the single route-guard
 *   factory. Both structural facts are machine-enforced
 *   (identity-boundary checks) — a second authorization engine anywhere is
 *   an architecture violation.
 *
 * Invariants honored (WORK-002 frozen requirements):
 * - tenant ownership resolved server-side (guards resolve targets from the
 *   route; client headers/bodies are never a trust source);
 * - one authorization chain (`authorization.ts` + `authorize` here);
 * - no cross-tenant reads/writes (guard-before-handler, mandatory tenant
 *   predicates in the store, fail-closed 403/404 with distinct codes);
 * - no AI credentials (this module knows nothing about AI providers; machine
 *   credentials are ServiceOS-internal service-account keys scoped only by
 *   the membership chain — AC-5).
 */
import { RouteHttpError, type RouteDescriptor } from '../../platform/http/index.js';
import type { TransactionalExecutor } from '../../platform/persistence/index.js';
import { defineModule } from '../../platform/module-registry/index.js';
import { StoreConflictError, type Authenticator, type Principal } from '../auth/index.js';
import { createAuthorizationGuard, type OrganizationGuardContext, type TenantGuardContext } from './guard.js';
import {
  isRole,
  isTenancyAction,
  roleAllowedForMachine,
  roleAllows,
  type TenancyAction,
} from './authorization.js';
import { createOrganizationRoutes, type MemberView } from './routes.js';
import { createSqlOrganizationsStore } from './sql-store.js';
import {
  StoreMissingError,
  StoreRuleError,
  type CreateMembershipInput,
  type CreateOrganizationInput,
  type CreateOrganizationResult,
  type CreateTenantInput,
  type MembershipChange,
  type MembershipRecord,
  type MembershipStatus,
  type MembershipWithOrganization,
  type OrganizationRecord,
  type OrganizationStatus,
  type OrganizationsStore,
  type Role,
  type TenantRecord,
  type TenantStatus,
  type UpdateMembershipOptions,
} from './store.js';

// Store port (public contract): the authoritative SQL implementation runs
// through the persistence boundary; tests inject faithful in-memory
// implementations of the same port through this surface. The SQL store
// factory is exported so tests and future composition roots can construct
// the production persistence implementation of the port directly.
export { StoreMissingError, StoreRuleError, createSqlOrganizationsStore };
export type {
  CreateMembershipInput,
  CreateOrganizationInput,
  CreateOrganizationResult,
  CreateTenantInput,
  MembershipChange,
  MembershipStatus,
  MembershipWithOrganization,
  OrganizationStatus,
  OrganizationsStore,
  TenantStatus,
  UpdateMembershipOptions,
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type { Role, TenancyAction };
export type { MembershipRecord, OrganizationRecord, TenantRecord };
export type { OrganizationGuardContext, TenantGuardContext };

/** Deny reasons surfaced by the authorization decision. */
export type AuthorizationDenyReason =
  | 'ORGANIZATION_NOT_FOUND'
  | 'TENANT_NOT_FOUND'
  | 'ORGANIZATION_SUSPENDED'
  | 'TENANT_SUSPENDED'
  | 'MEMBERSHIP_FORBIDDEN'
  | 'ROLE_FORBIDDEN';

export interface AuthorizationDecision {
  readonly allowed: boolean;
  readonly role?: Role;
  readonly reason?: AuthorizationDenyReason;
}

export type OrganizationsErrorCode =
  | 'INVALID_INPUT'
  | 'ORGANIZATION_NOT_FOUND'
  | 'TENANT_NOT_FOUND'
  | 'MEMBERSHIP_NOT_FOUND'
  | 'PRINCIPAL_NOT_FOUND'
  | 'ORG_SLUG_TAKEN'
  | 'TENANT_SLUG_TAKEN'
  | 'MEMBERSHIP_EXISTS'
  | 'ORGANIZATION_FORBIDDEN'
  | 'TENANT_FORBIDDEN'
  | 'ROLE_FORBIDDEN'
  | 'MACHINE_PRINCIPAL_FORBIDDEN'
  | 'MACHINE_ROLE_FORBIDDEN'
  | 'LAST_ACTIVE_OWNER';

export class OrganizationsError extends Error {
  constructor(
    readonly code: OrganizationsErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'OrganizationsError';
  }
}

/** The identity substrate this module consumes through /auth's public interface. */
export interface AuthIdentityService {
  readonly resolvePrincipalByEmail: (email: string) => Promise<Principal | null>;
  readonly resolvePrincipals: (principalIds: readonly string[]) => Promise<Principal[]>;
  readonly createMachinePrincipal: (input: { displayName: string }) => Promise<Principal>;
  readonly issueApiKey: (principalId: string) => Promise<{ keyId: string; secret: string }>;
  readonly revokeApiKeysForPrincipal: (principalId: string) => Promise<{ revoked: number }>;
}

export interface OrganizationsModuleOptions {
  /** Production wiring: transaction-capable persistence executor. */
  executor?: TransactionalExecutor;
  /** Test seam: inject a faithful in-memory store instead (tests only). */
  store?: OrganizationsStore;
  /** Credential verification entry point from /auth (injected by the composition root). */
  authenticator: Authenticator;
  /** Identity operations consumed through /auth's public interface. */
  identity: AuthIdentityService;
  /** Clock injection for deterministic proofs. */
  now?: () => Date;
}

export interface OrganizationsModule {
  /**
   * THE authorization decision entry point (one chain). Resolves the
   * organization/tenant server-side from durable state, then applies the
   * capability matrix to the principal's active membership.
   */
  authorize(
    principalId: string,
    scope: { organizationId: string } | { tenantId: string },
    action: TenancyAction,
  ): Promise<AuthorizationDecision>;
  createOrganization(
    principal: Principal,
    input: { slug: string; displayName: string },
  ): Promise<{ organization: OrganizationRecord; tenant: TenantRecord; membership: MembershipRecord }>;
  listOrganizationsForPrincipal(principalId: string): Promise<MembershipWithOrganization[]>;
  createTenant(principal: Principal, orgSlug: string, input: { slug: string; displayName: string }): Promise<TenantRecord>;
  listTenants(principal: Principal, orgSlug: string): Promise<TenantRecord[]>;
  addMember(principal: Principal, orgSlug: string, input: { principalId: string; role: string }): Promise<MemberView>;
  listMembers(principal: Principal, orgSlug: string): Promise<MemberView[]>;
  setMemberRole(principal: Principal, orgSlug: string, memberPrincipalId: string, role: string): Promise<MemberView>;
  revokeMember(principal: Principal, orgSlug: string, memberPrincipalId: string): Promise<MemberView>;
  listTenantMembers(principal: Principal, tenantSlug: string): Promise<MemberView[]>;
  createServiceAccount(
    principal: Principal,
    orgSlug: string,
    input: { displayName: string; role: string },
  ): Promise<{ member: MemberView; secret: string; keyId: string }>;
  listServiceAccounts(principal: Principal, orgSlug: string): Promise<MemberView[]>;
  revokeServiceAccount(
    principal: Principal,
    orgSlug: string,
    machinePrincipalId: string,
  ): Promise<{ member: MemberView; revokedKeys: number }>;
  /** Guarded customer routes (composed by src/main.ts into the server). */
  routes(): RouteDescriptor[];
}

const SLUG_PATTERN = /^[a-z][a-z0-9-]{2,62}$/;

function validateSlug(slug: string, what: string): void {
  if (typeof slug !== 'string' || !SLUG_PATTERN.test(slug)) {
    throw new OrganizationsError(
      'INVALID_INPUT',
      `${what} slug must match ${SLUG_PATTERN.toString()} (lowercase letters, digits, dashes)`,
    );
  }
}

function validateDisplayName(displayName: string): void {
  if (typeof displayName !== 'string' || displayName.trim() === '' || displayName.length > 200) {
    throw new OrganizationsError('INVALID_INPUT', 'displayName must be a non-empty string of at most 200 characters');
  }
}

function toRouteHttpError(error: unknown): RouteHttpError {
  if (error instanceof RouteHttpError) return error;
  if (error instanceof OrganizationsError) {
    const status =
      error.code === 'ORGANIZATION_NOT_FOUND' ||
      error.code === 'TENANT_NOT_FOUND' ||
      error.code === 'MEMBERSHIP_NOT_FOUND' ||
      error.code === 'PRINCIPAL_NOT_FOUND'
        ? 404
        : error.code === 'ORG_SLUG_TAKEN' ||
            error.code === 'TENANT_SLUG_TAKEN' ||
            error.code === 'MEMBERSHIP_EXISTS' ||
            error.code === 'LAST_ACTIVE_OWNER'
          ? 409
          : 400;
    return new RouteHttpError(status, error.code, error.message);
  }
  return new RouteHttpError(500, 'INTERNAL', 'internal error');
}

export function createOrganizationsModule(options: OrganizationsModuleOptions): OrganizationsModule {
  if ((options.executor === undefined) === (options.store === undefined)) {
    throw new OrganizationsError('INVALID_INPUT', 'createOrganizationsModule requires exactly one of executor or store');
  }
  const store = options.store ?? createSqlOrganizationsStore(options.executor as TransactionalExecutor);
  const identity = options.identity;
  const now = options.now ?? (() => new Date());
  const guards = createAuthorizationGuard({
    authenticator: options.authenticator,
    // Bound wrappers: store implementations may rely on their own `this`.
    findOrganizationBySlug: (slug: string) => store.findOrganizationBySlug(slug),
    findOrganizationById: (id: string) => store.findOrganizationById(id),
    findTenantBySlug: (slug: string) => store.findTenantBySlug(slug),
    findMembership: (organizationId: string, principalId: string) =>
      store.findMembership(organizationId, principalId),
  });

  // -------------------------------------------------------------------------
  // The authorization chain (single decision path)
  // -------------------------------------------------------------------------

  async function resolveAuthorization(
    principalId: string,
    scope: { organizationId: string } | { tenantId: string },
    action: TenancyAction,
  ): Promise<
    | { allowed: true; organization: OrganizationRecord; tenant: TenantRecord | null; membership: MembershipRecord; role: Role }
    | { allowed: false; reason: AuthorizationDenyReason }
  > {
    if (!isTenancyAction(action)) {
      throw new OrganizationsError('INVALID_INPUT', `unknown tenancy action ${JSON.stringify(action)}`);
    }
    let organization: OrganizationRecord | null;
    let tenant: TenantRecord | null = null;
    if ('tenantId' in scope) {
      tenant = await store.findTenantById(scope.tenantId);
      if (tenant === null) return { allowed: false, reason: 'TENANT_NOT_FOUND' };
      if (tenant.status !== 'active') return { allowed: false, reason: 'TENANT_SUSPENDED' };
      organization = await store.findOrganizationById(tenant.organizationId);
    } else {
      organization = await store.findOrganizationById(scope.organizationId);
    }
    if (organization === null) return { allowed: false, reason: 'ORGANIZATION_NOT_FOUND' };
    if (organization.status !== 'active') return { allowed: false, reason: 'ORGANIZATION_SUSPENDED' };
    const membership = await store.findMembership(organization.id, principalId);
    if (membership === null || membership.status !== 'active') return { allowed: false, reason: 'MEMBERSHIP_FORBIDDEN' };
    if (!roleAllows(membership.role, action)) return { allowed: false, reason: 'ROLE_FORBIDDEN' };
    return { allowed: true, organization, tenant, membership, role: membership.role };
  }

  async function authorize(
    principalId: string,
    scope: { organizationId: string } | { tenantId: string },
    action: TenancyAction,
  ): Promise<AuthorizationDecision> {
    const decision = await resolveAuthorization(principalId, scope, action);
    if (decision.allowed) {
      return { allowed: true, role: decision.role };
    }
    return { allowed: false, reason: decision.reason };
  }

  /** Resolve an organization by slug and demand a capability (the chain). */
  async function requireOrganizationAccess(
    principal: Principal,
    orgSlug: string,
    action: TenancyAction,
  ): Promise<OrganizationGuardContext> {
    const organization = await store.findOrganizationBySlug(orgSlug);
    if (organization === null) {
      throw new OrganizationsError('ORGANIZATION_NOT_FOUND', `organization ${orgSlug} does not exist`);
    }
    const decision = await resolveAuthorization(principal.id, { organizationId: organization.id }, action);
    if (decision.allowed) {
      return { principal, organization, membership: decision.membership, role: decision.role };
    }
    if (decision.reason === 'ROLE_FORBIDDEN') {
      throw new OrganizationsError('ROLE_FORBIDDEN', `role is insufficient for ${action} on organization ${orgSlug}`);
    }
    throw new OrganizationsError('ORGANIZATION_FORBIDDEN', `principal has no membership granting organization ${orgSlug}`);
  }

  async function requireTenantAccess(
    principal: Principal,
    tenantSlug: string,
    action: TenancyAction,
  ): Promise<TenantGuardContext> {
    const tenant = await store.findTenantBySlug(tenantSlug);
    if (tenant === null) {
      throw new OrganizationsError('TENANT_NOT_FOUND', `service tenant ${tenantSlug} does not exist`);
    }
    const decision = await resolveAuthorization(principal.id, { tenantId: tenant.id }, action);
    if (decision.allowed) {
      return {
        principal,
        organization: decision.organization,
        tenant: decision.tenant as TenantRecord,
        membership: decision.membership,
        role: decision.role,
      };
    }
    if (decision.reason === 'ROLE_FORBIDDEN') {
      throw new OrganizationsError('ROLE_FORBIDDEN', `role is insufficient for ${action} on tenant ${tenantSlug}`);
    }
    throw new OrganizationsError('TENANT_FORBIDDEN', `principal has no membership granting tenant ${tenantSlug}`);
  }

  // -------------------------------------------------------------------------
  // Membership operations (policy BEFORE business side effects, §2.6)
  // -------------------------------------------------------------------------

  async function createOrganization(
    principal: Principal,
    input: { slug: string; displayName: string },
  ): Promise<{ organization: OrganizationRecord; tenant: TenantRecord; membership: MembershipRecord }> {
    if (principal.kind !== 'human') {
      throw new OrganizationsError(
        'MACHINE_PRINCIPAL_FORBIDDEN',
        'service accounts cannot create organizations; organization creation is a human act',
      );
    }
    validateSlug(input.slug, 'organization');
    validateDisplayName(input.displayName);
    const tenantSlug = `${input.slug}-default`;
    try {
      return await store.createOrganizationWithTenant({
        slug: input.slug,
        displayName: input.displayName.trim(),
        tenantSlug,
        tenantDisplayName: 'Default tenant',
        ownerPrincipalId: principal.id,
        now: now(),
      });
    } catch (error) {
      if (error instanceof StoreConflictError) {
        if (error.constraint.startsWith('org_organizations_slug')) {
          throw new OrganizationsError('ORG_SLUG_TAKEN', `organization slug ${input.slug} is already in use`);
        }
        if (error.constraint.startsWith('org_service_tenants_slug')) {
          throw new OrganizationsError('TENANT_SLUG_TAKEN', `tenant slug ${tenantSlug} is already in use`);
        }
        if (error.constraint.startsWith('org_memberships')) {
          throw new OrganizationsError('MEMBERSHIP_EXISTS', 'owner membership already exists');
        }
      }
      throw error;
    }
  }

  async function listOrganizationsForPrincipal(principalId: string): Promise<MembershipWithOrganization[]> {
    return store.listOrganizationsForPrincipal(principalId);
  }

  async function createTenantIn(
    ctx: OrganizationGuardContext,
    input: { slug: string; displayName: string },
  ): Promise<TenantRecord> {
    validateSlug(input.slug, 'tenant');
    validateDisplayName(input.displayName);
    try {
      return await store.createTenant({
        organizationId: ctx.organization.id,
        slug: input.slug,
        displayName: input.displayName.trim(),
        now: now(),
      });
    } catch (error) {
      if (error instanceof StoreConflictError && error.constraint.startsWith('org_service_tenants_slug')) {
        throw new OrganizationsError('TENANT_SLUG_TAKEN', `tenant slug ${input.slug} is already in use`);
      }
      throw error;
    }
  }

  async function listTenantsIn(ctx: OrganizationGuardContext): Promise<TenantRecord[]> {
    return store.listTenantsForOrganization(ctx.organization.id);
  }

  async function addMemberIn(
    ctx: OrganizationGuardContext,
    input: { principalId: string; role: string },
  ): Promise<MemberView> {
    if (!isRole(input.role)) {
      throw new OrganizationsError('INVALID_INPUT', `role must be one of owner, admin, member, viewer`);
    }
    const role = input.role;
    const target = (await identity.resolvePrincipals([input.principalId]))[0] ?? null;
    if (target === null) {
      throw new OrganizationsError('PRINCIPAL_NOT_FOUND', `principal ${input.principalId} does not exist`);
    }
    if (target.kind === 'machine' && !roleAllowedForMachine(role)) {
      throw new OrganizationsError(
        'MACHINE_ROLE_FORBIDDEN',
        'service accounts can only hold the member or viewer role; machine credentials cannot gain administer or ownership capabilities',
      );
    }
    if (role === 'owner' && ctx.membership.role !== 'owner') {
      throw new OrganizationsError('ROLE_FORBIDDEN', 'only an active owner can grant the owner role');
    }
    try {
      const membership = await store.createMembership({
        organizationId: ctx.organization.id,
        principalId: target.id,
        role,
        grantedBy: ctx.principal.id,
        now: now(),
      });
      return { membership, principal: target };
    } catch (error) {
      if (error instanceof StoreConflictError && error.constraint.startsWith('org_memberships_organization')) {
        throw new OrganizationsError('MEMBERSHIP_EXISTS', `principal ${target.id} is already a member`);
      }
      throw error;
    }
  }

  async function listMembersIn(ctx: OrganizationGuardContext): Promise<MemberView[]> {
    const memberships = await store.listMembershipsForOrganization(ctx.organization.id);
    return enrichMembers(memberships);
  }

  async function enrichMembers(memberships: readonly MembershipRecord[]): Promise<MemberView[]> {
    if (memberships.length === 0) return [];
    const principals = await identity.resolvePrincipals(memberships.map((m) => m.principalId));
    const byId = new Map(principals.map((p) => [p.id, p]));
    return memberships.flatMap((membership) => {
      const principal = byId.get(membership.principalId);
      return principal === undefined ? [] : [{ membership, principal }];
    });
  }

  async function setMemberRoleIn(
    ctx: OrganizationGuardContext,
    memberPrincipalId: string,
    role: string,
  ): Promise<MemberView> {
    if (!isRole(role)) {
      throw new OrganizationsError('INVALID_INPUT', `role must be one of owner, admin, member, viewer`);
    }
    const target = (await identity.resolvePrincipals([memberPrincipalId]))[0] ?? null;
    if (target === null) {
      throw new OrganizationsError('PRINCIPAL_NOT_FOUND', `principal ${memberPrincipalId} does not exist`);
    }
    if (target.kind === 'machine' && !roleAllowedForMachine(role)) {
      throw new OrganizationsError(
        'MACHINE_ROLE_FORBIDDEN',
        'service accounts can only hold the member or viewer role',
      );
    }
    if (role === 'owner' && ctx.membership.role !== 'owner') {
      throw new OrganizationsError('ROLE_FORBIDDEN', 'only an active owner can grant the owner role');
    }
    const membership = await applyMembershipUpdate(ctx, memberPrincipalId, { role });
    return { membership, principal: target };
  }

  async function revokeMemberIn(
    ctx: OrganizationGuardContext,
    memberPrincipalId: string,
  ): Promise<MemberView> {
    const target = (await identity.resolvePrincipals([memberPrincipalId]))[0] ?? null;
    if (target === null) {
      throw new OrganizationsError('PRINCIPAL_NOT_FOUND', `principal ${memberPrincipalId} does not exist`);
    }
    const membership = await applyMembershipUpdate(ctx, memberPrincipalId, { status: 'revoked' });
    return { membership, principal: target };
  }

  async function applyMembershipUpdate(
    ctx: OrganizationGuardContext,
    memberPrincipalId: string,
    change: { role?: Role; status?: 'active' | 'revoked' },
  ): Promise<MembershipRecord> {
    try {
      return await store.updateMembership(
        ctx.organization.id,
        memberPrincipalId,
        change,
        { requireActiveOwnerRemaining: true },
        now(),
      );
    } catch (error) {
      if (error instanceof StoreMissingError) {
        throw new OrganizationsError(
          'MEMBERSHIP_NOT_FOUND',
          `principal ${memberPrincipalId} has no membership in organization ${ctx.organization.slug}`,
        );
      }
      if (error instanceof StoreRuleError && error.rule === 'last-active-owner') {
        throw new OrganizationsError(
          'LAST_ACTIVE_OWNER',
          'the organization must retain at least one active owner',
        );
      }
      throw error;
    }
  }

  async function listTenantMembersIn(ctx: TenantGuardContext): Promise<MemberView[]> {
    // Tenant-scoped read through the mandatory tenant predicate.
    const memberships = await store.listTenantDirectory(ctx.tenant.id);
    return enrichMembers(memberships);
  }

  async function createServiceAccountIn(
    ctx: OrganizationGuardContext,
    input: { displayName: string; role: string },
  ): Promise<{ member: MemberView; secret: string; keyId: string }> {
    if (!isRole(input.role)) {
      throw new OrganizationsError('INVALID_INPUT', `role must be one of owner, admin, member, viewer`);
    }
    if (!roleAllowedForMachine(input.role)) {
      throw new OrganizationsError(
        'MACHINE_ROLE_FORBIDDEN',
        'service accounts can only hold the member or viewer role; machine credentials cannot gain administer or ownership capabilities',
      );
    }
    validateDisplayName(input.displayName);
    const machine = await identity.createMachinePrincipal({ displayName: input.displayName.trim() });
    const membership = await store.createMembership({
      organizationId: ctx.organization.id,
      principalId: machine.id,
      role: input.role,
      grantedBy: ctx.principal.id,
      now: now(),
    });
    const apiKey = await identity.issueApiKey(machine.id);
    return { member: { membership, principal: machine }, secret: apiKey.secret, keyId: apiKey.keyId };
  }

  async function listServiceAccountsIn(ctx: OrganizationGuardContext): Promise<MemberView[]> {
    const members = await listMembersIn(ctx);
    return members.filter((member) => member.principal.kind === 'machine');
  }

  async function revokeServiceAccountIn(
    ctx: OrganizationGuardContext,
    machinePrincipalId: string,
  ): Promise<{ member: MemberView; revokedKeys: number }> {
    const target = (await identity.resolvePrincipals([machinePrincipalId]))[0] ?? null;
    if (target === null) {
      throw new OrganizationsError('PRINCIPAL_NOT_FOUND', `principal ${machinePrincipalId} does not exist`);
    }
    if (target.kind !== 'machine') {
      throw new OrganizationsError('INVALID_INPUT', 'only service accounts can be revoked through this operation');
    }
    // Credentials are revoked BEFORE the membership so a failure mid-way
    // never leaves an active key for a revoked member.
    const { revoked } = await identity.revokeApiKeysForPrincipal(machinePrincipalId);
    const membership = await applyMembershipUpdate(ctx, machinePrincipalId, { status: 'revoked' });
    return { member: { membership, principal: target }, revokedKeys: revoked };
  }

  // -------------------------------------------------------------------------
  // Public operations (resolve + authorize through the one chain, then act)
  // -------------------------------------------------------------------------

  async function createTenant(
    principal: Principal,
    orgSlug: string,
    input: { slug: string; displayName: string },
  ): Promise<TenantRecord> {
    const ctx = await requireOrganizationAccess(principal, orgSlug, 'administer');
    return createTenantIn(ctx, input);
  }

  async function listTenants(principal: Principal, orgSlug: string): Promise<TenantRecord[]> {
    const ctx = await requireOrganizationAccess(principal, orgSlug, 'read');
    return listTenantsIn(ctx);
  }

  async function addMember(
    principal: Principal,
    orgSlug: string,
    input: { principalId: string; role: string },
  ): Promise<MemberView> {
    const ctx = await requireOrganizationAccess(principal, orgSlug, 'administer');
    return addMemberIn(ctx, input);
  }

  async function listMembers(principal: Principal, orgSlug: string): Promise<MemberView[]> {
    const ctx = await requireOrganizationAccess(principal, orgSlug, 'read');
    return listMembersIn(ctx);
  }

  async function setMemberRole(
    principal: Principal,
    orgSlug: string,
    memberPrincipalId: string,
    role: string,
  ): Promise<MemberView> {
    const ctx = await requireOrganizationAccess(principal, orgSlug, 'administer');
    return setMemberRoleIn(ctx, memberPrincipalId, role);
  }

  async function revokeMember(principal: Principal, orgSlug: string, memberPrincipalId: string): Promise<MemberView> {
    const ctx = await requireOrganizationAccess(principal, orgSlug, 'administer');
    return revokeMemberIn(ctx, memberPrincipalId);
  }

  async function listTenantMembers(principal: Principal, tenantSlug: string): Promise<MemberView[]> {
    const ctx = await requireTenantAccess(principal, tenantSlug, 'read');
    return listTenantMembersIn(ctx);
  }

  async function createServiceAccount(
    principal: Principal,
    orgSlug: string,
    input: { displayName: string; role: string },
  ): Promise<{ member: MemberView; secret: string; keyId: string }> {
    const ctx = await requireOrganizationAccess(principal, orgSlug, 'administer');
    return createServiceAccountIn(ctx, input);
  }

  async function listServiceAccounts(principal: Principal, orgSlug: string): Promise<MemberView[]> {
    const ctx = await requireOrganizationAccess(principal, orgSlug, 'read');
    return listServiceAccountsIn(ctx);
  }

  async function revokeServiceAccount(
    principal: Principal,
    orgSlug: string,
    machinePrincipalId: string,
  ): Promise<{ member: MemberView; revokedKeys: number }> {
    const ctx = await requireOrganizationAccess(principal, orgSlug, 'administer');
    return revokeServiceAccountIn(ctx, machinePrincipalId);
  }

  const moduleRoutes = createOrganizationRoutes({
    ops: {
      createOrganization,
      listOrganizationsForPrincipal,
      listTenantsIn,
      createTenantIn,
      addMemberIn,
      listMembersIn,
      setMemberRoleIn,
      revokeMemberIn,
      listTenantMembersIn,
      createServiceAccountIn,
      listServiceAccountsIn,
      revokeServiceAccountIn,
    },
    guards,
    toRouteHttpError,
  });

  return {
    authorize,
    createOrganization,
    listOrganizationsForPrincipal,
    createTenant,
    listTenants,
    addMember,
    listMembers,
    setMemberRole,
    revokeMember,
    listTenantMembers,
    createServiceAccount,
    listServiceAccounts,
    revokeServiceAccount,
    routes: () => [...moduleRoutes],
  };
}

export default defineModule({
  name: 'organizations',
  version: '0.2.0',
  description: 'organizations, tenants, memberships and roles',
});
