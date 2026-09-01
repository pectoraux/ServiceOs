/**
 * ServiceOS /auth store port (WORK-002).
 *
 * The persistence contract for the identity substrate. The authoritative
 * implementation is the PostgreSQL store (`sql-store.ts`) driven through the
 * platform persistence boundary's `SqlExecutor`; tests inject an in-memory
 * implementation of the same port. This module never imports `pg` — the
 * persistence boundary is the single driver authority (architecture-lock #18).
 *
 * Store contract semantics (mirrored by every implementation):
 * - inserts enforce the schema's unique constraints and surface them as
 *   `StoreConflictError` with the offending constraint name;
 * - lookups by natural identity (email, token hash) return `null` for absent
 *   rows (a missing read is `null`, never an empty result — lock #30);
 * - conditional updates are atomic per store call (check + mutate with no
 *   interleaving gap), matching the transactional SQL implementation.
 */

/** Typed unique-constraint violation from any store implementation. */
export class StoreConflictError extends Error {
  constructor(
    message: string,
    readonly constraint: string,
  ) {
    super(message);
    this.name = 'StoreConflictError';
  }
}

/** Typed row-not-found for single-row mutations. */
export class StoreNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreNotFoundError';
  }
}

export type PrincipalKind = 'human' | 'machine';
export type PrincipalStatus = 'active' | 'disabled';
export type CredentialStatus = 'active' | 'revoked';

export interface PrincipalRecord {
  readonly id: string;
  readonly email: string;
  readonly kind: PrincipalKind;
  readonly displayName: string;
  /** scrypt password record; null for machine principals (no password). */
  readonly passwordHash: string | null;
  readonly status: PrincipalStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface SessionRecord {
  readonly id: string;
  readonly principalId: string;
  readonly tokenHash: string;
  readonly status: CredentialStatus;
  readonly expiresAt: Date;
  readonly lastUsedAt: Date | null;
  readonly createdAt: Date;
}

export interface ApiKeyRecord {
  readonly id: string;
  readonly principalId: string;
  readonly keyHash: string;
  readonly keyHint: string;
  readonly status: CredentialStatus;
  readonly createdAt: Date;
}

/** Session lookup result joined with its principal (single round trip). */
export interface SessionWithPrincipal {
  readonly session: SessionRecord;
  readonly principal: PrincipalRecord;
}

export interface ApiKeyWithPrincipal {
  readonly apiKey: ApiKeyRecord;
  readonly principal: PrincipalRecord;
}

export interface NewPrincipal {
  readonly email: string;
  readonly kind: PrincipalKind;
  readonly displayName: string;
  readonly passwordHash: string | null;
}

export interface NewSession {
  readonly principalId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
}

export interface NewApiKey {
  readonly principalId: string;
  readonly keyHash: string;
  readonly keyHint: string;
}

export interface AuthStore {
  createUser(principal: NewPrincipal): Promise<PrincipalRecord>;
  findUserByEmail(email: string): Promise<PrincipalRecord | null>;
  findUserById(id: string): Promise<PrincipalRecord | null>;
  insertSession(session: NewSession): Promise<SessionRecord>;
  findActiveSessionByTokenHash(tokenHash: string, now: Date): Promise<SessionWithPrincipal | null>;
  revokeSession(sessionId: string): Promise<boolean>;
  touchSessionLastUsed(sessionId: string, at: Date): Promise<void>;
  insertApiKey(apiKey: NewApiKey): Promise<ApiKeyRecord>;
  findActiveApiKeyByHash(keyHash: string): Promise<ApiKeyWithPrincipal | null>;
  revokeApiKeysForPrincipal(principalId: string): Promise<number>;
}
