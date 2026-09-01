/**
 * ServiceOS /auth SQL store (WORK-002, module internal).
 *
 * Authoritative persistence for the identity substrate, executed exclusively
 * through the platform persistence boundary's `SqlExecutor` (parameterized
 * queries only; this file never imports `pg`). PostgreSQL unique violations
 * are mapped to typed `StoreConflictError`s carrying the schema constraint
 * name, so module-level retry/convergence logic works identically against a
 * live database and a faithful test double.
 */
import type { SqlExecutor } from '../../platform/persistence/index.js';
import {
  StoreConflictError,
  type ApiKeyRecord,
  type ApiKeyWithPrincipal,
  type AuthStore,
  type NewApiKey,
  type NewPrincipal,
  type NewSession,
  type PrincipalRecord,
  type SessionRecord,
  type SessionWithPrincipal,
} from './store.js';

interface UserRow {
  id: string;
  email: string;
  kind: string;
  display_name: string;
  password_hash: string | null;
  status: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface SessionRow {
  id: string;
  principal_id: string;
  token_hash: string;
  status: string;
  expires_at: Date | string;
  last_used_at: Date | string | null;
  created_at: Date | string;
}

interface ApiKeyRow {
  id: string;
  principal_id: string;
  key_hash: string;
  key_hint: string;
  status: string;
  created_at: Date | string;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function mapUser(row: UserRow): PrincipalRecord {
  return {
    id: row.id,
    email: row.email,
    kind: row.kind === 'machine' ? 'machine' : 'human',
    displayName: row.display_name,
    passwordHash: row.password_hash,
    status: row.status === 'disabled' ? 'disabled' : 'active',
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function mapSession(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    principalId: row.principal_id,
    tokenHash: row.token_hash,
    status: row.status === 'revoked' ? 'revoked' : 'active',
    expiresAt: toDate(row.expires_at),
    lastUsedAt: row.last_used_at === null ? null : toDate(row.last_used_at),
    createdAt: toDate(row.created_at),
  };
}

function mapApiKey(row: ApiKeyRow): ApiKeyRecord {
  return {
    id: row.id,
    principalId: row.principal_id,
    keyHash: row.key_hash,
    keyHint: row.key_hint,
    status: row.status === 'revoked' ? 'revoked' : 'active',
    createdAt: toDate(row.created_at),
  };
}

/**
 * Map PostgreSQL constraint violations to typed store errors. Unknown errors
 * propagate unchanged (fail closed, never fabricated).
 */
function mapStoreError(error: unknown, context: string): unknown {
  if (error instanceof StoreConflictError) return error;
  const candidate = error as { code?: string; constraint?: string };
  if (typeof candidate?.code === 'string' && candidate.code === '23505') {
    return new StoreConflictError(`${context} violated a uniqueness constraint`, candidate.constraint ?? 'unknown');
  }
  return error;
}

async function insertReturning(
  executor: SqlExecutor,
  sql: string,
  params: unknown[],
  context: string,
): Promise<Record<string, unknown>[]> {
  try {
    const result = await executor.query(sql, params);
    return result.rows;
  } catch (error) {
    throw mapStoreError(error, context);
  }
}

export function createSqlAuthStore(executor: SqlExecutor): AuthStore {
  return {
    async createUser(principal: NewPrincipal): Promise<PrincipalRecord> {
      const rows = await insertReturning(
        executor,
        `INSERT INTO auth_users (email, kind, display_name, password_hash, status)
         VALUES ($1, $2, $3, $4, 'active')
         RETURNING id, email, kind, display_name, password_hash, status, created_at, updated_at`,
        [principal.email, principal.kind, principal.displayName, principal.passwordHash],
        'createUser',
      );
      return mapUser(rows[0] as unknown as UserRow);
    },

    async findUserByEmail(email: string): Promise<PrincipalRecord | null> {
      const result = await executor.query(
        `SELECT id, email, kind, display_name, password_hash, status, created_at, updated_at
         FROM auth_users WHERE email = $1`,
        [email],
      );
      const row = result.rows[0] as unknown as UserRow | undefined;
      return row === undefined ? null : mapUser(row);
    },

    async findUserById(id: string): Promise<PrincipalRecord | null> {
      const result = await executor.query(
        `SELECT id, email, kind, display_name, password_hash, status, created_at, updated_at
         FROM auth_users WHERE id = $1`,
        [id],
      );
      const row = result.rows[0] as unknown as UserRow | undefined;
      return row === undefined ? null : mapUser(row);
    },

    async insertSession(session: NewSession): Promise<SessionRecord> {
      const rows = await insertReturning(
        executor,
        `INSERT INTO auth_sessions (principal_id, token_hash, status, expires_at)
         VALUES ($1, $2, 'active', $3)
         RETURNING id, principal_id, token_hash, status, expires_at, last_used_at, created_at`,
        [session.principalId, session.tokenHash, session.expiresAt],
        'insertSession',
      );
      return mapSession(rows[0] as unknown as SessionRow);
    },

    async findActiveSessionByTokenHash(tokenHash: string, now: Date): Promise<SessionWithPrincipal | null> {
      const result = await executor.query(
        `SELECT s.id AS session_id, s.principal_id AS session_principal_id, s.token_hash,
                s.status AS session_status, s.expires_at, s.last_used_at, s.created_at AS session_created_at,
                u.id, u.email, u.kind, u.display_name, u.password_hash, u.status, u.created_at, u.updated_at
         FROM auth_sessions s
         JOIN auth_users u ON u.id = s.principal_id
         WHERE s.token_hash = $1 AND s.status = 'active' AND s.expires_at > $2 AND u.status = 'active'`,
        [tokenHash, now],
      );
      const row = result.rows[0] as
        | (Record<string, unknown> & {
            session_id: string;
            session_principal_id: string;
            token_hash: string;
            session_status: string;
            expires_at: Date | string;
            last_used_at: Date | string | null;
            session_created_at: Date | string;
          })
        | undefined;
      if (row === undefined) return null;
      return {
        session: mapSession({
          id: row.session_id,
          principal_id: row.session_principal_id,
          token_hash: row.token_hash,
          status: row.session_status,
          expires_at: row.expires_at,
          last_used_at: row.last_used_at,
          created_at: row.session_created_at,
        }),
        principal: mapUser({
          id: row.id as string,
          email: row.email as string,
          kind: row.kind as string,
          display_name: row.display_name as string,
          password_hash: (row.password_hash as string | null) ?? null,
          status: row.status as string,
          created_at: row.created_at as Date | string,
          updated_at: row.updated_at as Date | string,
        }),
      };
    },

    async revokeSession(sessionId: string): Promise<boolean> {
      const result = await executor.query(
        `UPDATE auth_sessions SET status = 'revoked', updated_at = now() WHERE id = $1 AND status = 'active'`,
        [sessionId],
      );
      return (result.rowCount ?? 0) > 0;
    },

    async touchSessionLastUsed(sessionId: string, at: Date): Promise<void> {
      await executor.query(`UPDATE auth_sessions SET last_used_at = $2 WHERE id = $1`, [sessionId, at]);
    },

    async insertApiKey(apiKey: NewApiKey): Promise<ApiKeyRecord> {
      const rows = await insertReturning(
        executor,
        `INSERT INTO auth_api_keys (principal_id, key_hash, key_hint, status)
         VALUES ($1, $2, $3, 'active')
         RETURNING id, principal_id, key_hash, key_hint, status, created_at`,
        [apiKey.principalId, apiKey.keyHash, apiKey.keyHint],
        'insertApiKey',
      );
      return mapApiKey(rows[0] as unknown as ApiKeyRow);
    },

    async findActiveApiKeyByHash(keyHash: string): Promise<ApiKeyWithPrincipal | null> {
      const result = await executor.query(
        `SELECT k.id AS key_id, k.principal_id AS key_principal_id, k.key_hash, k.key_hint,
                k.status AS key_status, k.created_at AS key_created_at,
                u.id, u.email, u.kind, u.display_name, u.password_hash, u.status, u.created_at, u.updated_at
         FROM auth_api_keys k
         JOIN auth_users u ON u.id = k.principal_id
         WHERE k.key_hash = $1 AND k.status = 'active' AND u.status = 'active'`,
        [keyHash],
      );
      const row = result.rows[0] as
        | (Record<string, unknown> & {
            key_id: string;
            key_principal_id: string;
            key_hash: string;
            key_hint: string;
            key_status: string;
            key_created_at: Date | string;
          })
        | undefined;
      if (row === undefined) return null;
      return {
        apiKey: mapApiKey({
          id: row.key_id,
          principal_id: row.key_principal_id,
          key_hash: row.key_hash,
          key_hint: row.key_hint,
          status: row.key_status,
          created_at: row.key_created_at,
        }),
        principal: mapUser({
          id: row.id as string,
          email: row.email as string,
          kind: row.kind as string,
          display_name: row.display_name as string,
          password_hash: (row.password_hash as string | null) ?? null,
          status: row.status as string,
          created_at: row.created_at as Date | string,
          updated_at: row.updated_at as Date | string,
        }),
      };
    },

    async revokeApiKeysForPrincipal(principalId: string): Promise<number> {
      const result = await executor.query(
        `UPDATE auth_api_keys SET status = 'revoked', updated_at = now()
         WHERE principal_id = $1 AND status = 'active'`,
        [principalId],
      );
      return result.rowCount ?? 0;
    },
  };
}
