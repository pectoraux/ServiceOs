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
import {
  createInteractionsModule,
  InteractionsStoreMissingError,
  InteractionsStoreRuleError,
  hashObservation,
  computeInteractionRecordHash,
  type ClaimDispatchInput,
  type CompleteDispatchInput,
  type CreateInteractionInput,
  type InteractionFilter,
  type InteractionRecord,
  type InteractionsModule,
  type InteractionsStore,
  type ReclaimDispatchInput,
  type RecordDispatchFailureInput,
  type RecordObservationInput,
} from '../../src/modules/interactions/index.js';
import {
  createAdapterRegistry,
  createEffectSink,
  createInMemoryProviderAdapter,
  type AdapterRegistry,
  type CapabilityClass,
  type ExternalEffectSink,
} from '../../src/modules/integrations/index.js';
import {
  createNotificationsModule,
  NotificationsStoreMissingError,
  NotificationsStoreRuleError,
  computeNotificationRecordHash,
  type CreateNotificationInput,
  type NotificationRecord,
  type NotificationsModule,
  type NotificationsStore,
  type SetInteractionPointerInput,
} from '../../src/modules/notifications/index.js';

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

// ---------------------------------------------------------------------------
// In-memory workflow store (WORK-004)
// ---------------------------------------------------------------------------

import {
  createWorkflowModule,
  hashTransitionRecord,
  WorkflowStoreMissingError,
  WorkflowStoreRuleError,
  type ApplyTransitionInput,
  type SlaBreach,
  type SlaDeadlineRecord,
  type SetSlaDeadlineInput,
  type TransitionPreconditions,
  type TransitionRecord,
  type WorkSnapshot,
  type WorkflowModule,
  type WorkflowStore,
} from '../../src/modules/workflow/index.js';

type MutableTransition = Mutable<TransitionRecord>;
type MutableSlaDeadline = Mutable<SlaDeadlineRecord>;

export interface InMemoryWorkflowStoreOptions {
  now?: () => Date;
  /** Race-injection point inside applyTransition, before the critical section. */
  beforeApplyTransition?: () => Promise<void>;
  /** Race-injection point inside setSlaDeadline, before the critical section. */
  beforeSetSlaDeadline?: () => Promise<void>;
  /** Race-injection point inside getWorkSnapshot (module-level race proofs). */
  beforeGetWorkSnapshot?: () => Promise<void>;
}

/**
 * Faithful in-memory implementation of the /workflow store port: the exact
 * semantics of the locked SQL transaction — keyed convergence, the work-row
 * critical section (status check -> dependency gate -> ledger insert ->
 * status write), the per-(work, state) SLA deadline upsert and the
 * deterministic breach join. The work tables are the composed
 * InMemoryWorkStore's internal maps (the transition boundary substrate:
 * applyTransition is the only writer of a work's status, mirroring the SQL
 * authority); reads copy, mutations stay internal.
 */
export class InMemoryWorkflowStore implements WorkflowStore {
  readonly transitions = new Map<string, MutableTransition>();
  readonly transitionsByIdempotency = new Map<string, string>();
  readonly slaDeadlines = new Map<string, MutableSlaDeadline>();
  readonly slaDeadlinesByWorkState = new Map<string, string>();
  readonly slaDeadlinesByIdempotency = new Map<string, string>();
  readonly reads = {
    transitionById: 0,
    transitionByKey: 0,
    transitionsList: 0,
    workSnapshot: 0,
    slaDeadlinesList: 0,
    slaBreaches: 0,
  };
  readonly options: InMemoryWorkflowStoreOptions;
  private readonly now: () => Date;

  constructor(
    private readonly workStore: InMemoryWorkStore,
    options: InMemoryWorkflowStoreOptions = {},
  ) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
  }

  async applyTransition(input: ApplyTransitionInput): Promise<{ transition: TransitionRecord; converged: boolean }> {
    await this.options.beforeApplyTransition?.();
    // Synchronous critical section (SQL: keyed convergence + work-row FOR
    // UPDATE + advisory-locked dependency gate + insert + status update).
    if (input.idempotencyKey !== null) {
      const existingId = this.transitionsByIdempotency.get(`${input.tenantId}:${input.idempotencyKey}`);
      if (existingId !== undefined) {
        const existing = this.transitions.get(existingId);
        if (existing !== undefined) {
          if (existing.inputHash !== input.inputHash) {
            throw new WorkflowStoreRuleError(
              `idempotency key "${input.idempotencyKey}" was already used for a different transition input`,
              'transition-input-conflict',
            );
          }
          return { transition: { ...existing, preconditions: existing.preconditions }, converged: true };
        }
      }
    }
    const work = this.workStore.works.get(input.workId);
    if (work === undefined || work.tenantId !== input.tenantId) {
      throw new WorkflowStoreMissingError(`work ${input.workId} does not exist in this tenant`, 'work');
    }
    if (work.status !== input.expectedFrom) {
      throw new WorkflowStoreRuleError(
        `work ${input.workId} is in state "${work.status}", not the expected "${input.expectedFrom}"; a competing transition committed first or the work already moved`,
        'transition-conflict',
      );
    }
    let dependencies: TransitionPreconditions['dependencies'] = { evaluated: false, satisfied: true };
    if (input.dependencyGateRequired) {
      const unmet = [...this.workStore.dependencies.values()].filter(
        (dependency) =>
          dependency.tenantId === input.tenantId && dependency.workId === input.workId && (() => {
            const prerequisite = this.workStore.works.get(dependency.dependsOnWorkId);
            return prerequisite === undefined || prerequisite.status !== 'completed';
          })(),
      );
      if (unmet.length > 0) {
        throw new WorkflowStoreRuleError(
          `work ${input.workId} has ${unmet.length} dependency work(s) that are not completed; it cannot become ready`,
          'precondition-dependencies',
        );
      }
      dependencies = { evaluated: true, satisfied: true };
    }
    const preconditions: TransitionPreconditions = { dependencies, policy: input.policy };
    // Strict per-work ledger sequence (synchronous critical section).
    const seq =
      [...this.transitions.values()].filter((transition) => transition.workId === input.workId).length + 1;
    const recordHash = hashTransitionRecord({
      tenantId: input.tenantId,
      workId: input.workId,
      seq,
      fromState: input.expectedFrom,
      toState: input.to,
      ruleId: input.ruleId,
      preconditions,
      reason: input.reason,
      transitionedBy: input.transitionedBy,
      idempotencyKey: input.idempotencyKey,
      inputHash: input.inputHash,
      createdAt: input.now.toISOString(),
    });
    const transition: MutableTransition = {
      id: randomUUID(),
      tenantId: input.tenantId,
      workId: input.workId,
      seq,
      fromState: input.expectedFrom,
      toState: input.to,
      ruleId: input.ruleId,
      preconditions,
      reason: input.reason,
      transitionedBy: input.transitionedBy,
      idempotencyKey: input.idempotencyKey,
      inputHash: input.inputHash,
      recordHash,
      createdAt: input.now,
    };
    this.transitions.set(transition.id, transition);
    if (input.idempotencyKey !== null) {
      this.transitionsByIdempotency.set(`${input.tenantId}:${input.idempotencyKey}`, transition.id);
    }
    // THE transition boundary write: the only status mutation, inside the
    // same critical section as the ledger insert.
    work.status = input.to;
    work.updatedAt = input.now;
    return { transition: { ...transition, preconditions }, converged: false };
  }

  async findTransitionById(tenantId: string, transitionId: string): Promise<TransitionRecord | null> {
    this.reads.transitionById += 1;
    const transition = this.transitions.get(transitionId);
    // MANDATORY tenant predicate; reads verify integrity (fail closed).
    if (transition === undefined || transition.tenantId !== tenantId) return null;
    return this.verify(transition);
  }

  async findTransitionByIdempotencyKey(tenantId: string, key: string): Promise<TransitionRecord | null> {
    this.reads.transitionByKey += 1;
    const id = this.transitionsByIdempotency.get(`${tenantId}:${key}`);
    if (id === undefined) return null;
    const transition = this.transitions.get(id);
    if (transition === undefined || transition.tenantId !== tenantId) return null;
    return this.verify(transition);
  }

  async listTransitions(tenantId: string, workId: string): Promise<TransitionRecord[]> {
    this.reads.transitionsList += 1;
    return [...this.transitions.values()]
      .filter((transition) => transition.tenantId === tenantId && transition.workId === workId)
      .sort((a, b) => a.seq - b.seq)
      .map((transition) => this.verify(transition));
  }

  async getWorkSnapshot(tenantId: string, workId: string): Promise<WorkSnapshot | null> {
    this.reads.workSnapshot += 1;
    await this.options.beforeGetWorkSnapshot?.();
    const work = this.workStore.works.get(workId);
    return work !== undefined && work.tenantId === tenantId
      ? { workId: work.id, workType: work.workType, status: work.status }
      : null;
  }

  async setSlaDeadline(input: SetSlaDeadlineInput): Promise<{ deadline: SlaDeadlineRecord; converged: boolean }> {
    await this.options.beforeSetSlaDeadline?.();
    // Synchronous critical section (SQL: keyed convergence + tenant-predicated
    // work existence + per-(work, state) upsert).
    if (input.idempotencyKey !== null) {
      const existingId = this.slaDeadlinesByIdempotency.get(`${input.tenantId}:${input.idempotencyKey}`);
      if (existingId !== undefined) {
        const existing = this.slaDeadlines.get(existingId);
        if (existing !== undefined) {
          if (
            existing.workId !== input.workId ||
            existing.state !== input.state ||
            existing.deadlineAt.getTime() !== input.deadlineAt.getTime()
          ) {
            throw new WorkflowStoreRuleError(
              `idempotency key "${input.idempotencyKey}" was already used for a different SLA deadline input`,
              'sla-deadline-conflict',
            );
          }
          return { deadline: { ...existing }, converged: true };
        }
      }
    }
    const work = this.workStore.works.get(input.workId);
    if (work === undefined || work.tenantId !== input.tenantId) {
      throw new WorkflowStoreMissingError(`work ${input.workId} does not exist in this tenant`, 'work');
    }
    const workStateKey = `${input.workId}:${input.state}`;
    const existingId = this.slaDeadlinesByWorkState.get(workStateKey);
    if (existingId !== undefined) {
      // Upsert: the deliberate extension path (latest set wins; the old key
      // mapping is released exactly like the SQL column overwrite).
      const existing = this.slaDeadlines.get(existingId);
      if (existing !== undefined) {
        if (existing.idempotencyKey !== null && existing.idempotencyKey !== input.idempotencyKey) {
          this.slaDeadlinesByIdempotency.delete(`${input.tenantId}:${existing.idempotencyKey}`);
        }
        existing.deadlineAt = input.deadlineAt;
        existing.setBy = input.setBy;
        existing.idempotencyKey = input.idempotencyKey;
        existing.updatedAt = input.now;
        return { deadline: { ...existing }, converged: false };
      }
    }
    const deadline: MutableSlaDeadline = {
      id: randomUUID(),
      tenantId: input.tenantId,
      workId: input.workId,
      state: input.state,
      deadlineAt: input.deadlineAt,
      setBy: input.setBy,
      idempotencyKey: input.idempotencyKey,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.slaDeadlines.set(deadline.id, deadline);
    this.slaDeadlinesByWorkState.set(workStateKey, deadline.id);
    if (input.idempotencyKey !== null) {
      this.slaDeadlinesByIdempotency.set(`${input.tenantId}:${input.idempotencyKey}`, deadline.id);
    }
    return { deadline: { ...deadline }, converged: false };
  }

  async findSlaDeadline(tenantId: string, workId: string, state: TransitionRecord['toState']): Promise<SlaDeadlineRecord | null> {
    const id = this.slaDeadlinesByWorkState.get(`${workId}:${state}`);
    if (id === undefined) return null;
    const deadline = this.slaDeadlines.get(id);
    return deadline !== undefined && deadline.tenantId === tenantId ? { ...deadline } : null;
  }

  async listSlaDeadlines(tenantId: string, workId: string): Promise<SlaDeadlineRecord[]> {
    this.reads.slaDeadlinesList += 1;
    return [...this.slaDeadlines.values()]
      .filter((deadline) => deadline.tenantId === tenantId && deadline.workId === workId)
      .sort((a, b) => a.state.localeCompare(b.state))
      .map((deadline) => ({ ...deadline }));
  }

  async listSlaBreaches(tenantId: string, now: Date): Promise<SlaBreach[]> {
    this.reads.slaBreaches += 1;
    // Deterministic join: deadlines whose work is CURRENTLY in the deadline
    // state, past the deadline (the state CHECK excludes terminal states).
    const breaches: SlaBreach[] = [];
    for (const deadline of this.slaDeadlines.values()) {
      if (deadline.tenantId !== tenantId) continue;
      const work = this.workStore.works.get(deadline.workId);
      if (work === undefined || work.tenantId !== tenantId) continue;
      if (work.status === deadline.state && deadline.deadlineAt.getTime() < now.getTime()) {
        breaches.push({
          workId: work.id,
          workType: work.workType,
          state: deadline.state,
          deadlineAt: deadline.deadlineAt,
        });
      }
    }
    return breaches.sort(
      (a, b) => a.deadlineAt.getTime() - b.deadlineAt.getTime() || a.workId.localeCompare(b.workId),
    );
  }

  /** Integrity verification on read (the SQL store recomputes hashes). */
  private verify(transition: MutableTransition): TransitionRecord {
    const copy: TransitionRecord = { ...transition, preconditions: transition.preconditions };
    if (
      hashTransitionRecord({
        tenantId: copy.tenantId,
        workId: copy.workId,
        seq: copy.seq,
        fromState: copy.fromState,
        toState: copy.toState,
        ruleId: copy.ruleId,
        preconditions: copy.preconditions,
        reason: copy.reason,
        transitionedBy: copy.transitionedBy,
        idempotencyKey: copy.idempotencyKey,
        inputHash: copy.inputHash,
        createdAt: copy.createdAt.toISOString(),
      }) !== copy.recordHash
    ) {
      throw new WorkflowStoreRuleError(
        `transition ${copy.id} record no longer matches its recorded integrity hash`,
        'transition-record-tampered',
      );
    }
    return copy;
  }
}

export interface WorkflowApp {
  authStore: InMemoryAuthStore;
  orgStore: InMemoryOrganizationsStore;
  workStore: InMemoryWorkStore;
  policyStore: InMemoryPoliciesStore;
  workflowStore: InMemoryWorkflowStore;
  auth: AuthModule;
  organizations: OrganizationsModule;
  work: WorkModule;
  policies: PoliciesModule;
  workflow: WorkflowModule;
}

/** Build the composed identity/tenancy/work/policies/workflow modules over in-memory stores. */
export function buildWorkflowApp(options: { now?: () => Date } = {}): WorkflowApp {
  const now = options.now ?? (() => new Date());
  const identity = buildIdentityApp({ now });
  const workStore = new InMemoryWorkStore({ now });
  const work = createWorkModule({ store: workStore, tenancy: identity.organizations, now });
  const policyStore = new InMemoryPoliciesStore({ now });
  const policies = createPoliciesModule({ store: policyStore, tenancy: identity.organizations, now });
  const workflowStore = new InMemoryWorkflowStore(workStore, { now });
  const workflow = createWorkflowModule({
    store: workflowStore,
    tenancy: identity.organizations,
    policies,
    now,
  });
  return {
    authStore: identity.authStore,
    orgStore: identity.orgStore,
    workStore,
    policyStore,
    workflowStore,
    auth: identity.auth,
    organizations: identity.organizations,
    work,
    policies,
    workflow,
  };
}

// ---------------------------------------------------------------------------
// In-memory /interactions store (WORK-015)
// ---------------------------------------------------------------------------

type MutableInteraction = Mutable<InteractionRecord>;

export interface InMemoryInteractionsStoreOptions {
  now?: () => Date;
  /** Race-injection points before the synchronous critical sections. */
  beforeCreateInteraction?: () => Promise<void>;
  beforeClaimDispatch?: () => Promise<void>;
  beforeCompleteDispatch?: () => Promise<void>;
  beforeRecordDispatchFailure?: () => Promise<void>;
  beforeRecordObservation?: () => Promise<void>;
  /**
   * CRASH SIMULATION: `crashAfterClaim` performs the claim mutation then
   * throws (process death INSIDE the claim transaction's commit — the
   * claim stands). `crashBeforeCompleteDispatch` throws BEFORE the
   * completion mutation: the adapter already accepted the effect, the
   * module dies between the adapter call and the durable completion
   * write (the W3 window — state stays `dispatching`, the effect exists
   * at the provider).
   */
  crashAfterClaim?: boolean;
  crashBeforeCompleteDispatch?: boolean;
  /** Fire the crash hooks only ONCE (the recovery call must survive). */
  oneShotCrash?: boolean;
}

/**
 * Faithful in-memory implementation of the /interactions store port. NOT
 * a second persistence authority: it implements the same contract the
 * SQL store implements, so the module's dispatch/observation protocol,
 * claim CAS and convergence semantics are proven without a live
 * PostgreSQL:
 *
 * - every read is tenant-predicated exactly like the SQL store;
 * - `reads` counters prove denials happen before domain data access;
 * - every mutation performs its check+mutate sequence inside ONE
 *   synchronous critical section (the semantics of the locked SQL
 *   transaction); async hooks inject deterministic interleaving points
 *   BEFORE the critical section so concurrency proofs exercise real
 *   check-then-act races; post-mutation crash hooks simulate process
 *   death between the durable write and the module's next step;
 * - the same typed rule/missing errors as the SQL store, with the same
 *   state names carried in the messages;
 * - every read recomputes the record integrity hash (tamper-evident,
 *   exactly like the SQL store's mapInteraction).
 */
export class InMemoryInteractionsStore implements InteractionsStore {
  readonly interactions = new Map<string, MutableInteraction>();
  readonly interactionsByIdempotency = new Map<string, string>();
  readonly reads = {
    interactionById: 0,
    interactionByKey: 0,
    interactionsList: 0,
    recoverableDispatches: 0,
  };
  readonly options: InMemoryInteractionsStoreOptions;
  private readonly now: () => Date;
  private crashed = false;

  constructor(options: InMemoryInteractionsStoreOptions = {}) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
  }

  private rehash(record: MutableInteraction): void {
    record.recordHash = computeInteractionRecordHash(record);
  }

  private verify(record: MutableInteraction): void {
    if (computeInteractionRecordHash(record) !== record.recordHash) {
      throw new InteractionsStoreRuleError(
        `interaction ${record.id} record no longer matches its integrity hash`,
        'interaction-record-tampered',
      );
    }
  }

  private findRow(tenantId: string, interactionId: string): MutableInteraction | null {
    const row = this.interactions.get(interactionId);
    this.reads.interactionById += 1;
    if (row === undefined || row.tenantId !== tenantId) return null;
    this.verify(row);
    return row;
  }

  async createInteraction(input: CreateInteractionInput): Promise<{ interaction: InteractionRecord; converged: boolean }> {
    await this.options.beforeCreateInteraction?.();
    // Synchronous critical section (SQL: keyed convergence lookup +
    // retry-target validation + INSERT ON CONFLICT DO NOTHING).
    if (input.idempotencyKey !== null) {
      const existingId = this.interactionsByIdempotency.get(`${input.tenantId}:${input.idempotencyKey}`);
      if (existingId !== undefined) {
        const existing = this.interactions.get(existingId);
        if (existing !== undefined) {
          this.verify(existing);
          if (existing.inputHash !== input.inputHash) {
            throw new InteractionsStoreRuleError(
              `idempotency key "${input.idempotencyKey}" was already used for a different interaction input`,
              'interaction-input-conflict',
            );
          }
          return { interaction: { ...existing, correlation: { ...existing.correlation } }, converged: true };
        }
      }
    }
    if (input.retryOfInteractionId !== null) {
      const target = this.findRow(input.tenantId, input.retryOfInteractionId);
      if (target === null) {
        throw new InteractionsStoreMissingError(
          `retry target ${input.retryOfInteractionId} does not exist in this tenant`,
          'retry-target',
        );
      }
      if (target.state !== 'observed' || target.observation?.outcome !== 'failed') {
        throw new InteractionsStoreRuleError(
          `retry target ${input.retryOfInteractionId} is not an observed failure (state ${target.state}); only failed observations are retried`,
          'retry-target-invalid',
        );
      }
    }
    const base: Omit<InteractionRecord, 'recordHash'> = {
      id: randomUUID(),
      tenantId: input.tenantId,
      capability: input.capability,
      params: input.params,
      correlation: input.correlation ?? {},
      retryOfInteractionId: input.retryOfInteractionId,
      policy: input.policy,
      requestedBy: input.requestedBy,
      idempotencyKey: input.idempotencyKey,
      inputHash: input.inputHash,
      state: 'intended',
      claim: null,
      dispatch: null,
      observation: null,
      createdAt: input.now,
      updatedAt: input.now,
    };
    const record: MutableInteraction = { ...base, recordHash: computeInteractionRecordHash(base) };
    this.interactions.set(record.id, record);
    if (input.idempotencyKey !== null) {
      this.interactionsByIdempotency.set(`${input.tenantId}:${input.idempotencyKey}`, record.id);
    }
    return { interaction: { ...record, correlation: { ...record.correlation } }, converged: false };
  }

  async findInteractionById(tenantId: string, interactionId: string): Promise<InteractionRecord | null> {
    const row = this.findRow(tenantId, interactionId);
    return row === null ? null : { ...row, correlation: { ...row.correlation } };
  }

  async findInteractionByIdempotencyKey(tenantId: string, key: string): Promise<InteractionRecord | null> {
    this.reads.interactionByKey += 1;
    const id = this.interactionsByIdempotency.get(`${tenantId}:${key}`);
    const row = id === undefined ? undefined : this.interactions.get(id);
    if (row === undefined || row.tenantId !== tenantId) return null;
    this.verify(row);
    return { ...row, correlation: { ...row.correlation } };
  }

  async listInteractions(tenantId: string, filter?: InteractionFilter): Promise<InteractionRecord[]> {
    this.reads.interactionsList += 1;
    const rows = [...this.interactions.values()]
      .filter((row) => row.tenantId === tenantId)
      .filter((row) => {
        if (filter === undefined) return true;
        if (filter.state !== undefined && row.state !== filter.state) return false;
        if (filter.capability !== undefined && row.capability !== filter.capability) return false;
        if (filter.outcome !== undefined && row.observation?.outcome !== filter.outcome) return false;
        if (filter.retryOfInteractionId !== undefined && row.retryOfInteractionId !== filter.retryOfInteractionId) return false;
        if (filter.correlation !== undefined && row.correlation[filter.correlation.key] !== filter.correlation.value) return false;
        return true;
      })
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
    for (const row of rows) this.verify(row);
    return rows.map((row) => ({ ...row, correlation: { ...row.correlation } }));
  }

  async listRecoverableDispatches(tenantId: string): Promise<InteractionRecord[]> {
    this.reads.recoverableDispatches += 1;
    const rows = [...this.interactions.values()]
      .filter((row) => row.tenantId === tenantId && row.state === 'dispatching')
      .sort((a, b) => ((a.claim?.claimedAt ?? a.createdAt) < (b.claim?.claimedAt ?? b.createdAt) ? -1 : 1));
    for (const row of rows) this.verify(row);
    return rows.map((row) => ({ ...row, correlation: { ...row.correlation } }));
  }

  async claimDispatch(input: ClaimDispatchInput): Promise<InteractionRecord> {
    await this.options.beforeClaimDispatch?.();
    // Synchronous critical section (SQL: row FOR UPDATE + state CAS).
    const row = this.findRow(input.tenantId, input.interactionId);
    if (row === null) {
      throw new InteractionsStoreMissingError(`interaction ${input.interactionId} does not exist in this tenant`, 'interaction');
    }
    if (row.state !== 'intended') {
      throw new InteractionsStoreRuleError(
        `interaction ${input.interactionId} is in state "${row.state}", not the expected "intended"`,
        'dispatch-claim-conflict',
      );
    }
    row.state = 'dispatching';
    row.claim = { claimedBy: input.claimedBy, claimedAt: input.now };
    row.updatedAt = input.now;
    this.rehash(row);
    if (this.options.crashAfterClaim === true && !(this.options.oneShotCrash === true && this.crashed)) {
      this.crashed = true;
      throw new Error('SIMULATED CRASH after the durable dispatch claim');
    }
    return { ...row, correlation: { ...row.correlation } };
  }

  async reclaimDispatch(input: ReclaimDispatchInput): Promise<InteractionRecord> {
    // Recovery re-claim (SQL: row FOR UPDATE + claim refresh + recomputed
    // record hash). The state STAYS dispatching.
    const row = this.findRow(input.tenantId, input.interactionId);
    if (row === null) {
      throw new InteractionsStoreMissingError(`interaction ${input.interactionId} does not exist in this tenant`, 'interaction');
    }
    if (row.state !== 'dispatching') {
      throw new InteractionsStoreRuleError(
        `interaction ${input.interactionId} is in state "${row.state}", not the claimed "dispatching"`,
        'dispatch-reclaim-conflict',
      );
    }
    row.claim = { claimedBy: input.reclaimedBy, claimedAt: input.now };
    row.updatedAt = input.now;
    this.rehash(row);
    return { ...row, correlation: { ...row.correlation } };
  }

  async completeDispatch(input: CompleteDispatchInput): Promise<InteractionRecord> {
    await this.options.beforeCompleteDispatch?.();
    if (this.options.crashBeforeCompleteDispatch === true && !(this.options.oneShotCrash === true && this.crashed)) {
      this.crashed = true;
      throw new Error('SIMULATED CRASH before the durable dispatch completion (adapter accepted the effect)');
    }
    // Synchronous critical section (SQL: row FOR UPDATE + state CAS +
    // recomputed record hash).
    const row = this.findRow(input.tenantId, input.interactionId);
    if (row === null) {
      throw new InteractionsStoreMissingError(`interaction ${input.interactionId} does not exist in this tenant`, 'interaction');
    }
    if (row.state !== 'dispatching') {
      throw new InteractionsStoreRuleError(
        `interaction ${input.interactionId} is in state "${row.state}", not the expected "dispatching"`,
        'dispatch-completion-conflict',
      );
    }
    row.state = 'dispatched';
    row.dispatch = {
      provider: input.provider,
      providerReference: input.providerReference,
      dispatchedAt: input.now,
      dispatchedBy: input.dispatchedBy,
    };
    row.updatedAt = input.now;
    this.rehash(row);
    return { ...row, correlation: { ...row.correlation } };
  }

  async recordDispatchFailure(input: RecordDispatchFailureInput): Promise<InteractionRecord> {
    await this.options.beforeRecordDispatchFailure?.();
    const row = this.findRow(input.tenantId, input.interactionId);
    if (row === null) {
      throw new InteractionsStoreMissingError(`interaction ${input.interactionId} does not exist in this tenant`, 'interaction');
    }
    if (row.state !== 'dispatching') {
      throw new InteractionsStoreRuleError(
        `interaction ${input.interactionId} is in state "${row.state}", not the expected "dispatching"`,
        'dispatch-completion-conflict',
      );
    }
    row.state = 'observed';
    row.observation = {
      outcome: 'failed',
      failureStage: 'dispatch',
      providerObservation: { error: input.error },
      observedBy: input.dispatchedBy,
      observedAt: input.now,
    };
    row.updatedAt = input.now;
    this.rehash(row);
    return { ...row, correlation: { ...row.correlation } };
  }

  async recordObservation(input: RecordObservationInput): Promise<{ interaction: InteractionRecord; converged: boolean }> {
    await this.options.beforeRecordObservation?.();
    const row = this.findRow(input.tenantId, input.interactionId);
    if (row === null) {
      throw new InteractionsStoreMissingError(`interaction ${input.interactionId} does not exist in this tenant`, 'interaction');
    }
    if (row.state === 'observed' && row.observation !== null) {
      const existingIdentity = hashObservation(row.observation.outcome, row.observation.providerObservation);
      const incomingIdentity = hashObservation(input.outcome, input.providerObservation);
      if (existingIdentity === incomingIdentity) {
        return { interaction: { ...row, correlation: { ...row.correlation } }, converged: true };
      }
      throw new InteractionsStoreRuleError(
        `interaction ${input.interactionId} already carries a different observed result (outcome ${row.observation.outcome}); duplicate interaction mutation is rejected`,
        'observation-conflict',
      );
    }
    if (row.state !== 'dispatched') {
      throw new InteractionsStoreRuleError(
        `interaction ${input.interactionId} is in state "${row.state}"; results are observed on dispatched interactions only`,
        'observation-state-invalid',
      );
    }
    row.state = 'observed';
    row.observation = {
      outcome: input.outcome,
      failureStage: input.outcome === 'failed' ? 'provider' : null,
      providerObservation: input.providerObservation,
      observedBy: input.observedBy,
      observedAt: input.now,
    };
    row.updatedAt = input.now;
    this.rehash(row);
    return { interaction: { ...row, correlation: { ...row.correlation } }, converged: false };
  }
}

// ---------------------------------------------------------------------------
// In-memory /notifications store (WORK-015)
// ---------------------------------------------------------------------------

type MutableNotification = Mutable<NotificationRecord>;

export interface InMemoryNotificationsStoreOptions {
  now?: () => Date;
  beforeCreateNotification?: () => Promise<void>;
  beforeSetInteractionPointer?: () => Promise<void>;
}

/** Faithful in-memory implementation of the /notifications store port. */
export class InMemoryNotificationsStore implements NotificationsStore {
  readonly notifications = new Map<string, MutableNotification>();
  readonly notificationsByIdempotency = new Map<string, string>();
  readonly reads = {
    notificationById: 0,
    notificationByKey: 0,
    notificationsList: 0,
  };
  readonly options: InMemoryNotificationsStoreOptions;
  private readonly now: () => Date;

  constructor(options: InMemoryNotificationsStoreOptions = {}) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
  }

  private rehash(record: MutableNotification): void {
    record.recordHash = computeNotificationRecordHash(record);
  }

  private verify(record: MutableNotification): void {
    if (computeNotificationRecordHash(record) !== record.recordHash) {
      throw new NotificationsStoreRuleError(
        `notification ${record.id} record no longer matches its integrity hash`,
        'notification-record-tampered',
      );
    }
  }

  async createNotification(input: CreateNotificationInput): Promise<{ notification: NotificationRecord; converged: boolean }> {
    await this.options.beforeCreateNotification?.();
    if (input.idempotencyKey !== null) {
      const existingId = this.notificationsByIdempotency.get(`${input.tenantId}:${input.idempotencyKey}`);
      if (existingId !== undefined) {
        const existing = this.notifications.get(existingId);
        if (existing !== undefined) {
          this.verify(existing);
          if (existing.inputHash !== input.inputHash) {
            throw new NotificationsStoreRuleError(
              `idempotency key "${input.idempotencyKey}" was already used for a different notification input`,
              'notification-input-conflict',
            );
          }
          return { notification: { ...existing, correlation: { ...existing.correlation } }, converged: true };
        }
      }
    }
    const base: Omit<NotificationRecord, 'recordHash'> = {
      id: randomUUID(),
      tenantId: input.tenantId,
      channel: input.channel,
      recipient: input.recipient,
      content: input.content,
      purpose: input.purpose,
      correlation: input.correlation,
      requestedBy: input.requestedBy,
      idempotencyKey: input.idempotencyKey,
      inputHash: input.inputHash,
      currentInteractionId: null,
      createdAt: input.now,
      updatedAt: input.now,
    };
    const record: MutableNotification = { ...base, recordHash: computeNotificationRecordHash(base) };
    this.notifications.set(record.id, record);
    if (input.idempotencyKey !== null) {
      this.notificationsByIdempotency.set(`${input.tenantId}:${input.idempotencyKey}`, record.id);
    }
    return { notification: { ...record, correlation: { ...record.correlation } }, converged: false };
  }

  async findNotificationById(tenantId: string, notificationId: string): Promise<NotificationRecord | null> {
    this.reads.notificationById += 1;
    const row = this.notifications.get(notificationId);
    if (row === undefined || row.tenantId !== tenantId) return null;
    this.verify(row);
    return { ...row, correlation: { ...row.correlation } };
  }

  async findNotificationByIdempotencyKey(tenantId: string, key: string): Promise<NotificationRecord | null> {
    this.reads.notificationByKey += 1;
    const id = this.notificationsByIdempotency.get(`${tenantId}:${key}`);
    const row = id === undefined ? undefined : this.notifications.get(id);
    if (row === undefined || row.tenantId !== tenantId) return null;
    this.verify(row);
    return { ...row, correlation: { ...row.correlation } };
  }

  async listNotifications(tenantId: string): Promise<NotificationRecord[]> {
    this.reads.notificationsList += 1;
    const rows = [...this.notifications.values()]
      .filter((row) => row.tenantId === tenantId)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
    for (const row of rows) this.verify(row);
    return rows.map((row) => ({ ...row, correlation: { ...row.correlation } }));
  }

  async setInteractionPointer(input: SetInteractionPointerInput): Promise<NotificationRecord> {
    await this.options.beforeSetInteractionPointer?.();
    const row = this.notifications.get(input.notificationId);
    if (row === undefined || row.tenantId !== input.tenantId) {
      throw new NotificationsStoreMissingError(`notification ${input.notificationId} does not exist in this tenant`);
    }
    this.verify(row);
    row.currentInteractionId = input.interactionId;
    row.updatedAt = input.now;
    this.rehash(row);
    return { ...row, correlation: { ...row.correlation } };
  }
}

// ---------------------------------------------------------------------------
// WORK-015 app builders
// ---------------------------------------------------------------------------

/**
 * The composed WORK-015 application over in-memory stores: identity,
 * tenancy, policies, the /integrations registry with test-double
 * adapters, the /interactions authority and (optionally) the
 * /notifications authority. `sink` overrides the registry-backed sink for
 * concurrency/discrimination hooks.
 */
export interface InteractionsApp {
  authStore: InMemoryAuthStore;
  orgStore: InMemoryOrganizationsStore;
  policyStore: InMemoryPoliciesStore;
  interactionsStore: InMemoryInteractionsStore;
  registry: AdapterRegistry;
  sink: ExternalEffectSink;
  auth: AuthModule;
  organizations: OrganizationsModule;
  policies: PoliciesModule;
  interactions: InteractionsModule;
}

export function buildInteractionsApp(
  options: {
    now?: () => Date;
    capabilities?: readonly CapabilityClass[];
    sink?: ExternalEffectSink;
    storeOptions?: InMemoryInteractionsStoreOptions;
  } = {},
): InteractionsApp {
  const now = options.now ?? (() => new Date());
  const identity = buildIdentityApp({ now });
  const policyStore = new InMemoryPoliciesStore({ now });
  const policies = createPoliciesModule({ store: policyStore, tenancy: identity.organizations, now });
  const registry = createAdapterRegistry();
  for (const capability of options.capabilities ?? ['email', 'sms', 'voice']) {
    const { adapter } = createInMemoryProviderAdapter(capability, { now });
    registry.register(adapter);
  }
  registry.seal();
  const sink = options.sink ?? createEffectSink(registry);
  const interactionsStore = new InMemoryInteractionsStore({ now, ...options.storeOptions });
  const interactions = createInteractionsModule({
    store: interactionsStore,
    tenancy: identity.organizations,
    policies,
    sink,
    now,
  });
  return {
    authStore: identity.authStore,
    orgStore: identity.orgStore,
    policyStore,
    interactionsStore,
    registry,
    sink,
    auth: identity.auth,
    organizations: identity.organizations,
    policies,
    interactions,
  };
}

/** The fully composed WORK-015 application including /notifications. */
export interface ExternalEffectsApp extends InteractionsApp {
  notificationsStore: InMemoryNotificationsStore;
  notifications: NotificationsModule;
}

export function buildExternalEffectsApp(
  options: {
    now?: () => Date;
    capabilities?: readonly CapabilityClass[];
    sink?: ExternalEffectSink;
    storeOptions?: InMemoryInteractionsStoreOptions;
    notificationStoreOptions?: InMemoryNotificationsStoreOptions;
  } = {},
): ExternalEffectsApp {
  const base = buildInteractionsApp(options);
  const notificationsStore = new InMemoryNotificationsStore({
    now: options.now ?? (() => new Date()),
    ...options.notificationStoreOptions,
  });
  const notifications = createNotificationsModule({
    store: notificationsStore,
    tenancy: base.organizations,
    interactions: base.interactions,
    now: options.now ?? (() => new Date()),
  });
  return { ...base, notificationsStore, notifications };
}

// ---------------------------------------------------------------------------
// WORK-009: /verticals + /services in-memory stores and app builders
// ---------------------------------------------------------------------------

import {
  createVerticalsModule,
  VerticalsStoreRuleError,
  hashPackageContent,
  hashVerticalRecord,
  type RegisterPackageInput,
  type VerticalPackageRecord,
  type VerticalsModule,
  type VerticalsStore,
} from '../../src/modules/verticals/index.js';
import {
  createServicesModule,
  ServicesStoreMissingError,
  ServicesStoreRuleError,
  computeConfigurationContentHash,
  computeConfigurationRecordHash,
  computeDefinitionContentHash,
  computeDefinitionRecordHash,
  type RegisterConfigurationInput,
  type RegisterDefinitionInput,
  type ServiceConfigurationRecord,
  type ServiceDefinitionRecord,
  type ServicesModule,
  type ServicesStore,
  type ServiceStatus,
} from '../../src/modules/services/index.js';

type MutableVerticalPackage = Mutable<VerticalPackageRecord>;
type MutableServiceDefinition = Mutable<ServiceDefinitionRecord>;
type MutableServiceConfiguration = Mutable<ServiceConfigurationRecord>;

export interface InMemoryVerticalsStoreOptions {
  now?: () => Date;
  /** Race-injection points before the synchronous critical sections. */
  beforeRegisterPackage?: () => Promise<void>;
}

/**
 * Faithful in-memory implementation of the /verticals store port (NOT a
 * second persistence authority: it implements the same contract the SQL
 * store implements, so the module's validation, versioning, convergence
 * and tamper-detection logic are proven without a live PostgreSQL):
 *
 * - every read is tenant-predicated exactly like the SQL store;
 * - `reads` counters prove denials happen before domain data access;
 * - version sequencing, convergence and content-conflict rules run inside
 *   ONE synchronous critical section (the semantics of the
 *   advisory-locked SQL transaction); the async hook injects a
 *   deterministic interleaving point BEFORE the critical section so
 *   concurrency proofs exercise real races;
 * - reads verify BOTH persisted hashes (content + record) exactly like
 *   the SQL store — the package map holds mutable records so tests can
 *   tamper deliberately and prove detection;
 * - the same typed rule errors as the SQL store.
 */
export class InMemoryVerticalsStore implements VerticalsStore {
  readonly packages = new Map<string, MutableVerticalPackage>();
  readonly packagesByIdempotency = new Map<string, string>();
  readonly reads = { byId: 0, byKey: 0, list: 0 };
  /** Race-injection hook (public so concurrency tests can swap it). */
  readonly options: InMemoryVerticalsStoreOptions;
  private readonly now: () => Date;

  constructor(options: InMemoryVerticalsStoreOptions = {}) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
  }

  private verify(pkg: MutableVerticalPackage): VerticalPackageRecord {
    if (hashPackageContent(pkg) !== pkg.contentHash) {
      throw new VerticalsStoreRuleError(
        `package ${pkg.packageId} v${pkg.version} content no longer matches its recorded content hash`,
        'vertical-record-tampered',
      );
    }
    if (hashVerticalRecord(pkg) !== pkg.recordHash) {
      throw new VerticalsStoreRuleError(
        `package ${pkg.packageId} v${pkg.version} record no longer matches its recorded integrity hash`,
        'vertical-record-tampered',
      );
    }
    return { ...pkg };
  }

  async registerPackage(input: RegisterPackageInput): Promise<{ pkg: VerticalPackageRecord; converged: boolean }> {
    await this.options.beforeRegisterPackage?.();
    // Synchronous critical section (SQL: idempotency lookup +
    // advisory-locked sequencing + insert).
    if (input.idempotencyKey !== null) {
      const existingId = this.packagesByIdempotency.get(`${input.tenantId}:${input.idempotencyKey}`);
      if (existingId !== undefined) {
        const existing = this.packages.get(existingId);
        if (existing !== undefined) {
          if (existing.contentHash !== input.contentHash) {
            throw new VerticalsStoreRuleError(
              `vertical package idempotency key "${input.idempotencyKey}" was already bound to different content`,
              'idempotency-input-conflict',
            );
          }
          return { pkg: this.verify(existing), converged: true };
        }
      }
    }
    let max = 0;
    for (const pkg of this.packages.values()) {
      if (pkg.tenantId === input.tenantId && pkg.packageId === input.packageId && pkg.version > max) {
        max = pkg.version;
      }
    }
    if (input.version <= max) {
      const twin = [...this.packages.values()].find(
        (pkg) => pkg.tenantId === input.tenantId && pkg.packageId === input.packageId && pkg.version === input.version,
      );
      if (twin === undefined) {
        throw new VerticalsStoreRuleError(
          `vertical package ${input.packageId} version ${input.version} is behind the registered sequence (max ${max}) and missing; versions must be contiguous`,
          'version-not-sequential',
        );
      }
      if (twin.contentHash !== input.contentHash) {
        throw new VerticalsStoreRuleError(
          `vertical package ${input.packageId} version ${input.version} is already registered with different content`,
          'version-content-conflict',
        );
      }
      return { pkg: this.verify(twin), converged: true };
    }
    if (input.version !== max + 1) {
      throw new VerticalsStoreRuleError(
        `vertical package ${input.packageId} version ${input.version} skips the sequence (next is ${max + 1})`,
        'version-not-sequential',
      );
    }
    const id = randomUUID();
    const pkg: MutableVerticalPackage = {
      id,
      tenantId: input.tenantId,
      packageId: input.packageId,
      version: input.version,
      name: input.name,
      description: input.description,
      terminology: { ...input.terminology },
      entities: input.entities.map((entity) => ({ ...entity })),
      workTypes: input.workTypes.map((workType) => ({ ...workType })),
      workflowSteps: input.workflowSteps.map((step) => ({ ...step })),
      policyDefaults: input.policyDefaults.map((declaration) => ({ ...declaration })),
      approvalMatrix: input.approvalMatrix.map((rule) => ({ ...rule })),
      evidenceRequirements: input.evidenceRequirements.map((requirement) => ({ ...requirement })),
      integrationBindings: input.integrationBindings.map((binding) => ({ ...binding })),
      zeckCapabilityRequirements: input.zeckCapabilityRequirements.map((requirement) => ({ ...requirement })),
      pricingRules: input.pricingRules.map((rule) => ({ ...rule })),
      contentHash: input.contentHash,
      recordHash: input.recordHash,
      createdBy: input.createdBy,
      idempotencyKey: input.idempotencyKey,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.packages.set(id, pkg);
    if (input.idempotencyKey !== null) {
      this.packagesByIdempotency.set(`${input.tenantId}:${input.idempotencyKey}`, id);
    }
    return { pkg: { ...pkg }, converged: false };
  }

  async findPackageById(tenantId: string, rowId: string): Promise<VerticalPackageRecord | null> {
    this.reads.byId += 1;
    const pkg = this.packages.get(rowId);
    if (pkg === undefined || pkg.tenantId !== tenantId) return null;
    return this.verify(pkg);
  }

  async findPackage(tenantId: string, packageId: string, version: number): Promise<VerticalPackageRecord | null> {
    this.reads.byKey += 1;
    for (const pkg of this.packages.values()) {
      if (pkg.tenantId === tenantId && pkg.packageId === packageId && pkg.version === version) {
        return this.verify(pkg);
      }
    }
    return null;
  }

  async listPackages(tenantId: string, packageId?: string): Promise<VerticalPackageRecord[]> {
    this.reads.list += 1;
    const matches = [...this.packages.values()].filter(
      (pkg) => pkg.tenantId === tenantId && (packageId === undefined || pkg.packageId === packageId),
    );
    matches.sort((a, b) => (a.packageId === b.packageId ? a.version - b.version : a.packageId < b.packageId ? -1 : 1));
    return matches.map((pkg) => this.verify(pkg));
  }
}

export interface InMemoryServicesStoreOptions {
  now?: () => Date;
  /** Race-injection points before the synchronous critical sections. */
  beforeRegisterDefinition?: () => Promise<void>;
  beforeActivateDefinition?: () => Promise<void>;
  beforeRegisterConfiguration?: () => Promise<void>;
  beforeActivateConfiguration?: () => Promise<void>;
}

/**
 * Faithful in-memory implementation of the /services store port (NOT a
 * second persistence authority): tenant predicates, reads counters, one
 * synchronous critical section per store operation (the semantics of the
 * advisory-locked SQL transactions), async race-injection hooks, hash
 * verification on reads (mutable records so tests can tamper and prove
 * detection), forward-only one-active lifecycles with truthful record
 * hashes, and the same typed rule/missing errors as the SQL store.
 */
export class InMemoryServicesStore implements ServicesStore {
  readonly definitions = new Map<string, MutableServiceDefinition>();
  readonly definitionsByIdempotency = new Map<string, string>();
  readonly configurations = new Map<string, MutableServiceConfiguration>();
  readonly configurationsByIdempotency = new Map<string, string>();
  readonly reads = { definitionByKey: 0, definitionsList: 0, activeDefinition: 0, configurationById: 0, configurationsList: 0, activeConfiguration: 0 };
  /** Race-injection hooks (public so concurrency tests can swap them). */
  readonly options: InMemoryServicesStoreOptions;
  private readonly now: () => Date;

  constructor(options: InMemoryServicesStoreOptions = {}) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
  }

  private verifyDefinition(definition: MutableServiceDefinition): ServiceDefinitionRecord {
    if (computeDefinitionContentHash(definition) !== definition.contentHash) {
      throw new ServicesStoreRuleError(
        `service definition ${definition.serviceId} v${definition.version} content no longer matches its recorded content hash`,
        'service-record-tampered',
      );
    }
    if (computeDefinitionRecordHash(definition) !== definition.recordHash) {
      throw new ServicesStoreRuleError(
        `service definition ${definition.serviceId} v${definition.version} record no longer matches its recorded integrity hash`,
        'service-record-tampered',
      );
    }
    return { ...definition };
  }

  private verifyConfiguration(configuration: MutableServiceConfiguration): ServiceConfigurationRecord {
    if (computeConfigurationContentHash(configuration) !== configuration.contentHash) {
      throw new ServicesStoreRuleError(
        `service configuration ${configuration.serviceId} #${configuration.configurationVersion} content no longer matches its recorded content hash`,
        'configuration-record-tampered',
      );
    }
    if (computeConfigurationRecordHash(configuration) !== configuration.recordHash) {
      throw new ServicesStoreRuleError(
        `service configuration ${configuration.serviceId} #${configuration.configurationVersion} record no longer matches its recorded integrity hash`,
        'configuration-record-tampered',
      );
    }
    return { ...configuration };
  }

  private maxDefinitionVersion(tenantId: string, serviceId: string): number {
    let max = 0;
    for (const definition of this.definitions.values()) {
      if (definition.tenantId === tenantId && definition.serviceId === serviceId && definition.version > max) {
        max = definition.version;
      }
    }
    return max;
  }

  async registerDefinition(input: RegisterDefinitionInput): Promise<{ definition: ServiceDefinitionRecord; converged: boolean }> {
    await this.options.beforeRegisterDefinition?.();
    if (input.idempotencyKey !== null) {
      const existingId = this.definitionsByIdempotency.get(`${input.tenantId}:${input.idempotencyKey}`);
      if (existingId !== undefined) {
        const existing = this.definitions.get(existingId);
        if (existing !== undefined) {
          if (existing.contentHash !== input.contentHash) {
            throw new ServicesStoreRuleError(
              `service definition idempotency key "${input.idempotencyKey}" was already bound to different content`,
              'idempotency-input-conflict',
            );
          }
          return { definition: this.verifyDefinition(existing), converged: true };
        }
      }
    }
    const max = this.maxDefinitionVersion(input.tenantId, input.serviceId);
    if (input.version <= max) {
      const twin = [...this.definitions.values()].find(
        (definition) =>
          definition.tenantId === input.tenantId &&
          definition.serviceId === input.serviceId &&
          definition.version === input.version,
      );
      if (twin === undefined) {
        throw new ServicesStoreRuleError(
          `service definition ${input.serviceId} version ${input.version} is behind the registered sequence (max ${max}) and missing; versions must be contiguous`,
          'version-not-sequential',
        );
      }
      if (twin.contentHash !== input.contentHash) {
        throw new ServicesStoreRuleError(
          `service definition ${input.serviceId} version ${input.version} is already registered with different content`,
          'version-content-conflict',
        );
      }
      return { definition: this.verifyDefinition(twin), converged: true };
    }
    if (input.version !== max + 1) {
      throw new ServicesStoreRuleError(
        `service definition ${input.serviceId} version ${input.version} skips the sequence (next is ${max + 1})`,
        'version-not-sequential',
      );
    }
    const id = randomUUID();
    const definition: MutableServiceDefinition = {
      id,
      tenantId: input.tenantId,
      serviceId: input.serviceId,
      version: input.version,
      status: 'draft',
      name: input.name,
      description: input.description,
      verticalPackageId: input.verticalPackageId,
      verticalPackageVersion: input.verticalPackageVersion,
      entities: input.entities.map((entity) => ({ ...entity })),
      workDefinitions: input.workDefinitions.map((binding) => ({ ...binding })),
      workflowBinding: input.workflowBinding.map((binding) => ({ ...binding })),
      policyConfiguration: input.policyConfiguration.map((declaration) => ({ ...declaration })),
      approvalRules: input.approvalRules.map((rule) => ({ ...rule })),
      slaDefaults: input.slaDefaults.map((entry) => ({ ...entry })),
      outcomeContract: { ...input.outcomeContract },
      requiredExternalCapabilities: [...input.requiredExternalCapabilities],
      requiredAiCapabilities: input.requiredAiCapabilities.map((requirement) => ({ ...requirement })),
      pricing: { ...input.pricing },
      contentHash: input.contentHash,
      recordHash: input.recordHash,
      createdBy: input.createdBy,
      idempotencyKey: input.idempotencyKey,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.definitions.set(id, definition);
    if (input.idempotencyKey !== null) {
      this.definitionsByIdempotency.set(`${input.tenantId}:${input.idempotencyKey}`, id);
    }
    return { definition: { ...definition }, converged: false };
  }

  async findDefinition(tenantId: string, serviceId: string, version: number): Promise<ServiceDefinitionRecord | null> {
    this.reads.definitionByKey += 1;
    for (const definition of this.definitions.values()) {
      if (definition.tenantId === tenantId && definition.serviceId === serviceId && definition.version === version) {
        return this.verifyDefinition(definition);
      }
    }
    return null;
  }

  async listDefinitions(tenantId: string, serviceId?: string, status?: ServiceStatus): Promise<ServiceDefinitionRecord[]> {
    this.reads.definitionsList += 1;
    const matches = [...this.definitions.values()].filter(
      (definition) =>
        definition.tenantId === tenantId &&
        (serviceId === undefined || definition.serviceId === serviceId) &&
        (status === undefined || definition.status === status),
    );
    matches.sort((a, b) =>
      a.serviceId === b.serviceId ? a.version - b.version : a.serviceId < b.serviceId ? -1 : 1,
    );
    return matches.map((definition) => this.verifyDefinition(definition));
  }

  async findActiveDefinition(tenantId: string, serviceId: string): Promise<ServiceDefinitionRecord | null> {
    this.reads.activeDefinition += 1;
    let best: MutableServiceDefinition | null = null;
    for (const definition of this.definitions.values()) {
      if (
        definition.tenantId === tenantId &&
        definition.serviceId === serviceId &&
        definition.status === 'active' &&
        (best === null || definition.version > best.version)
      ) {
        best = definition;
      }
    }
    return best === null ? null : this.verifyDefinition(best);
  }

  async activateDefinition(input: { tenantId: string; serviceId: string; version: number; now: Date }): Promise<{ definition: ServiceDefinitionRecord; converged: boolean }> {
    await this.options.beforeActivateDefinition?.();
    const target = [...this.definitions.values()].find(
      (definition) =>
        definition.tenantId === input.tenantId &&
        definition.serviceId === input.serviceId &&
        definition.version === input.version,
    );
    if (target === undefined) {
      throw new ServicesStoreMissingError('definition', `${input.serviceId} v${input.version}`);
    }
    if (target.status === 'active') {
      return { definition: this.verifyDefinition(target), converged: true };
    }
    if (target.status === 'retired') {
      throw new ServicesStoreRuleError(
        `service definition ${input.serviceId} version ${input.version} is retired and cannot be re-activated`,
        'version-retired',
      );
    }
    // Retire the currently active version FIRST; its record hash is
    // recomputed over its new state (status/updated_at participate).
    for (const definition of this.definitions.values()) {
      if (definition.tenantId === input.tenantId && definition.serviceId === input.serviceId && definition.status === 'active') {
        definition.status = 'retired';
        definition.updatedAt = input.now;
        definition.recordHash = computeDefinitionRecordHash(definition);
      }
    }
    target.status = 'active';
    target.updatedAt = input.now;
    target.recordHash = computeDefinitionRecordHash(target);
    return { definition: this.verifyDefinition(target), converged: false };
  }

  async registerConfiguration(input: RegisterConfigurationInput): Promise<{ configuration: ServiceConfigurationRecord; converged: boolean }> {
    await this.options.beforeRegisterConfiguration?.();
    if (input.idempotencyKey !== null) {
      const existingId = this.configurationsByIdempotency.get(`${input.tenantId}:${input.idempotencyKey}`);
      if (existingId !== undefined) {
        const existing = this.configurations.get(existingId);
        if (existing !== undefined) {
          if (existing.contentHash !== input.contentHash) {
            throw new ServicesStoreRuleError(
              `service configuration idempotency key "${input.idempotencyKey}" was already bound to different content`,
              'idempotency-input-conflict',
            );
          }
          return { configuration: this.verifyConfiguration(existing), converged: true };
        }
      }
    }
    let nextConfigurationVersion = 1;
    for (const configuration of this.configurations.values()) {
      if (
        configuration.tenantId === input.tenantId &&
        configuration.serviceId === input.serviceId &&
        configuration.configurationVersion >= nextConfigurationVersion
      ) {
        nextConfigurationVersion = configuration.configurationVersion + 1;
      }
    }
    const id = randomUUID();
    const configuration: MutableServiceConfiguration = {
      id,
      tenantId: input.tenantId,
      serviceId: input.serviceId,
      serviceVersion: input.serviceVersion,
      configurationVersion: nextConfigurationVersion,
      status: 'draft',
      policyParameters: input.policyParameters.map((entry) => ({ policyKey: entry.policyKey, values: { ...entry.values } })),
      slaAdjustments: input.slaAdjustments.map((adjustment) => ({ ...adjustment })),
      approvalAdjustments: input.approvalAdjustments.map((adjustment) => ({ ...adjustment })),
      contentHash: input.contentHash,
      // The STORE computes the record hash over the full allocated
      // identity (configurationVersion participates; only its allocator
      // can hash it).
      recordHash: '',
      createdBy: input.createdBy,
      idempotencyKey: input.idempotencyKey,
      createdAt: input.now,
      updatedAt: input.now,
    };
    configuration.recordHash = computeConfigurationRecordHash(configuration);
    this.configurations.set(id, configuration);
    if (input.idempotencyKey !== null) {
      this.configurationsByIdempotency.set(`${input.tenantId}:${input.idempotencyKey}`, id);
    }
    return { configuration: { ...configuration }, converged: false };
  }

  async findConfigurationById(tenantId: string, configurationId: string): Promise<ServiceConfigurationRecord | null> {
    this.reads.configurationById += 1;
    const configuration = this.configurations.get(configurationId);
    if (configuration === undefined || configuration.tenantId !== tenantId) return null;
    return this.verifyConfiguration(configuration);
  }

  async listConfigurations(tenantId: string, serviceId?: string): Promise<ServiceConfigurationRecord[]> {
    this.reads.configurationsList += 1;
    const matches = [...this.configurations.values()].filter(
      (configuration) =>
        configuration.tenantId === tenantId && (serviceId === undefined || configuration.serviceId === serviceId),
    );
    matches.sort((a, b) =>
      a.serviceId === b.serviceId ? a.configurationVersion - b.configurationVersion : a.serviceId < b.serviceId ? -1 : 1,
    );
    return matches.map((configuration) => this.verifyConfiguration(configuration));
  }

  async activateConfiguration(input: { tenantId: string; serviceId: string; configurationVersion: number; now: Date }): Promise<{ configuration: ServiceConfigurationRecord; converged: boolean }> {
    await this.options.beforeActivateConfiguration?.();
    const target = [...this.configurations.values()].find(
      (configuration) =>
        configuration.tenantId === input.tenantId &&
        configuration.serviceId === input.serviceId &&
        configuration.configurationVersion === input.configurationVersion,
    );
    if (target === undefined) {
      throw new ServicesStoreMissingError('configuration', `${input.serviceId} #${input.configurationVersion}`);
    }
    if (target.status === 'active') {
      return { configuration: this.verifyConfiguration(target), converged: true };
    }
    if (target.status === 'retired') {
      throw new ServicesStoreRuleError(
        `service configuration ${input.serviceId} #${input.configurationVersion} is retired and cannot be re-activated`,
        'version-retired',
      );
    }
    for (const configuration of this.configurations.values()) {
      if (
        configuration.tenantId === input.tenantId &&
        configuration.serviceId === input.serviceId &&
        configuration.status === 'active'
      ) {
        configuration.status = 'retired';
        configuration.updatedAt = input.now;
        configuration.recordHash = computeConfigurationRecordHash(configuration);
      }
    }
    target.status = 'active';
    target.updatedAt = input.now;
    target.recordHash = computeConfigurationRecordHash(target);
    return { configuration: this.verifyConfiguration(target), converged: false };
  }

  async findActiveConfiguration(tenantId: string, serviceId: string): Promise<ServiceConfigurationRecord | null> {
    this.reads.activeConfiguration += 1;
    let best: MutableServiceConfiguration | null = null;
    for (const configuration of this.configurations.values()) {
      if (
        configuration.tenantId === tenantId &&
        configuration.serviceId === serviceId &&
        configuration.status === 'active' &&
        (best === null || configuration.configurationVersion > best.configurationVersion)
      ) {
        best = configuration;
      }
    }
    return best === null ? null : this.verifyConfiguration(best);
  }
}

/** The composed WORK-009 application (identity + /verticals + /services). */
export interface ServiceRuntimeApp {
  authStore: InMemoryAuthStore;
  orgStore: InMemoryOrganizationsStore;
  verticalsStore: InMemoryVerticalsStore;
  servicesStore: InMemoryServicesStore;
  auth: AuthModule;
  organizations: OrganizationsModule;
  verticals: VerticalsModule;
  services: ServicesModule;
}

export function buildServiceRuntimeApp(
  options: {
    now?: () => Date;
    verticalStoreOptions?: InMemoryVerticalsStoreOptions;
    servicesStoreOptions?: InMemoryServicesStoreOptions;
  } = {},
): ServiceRuntimeApp {
  const now = options.now ?? (() => new Date());
  const identity = buildIdentityApp({ now });
  const verticalsStore = new InMemoryVerticalsStore({ now, ...options.verticalStoreOptions });
  const verticals = createVerticalsModule({ store: verticalsStore, tenancy: identity.organizations, now });
  const servicesStore = new InMemoryServicesStore({ now, ...options.servicesStoreOptions });
  const services = createServicesModule({
    store: servicesStore,
    tenancy: identity.organizations,
    verticals,
    now,
  });
  return {
    authStore: identity.authStore,
    orgStore: identity.orgStore,
    verticalsStore,
    servicesStore,
    auth: identity.auth,
    organizations: identity.organizations,
    verticals,
    services,
  };
}

// ---------------------------------------------------------------------------
// In-memory billing store (WORK-011)
// ---------------------------------------------------------------------------

import {
  createBillingModule,
  BillingStoreMissingError,
  BillingStoreRuleError,
  computeCostReferenceContentHash,
  computeCostReferenceRecordHash,
  computeLedgerContentHash,
  computeLedgerRecordHash,
  computeSubscriptionContentHash,
  computeSubscriptionRecordHash,
  computeUsageContentHash,
  computeUsageRecordHash,
  type ActivateSubscriptionInput,
  type BillingLedgerRecord,
  type BillingModule,
  type BillingStore,
  type BillingSubscriptionRecord,
  type CancelSubscriptionInput,
  type CostReferenceRecord,
  type RecordCostReferenceStoreInput,
  type RecordUsageInput,
  type RegisterSubscriptionStoreInput,
  type SettlePeriodInput,
  type SubscriptionPlan,
  type UsageRecord,
} from '../../src/modules/billing/index.js';

export interface InMemoryBillingStoreOptions {
  now?: () => Date;
  /** Race-injection points before the synchronous critical sections. */
  beforeRegisterSubscription?: () => Promise<void>;
  beforeActivateSubscription?: () => Promise<void>;
  beforeCancelSubscription?: () => Promise<void>;
  beforeRecordUsage?: () => Promise<void>;
  beforeSettlePeriod?: () => Promise<void>;
  beforeRecordCostReference?: () => Promise<void>;
}

type MutableBillingSubscription = Mutable<BillingSubscriptionRecord>;
type MutableUsageRecord = Mutable<UsageRecord>;
type MutableBillingLedger = Mutable<BillingLedgerRecord>;
type MutableCostReference = Mutable<CostReferenceRecord>;

/**
 * Faithful in-memory implementation of the /billing store port (NOT a
 * second persistence authority): tenant predicates, one SYNCHRONOUS
 * critical section per store operation (the exact semantics of the
 * advisory-locked SQL transactions — the async race hooks inject
 * interleaving points BEFORE each section), hash verification on reads
 * (mutable records so tests can tamper deliberately and prove
 * detection), forward-only one-live lifecycle with truthful record
 * hashes, durable dedup identities (work/outcome/key), atomic
 * settlement (usage marks + ledger row in one critical section) and
 * the same typed rule/missing errors as the SQL store.
 */
export class InMemoryBillingStore implements BillingStore {
  readonly subscriptions = new Map<string, MutableBillingSubscription>();
  readonly subscriptionsByIdempotency = new Map<string, string>();
  readonly usage = new Map<string, MutableUsageRecord>();
  readonly usageByWork = new Map<string, string>();
  readonly usageByOutcome = new Map<string, string>();
  readonly usageByIdempotency = new Map<string, string>();
  readonly ledger = new Map<string, MutableBillingLedger>();
  readonly ledgerByPeriod = new Map<string, string>();
  readonly costReferences = new Map<string, MutableCostReference>();
  readonly costReferencesByKey = new Map<string, string>();
  readonly reads = { subscriptionById: 0, subscriptionsList: 0, workUsage: 0, outcomeUsage: 0, usageList: 0, ledger: 0, ledgerList: 0, costReferencesList: 0 };
  /** Race-injection hooks (public so concurrency tests can swap them). */
  readonly options: InMemoryBillingStoreOptions;
  private readonly now: () => Date;

  constructor(options: InMemoryBillingStoreOptions = {}) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
  }

  private verifySubscription(subscription: MutableBillingSubscription): BillingSubscriptionRecord {
    if (computeSubscriptionContentHash(subscription) !== subscription.contentHash) {
      throw new BillingStoreRuleError(
        `subscription ${subscription.id} content no longer matches its recorded content hash`,
        'subscription-record-tampered',
      );
    }
    if (computeSubscriptionRecordHash(subscription) !== subscription.recordHash) {
      throw new BillingStoreRuleError(
        `subscription ${subscription.id} record no longer matches its recorded integrity hash`,
        'subscription-record-tampered',
      );
    }
    return { ...subscription };
  }

  private verifyUsage(record: MutableUsageRecord): UsageRecord {
    if (computeUsageContentHash(record) !== record.contentHash) {
      throw new BillingStoreRuleError(
        `usage ${record.id} content no longer matches its recorded content hash`,
        'usage-record-tampered',
      );
    }
    if (computeUsageRecordHash(record) !== record.recordHash) {
      throw new BillingStoreRuleError(
        `usage ${record.id} record no longer matches its recorded integrity hash`,
        'usage-record-tampered',
      );
    }
    return { ...record };
  }

  private verifyLedger(entry: MutableBillingLedger): BillingLedgerRecord {
    if (computeLedgerContentHash(entry) !== entry.contentHash) {
      throw new BillingStoreRuleError(
        `ledger entry ${entry.id} content no longer matches its recorded content hash`,
        'ledger-record-tampered',
      );
    }
    if (computeLedgerRecordHash(entry) !== entry.recordHash) {
      throw new BillingStoreRuleError(
        `ledger entry ${entry.id} record no longer matches its recorded integrity hash`,
        'ledger-record-tampered',
      );
    }
    return { ...entry };
  }

  private verifyCostReference(reference: MutableCostReference): CostReferenceRecord {
    if (computeCostReferenceContentHash(reference) !== reference.contentHash) {
      throw new BillingStoreRuleError(
        `cost reference ${reference.id} content no longer matches its recorded content hash`,
        'cost-reference-record-tampered',
      );
    }
    if (computeCostReferenceRecordHash(reference) !== reference.recordHash) {
      throw new BillingStoreRuleError(
        `cost reference ${reference.id} record no longer matches its recorded integrity hash`,
        'cost-reference-record-tampered',
      );
    }
    return { ...reference };
  }

  private liveSubscriptionOf(tenantId: string, serviceId: string): MutableBillingSubscription | undefined {
    return [...this.subscriptions.values()].find(
      (subscription) => subscription.tenantId === tenantId && subscription.serviceId === serviceId && subscription.status !== 'cancelled',
    );
  }

  async registerSubscription(input: RegisterSubscriptionStoreInput): Promise<{ subscription: BillingSubscriptionRecord; converged: boolean }> {
    await this.options.beforeRegisterSubscription?.();
    // Synchronous critical section (SQL: key lookup + advisory-locked
    // one-live check + insert).
    if (input.idempotencyKey !== null) {
      const existingId = this.subscriptionsByIdempotency.get(`${input.tenantId}:${input.idempotencyKey}`);
      const existing = existingId !== undefined ? this.subscriptions.get(existingId) : undefined;
      if (existing !== undefined) {
        if (existing.contentHash !== input.contentHash) {
          throw new BillingStoreRuleError(
            `subscription idempotency key "${input.idempotencyKey}" was already bound to different content`,
            'idempotency-input-conflict',
          );
        }
        return { subscription: this.verifySubscription(existing), converged: true };
      }
    }
    const live = this.liveSubscriptionOf(input.tenantId, input.serviceId);
    if (live !== undefined) {
      if (live.idempotencyKey !== null && live.idempotencyKey === input.idempotencyKey) {
        return { subscription: this.verifySubscription(live), converged: true };
      }
      throw new BillingStoreRuleError(
        `service ${input.serviceId} already has a live subscription (${live.status}) in this tenant; cancel it before registering a replacement`,
        'subscription-already-active',
      );
    }
    const id = randomUUID();
    const subscription: MutableBillingSubscription = {
      id,
      tenantId: input.tenantId,
      serviceId: input.serviceId,
      serviceVersion: input.serviceVersion,
      status: 'draft',
      plan: input.plan,
      createdBy: input.createdBy,
      idempotencyKey: input.idempotencyKey,
      createdAt: input.now,
      updatedAt: input.now,
      cancelledAt: null,
      contentHash: input.contentHash,
      recordHash: '',
    };
    subscription.recordHash = computeSubscriptionRecordHash(subscription);
    this.subscriptions.set(id, subscription);
    if (input.idempotencyKey !== null) {
      this.subscriptionsByIdempotency.set(`${input.tenantId}:${input.idempotencyKey}`, id);
    }
    return { subscription: this.verifySubscription(subscription), converged: false };
  }

  async findSubscription(tenantId: string, subscriptionId: string): Promise<BillingSubscriptionRecord | null> {
    this.reads.subscriptionById += 1;
    const subscription = this.subscriptions.get(subscriptionId);
    if (subscription === undefined || subscription.tenantId !== tenantId) {
      return null;
    }
    return this.verifySubscription(subscription);
  }

  async listSubscriptions(tenantId: string, serviceId?: string): Promise<BillingSubscriptionRecord[]> {
    this.reads.subscriptionsList += 1;
    const matches = [...this.subscriptions.values()].filter(
      (subscription) =>
        subscription.tenantId === tenantId && (serviceId === undefined || subscription.serviceId === serviceId),
    );
    matches.sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1));
    return matches.map((subscription) => this.verifySubscription(subscription));
  }

  async findLiveSubscription(tenantId: string, serviceId: string): Promise<BillingSubscriptionRecord | null> {
    const live = this.liveSubscriptionOf(tenantId, serviceId);
    return live === undefined ? null : this.verifySubscription(live);
  }

  async activateSubscription(input: ActivateSubscriptionInput): Promise<{ subscription: BillingSubscriptionRecord; converged: boolean }> {
    await this.options.beforeActivateSubscription?.();
    const subscription = this.subscriptions.get(input.subscriptionId);
    if (subscription === undefined || subscription.tenantId !== input.tenantId) {
      throw new BillingStoreMissingError('subscription', input.subscriptionId);
    }
    if (subscription.status === 'active') {
      return { subscription: this.verifySubscription(subscription), converged: true };
    }
    if (subscription.status === 'cancelled') {
      throw new BillingStoreRuleError(
        `subscription ${input.subscriptionId} is cancelled and cannot be re-activated`,
        'subscription-lifecycle',
      );
    }
    subscription.status = 'active';
    subscription.updatedAt = input.now;
    subscription.recordHash = computeSubscriptionRecordHash(subscription);
    return { subscription: this.verifySubscription(subscription), converged: false };
  }

  async cancelSubscription(input: CancelSubscriptionInput): Promise<{ subscription: BillingSubscriptionRecord; converged: boolean }> {
    await this.options.beforeCancelSubscription?.();
    const subscription = this.subscriptions.get(input.subscriptionId);
    if (subscription === undefined || subscription.tenantId !== input.tenantId) {
      throw new BillingStoreMissingError('subscription', input.subscriptionId);
    }
    if (subscription.status === 'cancelled') {
      return { subscription: this.verifySubscription(subscription), converged: true };
    }
    subscription.status = 'cancelled';
    subscription.updatedAt = input.now;
    subscription.cancelledAt = input.now;
    subscription.recordHash = computeSubscriptionRecordHash(subscription);
    return { subscription: this.verifySubscription(subscription), converged: false };
  }

  async recordUsage(input: RecordUsageInput): Promise<{ usage: UsageRecord; converged: boolean }> {
    await this.options.beforeRecordUsage?.();
    // Synchronous critical section (SQL: dedup lookups + insert with
    // unique-index arbitration + convergence re-read).
    const refKey =
      input.source === 'work' && input.workId !== null
        ? `work:${input.tenantId}:${input.workId}`
        : input.source === 'outcome' && input.outcomeId !== null
          ? `outcome:${input.tenantId}:${input.outcomeId}`
          : undefined;
    const refId = refKey !== undefined ? this.usageByWork.get(refKey) ?? this.usageByOutcome.get(refKey) : undefined;
    const refRow = refId !== undefined ? this.usage.get(refId) : undefined;
    if (refRow !== undefined) {
      if (refRow.contentHash !== input.contentHash) {
        throw new BillingStoreRuleError(
          `work/outcome ${input.workId ?? input.outcomeId} is already metered with different content; duplicate billable work must not double-charge`,
          'usage-input-conflict',
        );
      }
      return { usage: this.verifyUsage(refRow), converged: true };
    }
    if (input.idempotencyKey !== null) {
      const keyedId = this.usageByIdempotency.get(`${input.tenantId}:${input.idempotencyKey}`);
      const keyed = keyedId !== undefined ? this.usage.get(keyedId) : undefined;
      if (keyed !== undefined) {
        if (keyed.contentHash !== input.contentHash) {
          throw new BillingStoreRuleError(
            `usage idempotency key "${input.idempotencyKey}" was already bound to different content`,
            'idempotency-input-conflict',
          );
        }
        return { usage: this.verifyUsage(keyed), converged: true };
      }
    }
    const id = randomUUID();
    const record: MutableUsageRecord = {
      id,
      tenantId: input.tenantId,
      subscriptionId: input.subscriptionId,
      serviceId: input.serviceId,
      serviceVersion: input.serviceVersion,
      source: input.source,
      metric: input.metric,
      unit: input.unit,
      quantity: input.quantity,
      workId: input.workId,
      outcomeId: input.outcomeId,
      occurredAt: input.occurredAt,
      billingPeriod: input.billingPeriod,
      settledLedgerId: null,
      createdBy: input.createdBy,
      idempotencyKey: input.idempotencyKey,
      createdAt: input.now,
      updatedAt: input.now,
      contentHash: input.contentHash,
      recordHash: '',
    };
    record.recordHash = computeUsageRecordHash(record);
    this.usage.set(id, record);
    if (input.source === 'work' && input.workId !== null) {
      this.usageByWork.set(`work:${input.tenantId}:${input.workId}`, id);
    }
    if (input.source === 'outcome' && input.outcomeId !== null) {
      this.usageByOutcome.set(`outcome:${input.tenantId}:${input.outcomeId}`, id);
    }
    if (input.idempotencyKey !== null) {
      this.usageByIdempotency.set(`${input.tenantId}:${input.idempotencyKey}`, id);
    }
    return { usage: this.verifyUsage(record), converged: false };
  }

  async findWorkUsage(tenantId: string, workId: string): Promise<UsageRecord | null> {
    this.reads.workUsage += 1;
    const id = this.usageByWork.get(`work:${tenantId}:${workId}`);
    const record = id !== undefined ? this.usage.get(id) : undefined;
    return record === undefined ? null : this.verifyUsage(record);
  }

  async findOutcomeUsage(tenantId: string, outcomeId: string): Promise<UsageRecord | null> {
    this.reads.outcomeUsage += 1;
    const id = this.usageByOutcome.get(`outcome:${tenantId}:${outcomeId}`);
    const record = id !== undefined ? this.usage.get(id) : undefined;
    return record === undefined ? null : this.verifyUsage(record);
  }

  async listUsage(tenantId: string, filter?: { subscriptionId?: string; billingPeriod?: string }): Promise<UsageRecord[]> {
    this.reads.usageList += 1;
    const matches = [...this.usage.values()].filter(
      (record) =>
        record.tenantId === tenantId &&
        (filter?.subscriptionId === undefined || record.subscriptionId === filter.subscriptionId) &&
        (filter?.billingPeriod === undefined || record.billingPeriod === filter.billingPeriod),
    );
    matches.sort((a, b) => (a.occurredAt === b.occurredAt ? (a.id < b.id ? -1 : 1) : a.occurredAt < b.occurredAt ? -1 : 1));
    return matches.map((record) => this.verifyUsage(record));
  }

  async settlePeriod(input: SettlePeriodInput): Promise<{ ledger: BillingLedgerRecord; converged: boolean }> {
    await this.options.beforeSettlePeriod?.();
    // Synchronous critical section (SQL: advisory-locked settlement —
    // ledger convergence check, unsettled usage selection, pricing,
    // ledger insert + usage settlement marks, all atomic).
    const periodKey = `${input.tenantId}:${input.subscriptionId}:${input.billingPeriod}`;
    const existingId = this.ledgerByPeriod.get(periodKey);
    const existing = existingId !== undefined ? this.ledger.get(existingId) : undefined;
    if (existing !== undefined) {
      return { ledger: this.verifyLedger(existing), converged: true };
    }
    const subscription = this.subscriptions.get(input.subscriptionId);
    if (subscription === undefined || subscription.tenantId !== input.tenantId) {
      throw new BillingStoreMissingError('subscription', input.subscriptionId);
    }
    const unsettled = [...this.usage.values()].filter(
      (record) =>
        record.tenantId === input.tenantId &&
        record.subscriptionId === input.subscriptionId &&
        record.billingPeriod === input.billingPeriod &&
        record.settledLedgerId === null,
    );
    unsettled.sort((a, b) => (a.occurredAt === b.occurredAt ? (a.id < b.id ? -1 : 1) : a.occurredAt < b.occurredAt ? -1 : 1));
    // Module-owned pure pricing policy (no clock, no IO).
    const charges = input.priceUsage(unsettled.map((record) => this.verifyUsage(record)));
    const id = randomUUID();
    const entry: MutableBillingLedger = {
      id,
      tenantId: input.tenantId,
      subscriptionId: input.subscriptionId,
      serviceId: input.serviceId,
      billingPeriod: input.billingPeriod,
      currency: input.currency,
      subscriptionCharge: charges.subscriptionCharge,
      usageCharge: charges.usageCharge,
      totalCharge: charges.totalCharge,
      usageCount: unsettled.length,
      settledAt: input.now,
      settledBy: input.settledBy,
      createdBy: input.settledBy,
      createdAt: input.now,
      updatedAt: input.now,
      contentHash: computeLedgerContentHash({
        tenantId: input.tenantId,
        subscriptionId: input.subscriptionId,
        serviceId: input.serviceId,
        billingPeriod: input.billingPeriod,
        currency: input.currency,
        subscriptionCharge: charges.subscriptionCharge,
        usageCharge: charges.usageCharge,
        totalCharge: charges.totalCharge,
        usageCount: unsettled.length,
        settledBy: input.settledBy,
      }),
      recordHash: '',
    };
    entry.recordHash = computeLedgerRecordHash(entry);
    this.ledger.set(id, entry);
    this.ledgerByPeriod.set(periodKey, id);
    // Atomic settlement marks with truthful record hashes.
    for (const record of unsettled) {
      record.settledLedgerId = id;
      record.updatedAt = input.now;
      record.recordHash = computeUsageRecordHash(record);
    }
    return { ledger: this.verifyLedger(entry), converged: false };
  }

  async findLedgerEntry(tenantId: string, subscriptionId: string, billingPeriod: string): Promise<BillingLedgerRecord | null> {
    this.reads.ledger += 1;
    const id = this.ledgerByPeriod.get(`${tenantId}:${subscriptionId}:${billingPeriod}`);
    const entry = id !== undefined ? this.ledger.get(id) : undefined;
    return entry === undefined ? null : this.verifyLedger(entry);
  }

  async listLedgerEntries(tenantId: string, billingPeriod?: string): Promise<BillingLedgerRecord[]> {
    this.reads.ledgerList += 1;
    const matches = [...this.ledger.values()].filter(
      (entry) => entry.tenantId === tenantId && (billingPeriod === undefined || entry.billingPeriod === billingPeriod),
    );
    matches.sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1));
    return matches.map((entry) => this.verifyLedger(entry));
  }

  async recordCostReference(input: RecordCostReferenceStoreInput): Promise<{ reference: CostReferenceRecord; converged: boolean }> {
    await this.options.beforeRecordCostReference?.();
    // Synchronous critical section (SQL: keyed lookup + insert with
    // unique arbitration + convergence re-read).
    const key = `${input.tenantId}:${input.idempotencyKey}`;
    const existingId = this.costReferencesByKey.get(key);
    const existing = existingId !== undefined ? this.costReferences.get(existingId) : undefined;
    if (existing !== undefined) {
      if (existing.contentHash !== input.contentHash) {
        throw new BillingStoreRuleError(
          `cost reference idempotency key "${input.idempotencyKey}" was already bound to different content`,
          'idempotency-input-conflict',
        );
      }
      return { reference: this.verifyCostReference(existing), converged: true };
    }
    const id = randomUUID();
    const reference: MutableCostReference = {
      id,
      tenantId: input.tenantId,
      billingPeriod: input.billingPeriod,
      source: input.source,
      externalReference: input.externalReference,
      amount: input.amount,
      currency: input.currency,
      recordedBy: input.recordedBy,
      idempotencyKey: input.idempotencyKey,
      createdAt: input.now,
      updatedAt: input.now,
      contentHash: input.contentHash,
      recordHash: '',
    };
    reference.recordHash = computeCostReferenceRecordHash(reference);
    this.costReferences.set(id, reference);
    this.costReferencesByKey.set(key, id);
    return { reference: this.verifyCostReference(reference), converged: false };
  }

  async listCostReferences(tenantId: string, billingPeriod?: string): Promise<CostReferenceRecord[]> {
    this.reads.costReferencesList += 1;
    const matches = [...this.costReferences.values()].filter(
      (reference) =>
        reference.tenantId === tenantId && (billingPeriod === undefined || reference.billingPeriod === billingPeriod),
    );
    matches.sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1));
    return matches.map((reference) => this.verifyCostReference(reference));
  }
}

export interface BillingEconomicsApp {
  authStore: InMemoryAuthStore;
  orgStore: InMemoryOrganizationsStore;
  verticalsStore: InMemoryVerticalsStore;
  servicesStore: InMemoryServicesStore;
  workStore: InMemoryWorkStore;
  billingStore: InMemoryBillingStore;
  auth: ReturnType<typeof buildIdentityApp>['auth'];
  organizations: ReturnType<typeof buildIdentityApp>['organizations'];
  verticals: VerticalsModule;
  services: ServicesModule;
  work: ReturnType<typeof createWorkModule>;
  billing: BillingModule;
}

/**
 * One composed in-memory application for the billing economics proofs:
 * identity/tenancy + the service catalog (verticals + services) + real
 * work identities + the billing module under test, sharing the single
 * authorization chain (exactly like the composition root).
 */
export function buildBillingEconomicsApp(
  options: {
    now?: () => Date;
    verticalStoreOptions?: InMemoryVerticalsStoreOptions;
    servicesStoreOptions?: InMemoryServicesStoreOptions;
    workStoreOptions?: InMemoryWorkStoreOptions;
    billingStoreOptions?: InMemoryBillingStoreOptions;
  } = {},
): BillingEconomicsApp {
  const now = options.now ?? (() => new Date());
  const identity = buildIdentityApp({ now });
  const verticalsStore = new InMemoryVerticalsStore({ now, ...options.verticalStoreOptions });
  const verticals = createVerticalsModule({ store: verticalsStore, tenancy: identity.organizations, now });
  const servicesStore = new InMemoryServicesStore({ now, ...options.servicesStoreOptions });
  const services = createServicesModule({
    store: servicesStore,
    tenancy: identity.organizations,
    verticals,
    now,
  });
  const workStore = new InMemoryWorkStore({ now, ...options.workStoreOptions });
  const work = createWorkModule({ store: workStore, tenancy: identity.organizations, now });
  const billingStore = new InMemoryBillingStore({ now, ...options.billingStoreOptions });
  const billing = createBillingModule({
    store: billingStore,
    tenancy: identity.organizations,
    services,
    work,
    now,
  });
  return {
    authStore: identity.authStore,
    orgStore: identity.orgStore,
    verticalsStore,
    servicesStore,
    workStore,
    billingStore,
    auth: identity.auth,
    organizations: identity.organizations,
    verticals,
    services,
    work,
    billing,
  };
}
