/**
 * ServiceOS /organizations customer route guard (WORK-002, module internal).
 *
 * THE guard factory for customer routes. It composes the single authorization
 * chain into route guards:
 *
 *   request -> /auth authenticate (credential -> principal)
 *            -> server-side organization/tenant resolution (from the ROUTE,
 *               never from client-supplied trust material)
 *            -> membership lookup (server-side)
 *            -> roleAllows (the one capability matrix)
 *            -> handler (only on allow; a denial never reaches domain data)
 *
 * Every denial fails closed with a typed `RouteHttpError` BEFORE any domain
 * data is read (AC-4, architecture-lock #15/#16). Client headers and bodies
 * are never a trust source: the tenant/organization context is resolved from
 * the route path on the server.
 *
 * Only this module exports guard factories (structural check
 * `second-route-guard`); later Work Orders (e.g. WORK-012) reuse these guards
 * through the public interface instead of creating their own chain.
 */
import { RouteHttpError, type RouteGuard, type RouteRequest } from '../../platform/http/index.js';
import type { Authenticator, Principal } from '../auth/index.js';
import { roleAllows, type TenancyAction } from './authorization.js';
import type { MembershipRecord, OrganizationRecord, Role, TenantRecord } from './store.js';

export interface PrincipalGuardContext {
  readonly principal: Principal;
}

export interface OrganizationGuardContext {
  readonly principal: Principal;
  readonly organization: OrganizationRecord;
  readonly membership: MembershipRecord;
  readonly role: Role;
}

export interface TenantGuardContext extends OrganizationGuardContext {
  readonly tenant: TenantRecord;
}

export interface GuardDeps {
  readonly authenticator: Authenticator;
  readonly findOrganizationBySlug: (slug: string) => Promise<OrganizationRecord | null>;
  readonly findOrganizationById: (id: string) => Promise<OrganizationRecord | null>;
  readonly findTenantBySlug: (slug: string) => Promise<TenantRecord | null>;
  readonly findMembership: (organizationId: string, principalId: string) => Promise<MembershipRecord | null>;
}

function guardMisconfigured(detail: string): RouteHttpError {
  return new RouteHttpError(500, 'ROUTE_MISCONFIGURED', detail);
}

function unauthenticated(): RouteHttpError {
  return new RouteHttpError(401, 'UNAUTHENTICATED', 'a valid Bearer credential is required');
}

async function resolveMembership(
  deps: GuardDeps,
  principal: Principal,
  organization: OrganizationRecord,
  action: TenancyAction,
  deniedCode: 'ORGANIZATION_FORBIDDEN' | 'TENANT_FORBIDDEN',
): Promise<{ principal: Principal; membership: MembershipRecord; role: Role }> {
  if (organization.status !== 'active') {
    throw new RouteHttpError(403, 'ORGANIZATION_SUSPENDED', `organization ${organization.slug} is suspended`);
  }
  const membership = await deps.findMembership(organization.id, principal.id);
  if (membership === null || membership.status !== 'active') {
    // No membership in the organization that owns this tenant/organization:
    // cross-tenant access rejected before any domain data is touched.
    throw new RouteHttpError(
      403,
      deniedCode,
      `principal ${principal.id} has no active membership granting this ${deniedCode === 'TENANT_FORBIDDEN' ? 'tenant' : 'organization'}`,
    );
  }
  if (!roleAllows(membership.role, action)) {
    throw new RouteHttpError(
      403,
      'ROLE_FORBIDDEN',
      `role ${membership.role} does not grant the required capability`,
    );
  }
  return { principal, membership, role: membership.role };
}

/**
 * Authenticate FIRST: an unauthenticated caller must never learn whether a
 * target organization/tenant exists (401 precedes any 404/403 disclosure).
 */
async function authenticateRequest(deps: GuardDeps, req: RouteRequest): Promise<Principal> {
  try {
    return await deps.authenticator(req.headers['authorization']);
  } catch {
    throw unauthenticated();
  }
}

export function createAuthorizationGuard(deps: GuardDeps): {
  principal(): RouteGuard<PrincipalGuardContext>;
  organization(action: TenancyAction): RouteGuard<OrganizationGuardContext>;
  tenant(action: TenancyAction): RouteGuard<TenantGuardContext>;
} {
  async function requirePrincipal(req: RouteRequest): Promise<PrincipalGuardContext> {
    try {
      return { principal: await deps.authenticator(req.headers['authorization']) };
    } catch {
      throw unauthenticated();
    }
  }

  async function requireOrganization(
    req: RouteRequest,
    action: TenancyAction,
  ): Promise<OrganizationGuardContext> {
    // Authenticate FIRST: an unauthenticated caller must never learn whether
    // the target exists (401 precedes any 404/403 disclosure).
    const principal = await authenticateRequest(deps, req);
    const orgSlug = req.params['orgSlug'];
    if (typeof orgSlug !== 'string' || orgSlug === '') {
      throw guardMisconfigured('organization guard requires an :orgSlug route parameter');
    }
    const organization = await deps.findOrganizationBySlug(orgSlug);
    if (organization === null) {
      throw new RouteHttpError(404, 'ORGANIZATION_NOT_FOUND', `organization ${orgSlug} does not exist`);
    }
    const resolved = await resolveMembership(deps, principal, organization, action, 'ORGANIZATION_FORBIDDEN');
    return { ...resolved, organization };
  }

  async function requireTenant(req: RouteRequest, action: TenancyAction): Promise<TenantGuardContext> {
    // Authenticate FIRST (same reason as the organization guard).
    const principal = await authenticateRequest(deps, req);
    const tenantSlug = req.params['tenantSlug'];
    if (typeof tenantSlug !== 'string' || tenantSlug === '') {
      throw guardMisconfigured('tenant guard requires a :tenantSlug route parameter');
    }
    const tenant = await deps.findTenantBySlug(tenantSlug);
    if (tenant === null) {
      throw new RouteHttpError(404, 'TENANT_NOT_FOUND', `service tenant ${tenantSlug} does not exist`);
    }
    if (tenant.status !== 'active') {
      throw new RouteHttpError(403, 'TENANT_SUSPENDED', `service tenant ${tenant.slug} is suspended`);
    }
    const organization = await deps.findOrganizationById(tenant.organizationId);
    if (organization === null) {
      throw guardMisconfigured(`service tenant ${tenant.slug} references a missing organization`);
    }
    const resolved = await resolveMembership(deps, principal, organization, action, 'TENANT_FORBIDDEN');
    return { ...resolved, organization, tenant };
  }

  return {
    principal: () => requirePrincipal,
    organization: (action: TenancyAction) => (req: RouteRequest) => requireOrganization(req, action),
    tenant: (action: TenancyAction) => (req: RouteRequest) => requireTenant(req, action),
  };
}
