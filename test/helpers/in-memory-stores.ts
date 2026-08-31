/**
 * Test helpers: faithful in-memory implementations of the /auth and
 * /organizations store ports (WORK-002).
 *
 * These are NOT a second persistence authority — they implement the same
 * store contract the SQL stores implement, so the modules' decision logic,
 * guard chain and route behavior are proven without a live PostgreSQL:
 *
 * - unique constraints surface as `StoreConflictError` with the same
 *   constraint names as the schema;
 * - `createOrganizationWithTenant` and `updateMembership` are atomic per call
 *   (synchronous critical sections after optional async hooks — the exact
 *   semantics of the locked SQL transaction);
 * - async hooks (`before*`) inject deterministic interleaving points so
 *   concurrency proofs exercise real check-then-insert races;
 * - `reads` counters allow tests to prove that a denied request NEVER
 *   touches domain data (authorization happens before data access);
 * - `listTenantDirectory` applies the mandatory tenant predicate exactly like
 *   the SQL store.
 */
import { randomUUID } from 'node:crypto';
import {
  StoreConflictError,
  createAuthModule,
  type ApiKeyRecord,
  type ApiKeyWithPrincipal,
  type AuthModule,
  type AuthStore,
  type NewApiKey,
  type NewPrincipal,
  type NewSession,
  type PrincipalRecord,
  type SessionRecord,
  type SessionWithPrincipal,
} from '../../src/modules/auth/index.js';
import {
  StoreMissingError,
  StoreRuleError,
  createOrganizationsModule,
  type CreateMembershipInput,
  type CreateOrganizationInput,
  type CreateOrganizationResult,
  type CreateTenantInput,
  type MembershipRecord,
  type MembershipWithOrganization,
  type OrganizationRecord,
  type OrganizationsModule,
  type OrganizationsStore,
  type Role,
  type TenantRecord,
} from '../../src/modules/organizations/index.js';
import type { RouteDescriptor } from '../../src/platform/http/index.js';

/** Internal mutable shape of a readonly record (stores keep these; reads copy). */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

type MutablePrincipal = Mutable<PrincipalRecord>;
type MutableSession = Mutable<SessionRecord>;
type MutableApiKey = Mutable<ApiKeyRecord>;
type MutableOrganization = Mutable<OrganizationRecord>;
type MutableTenant = Mutable<TenantRecord>;
type MutableMembership = Mutable<MembershipRecord>;

// ---------------------------------------------------------------------------
// In-memory auth store
// ---------------------------------------------------------------------------

export interface InMemoryAuthStoreOptions {
  now?: () => Date;
  /** Race-injection point inside createUser, before the unique check. */
  beforeCreateUser?: () => Promise<void>;
}

export class InMemoryAuthStore implements AuthStore {
  readonly users = new Map<string, MutablePrincipal>();
  readonly usersByEmail = new Map<string, string>();
  readonly sessions = new Map<string, MutableSession>();
  readonly sessionsByTokenHash = new Map<string, string>();
  readonly apiKeys = new Map<string, MutableApiKey>();
  readonly apiKeysByHash = new Map<string, string>();
  readonly reads = { byEmail: 0, byTokenHash: 0, byKeyHash: 0 };

  constructor(private readonly options: InMemoryAuthStoreOptions = {}) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  async createUser(principal: NewPrincipal): Promise<PrincipalRecord> {
    await this.options.beforeCreateUser?.();
    // Atomic check + insert (synchronous critical section).
    if (this.usersByEmail.has(principal.email)) {
      throw new StoreConflictError(`email ${principal.email} is already registered`, 'auth_users_email_key');
    }
    const record: PrincipalRecord = {
      id: randomUUID(),
      email: principal.email,
      kind: principal.kind,
      displayName: principal.displayName,
      passwordHash: principal.passwordHash,
      status: 'active',
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    this.users.set(record.id, record);
    this.usersByEmail.set(record.email, record.id);
    return { ...record };
  }

  async findUserByEmail(email: string): Promise<PrincipalRecord | null> {
    this.reads.byEmail += 1;
    const id = this.usersByEmail.get(email);
    const record = id === undefined ? undefined : this.users.get(id);
    return record === undefined ? null : { ...record };
  }

  async findUserById(id: string): Promise<PrincipalRecord | null> {
    const record = this.users.get(id);
    return record === undefined ? null : { ...record };
  }

  async insertSession(session: NewSession): Promise<SessionRecord> {
    if (this.sessionsByTokenHash.has(session.tokenHash)) {
      throw new StoreConflictError('session token hash already exists', 'auth_sessions_token_hash_key');
    }
    const record: SessionRecord = {
      id: randomUUID(),
      principalId: session.principalId,
      tokenHash: session.tokenHash,
      status: 'active',
      expiresAt: session.expiresAt,
      lastUsedAt: null,
      createdAt: this.now(),
    };
    this.sessions.set(record.id, record);
    this.sessionsByTokenHash.set(record.tokenHash, record.id);
    return { ...record };
  }

  async findActiveSessionByTokenHash(tokenHash: string, now: Date): Promise<SessionWithPrincipal | null> {
    this.reads.byTokenHash += 1;
    const id = this.sessionsByTokenHash.get(tokenHash);
    const session = id === undefined ? undefined : this.sessions.get(id);
    const principal = session === undefined ? undefined : this.users.get(session.principalId);
    if (session === undefined || principal === undefined) return null;
    if (session.status !== 'active' || principal.status !== 'active' || session.expiresAt.getTime() <= now.getTime()) {
      return null;
    }
    return { session: { ...session }, principal: { ...principal } };
  }

  async revokeSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (session === undefined || session.status !== 'active') return false;
    session.status = 'revoked';
    return true;
  }

  async touchSessionLastUsed(sessionId: string, at: Date): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session !== undefined) {
      session.lastUsedAt = at;
    }
  }

  async insertApiKey(apiKey: NewApiKey): Promise<ApiKeyRecord> {
    if (this.apiKeysByHash.has(apiKey.keyHash)) {
      throw new StoreConflictError('api key hash already exists', 'auth_api_keys_key_hash_key');
    }
    const record: ApiKeyRecord = {
      id: randomUUID(),
      principalId: apiKey.principalId,
      keyHash: apiKey.keyHash,
      keyHint: apiKey.keyHint,
      status: 'active',
      createdAt: this.now(),
    };
    this.apiKeys.set(record.id, record);
    this.apiKeysByHash.set(record.keyHash, record.id);
    return { ...record };
  }

  async findActiveApiKeyByHash(keyHash: string): Promise<ApiKeyWithPrincipal | null> {
    this.reads.byKeyHash += 1;
    const id = this.apiKeysByHash.get(keyHash);
    const apiKey = id === undefined ? undefined : this.apiKeys.get(id);
    const principal = apiKey === undefined ? undefined : this.users.get(apiKey.principalId);
    if (apiKey === undefined || principal === undefined) return null;
    if (apiKey.status !== 'active' || principal.status !== 'active') return null;
    return { apiKey: { ...apiKey }, principal: { ...principal } };
  }

  async revokeApiKeysForPrincipal(principalId: string): Promise<number> {
    let revoked = 0;
    for (const key of this.apiKeys.values()) {
      if (key.principalId === principalId && key.status === 'active') {
        key.status = 'revoked';
        revoked += 1;
      }
    }
    return revoked;
  }
}

// ---------------------------------------------------------------------------
// In-memory organizations store
// ---------------------------------------------------------------------------

export interface InMemoryOrganizationsStoreOptions {
  now?: () => Date;
  /** Race-injection point inside createOrganizationWithTenant. */
  beforeCreateOrganization?: () => Promise<void>;
  /** Race-injection point inside createMembership/createTenant. */
  beforeCreateMembership?: () => Promise<void>;
}

export class InMemoryOrganizationsStore implements OrganizationsStore {
  readonly organizations = new Map<string, MutableOrganization>();
  readonly organizationsBySlug = new Map<string, string>();
  readonly tenants = new Map<string, MutableTenant>();
  readonly tenantsBySlug = new Map<string, string>();
  readonly memberships = new Map<string, MutableMembership>();
  /** Read counters used to prove denials happen BEFORE domain data access. */
  readonly reads = { tenantDirectory: 0, membershipsForOrganization: 0, tenantsForOrganization: 0 };

  constructor(private readonly options: InMemoryOrganizationsStoreOptions = {}) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  async createOrganizationWithTenant(input: CreateOrganizationInput): Promise<CreateOrganizationResult> {
    await this.options.beforeCreateOrganization?.();
    // Atomic critical section: all-or-nothing creation of organization,
    // default tenant and owner membership, with the schema's unique rules.
    if (this.organizationsBySlug.has(input.slug)) {
      throw new StoreConflictError(`organization slug ${input.slug} is taken`, 'org_organizations_slug_key');
    }
    if (this.tenantsBySlug.has(input.tenantSlug)) {
      throw new StoreConflictError(`tenant slug ${input.tenantSlug} is taken`, 'org_service_tenants_slug_key');
    }
    const now = this.now();
    const organization: MutableOrganization = {
      id: randomUUID(),
      slug: input.slug,
      displayName: input.displayName,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    const tenant: MutableTenant = {
      id: randomUUID(),
      organizationId: organization.id,
      slug: input.tenantSlug,
      displayName: input.tenantDisplayName,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    const membership: MutableMembership = {
      id: randomUUID(),
      organizationId: organization.id,
      principalId: input.ownerPrincipalId,
      role: 'owner',
      status: 'active',
      grantedBy: input.ownerPrincipalId,
      createdAt: now,
      updatedAt: now,
    };
    this.organizations.set(organization.id, organization);
    this.organizationsBySlug.set(organization.slug, organization.id);
    this.tenants.set(tenant.id, tenant);
    this.tenantsBySlug.set(tenant.slug, tenant.id);
    this.memberships.set(membership.id, membership);
    return { organization: { ...organization }, tenant: { ...tenant }, membership: { ...membership } };
  }

  async findOrganizationBySlug(slug: string): Promise<OrganizationRecord | null> {
    const id = this.organizationsBySlug.get(slug);
    const record = id === undefined ? undefined : this.organizations.get(id);
    return record === undefined ? null : { ...record };
  }

  async findOrganizationById(id: string): Promise<OrganizationRecord | null> {
    const record = this.organizations.get(id);
    return record === undefined ? null : { ...record };
  }

  async findTenantBySlug(slug: string): Promise<TenantRecord | null> {
    const id = this.tenantsBySlug.get(slug);
    const record = id === undefined ? undefined : this.tenants.get(id);
    return record === undefined ? null : { ...record };
  }

  async findTenantById(id: string): Promise<TenantRecord | null> {
    const record = this.tenants.get(id);
    return record === undefined ? null : { ...record };
  }

  async createTenant(input: CreateTenantInput): Promise<TenantRecord> {
    await this.options.beforeCreateMembership?.();
    if (this.tenantsBySlug.has(input.slug)) {
      throw new StoreConflictError(`tenant slug ${input.slug} is taken`, 'org_service_tenants_slug_key');
    }
    const now = this.now();
    const tenant: MutableTenant = {
      id: randomUUID(),
      organizationId: input.organizationId,
      slug: input.slug,
      displayName: input.displayName,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    this.tenants.set(tenant.id, tenant);
    this.tenantsBySlug.set(tenant.slug, tenant.id);
    return { ...tenant };
  }

  async listTenantsForOrganization(organizationId: string): Promise<TenantRecord[]> {
    this.reads.tenantsForOrganization += 1;
    return [...this.tenants.values()]
      .filter((tenant) => tenant.organizationId === organizationId)
      .map((tenant) => ({ ...tenant }));
  }

  async createMembership(input: CreateMembershipInput): Promise<MembershipRecord> {
    await this.options.beforeCreateMembership?.();
    for (const membership of this.memberships.values()) {
      if (membership.organizationId === input.organizationId && membership.principalId === input.principalId) {
        throw new StoreConflictError(
          `principal ${input.principalId} is already a member`,
          'org_memberships_organization_id_principal_id_key',
        );
      }
    }
    const now = this.now();
    const membership: MutableMembership = {
      id: randomUUID(),
      organizationId: input.organizationId,
      principalId: input.principalId,
      role: input.role,
      status: 'active',
      grantedBy: input.grantedBy,
      createdAt: now,
      updatedAt: now,
    };
    this.memberships.set(membership.id, membership);
    return { ...membership };
  }

  async findMembership(organizationId: string, principalId: string): Promise<MembershipRecord | null> {
    for (const membership of this.memberships.values()) {
      if (membership.organizationId === organizationId && membership.principalId === principalId) {
        return { ...membership };
      }
    }
    return null;
  }

  async updateMembership(
    organizationId: string,
    principalId: string,
    change: { role?: Role; status?: 'active' | 'revoked' },
    options: { requireActiveOwnerRemaining: boolean },
    now: Date,
  ): Promise<MembershipRecord> {
    // Atomic critical section: lock-equivalent read, rule check, update.
    const membership = [...this.memberships.values()].find(
      (candidate) => candidate.organizationId === organizationId && candidate.principalId === principalId,
    );
    if (membership === undefined) {
      throw new StoreMissingError(`no membership for principal ${principalId} in organization ${organizationId}`);
    }
    const nextRole = change.role ?? membership.role;
    const nextStatus = change.status ?? membership.status;
    if (
      options.requireActiveOwnerRemaining &&
      membership.status === 'active' &&
      membership.role === 'owner' &&
      (nextRole !== 'owner' || nextStatus !== 'active')
    ) {
      const activeOwners = [...this.memberships.values()].filter(
        (candidate) =>
          candidate.organizationId === organizationId &&
          candidate.status === 'active' &&
          candidate.role === 'owner',
      );
      if (activeOwners.length <= 1) {
        throw new StoreRuleError(
          `revoking or demoting the last active owner of organization ${organizationId} is forbidden`,
          'last-active-owner',
        );
      }
    }
    membership.role = nextRole;
    membership.status = nextStatus;
    membership.updatedAt = now;
    return { ...membership };
  }

  async listOrganizationsForPrincipal(principalId: string): Promise<MembershipWithOrganization[]> {
    const results: MembershipWithOrganization[] = [];
    for (const membership of this.memberships.values()) {
      if (membership.principalId !== principalId || membership.status !== 'active') continue;
      const organization = this.organizations.get(membership.organizationId);
      if (organization === undefined) continue;
      results.push({ membership: { ...membership }, organization: { ...organization } });
    }
    return results.sort((a, b) => a.organization.slug.localeCompare(b.organization.slug));
  }

  async listMembershipsForOrganization(organizationId: string): Promise<MembershipRecord[]> {
    this.reads.membershipsForOrganization += 1;
    return [...this.memberships.values()]
      .filter((membership) => membership.organizationId === organizationId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.principalId.localeCompare(b.principalId))
      .map((membership) => ({ ...membership }));
  }

  async listTenantDirectory(tenantId: string): Promise<MembershipRecord[]> {
    this.reads.tenantDirectory += 1;
    // MANDATORY tenant predicate: select memberships THROUGH the tenant.
    const tenant = this.tenants.get(tenantId);
    if (tenant === undefined) return [];
    return [...this.memberships.values()]
      .filter((membership) => membership.organizationId === tenant.organizationId && membership.status === 'active')
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.principalId.localeCompare(b.principalId))
      .map((membership) => ({ ...membership }));
  }

  async countActiveOwners(organizationId: string): Promise<number> {
    return [...this.memberships.values()].filter(
      (membership) =>
        membership.organizationId === organizationId &&
        membership.status === 'active' &&
        membership.role === 'owner',
    ).length;
  }
}

// ---------------------------------------------------------------------------
// Full identity application over the in-memory stores
// ---------------------------------------------------------------------------

export interface IdentityApp {
  authStore: InMemoryAuthStore;
  orgStore: InMemoryOrganizationsStore;
  auth: AuthModule;
  organizations: OrganizationsModule;
  routes: RouteDescriptor[];
}

/** Build the composed identity/tenancy modules over in-memory stores. */
export function buildIdentityApp(options: { now?: () => Date } = {}): IdentityApp {
  const now = options.now ?? (() => new Date());
  const authStore = new InMemoryAuthStore({ now });
  const orgStore = new InMemoryOrganizationsStore({ now });
  const auth = createAuthModule({ store: authStore, now });
  const organizations = createOrganizationsModule({
    store: orgStore,
    authenticator: auth.authenticate,
    identity: auth,
    now,
  });
  return { authStore, orgStore, auth, organizations, routes: [...auth.routes(), ...organizations.routes()] };
}
