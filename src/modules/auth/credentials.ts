/**
 * ServiceOS credential primitives (WORK-002, /auth module internal).
 *
 * Deliberately dependency-free (node:crypto only — the platform dependency
 * policy allows no credential libraries):
 *
 * - human passwords use scrypt with per-principal random salt, encoded as
 *   `scrypt$N$r$p$salt$hash` and verified with a constant-time comparison;
 * - session tokens and API keys are opaque 256-bit random secrets with
 *   distinct service prefixes (`sos_` sessions, `soak_` machine API keys);
 *   only their SHA-256 digests are persisted, so a database disclosure does
 *   not disclose usable credentials;
 * - these are ServiceOS business identity credentials. No AI provider or
 *   model credential exists anywhere in this module (architecture-lock #17).
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem?: number },
) => Promise<Buffer>;

const SCRYPT_N = 16384;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const SCRYPT_KEYLEN = 32;
const SCRYPT_SALT_BYTES = 16;

export const SESSION_TOKEN_PREFIX = 'sos_';
export const API_KEY_PREFIX = 'soak_';
const SECRET_RANDOM_BYTES = 32;

/** Password policy for human principals (deterministic, documented). */
export function validatePasswordPolicy(password: string): { ok: true } | { ok: false; problem: string } {
  if (typeof password !== 'string' || password.length < 10) {
    return { ok: false, problem: 'password must be at least 10 characters' };
  }
  if (password.length > 128) {
    return { ok: false, problem: 'password must be at most 128 characters' };
  }
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return { ok: false, problem: 'password must contain at least one letter and one digit' };
  }
  return { ok: true };
}

/** Structural email form check (normalization to lowercase happens in the module). */
export function isValidEmailForm(email: string): boolean {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Hash a password into the portable scrypt record format. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p });
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_r,
    SCRYPT_p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/** Constant-time password verification against a stored scrypt record. */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number.parseInt(parts[1] as string, 10);
  const r = Number.parseInt(parts[2] as string, 10);
  const p = Number.parseInt(parts[3] as string, 10);
  const salt = Buffer.from(parts[4] as string, 'base64');
  const expected = Buffer.from(parts[5] as string, 'base64');
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) || expected.length !== SCRYPT_KEYLEN) {
    return false;
  }
  const derived = await scrypt(password, salt, expected.length, { N, r, p });
  return timingSafeEqual(derived, expected);
}

/** Generate a fresh opaque session secret (shown once, stored hashed). */
export function generateSessionSecret(): string {
  return SESSION_TOKEN_PREFIX + randomBytes(SECRET_RANDOM_BYTES).toString('base64url');
}

/** Generate a fresh opaque machine API key secret (shown once, stored hashed). */
export function generateApiKeySecret(): string {
  return API_KEY_PREFIX + randomBytes(SECRET_RANDOM_BYTES).toString('base64url');
}

/** At-rest digest for tokens/keys. */
export function credentialDigest(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** Stable short hint used to identify an API key without revealing it. */
export function apiKeyHint(secret: string): string {
  return secret.slice(0, 12);
}
