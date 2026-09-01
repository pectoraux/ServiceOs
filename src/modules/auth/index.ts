/**
 * ServiceOS module: /auth (WORK-002 implementation).
 *
 * ServiceOS human and machine identity integration (architecture.md §6).
 * The authority matrix assigns user identity to this module: it is the single
 * credential-verification authority. Other modules consume `authenticate`
 * through this public interface; a second identity store or credential
 * verifier anywhere else is an architecture violation (enforced structurally
 * by the identity-boundary checks in the governance platform).
 *
 * Identity mechanism (the selected ServiceOS identity mechanism, AC-1):
 * - humans authenticate with email + scrypt password and receive an opaque
 *   bearer session token (stored hashed, revocable, expiring);
 * - machines are service-account principals without passwords that present
 *   opaque API keys (stored hashed, revocable). Machine credentials resolve
 *   to a principal whose capabilities come ONLY from the /organizations
 *   membership/role chain — there is no machine-specific grant anywhere
 *   (AC-5).
 *
 * No AI provider/model credential is known to this module (lock #17).
 */
import {
  defineRoute,
  readJsonObject,
  RouteHttpError,
  type RouteDescriptor,
  type RouteRequest,
} from '../../platform/http/index.js';
import type { SqlExecutor } from '../../platform/persistence/index.js';
import { defineModule } from '../../platform/module-registry/index.js';
import {
  apiKeyHint,
  credentialDigest,
  generateApiKeySecret,
  generateSessionSecret,
  hashPassword,
  isValidEmailForm,
  normalizeEmail,
  validatePasswordPolicy,
  verifyPassword,
  API_KEY_PREFIX,
  SESSION_TOKEN_PREFIX,
} from './credentials.js';
import { createSqlAuthStore } from './sql-store.js';
import {
  StoreConflictError,
  type ApiKeyRecord,
  type AuthStore,
  type PrincipalKind,
  type PrincipalRecord,
  type PrincipalStatus,
} from './store.js';

// Shared store-contract error: re-exported so /organizations (the tenancy
// authority consuming this module's public interface) can map unique
// constraint violations uniformly. Kept in the public surface deliberately.
export { StoreConflictError };
export type {
  ApiKeyRecord,
  ApiKeyWithPrincipal,
  AuthStore,
  CredentialStatus,
  NewApiKey,
  NewPrincipal,
  NewSession,
  PrincipalKind,
  PrincipalRecord,
  PrincipalStatus,
  SessionRecord,
  SessionWithPrincipal,
} from './store.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface Principal {
  readonly id: string;
  readonly email: string;
  readonly kind: PrincipalKind;
  readonly displayName: string;
  readonly status: PrincipalStatus;
}

export interface SessionIssuance {
  readonly token: string;
  readonly expiresAt: Date;
  readonly principal: Principal;
}

export interface ApiKeyIssuance {
  readonly keyId: string;
  /** The secret is shown exactly once at issuance; only its digest persists. */
  readonly secret: string;
  readonly keyHint: string;
  readonly principalId: string;
}

/**
 * The credential-verification entry point consumed by the /organizations
 * authorization chain (injected there by the composition root). This export
 * name is reserved to /auth by the identity-boundary structural checks.
 */
export type Authenticator = (authorization: string | undefined) => Promise<Principal>;

export type AuthErrorCode =
  | 'UNAUTHENTICATED'
  | 'INVALID_CREDENTIALS'
  | 'EMAIL_TAKEN'
  | 'WEAK_PASSWORD'
  | 'INVALID_INPUT'
  | 'PRINCIPAL_NOT_FOUND'
  | 'MACHINE_PRINCIPAL_FORBIDDEN';

export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'AuthError';
  }
}

/** Bearer session lifetime (deliberate platform constant, 12 hours). */
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

// ---------------------------------------------------------------------------
// Module factory
// ---------------------------------------------------------------------------

export interface AuthModuleOptions {
  /** Production wiring: persistence-boundary executor for the SQL store. */
  executor?: SqlExecutor;
  /** Test seam: inject a faithful in-memory store instead (tests only). */
  store?: AuthStore;
  /** Clock injection for deterministic expiry proofs (defaults to real time). */
  now?: () => Date;
}

export interface AuthModule {
  /** Verify a request credential and resolve the active principal (AC-1). */
  authenticate: Authenticator;
  registerHuman(input: { email: string; password: string; displayName: string }): Promise<Principal>;
  login(input: { email: string; password: string }): Promise<SessionIssuance>;
  logout(sessionId: string): Promise<{ revoked: boolean }>;
  /** Identity reads consumed by other modules through the public interface. */
  resolvePrincipalByEmail(email: string): Promise<Principal | null>;
  resolvePrincipals(principalIds: readonly string[]): Promise<Principal[]>;
  /** Machine-identity operations consumed by /organizations service accounts. */
  createMachinePrincipal(input: { displayName: string }): Promise<Principal>;
  issueApiKey(principalId: string): Promise<ApiKeyIssuance>;
  revokeApiKeysForPrincipal(principalId: string): Promise<{ revoked: number }>;
  /** Guarded + public HTTP routes for the identity surface. */
  routes(): RouteDescriptor[];
}

interface CredentialContext {
  readonly principal: Principal;
  readonly credential:
    | { readonly type: 'session'; readonly id: string }
    | { readonly type: 'api-key'; readonly id: string };
}

export function createAuthModule(options: AuthModuleOptions): AuthModule {
  if ((options.executor === undefined) === (options.store === undefined)) {
    throw new AuthError('INVALID_INPUT', 'createAuthModule requires exactly one of executor or store');
  }
  const store = options.store ?? createSqlAuthStore(options.executor as SqlExecutor);
  const now = options.now ?? (() => new Date());

  function toPrincipal(record: PrincipalRecord): Principal {
    return {
      id: record.id,
      email: record.email,
      kind: record.kind,
      displayName: record.displayName,
      status: record.status,
    };
  }

  /** Resolve a Bearer credential to an active principal (fail closed). */
  async function resolveCredential(authorization: string | undefined): Promise<CredentialContext> {
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
      throw new AuthError('UNAUTHENTICATED', 'a Bearer credential is required');
    }
    const secret = authorization.slice('Bearer '.length).trim();
    if (secret === '') {
      throw new AuthError('UNAUTHENTICATED', 'a Bearer credential is required');
    }
    const digest = credentialDigest(secret);
    if (secret.startsWith(SESSION_TOKEN_PREFIX)) {
      const found = await store.findActiveSessionByTokenHash(digest, now());
      if (found === null) {
        // Uniform 401: unknown, revoked, expired and disabled all look alike.
        throw new AuthError('UNAUTHENTICATED', 'credential rejected');
      }
      void store.touchSessionLastUsed(found.session.id, now()).catch(() => undefined);
      return {
        principal: toPrincipal(found.principal),
        credential: { type: 'session', id: found.session.id },
      };
    }
    if (secret.startsWith(API_KEY_PREFIX)) {
      const found = await store.findActiveApiKeyByHash(digest);
      if (found === null) {
        throw new AuthError('UNAUTHENTICATED', 'credential rejected');
      }
      return {
        principal: toPrincipal(found.principal),
        credential: { type: 'api-key', id: found.apiKey.id },
      };
    }
    throw new AuthError('UNAUTHENTICATED', 'unsupported credential');
  }

  async function authenticate(authorization: string | undefined): Promise<Principal> {
    const resolved = await resolveCredential(authorization);
    return resolved.principal;
  }

  async function registerHuman(input: {
    email: string;
    password: string;
    displayName: string;
  }): Promise<Principal> {
    if (typeof input.displayName !== 'string' || input.displayName.trim() === '' || input.displayName.length > 200) {
      throw new AuthError('INVALID_INPUT', 'displayName must be a non-empty string of at most 200 characters');
    }
    const email = typeof input.email === 'string' ? normalizeEmail(input.email) : '';
    if (!isValidEmailForm(email)) {
      throw new AuthError('INVALID_INPUT', 'email is not a valid address');
    }
    if (typeof input.password !== 'string') {
      throw new AuthError('WEAK_PASSWORD', 'password is required');
    }
    const policy = validatePasswordPolicy(input.password);
    if (!policy.ok) {
      throw new AuthError('WEAK_PASSWORD', policy.problem);
    }
    const passwordHash = await hashPassword(input.password);
    try {
      const record = await store.createUser({ email, kind: 'human', displayName: input.displayName.trim(), passwordHash });
      return toPrincipal(record);
    } catch (error) {
      if (error instanceof StoreConflictError && error.constraint.startsWith('auth_users_email')) {
        throw new AuthError('EMAIL_TAKEN', `email ${email} is already registered`);
      }
      throw error;
    }
  }

  async function login(input: { email: string; password: string }): Promise<SessionIssuance> {
    const email = typeof input.email === 'string' ? normalizeEmail(input.email) : '';
    const record = await store.findUserByEmail(email);
    // Uniform outcome for unknown email, machine principal, wrong password and
    // disabled principal: a single INVALID_CREDENTIALS response.
    if (record === null || record.status !== 'active' || record.kind !== 'human') {
      throw new AuthError('INVALID_CREDENTIALS', 'email or password is incorrect');
    }
    const ok = await verifyPassword(input.password, record.passwordHash);
    if (!ok) {
      throw new AuthError('INVALID_CREDENTIALS', 'email or password is incorrect');
    }
    const token = generateSessionSecret();
    const session = await store.insertSession({
      principalId: record.id,
      tokenHash: credentialDigest(token),
      expiresAt: new Date(now().getTime() + SESSION_TTL_SECONDS * 1000),
    });
    return { token, expiresAt: session.expiresAt, principal: toPrincipal(record) };
  }

  async function logout(sessionId: string): Promise<{ revoked: boolean }> {
    const revoked = await store.revokeSession(sessionId);
    return { revoked };
  }

  async function createMachinePrincipal(input: { displayName: string }): Promise<Principal> {
    if (typeof input.displayName !== 'string' || input.displayName.trim() === '' || input.displayName.length > 200) {
      throw new AuthError('INVALID_INPUT', 'displayName must be a non-empty string of at most 200 characters');
    }
    // Service accounts get a generated, collision-resistant address; they are
    // password-less by construction (password login rejects them uniformly).
    const email = `sa-${credentialDigest(generateApiKeySecret()).slice(0, 24)}@machine.serviceos.invalid`;
    const record = await store.createUser({
      email,
      kind: 'machine',
      displayName: input.displayName.trim(),
      passwordHash: null,
    });
    return toPrincipal(record);
  }

  async function issueApiKey(principalId: string): Promise<ApiKeyIssuance> {
    const secret = generateApiKeySecret();
    const record: ApiKeyRecord = await store.insertApiKey({
      principalId,
      keyHash: credentialDigest(secret),
      keyHint: apiKeyHint(secret),
    });
    return { keyId: record.id, secret, keyHint: record.keyHint, principalId };
  }

  async function revokeApiKeysForPrincipal(principalId: string): Promise<{ revoked: number }> {
    const revoked = await store.revokeApiKeysForPrincipal(principalId);
    return { revoked };
  }

  async function resolvePrincipalByEmail(email: string): Promise<Principal | null> {
    const record = await store.findUserByEmail(normalizeEmail(email));
    return record === null ? null : toPrincipal(record);
  }

  async function resolvePrincipals(principalIds: readonly string[]): Promise<Principal[]> {
    const records = await Promise.all(principalIds.map((id) => store.findUserById(id)));
    const found: Principal[] = [];
    for (const record of records) {
      if (record !== null) {
        found.push(toPrincipal(record));
      }
    }
    return found;
  }

  // -------------------------------------------------------------------------
  // HTTP routes (identity lifecycle). Identity routes are public or
  // principal-scoped; tenancy-scoped routes live in /organizations and use
  // that module's authorization guard.
  // -------------------------------------------------------------------------

  function requirePrincipal(req: RouteRequest): Promise<CredentialContext> {
    return resolveCredential(req.headers['authorization']).catch((error: unknown) => {
      if (error instanceof AuthError && error.code === 'UNAUTHENTICATED') {
        // Guards must surface typed HTTP errors so a denial never leaks as 500.
        throw new RouteHttpError(401, 'UNAUTHENTICATED', error.message);
      }
      throw error;
    });
  }

  function httpError(error: unknown): RouteHttpError {
    if (error instanceof AuthError) {
      const status =
        error.code === 'EMAIL_TAKEN'
          ? 409
          : error.code === 'UNAUTHENTICATED' || error.code === 'INVALID_CREDENTIALS'
            ? 401
            : error.code === 'PRINCIPAL_NOT_FOUND'
              ? 404
              : 400;
      return new RouteHttpError(status, error.code, error.message);
    }
    if (error instanceof RouteHttpError) return error;
    return new RouteHttpError(500, 'INTERNAL', 'internal error');
  }

  function requireString(body: Record<string, unknown>, field: string): string {
    const value = body[field];
    if (typeof value !== 'string') {
      throw new AuthError('INVALID_INPUT', `${field} must be a string`);
    }
    return value;
  }

  const moduleRoutes: RouteDescriptor[] = [
    defineRoute({
      access: 'public',
      method: 'POST',
      path: '/api/auth/register',
      handler: async (req) => {
        try {
          const body = await readJsonObject(req);
          const principal = await registerHuman({
            email: requireString(body, 'email'),
            password: requireString(body, 'password'),
            displayName: requireString(body, 'displayName'),
          });
          return { status: 201, body: { principal: serializePrincipal(principal) } };
        } catch (error) {
          throw httpError(error);
        }
      },
    }),
    defineRoute({
      access: 'public',
      method: 'POST',
      path: '/api/auth/login',
      handler: async (req) => {
        try {
          const body = await readJsonObject(req);
          const issuance = await login({
            email: requireString(body, 'email'),
            password: requireString(body, 'password'),
          });
          return {
            status: 200,
            body: {
              token: issuance.token,
              expiresAt: issuance.expiresAt.toISOString(),
              principal: serializePrincipal(issuance.principal),
            },
          };
        } catch (error) {
          throw httpError(error);
        }
      },
    }),
    defineRoute({
      access: 'principal',
      method: 'POST',
      path: '/api/auth/logout',
      guard: requirePrincipal,
      handler: async (_req, ctx) => {
        try {
          if (ctx.credential.type !== 'session') {
            return { status: 200, body: { revoked: false } };
          }
          return { status: 200, body: await logout(ctx.credential.id) };
        } catch (error) {
          throw httpError(error);
        }
      },
    }),
    defineRoute({
      access: 'principal',
      method: 'GET',
      path: '/api/auth/me',
      guard: requirePrincipal,
      handler: async (_req, ctx) => ({ status: 200, body: { principal: serializePrincipal(ctx.principal) } }),
    }),
  ];

  return {
    authenticate,
    registerHuman,
    login,
    logout,
    resolvePrincipalByEmail,
    resolvePrincipals,
    createMachinePrincipal,
    issueApiKey,
    revokeApiKeysForPrincipal,
    routes: () => [...moduleRoutes],
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

export default defineModule({
  name: 'auth',
  version: '0.2.0',
  description: 'ServiceOS human and machine identity integration',
});
