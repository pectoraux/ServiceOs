/**
 * ServiceOS /organizations HTTP routes (WORK-002, module internal).
 *
 * Every tenancy-scoped (customer) route is defined with the module's
 * authorization guard — the single chain — so authorization happens BEFORE
 * any handler (and therefore before any domain data is touched). Handlers
 * receive the server-resolved guard context and never trust client-supplied
 * tenant/organization claims.
 *
 * WORK-012 owns the larger control-plane API; these routes are the
 * identity/tenancy substrate that Work Order requires on the protected
 * surfaces `/auth`, `/organizations`, `customer route guards`.
 */
import { defineRoute, readJsonObject, RouteHttpError, type RouteDescriptor } from '../../platform/http/index.js';
import type { Principal } from '../auth/index.js';
import type { OrganizationGuardContext, TenantGuardContext } from './guard.js';
import type { MembershipRecord, OrganizationRecord, TenantRecord } from './store.js';

export interface MemberView {
  readonly membership: MembershipRecord;
  readonly principal: Principal;
}

export interface OrganizationRouteDeps {
  readonly ops: {
    createOrganization(principal: Principal, input: { slug: string; displayName: string }): Promise<{
      organization: OrganizationRecord;
      tenant: TenantRecord;
      membership: MembershipRecord;
    }>;
    listOrganizationsForPrincipal(principalId: string): Promise<
      { membership: MembershipRecord; organization: OrganizationRecord }[]
    >;
    listTenantsIn(ctx: OrganizationGuardContext): Promise<TenantRecord[]>;
    createTenantIn(ctx: OrganizationGuardContext, input: { slug: string; displayName: string }): Promise<TenantRecord>;
    addMemberIn(ctx: OrganizationGuardContext, input: { principalId: string; role: string }): Promise<MemberView>;
    listMembersIn(ctx: OrganizationGuardContext): Promise<MemberView[]>;
    setMemberRoleIn(ctx: OrganizationGuardContext, memberPrincipalId: string, role: string): Promise<MemberView>;
    revokeMemberIn(ctx: OrganizationGuardContext, memberPrincipalId: string): Promise<MemberView>;
    listTenantMembersIn(ctx: TenantGuardContext): Promise<MemberView[]>;
    createServiceAccountIn(
      ctx: OrganizationGuardContext,
      input: { displayName: string; role: string },
    ): Promise<{ member: MemberView; secret: string; keyId: string }>;
    listServiceAccountsIn(ctx: OrganizationGuardContext): Promise<MemberView[]>;
    revokeServiceAccountIn(
      ctx: OrganizationGuardContext,
      machinePrincipalId: string,
    ): Promise<{ member: MemberView; revokedKeys: number }>;
  };
  readonly guards: {
    principal(): (req: import('../../platform/http/index.js').RouteRequest) => Promise<{ principal: Principal }>;
    organization(
      action: import('./authorization.js').TenancyAction,
    ): (req: import('../../platform/http/index.js').RouteRequest) => Promise<OrganizationGuardContext>;
    tenant(
      action: import('./authorization.js').TenancyAction,
    ): (req: import('../../platform/http/index.js').RouteRequest) => Promise<TenantGuardContext>;
  };
  toRouteHttpError(error: unknown): RouteHttpError;
}

function serializeOrganization(organization: OrganizationRecord): Record<string, unknown> {
  return {
    id: organization.id,
    slug: organization.slug,
    displayName: organization.displayName,
    status: organization.status,
    createdAt: organization.createdAt.toISOString(),
    updatedAt: organization.updatedAt.toISOString(),
  };
}

function serializeTenant(tenant: TenantRecord): Record<string, unknown> {
  return {
    id: tenant.id,
    organizationId: tenant.organizationId,
    slug: tenant.slug,
    displayName: tenant.displayName,
    status: tenant.status,
    createdAt: tenant.createdAt.toISOString(),
    updatedAt: tenant.updatedAt.toISOString(),
  };
}

function serializeMembership(membership: MembershipRecord): Record<string, unknown> {
  return {
    id: membership.id,
    organizationId: membership.organizationId,
    principalId: membership.principalId,
    role: membership.role,
    status: membership.status,
    grantedBy: membership.grantedBy,
    createdAt: membership.createdAt.toISOString(),
    updatedAt: membership.updatedAt.toISOString(),
  };
}

function serializePrincipal(principal: Principal): Record<string, unknown> {
  return {
    id: principal.id,
    email: principal.email,
    kind: principal.kind,
    displayName: principal.displayName,
    status: principal.status,
  };
}

function serializeMember(member: MemberView): Record<string, unknown> {
  return { membership: serializeMembership(member.membership), principal: serializePrincipal(member.principal) };
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string') {
    throw new RouteHttpError(400, 'INVALID_INPUT', `${field} must be a string`);
  }
  return value;
}

export function createOrganizationRoutes(deps: OrganizationRouteDeps): RouteDescriptor[] {
  const { ops, guards } = deps;
  const fail = (error: unknown): RouteHttpError => deps.toRouteHttpError(error);

  return [
    defineRoute({
      access: 'principal',
      method: 'POST',
      path: '/api/organizations',
      guard: guards.principal(),
      handler: async (req, ctx) => {
        try {
          const body = await readJsonObject(req);
          const created = await ops.createOrganization(ctx.principal, {
            slug: requireString(body, 'slug'),
            displayName: requireString(body, 'displayName'),
          });
          return {
            status: 201,
            body: {
              organization: serializeOrganization(created.organization),
              tenant: serializeTenant(created.tenant),
              membership: serializeMembership(created.membership),
            },
          };
        } catch (error) {
          throw fail(error);
        }
      },
    }),
    defineRoute({
      access: 'principal',
      method: 'GET',
      path: '/api/organizations',
      guard: guards.principal(),
      handler: async (_req, ctx) => {
        try {
          // Server-resolved from the principal's own memberships; the client
          // never supplies the organization list.
          const organizations = await ops.listOrganizationsForPrincipal(ctx.principal.id);
          return {
            status: 200,
            body: {
              organizations: organizations.map((entry) => ({
                organization: serializeOrganization(entry.organization),
                role: entry.membership.role,
              })),
            },
          };
        } catch (error) {
          throw fail(error);
        }
      },
    }),
    defineRoute({
      access: 'organization',
      method: 'GET',
      path: '/api/organizations/:orgSlug',
      guard: guards.organization('read'),
      handler: async (_req, ctx) => {
        try {
          const tenants = await ops.listTenantsIn(ctx);
          return {
            status: 200,
            body: {
              organization: serializeOrganization(ctx.organization),
              role: ctx.role,
              tenants: tenants.map(serializeTenant),
            },
          };
        } catch (error) {
          throw fail(error);
        }
      },
    }),
    defineRoute({
      access: 'organization',
      method: 'POST',
      path: '/api/organizations/:orgSlug/tenants',
      guard: guards.organization('administer'),
      handler: async (req, ctx) => {
        try {
          const body = await readJsonObject(req);
          const tenant = await ops.createTenantIn(ctx, {
            slug: requireString(body, 'slug'),
            displayName: requireString(body, 'displayName'),
          });
          return { status: 201, body: { tenant: serializeTenant(tenant) } };
        } catch (error) {
          throw fail(error);
        }
      },
    }),
    defineRoute({
      access: 'organization',
      method: 'GET',
      path: '/api/organizations/:orgSlug/tenants',
      guard: guards.organization('read'),
      handler: async (_req, ctx) => {
        try {
          const tenants = await ops.listTenantsIn(ctx);
          return { status: 200, body: { tenants: tenants.map(serializeTenant) } };
        } catch (error) {
          throw fail(error);
        }
      },
    }),
    defineRoute({
      access: 'organization',
      method: 'POST',
      path: '/api/organizations/:orgSlug/members',
      guard: guards.organization('administer'),
      handler: async (req, ctx) => {
        try {
          const body = await readJsonObject(req);
          const member = await ops.addMemberIn(ctx, {
            principalId: requireString(body, 'principalId'),
            role: requireString(body, 'role'),
          });
          return { status: 201, body: { member: serializeMember(member) } };
        } catch (error) {
          throw fail(error);
        }
      },
    }),
    defineRoute({
      access: 'organization',
      method: 'GET',
      path: '/api/organizations/:orgSlug/members',
      guard: guards.organization('read'),
      handler: async (_req, ctx) => {
        try {
          const members = await ops.listMembersIn(ctx);
          return { status: 200, body: { members: members.map(serializeMember) } };
        } catch (error) {
          throw fail(error);
        }
      },
    }),
    defineRoute({
      access: 'organization',
      method: 'POST',
      path: '/api/organizations/:orgSlug/members/:principalId/role',
      guard: guards.organization('administer'),
      handler: async (req, ctx) => {
        try {
          const body = await readJsonObject(req);
          const member = await ops.setMemberRoleIn(
            ctx,
            req.params['principalId'] ?? '',
            requireString(body, 'role'),
          );
          return { status: 200, body: { member: serializeMember(member) } };
        } catch (error) {
          throw fail(error);
        }
      },
    }),
    defineRoute({
      access: 'organization',
      method: 'POST',
      path: '/api/organizations/:orgSlug/members/:principalId/revoke',
      guard: guards.organization('administer'),
      handler: async (req, ctx) => {
        try {
          const member = await ops.revokeMemberIn(ctx, req.params['principalId'] ?? '');
          return { status: 200, body: { member: serializeMember(member) } };
        } catch (error) {
          throw fail(error);
        }
      },
    }),
    defineRoute({
      access: 'tenant',
      method: 'GET',
      path: '/api/tenants/:tenantSlug',
      guard: guards.tenant('read'),
      handler: async (_req, ctx) => ({
        status: 200,
        body: {
          tenant: serializeTenant(ctx.tenant),
          organization: serializeOrganization(ctx.organization),
          role: ctx.role,
        },
      }),
    }),
    defineRoute({
      access: 'tenant',
      method: 'GET',
      path: '/api/tenants/:tenantSlug/members',
      guard: guards.tenant('read'),
      handler: async (_req, ctx) => {
        try {
          // Tenant-scoped read: the store selects through the tenant
          // predicate (server-resolved ctx.tenant.id).
          const members = await ops.listTenantMembersIn(ctx);
          return { status: 200, body: { members: members.map(serializeMember) } };
        } catch (error) {
          throw fail(error);
        }
      },
    }),
    defineRoute({
      access: 'organization',
      method: 'POST',
      path: '/api/organizations/:orgSlug/service-accounts',
      guard: guards.organization('administer'),
      handler: async (req, ctx) => {
        try {
          const body = await readJsonObject(req);
          const created = await ops.createServiceAccountIn(ctx, {
            displayName: requireString(body, 'displayName'),
            role: requireString(body, 'role'),
          });
          return {
            status: 201,
            body: {
              member: serializeMember(created.member),
              // The API key secret is returned exactly once at issuance.
              apiKey: { id: created.keyId, secret: created.secret },
            },
          };
        } catch (error) {
          throw fail(error);
        }
      },
    }),
    defineRoute({
      access: 'organization',
      method: 'GET',
      path: '/api/organizations/:orgSlug/service-accounts',
      guard: guards.organization('read'),
      handler: async (_req, ctx) => {
        try {
          const members = await ops.listServiceAccountsIn(ctx);
          return { status: 200, body: { serviceAccounts: members.map(serializeMember) } };
        } catch (error) {
          throw fail(error);
        }
      },
    }),
    defineRoute({
      access: 'organization',
      method: 'POST',
      path: '/api/organizations/:orgSlug/service-accounts/:principalId/revoke',
      guard: guards.organization('administer'),
      handler: async (req, ctx) => {
        try {
          const result = await ops.revokeServiceAccountIn(ctx, req.params['principalId'] ?? '');
          return {
            status: 200,
            body: { member: serializeMember(result.member), revokedApiKeys: result.revokedKeys },
          };
        } catch (error) {
          throw fail(error);
        }
      },
    }),
  ];
}
