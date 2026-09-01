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
import {
  createWorkModule,
  WorkStoreMissingError,
  WorkStoreRuleError,
  type AddDependencyInput,
  type CreateAttemptInput,
  type CreateWorkInput,
  type DispatchAttemptInput,
  type RecordAttemptResultInput,
  type WorkAttemptRecord,
  type WorkDependencyRecord,
  type WorkModule,
  type WorkRecord,
  type WorkStore,
} from '../../src/modules/work/index.js';

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

// ---------------------------------------------------------------------------
// In-memory /work store (WORK-003)
// ---------------------------------------------------------------------------

type MutableWork = Mutable<WorkRecord>;
type MutableAttempt = Mutable<WorkAttemptRecord>;
type MutableDependency = Mutable<WorkDependencyRecord>;

export interface InMemoryWorkStoreOptions {
  now?: () => Date;
  /** Race-injection points before the synchronous critical sections. */
  beforeCreateWork?: () => Promise<void>;
  beforeCreateAttempt?: () => Promise<void>;
  beforeAddDependency?: () => Promise<void>;
  beforeDispatchAttempt?: () => Promise<void>;
  beforeRecordResult?: () => Promise<void>;
}

/**
 * Faithful in-memory implementation of the /work store port. NOT a second
 * persistence authority: it implements the same contract the SQL store
 * implements, so the module's decision logic and the retry/supersession
 * protocol are proven without a live PostgreSQL:
 *
 * - every read is tenant-predicated exactly like the SQL store;
 * - `reads` counters prove denials happen before domain data access;
 * - createWork/createAttempt/addDependency perform their check+mutate
 *   sequence inside ONE synchronous critical section (the semantics of the
 *   locked SQL transaction); async hooks inject deterministic interleaving
 *   points BEFORE the critical section so concurrency proofs exercise real
 *   races;
 * - dependency-cycle detection is a graph traversal equivalent to the SQL
 *   recursive CTE;
 * - the same typed rule/missing errors as the SQL store.
 */
export class InMemoryWorkStore implements WorkStore {
  readonly works = new Map<string, MutableWork>();
  readonly worksByIdempotency = new Map<string, string>();
  readonly attempts = new Map<string, MutableAttempt>();
  readonly dependencies = new Map<string, MutableDependency>();
  readonly reads = {
    workById: 0,
    worksList: 0,
    attemptById: 0,
    attemptsList: 0,
    dependenciesList: 0,
  };
  /** Race-injection hooks (public so concurrency tests can swap them). */
  readonly options: InMemoryWorkStoreOptions;
  private readonly now: () => Date;

  constructor(options: InMemoryWorkStoreOptions = {}) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
  }

  async createWork(input: CreateWorkInput): Promise<{ work: WorkRecord; converged: boolean }> {
    await this.options.beforeCreateWork?.();
    // Synchronous critical section (SQL: insert against the partial unique
    // index, conflict -> converged re-read).
    if (input.idempotencyKey !== null) {
      const existingId = this.worksByIdempotency.get(`${input.tenantId}:${input.idempotencyKey}`);
      if (existingId !== undefined) {
        const existing = this.works.get(existingId);
        if (existing !== undefined) return { work: { ...existing }, converged: true };
      }
    }
    const work: MutableWork = {
      id: randomUUID(),
      tenantId: input.tenantId,
      workType: input.workType,
      title: input.title,
      status: 'draft',
      createdBy: input.createdBy,
      idempotencyKey: input.idempotencyKey,
      currentAttemptId: null,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.works.set(work.id, work);
    if (work.idempotencyKey !== null) {
      this.worksByIdempotency.set(`${work.tenantId}:${work.idempotencyKey}`, work.id);
    }
    return { work: { ...work }, converged: false };
  }

  async findWorkById(tenantId: string, workId: string): Promise<WorkRecord | null> {
    this.reads.workById += 1;
    const work = this.works.get(workId);
    // MANDATORY tenant predicate: a row in another tenant is invisible.
    return work !== undefined && work.tenantId === tenantId ? { ...work } : null;
  }

  async listWorks(tenantId: string): Promise<WorkRecord[]> {
    this.reads.worksList += 1;
    return [...this.works.values()]
      .filter((work) => work.tenantId === tenantId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
      .map((work) => ({ ...work }));
  }

  async addDependency(input: AddDependencyInput): Promise<{ dependency: WorkDependencyRecord; converged: boolean }> {
    await this.options.beforeAddDependency?.();
    // Synchronous critical section (SQL: advisory transaction lock).
    if (input.workId === input.dependsOnWorkId) {
      throw new WorkStoreRuleError('a work cannot depend on itself', 'self-dependency');
    }
    const work = this.works.get(input.workId);
    const prerequisite = this.works.get(input.dependsOnWorkId);
    if (work === undefined || prerequisite === undefined || work.tenantId !== input.tenantId || prerequisite.tenantId !== input.tenantId) {
      throw new WorkStoreMissingError(`dependency endpoints must both exist in tenant ${input.tenantId}`, 'work');
    }
    for (const dependency of this.dependencies.values()) {
      if (dependency.workId === input.workId && dependency.dependsOnWorkId === input.dependsOnWorkId) {
        return { dependency: { ...dependency }, converged: true };
      }
    }
    if (this.reaches(prerequisite.id, work.id)) {
      throw new WorkStoreRuleError(
        `dependency ${input.workId} -> ${input.dependsOnWorkId} would close a cycle`,
        'dependency-cycle',
      );
    }
    const dependency: MutableDependency = {
      id: randomUUID(),
      tenantId: input.tenantId,
      workId: input.workId,
      dependsOnWorkId: input.dependsOnWorkId,
      createdBy: input.createdBy,
      createdAt: input.now,
    };
    this.dependencies.set(dependency.id, dependency);
    return { dependency: { ...dependency }, converged: false };
  }

  async listDependencies(tenantId: string, workId: string): Promise<WorkDependencyRecord[]> {
    this.reads.dependenciesList += 1;
    return [...this.dependencies.values()]
      .filter((dependency) => dependency.tenantId === tenantId && dependency.workId === workId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
      .map((dependency) => ({ ...dependency }));
  }

  async createAttempt(input: CreateAttemptInput): Promise<{ attempt: WorkAttemptRecord; converged: boolean }> {
    await this.options.beforeCreateAttempt?.();
    // Synchronous critical section (SQL: work-row FOR UPDATE lock).
    const work = this.works.get(input.workId);
    if (work === undefined || work.tenantId !== input.tenantId) {
      throw new WorkStoreMissingError(`work ${input.workId} does not exist in this tenant`, 'work');
    }
    const live = [...this.attempts.values()].find(
      (attempt) => attempt.workId === input.workId && attempt.supersededAt === null,
    );
    if (input.idempotencyKey !== null && live !== undefined && live.idempotencyKey === input.idempotencyKey) {
      if (live.dispatchedAt === null) {
        // Pre-dispatch convergence window: safely re-observe the original.
        return { attempt: { ...live }, converged: true };
      }
      // Dispatched: fall through and create a distinct replacement identity.
    }
    const current = live ?? null;
    const attemptNo = [...this.attempts.values()].filter((attempt) => attempt.workId === input.workId).length + 1;
    const attempt: MutableAttempt = {
      id: randomUUID(),
      tenantId: input.tenantId,
      workId: input.workId,
      attemptNo,
      status: 'pending',
      idempotencyKey: input.idempotencyKey,
      createdBy: input.createdBy,
      supersedesId: current !== null ? current.id : null,
      supersededAt: null,
      dispatchedAt: null,
      outcome: null,
      result: null,
      createdAt: input.now,
      updatedAt: input.now,
    };
    if (current !== null) {
      current.status = 'superseded';
      current.supersededAt = input.now;
      current.updatedAt = input.now;
    }
    this.attempts.set(attempt.id, attempt);
    work.currentAttemptId = attempt.id;
    work.updatedAt = input.now;
    return { attempt: { ...attempt }, converged: false };
  }

  async findAttemptById(tenantId: string, attemptId: string): Promise<WorkAttemptRecord | null> {
    this.reads.attemptById += 1;
    const attempt = this.attempts.get(attemptId);
    // MANDATORY tenant predicate.
    return attempt !== undefined && attempt.tenantId === tenantId ? { ...attempt } : null;
  }

  async listAttempts(tenantId: string, workId: string): Promise<WorkAttemptRecord[]> {
    this.reads.attemptsList += 1;
    return [...this.attempts.values()]
      .filter((attempt) => attempt.tenantId === tenantId && attempt.workId === workId)
      .sort((a, b) => a.attemptNo - b.attemptNo)
      .map((attempt) => ({ ...attempt }));
  }

  async dispatchAttempt(input: DispatchAttemptInput): Promise<{ attempt: WorkAttemptRecord; converged: boolean }> {
    await this.options.beforeDispatchAttempt?.();
    // Synchronous critical section (SQL: attempt-row FOR UPDATE lock).
    const attempt = this.attempts.get(input.attemptId);
    if (attempt === undefined || attempt.tenantId !== input.tenantId) {
      throw new WorkStoreMissingError(`attempt ${input.attemptId} does not exist in this tenant`, 'attempt');
    }
    if (attempt.supersededAt !== null) {
      throw new WorkStoreRuleError(
        `attempt ${input.attemptId} is superseded and cannot be dispatched`,
        'attempt-superseded',
      );
    }
    if (attempt.dispatchedAt !== null) {
      return { attempt: { ...attempt }, converged: true };
    }
    attempt.status = 'dispatched';
    attempt.dispatchedAt = input.now;
    attempt.updatedAt = input.now;
    return { attempt: { ...attempt }, converged: false };
  }

  async recordAttemptResult(input: RecordAttemptResultInput): Promise<{ attempt: WorkAttemptRecord; converged: boolean }> {
    await this.options.beforeRecordResult?.();
    // Synchronous critical section (SQL: attempt-row FOR UPDATE lock).
    const attempt = this.attempts.get(input.attemptId);
    if (attempt === undefined || attempt.tenantId !== input.tenantId) {
      throw new WorkStoreMissingError(`attempt ${input.attemptId} does not exist in this tenant`, 'attempt');
    }
    if (attempt.supersededAt !== null) {
      throw new WorkStoreRuleError(
        `attempt ${input.attemptId} is superseded; a late result cannot be recorded`,
        'attempt-superseded',
      );
    }
    if (attempt.outcome !== null) {
      if (attempt.outcome === input.outcome && attempt.result === input.result) {
        return { attempt: { ...attempt }, converged: true };
      }
      throw new WorkStoreRuleError(
        `attempt ${input.attemptId} already recorded a different result`,
        'attempt-result-conflict',
      );
    }
    attempt.status = input.outcome;
    attempt.outcome = input.outcome;
    attempt.result = input.result;
    attempt.updatedAt = input.now;
    return { attempt: { ...attempt }, converged: false };
  }

  /** Cycle detection: does `fromId` transitively depend on `toId`? */
  private reaches(fromId: string, toId: string): boolean {
    const visited = new Set<string>();
    const queue = [...this.dependencies.values()]
      .filter((dependency) => dependency.workId === fromId)
      .map((dependency) => dependency.dependsOnWorkId);
    while (queue.length > 0) {
      const node = queue.shift() as string;
      if (node === toId) return true;
      if (visited.has(node)) continue;
      visited.add(node);
      for (const dependency of this.dependencies.values()) {
        if (dependency.workId === node) queue.push(dependency.dependsOnWorkId);
      }
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Full Service Work application over the in-memory stores
// ---------------------------------------------------------------------------

export interface ServiceWorkApp {
  authStore: InMemoryAuthStore;
  orgStore: InMemoryOrganizationsStore;
  workStore: InMemoryWorkStore;
  auth: AuthModule;
  organizations: OrganizationsModule;
  work: WorkModule;
}

/** Build the composed identity/tenancy/work modules over in-memory stores. */
export function buildServiceWorkApp(options: { now?: () => Date } = {}): ServiceWorkApp {
  const now = options.now ?? (() => new Date());
  const identity = buildIdentityApp({ now });
  const workStore = new InMemoryWorkStore({ now });
  const work = createWorkModule({ store: workStore, tenancy: identity.organizations, now });
  return {
    authStore: identity.authStore,
    orgStore: identity.orgStore,
    workStore,
    auth: identity.auth,
    organizations: identity.organizations,
    work,
  };
}

// ---------------------------------------------------------------------------
// In-memory policies store (WORK-014)
// ---------------------------------------------------------------------------

import {
  createPoliciesModule,
  PolicyStoreMissingError,
  PolicyStoreRuleError,
  type ActivatePolicyVersionInput,
  type CreatePolicyVersionInput,
  type PoliciesModule,
  type PolicyContractRecord,
  type PolicyDecisionRecord,
  type PolicyScope,
  type PolicyStore,
  type RecordDecisionInput,
} from '../../src/modules/policies/index.js';
import { canonicalJson } from '../../src/modules/policies/evaluation.js';
import { createHash } from 'node:crypto';

export interface InMemoryPoliciesStoreOptions {
  now?: () => Date;
  /** Race-injection points before the synchronous critical sections. */
  beforeCreatePolicyVersion?: () => Promise<void>;
  beforeActivatePolicyVersion?: () => Promise<void>;
  beforeRecordDecision?: () => Promise<void>;
}

type MutableContract = Mutable<PolicyContractRecord>;
type MutableDecision = Mutable<PolicyDecisionRecord>;

/**
 * Faithful in-memory implementation of the /policies store port. NOT a
 * second persistence authority: it implements the same contract the SQL
 * store implements, so the module's resolution/composition logic and the
 * versioning/idempotency protocol are proven without a live PostgreSQL:
 *
 * - every read is tenant-predicated exactly like the SQL store;
 * - `reads` counters prove denials happen before domain data access;
 * - version numbering, activation retirement ordering and decision
 *   convergence run inside ONE synchronous critical section (the semantics
 *   of the locked SQL transaction); async hooks inject deterministic
 *   interleaving points BEFORE the critical section so concurrency proofs
 *   exercise real races;
 * - decision reads verify the input hash and record hash exactly like the
 *   SQL store (tamper detection) — the decision map holds mutable records
 *   so tests can tamper deliberately and prove detection;
 * - the same typed rule/missing errors as the SQL store.
 */
export class InMemoryPoliciesStore implements PolicyStore {
  readonly contracts = new Map<string, MutableContract>();
  readonly contractsByIdempotency = new Map<string, string>();
  readonly decisions = new Map<string, MutableDecision>();
  readonly decisionsByIdempotency = new Map<string, string>();
  readonly reads = {
    contractById: 0,
    contractsList: 0,
    activeLookup: 0,
    decisionById: 0,
    decisionByIdempotency: 0,
  };
  /** Race-injection hooks (public so concurrency tests can swap them). */
  readonly options: InMemoryPoliciesStoreOptions;
  private readonly now: () => Date;

  constructor(options: InMemoryPoliciesStoreOptions = {}) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
  }

  private inputHash(input: { action: string; attributes: Readonly<Record<string, unknown>> }): string {
    return createHash('sha256').update(canonicalJson(input)).digest('hex');
  }

  private recordHash(decision: PolicyDecisionRecord): string {
    return createHash('sha256')
      .update(
        canonicalJson({
          tenantId: decision.tenantId,
          policyKey: decision.policyKey,
          outcome: decision.outcome,
          decidingLayer: decision.decidingLayer,
          decidingRuleId: decision.decidingRuleId,
          frozenRevision: decision.frozenRevision,
          layers: decision.layers,
          input: decision.input,
          inputHash: decision.inputHash,
          decidedBy: decision.decidedBy,
          createdAt: decision.createdAt.toISOString(),
        }),
      )
      .digest('hex');
  }

  /** Integrity verification mirroring the SQL store's read path. */
  private verifyDecision(decision: MutableDecision): PolicyDecisionRecord {
    if (this.inputHash(decision.input) !== decision.inputHash) {
      throw new PolicyStoreRuleError(
        `policy decision ${decision.id} input no longer matches its recorded input hash`,
        'decision-record-tampered',
      );
    }
    if (this.recordHash(decision) !== decision.recordHash) {
      throw new PolicyStoreRuleError(
        `policy decision ${decision.id} record no longer matches its recorded integrity hash`,
        'decision-record-tampered',
      );
    }
    return { ...decision, layers: decision.layers.map((layer) => ({ ...layer })) };
  }

  async createPolicyVersion(input: CreatePolicyVersionInput): Promise<{ contract: PolicyContractRecord; converged: boolean }> {
    await this.options.beforeCreatePolicyVersion?.();
    // Synchronous critical section (SQL: idempotency lookup + advisory-locked
    // version numbering + insert).
    if (input.idempotencyKey !== null) {
      const existingId = this.contractsByIdempotency.get(`${input.tenantId}:${input.idempotencyKey}`);
      if (existingId !== undefined) {
        const existing = this.contracts.get(existingId);
        if (existing !== undefined) return { contract: { ...existing }, converged: true };
      }
    }
    let version = 1;
    for (const contract of this.contracts.values()) {
      if (
        contract.tenantId === input.tenantId &&
        contract.policyKey === input.policyKey &&
        contract.scope === input.scope &&
        contract.version >= version
      ) {
        version = contract.version + 1;
      }
    }
    const id = randomUUID();
    const contract: MutableContract = {
      id,
      tenantId: input.tenantId,
      policyKey: input.policyKey,
      scope: input.scope,
      version,
      status: 'draft',
      rules: input.rules.map((rule) => ({ ...rule, when: rule.when })),
      defaultEffect: input.defaultEffect,
      createdBy: input.createdBy,
      idempotencyKey: input.idempotencyKey,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.contracts.set(id, contract);
    if (input.idempotencyKey !== null) {
      this.contractsByIdempotency.set(`${input.tenantId}:${input.idempotencyKey}`, id);
    }
    return { contract: { ...contract }, converged: false };
  }

  async findPolicyVersionById(tenantId: string, versionId: string): Promise<PolicyContractRecord | null> {
    this.reads.contractById += 1;
    const contract = this.contracts.get(versionId);
    if (contract === undefined || contract.tenantId !== tenantId) return null;
    return { ...contract, rules: contract.rules.map((rule) => ({ ...rule })) };
  }

  async listPolicyVersions(tenantId: string, policyKey: string, scope?: PolicyScope): Promise<PolicyContractRecord[]> {
    this.reads.contractsList += 1;
    const matches: MutableContract[] = [];
    for (const contract of this.contracts.values()) {
      if (
        contract.tenantId === tenantId &&
        contract.policyKey === policyKey &&
        (scope === undefined || contract.scope === scope)
      ) {
        matches.push(contract);
      }
    }
    matches.sort((a, b) => a.version - b.version);
    return matches.map((contract) => ({ ...contract, rules: contract.rules.map((rule) => ({ ...rule })) }));
  }

  async findActivePolicyVersion(tenantId: string, policyKey: string, scope: PolicyScope): Promise<PolicyContractRecord | null> {
    this.reads.activeLookup += 1;
    let active: MutableContract | null = null;
    for (const contract of this.contracts.values()) {
      if (
        contract.tenantId === tenantId &&
        contract.policyKey === policyKey &&
        contract.scope === scope &&
        contract.status === 'active' &&
        (active === null || contract.version > active.version)
      ) {
        active = contract;
      }
    }
    return active === null ? null : { ...active, rules: active.rules.map((rule) => ({ ...rule })) };
  }

  async activatePolicyVersion(input: ActivatePolicyVersionInput): Promise<{ contract: PolicyContractRecord; converged: boolean }> {
    await this.options.beforeActivatePolicyVersion?.();
    // Synchronous critical section (SQL: SELECT ... FOR UPDATE, retire
    // prior active first, then activate — the partial unique index is
    // per-statement, so ordering matters exactly like the SQL store).
    const contract = this.contracts.get(input.versionId);
    if (contract === undefined || contract.tenantId !== input.tenantId) {
      throw new PolicyStoreMissingError(
        `policy version ${input.versionId} does not exist in this tenant`,
        'policy-version',
      );
    }
    if (contract.status === 'active') {
      return { contract: { ...contract }, converged: true };
    }
    if (contract.status === 'retired') {
      throw new PolicyStoreRuleError(
        `policy version ${input.versionId} is retired and cannot be re-activated`,
        'version-retired',
      );
    }
    for (const other of this.contracts.values()) {
      if (
        other.tenantId === contract.tenantId &&
        other.policyKey === contract.policyKey &&
        other.scope === contract.scope &&
        other.status === 'active'
      ) {
        other.status = 'retired';
        other.updatedAt = input.now;
      }
    }
    contract.status = 'active';
    contract.updatedAt = input.now;
    return { contract: { ...contract }, converged: false };
  }

  async recordDecision(input: RecordDecisionInput): Promise<{ decision: PolicyDecisionRecord; converged: boolean }> {
    await this.options.beforeRecordDecision?.();
    // Synchronous critical section (SQL: idempotency lookup with input-hash
    // conflict check, then insert against the partial unique index).
    if (input.idempotencyKey !== null) {
      const existingId = this.decisionsByIdempotency.get(`${input.tenantId}:${input.idempotencyKey}`);
      if (existingId !== undefined) {
        const existing = this.decisions.get(existingId);
        if (existing !== undefined) {
          if (existing.inputHash !== input.inputHash) {
            throw new PolicyStoreRuleError(
              `decision idempotency key "${input.idempotencyKey}" was already bound to a different input`,
              'decision-input-conflict',
            );
          }
          return { decision: this.verifyDecision(existing), converged: true };
        }
      }
    }
    const id = randomUUID();
    const decision: MutableDecision = {
      id,
      tenantId: input.tenantId,
      policyKey: input.policyKey,
      outcome: input.outcome,
      decidingLayer: input.decidingLayer,
      decidingRuleId: input.decidingRuleId,
      frozenRevision: input.frozenRevision,
      layers: input.layers.map((layer) => ({ ...layer })),
      input: { action: input.input.action, attributes: { ...input.input.attributes } },
      inputHash: input.inputHash,
      recordHash: input.recordHash,
      decidedBy: input.decidedBy,
      idempotencyKey: input.idempotencyKey,
      createdAt: input.now,
    };
    this.decisions.set(id, decision);
    if (input.idempotencyKey !== null) {
      this.decisionsByIdempotency.set(`${input.tenantId}:${input.idempotencyKey}`, id);
    }
    return { decision: this.verifyDecision(decision), converged: false };
  }

  async findDecisionById(tenantId: string, decisionId: string): Promise<PolicyDecisionRecord | null> {
    this.reads.decisionById += 1;
    const decision = this.decisions.get(decisionId);
    if (decision === undefined || decision.tenantId !== tenantId) return null;
    // mapDecision-equivalent integrity verification (tamper detection).
    return this.verifyDecision(decision);
  }

  async findDecisionByIdempotencyKey(tenantId: string, idempotencyKey: string): Promise<PolicyDecisionRecord | null> {
    this.reads.decisionByIdempotency += 1;
    const id = this.decisionsByIdempotency.get(`${tenantId}:${idempotencyKey}`);
    if (id === undefined) return null;
    const decision = this.decisions.get(id);
    if (decision === undefined || decision.tenantId !== tenantId) return null;
    return this.verifyDecision(decision);
  }
}

export interface PoliciesApp {
  authStore: InMemoryAuthStore;
  orgStore: InMemoryOrganizationsStore;
  policyStore: InMemoryPoliciesStore;
  auth: AuthModule;
  organizations: OrganizationsModule;
  policies: PoliciesModule;
}

/** Build the composed identity/tenancy/policies modules over in-memory stores. */
export function buildPoliciesApp(options: { now?: () => Date } = {}): PoliciesApp {
  const now = options.now ?? (() => new Date());
  const identity = buildIdentityApp({ now });
  const policyStore = new InMemoryPoliciesStore({ now });
  const policies = createPoliciesModule({ store: policyStore, tenancy: identity.organizations, now });
  return {
    authStore: identity.authStore,
    orgStore: identity.orgStore,
    policyStore,
    auth: identity.auth,
    organizations: identity.organizations,
    policies,
  };
}
