/**
 * ServiceOS /organizations SQL store (WORK-002, module internal).
 *
 * Authoritative persistence for organizations, service tenants and
 * memberships, executed through the persistence boundary's
 * `TransactionalExecutor` (parameterized SQL only; this file never imports
 * `pg`). Two invariants are load-bearing here:
 *
 * 1. Tenant-scoped reads carry a MANDATORY tenant predicate:
 *    `listTenantDirectory(tenantId)` selects memberships THROUGH
 *    `org_service_tenants.id = $1` (the isolated customer-domain boundary).
 *    The tenant-scoped-persistence discrimination tests assert the predicate
 *    text and the bound parameter; removing the predicate must fail them.
 * 2. `createOrganizationWithTenant` and `updateMembership` run inside one
 *    client-pinned transaction; `updateMembership` additionally serializes
 *    concurrent membership mutations with `SELECT ... FOR UPDATE` and
 *    enforces the last-active-owner rule inside the same transaction, so two
 *    concurrent revocations can never strip an organization of all owners.
 *
 * PostgreSQL constraint violations map to typed store errors exactly like
 * the in-memory test double, so module-level convergence logic is faithful.
 */
import type { SqlExecutor, TransactionalExecutor } from '../../platform/persistence/index.js';
import { StoreConflictError } from '../auth/index.js';
import {
  StoreMissingError,
  StoreRuleError,
  type CreateMembershipInput,
  type CreateOrganizationInput,
  type CreateOrganizationResult,
  type CreateTenantInput,
  type MembershipRecord,
  type MembershipWithOrganization,
  type OrganizationRecord,
  type OrganizationsStore,
  type Role,
  type TenantRecord,
} from './store.js';

interface OrganizationRow {
  id: string;
  slug: string;
  display_name: string;
  status: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface TenantRow {
  id: string;
  organization_id: string;
  slug: string;
  display_name: string;
  status: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface MembershipRow {
  id: string;
  organization_id: string;
  principal_id: string;
  role: string;
  status: string;
  granted_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const ORGANIZATION_COLUMNS = 'id, slug, display_name, status, created_at, updated_at';
const TENANT_COLUMNS = 'id, organization_id, slug, display_name, status, created_at, updated_at';
const MEMBERSHIP_COLUMNS = 'id, organization_id, principal_id, role, status, granted_by, created_at, updated_at';

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function mapOrganization(row: OrganizationRow): OrganizationRecord {
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    status: row.status === 'suspended' ? 'suspended' : 'active',
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function mapTenant(row: TenantRow): TenantRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    slug: row.slug,
    displayName: row.display_name,
    status: row.status === 'suspended' ? 'suspended' : 'active',
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function mapMembership(row: MembershipRow): MembershipRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    principalId: row.principal_id,
    role: row.role as Role,
    status: row.status === 'revoked' ? 'revoked' : 'active',
    grantedBy: row.granted_by,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function mapStoreError(error: unknown, context: string): unknown {
  if (error instanceof StoreConflictError || error instanceof StoreRuleError || error instanceof StoreMissingError) {
    return error;
  }
  const candidate = error as { code?: string; constraint?: string };
  if (typeof candidate?.code === 'string' && candidate.code === '23505') {
    return new StoreConflictError(`${context} violated a uniqueness constraint`, candidate.constraint ?? 'unknown');
  }
  return error;
}

export function createSqlOrganizationsStore(executor: TransactionalExecutor): OrganizationsStore {
  async function insertReturning(
    exec: SqlExecutor,
    sql: string,
    params: unknown[],
    context: string,
  ): Promise<Record<string, unknown>[]> {
    try {
      const result = await exec.query(sql, params);
      return result.rows;
    } catch (error) {
      throw mapStoreError(error, context);
    }
  }

  return {
    async createOrganizationWithTenant(input: CreateOrganizationInput): Promise<CreateOrganizationResult> {
      try {
        return await executor.withTransaction(async (tx) => {
          const orgRows = await insertReturning(
            tx,
            `INSERT INTO org_organizations (slug, display_name, status)
             VALUES ($1, $2, 'active')
             RETURNING ${ORGANIZATION_COLUMNS}`,
            [input.slug, input.displayName],
            'createOrganization',
          );
          const tenantRows = await insertReturning(
            tx,
            `INSERT INTO org_service_tenants (organization_id, slug, display_name, status)
             VALUES ($1, $2, $3, 'active')
             RETURNING ${TENANT_COLUMNS}`,
            [(orgRows[0] as { id: string }).id, input.tenantSlug, input.tenantDisplayName],
            'createOrganization.tenant',
          );
          const membershipRows = await insertReturning(
            tx,
            `INSERT INTO org_memberships (organization_id, principal_id, role, status, granted_by)
             VALUES ($1, $2, 'owner', 'active', $3)
             RETURNING ${MEMBERSHIP_COLUMNS}`,
            [(orgRows[0] as { id: string }).id, input.ownerPrincipalId, input.ownerPrincipalId],
            'createOrganization.membership',
          );
          return {
            organization: mapOrganization(orgRows[0] as unknown as OrganizationRow),
            tenant: mapTenant(tenantRows[0] as unknown as TenantRow),
            membership: mapMembership(membershipRows[0] as unknown as MembershipRow),
          };
        });
      } catch (error) {
        throw mapStoreError(error, 'createOrganizationWithTenant');
      }
    },

    async findOrganizationBySlug(slug: string): Promise<OrganizationRecord | null> {
      const result = await executor.query(
        `SELECT ${ORGANIZATION_COLUMNS} FROM org_organizations WHERE slug = $1`,
        [slug],
      );
      const row = result.rows[0] as unknown as OrganizationRow | undefined;
      return row === undefined ? null : mapOrganization(row);
    },

    async findOrganizationById(id: string): Promise<OrganizationRecord | null> {
      const result = await executor.query(
        `SELECT ${ORGANIZATION_COLUMNS} FROM org_organizations WHERE id = $1`,
        [id],
      );
      const row = result.rows[0] as unknown as OrganizationRow | undefined;
      return row === undefined ? null : mapOrganization(row);
    },

    async findTenantBySlug(slug: string): Promise<TenantRecord | null> {
      const result = await executor.query(
        `SELECT ${TENANT_COLUMNS} FROM org_service_tenants WHERE slug = $1`,
        [slug],
      );
      const row = result.rows[0] as unknown as TenantRow | undefined;
      return row === undefined ? null : mapTenant(row);
    },

    async findTenantById(id: string): Promise<TenantRecord | null> {
      const result = await executor.query(
        `SELECT ${TENANT_COLUMNS} FROM org_service_tenants WHERE id = $1`,
        [id],
      );
      const row = result.rows[0] as unknown as TenantRow | undefined;
      return row === undefined ? null : mapTenant(row);
    },

    async createTenant(input: CreateTenantInput): Promise<TenantRecord> {
      const rows = await insertReturning(
        executor,
        `INSERT INTO org_service_tenants (organization_id, slug, display_name, status)
         VALUES ($1, $2, $3, 'active')
         RETURNING ${TENANT_COLUMNS}`,
        [input.organizationId, input.slug, input.displayName],
        'createTenant',
      );
      return mapTenant(rows[0] as unknown as TenantRow);
    },

    async listTenantsForOrganization(organizationId: string): Promise<TenantRecord[]> {
      const result = await executor.query(
        `SELECT ${TENANT_COLUMNS} FROM org_service_tenants
         WHERE organization_id = $1
         ORDER BY created_at ASC, slug ASC`,
        [organizationId],
      );
      return result.rows.map((row) => mapTenant(row as unknown as TenantRow));
    },

    async createMembership(input: CreateMembershipInput): Promise<MembershipRecord> {
      const rows = await insertReturning(
        executor,
        `INSERT INTO org_memberships (organization_id, principal_id, role, status, granted_by)
         VALUES ($1, $2, $3, 'active', $4)
         RETURNING ${MEMBERSHIP_COLUMNS}`,
        [input.organizationId, input.principalId, input.role, input.grantedBy],
        'createMembership',
      );
      return mapMembership(rows[0] as unknown as MembershipRow);
    },

    async findMembership(organizationId: string, principalId: string): Promise<MembershipRecord | null> {
      const result = await executor.query(
        `SELECT ${MEMBERSHIP_COLUMNS} FROM org_memberships
         WHERE organization_id = $1 AND principal_id = $2`,
        [organizationId, principalId],
      );
      const row = result.rows[0] as unknown as MembershipRow | undefined;
      return row === undefined ? null : mapMembership(row);
    },

    async updateMembership(
      organizationId: string,
      principalId: string,
      change: { role?: Role; status?: 'active' | 'revoked' },
      options: { requireActiveOwnerRemaining: boolean },
      now: Date,
    ): Promise<MembershipRecord> {
      return executor.withTransaction(async (tx) => {
        // Serialize concurrent membership mutations for this organization so
        // the last-active-owner check sees committed state (SQL equivalent of
        // the in-memory store's synchronous critical section).
        await tx.query(
          `SELECT principal_id FROM org_memberships WHERE organization_id = $1 FOR UPDATE`,
          [organizationId],
        );
        const current = await tx.query(
          `SELECT ${MEMBERSHIP_COLUMNS} FROM org_memberships
           WHERE organization_id = $1 AND principal_id = $2`,
          [organizationId, principalId],
        );
        const currentRow = current.rows[0] as unknown as MembershipRow | undefined;
        if (currentRow === undefined) {
          throw new StoreMissingError(`no membership for principal ${principalId} in organization ${organizationId}`);
        }
        const nextRole = change.role ?? (currentRow.role as Role);
        const nextStatus = change.status ?? (currentRow.status === 'revoked' ? 'revoked' : 'active');
        if (options.requireActiveOwnerRemaining && currentRow.status === 'active' && currentRow.role === 'owner') {
          if (nextRole !== 'owner' || nextStatus !== 'active') {
            const owners = await tx.query(
              `SELECT COUNT(*)::int AS count FROM org_memberships
               WHERE organization_id = $1 AND status = 'active' AND role = 'owner'`,
              [organizationId],
            );
            const count = (owners.rows[0] as { count: number }).count;
            if (count <= 1) {
              throw new StoreRuleError(
                `revoking or demoting the last active owner of organization ${organizationId} is forbidden`,
                'last-active-owner',
              );
            }
          }
        }
        const updated = await tx.query(
          `UPDATE org_memberships SET role = $3, status = $4, updated_at = $5
           WHERE organization_id = $1 AND principal_id = $2
           RETURNING ${MEMBERSHIP_COLUMNS}`,
          [organizationId, principalId, nextRole, nextStatus, now],
        );
        return mapMembership(updated.rows[0] as unknown as MembershipRow);
      });
    },

    async listOrganizationsForPrincipal(principalId: string): Promise<MembershipWithOrganization[]> {
      const result = await executor.query(
        `SELECT m.id AS membership_id, m.organization_id, m.principal_id, m.role, m.status,
                m.granted_by, m.created_at AS membership_created_at, m.updated_at AS membership_updated_at,
                o.id AS org_id, o.slug, o.display_name, o.status AS org_status,
                o.created_at AS org_created_at, o.updated_at AS org_updated_at
         FROM org_memberships m
         JOIN org_organizations o ON o.id = m.organization_id
         WHERE m.principal_id = $1 AND m.status = 'active'
         ORDER BY o.slug ASC`,
        [principalId],
      );
      return result.rows.map((row) => {
        const record = row as Record<string, unknown>;
        return {
          membership: mapMembership({
            id: record.membership_id as string,
            organization_id: record.organization_id as string,
            principal_id: record.principal_id as string,
            role: record.role as string,
            status: record.status as string,
            granted_by: (record.granted_by as string | null) ?? null,
            created_at: record.membership_created_at as Date | string,
            updated_at: record.membership_updated_at as Date | string,
          }),
          organization: mapOrganization({
            id: record.org_id as string,
            slug: record.slug as string,
            display_name: record.display_name as string,
            status: record.org_status as string,
            created_at: record.org_created_at as Date | string,
            updated_at: record.org_updated_at as Date | string,
          }),
        };
      });
    },

    async listMembershipsForOrganization(organizationId: string): Promise<MembershipRecord[]> {
      const result = await executor.query(
        `SELECT ${MEMBERSHIP_COLUMNS} FROM org_memberships
         WHERE organization_id = $1
         ORDER BY created_at ASC, principal_id ASC`,
        [organizationId],
      );
      return result.rows.map((row) => mapMembership(row as unknown as MembershipRow));
    },

    async listTenantDirectory(tenantId: string): Promise<MembershipRecord[]> {
      // MANDATORY tenant predicate: the directory is selected THROUGH the
      // isolated customer-domain boundary (org_service_tenants.id = $1).
      // Removing this predicate must fail the tenant-scoped-persistence
      // discrimination tests.
      const result = await executor.query(
        `SELECT m.id, m.organization_id, m.principal_id, m.role, m.status, m.granted_by,
                m.created_at, m.updated_at
         FROM org_service_tenants t
         JOIN org_memberships m ON m.organization_id = t.organization_id
         WHERE t.id = $1 AND m.status = 'active'
         ORDER BY m.created_at ASC, m.principal_id ASC`,
        [tenantId],
      );
      return result.rows.map((row) => mapMembership(row as unknown as MembershipRow));
    },

    async countActiveOwners(organizationId: string): Promise<number> {
      const result = await executor.query(
        `SELECT COUNT(*)::int AS count FROM org_memberships
         WHERE organization_id = $1 AND status = 'active' AND role = 'owner'`,
        [organizationId],
      );
      return (result.rows[0] as { count: number }).count;
    },
  };
}
