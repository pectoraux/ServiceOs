/**
 * Behavioral proof: ServiceOS identity lifecycle (WORK-002, /auth).
 *
 * AC-1 — humans authenticate through the selected ServiceOS identity
 * mechanism (email + scrypt password -> opaque hashed session token), and
 * machine principals authenticate through hashed API keys. Fail-closed
 * semantics: unknown/expired/revoked credentials are indistinguishable
 * uniform 401-class rejections; nothing fabricates a principal.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AuthError, SESSION_TTL_SECONDS, type Principal } from '../src/modules/auth/index.js';
import { buildIdentityApp } from './helpers/in-memory-stores.js';

const PASSWORD = 'correct horse battery 7';

async function registerAndLogin(
  app: ReturnType<typeof buildIdentityApp>,
  email = 'alice@example.com',
): Promise<{ principal: Principal; token: string }> {
  const principal = await app.auth.registerHuman({
    email,
    password: PASSWORD,
    displayName: 'Alice Example',
  });
  const issuance = await app.auth.login({ email, password: PASSWORD });
  return { principal, token: issuance.token };
}

test('register + login + authenticate resolves the principal (AC-1 happy path)', async () => {
  const app = buildIdentityApp();
  const { principal, token } = await registerAndLogin(app);
  assert.match(token, /^sos_[A-Za-z0-9_-]{43}$/);
  const resolved = await app.auth.authenticate(`Bearer ${token}`);
  assert.equal(resolved.id, principal.id);
  assert.equal(resolved.email, 'alice@example.com');
  assert.equal(resolved.kind, 'human');
  assert.equal(resolved.status, 'active');
});

test('emails are normalized to lowercase on register and login', async () => {
  const app = buildIdentityApp();
  const principal = await app.auth.registerHuman({
    email: '  MixedCase@Example.COM ',
    password: PASSWORD,
    displayName: 'Mixed',
  });
  assert.equal(principal.email, 'mixedcase@example.com');
  const issuance = await app.auth.login({ email: 'MIXEDCASE@example.com', password: PASSWORD });
  assert.equal(issuance.principal.id, principal.id);
});

test('registration stores scrypt records, never plaintext passwords', async () => {
  const app = buildIdentityApp();
  const { principal } = await registerAndLogin(app);
  const record = app.authStore.users.get(principal.id);
  assert.ok(record);
  assert.match(record.passwordHash ?? '', /^scrypt\$16384\$8\$1\$/);
  assert.ok(!JSON.stringify(record).includes(PASSWORD));
});

test('registering the same email twice fails closed with EMAIL_TAKEN', async () => {
  const app = buildIdentityApp();
  await registerAndLogin(app);
  await assert.rejects(
    () => app.auth.registerHuman({ email: 'alice@example.com', password: PASSWORD, displayName: 'Duplicate' }),
    (error: unknown) => {
      assert.ok(error instanceof AuthError);
      assert.equal((error as AuthError).code, 'EMAIL_TAKEN');
      return true;
    },
  );
  assert.equal(app.authStore.users.size, 1);
});

test('weak passwords are rejected deterministically', async () => {
  const app = buildIdentityApp();
  for (const weak of ['short1', 'nodigitsatallxx', '1234567890123']) {
    await assert.rejects(
      () => app.auth.registerHuman({ email: 'u@example.com', password: weak, displayName: 'U' }),
      (error: unknown) => {
        assert.ok(error instanceof AuthError);
        assert.equal((error as AuthError).code, 'WEAK_PASSWORD');
        return true;
      },
    );
  }
  assert.equal(app.authStore.users.size, 0);
});

test('malformed emails are rejected', async () => {
  const app = buildIdentityApp();
  await assert.rejects(
    () => app.auth.registerHuman({ email: 'not-an-email', password: PASSWORD, displayName: 'U' }),
    (error: unknown) => {
      assert.ok(error instanceof AuthError);
      assert.equal((error as AuthError).code, 'INVALID_INPUT');
      return true;
    },
  );
});

test('login failures are uniform for unknown email, wrong password and machine principals', async () => {
  const app = buildIdentityApp();
  await registerAndLogin(app);
  const machine = await app.auth.createMachinePrincipal({ displayName: 'svc' });
  for (const bad of [
    { email: 'ghost@example.com', password: PASSWORD },
    { email: 'alice@example.com', password: 'wrong password 9' },
    { email: machine.email, password: PASSWORD },
  ]) {
    await assert.rejects(
      () => app.auth.login(bad),
      (error: unknown) => {
        assert.ok(error instanceof AuthError);
        assert.equal((error as AuthError).code, 'INVALID_CREDENTIALS');
        return true;
      },
    );
  }
});

test('logout revokes the session and the token stops authenticating', async () => {
  const app = buildIdentityApp();
  const { token } = await registerAndLogin(app);
  const before = await app.auth.authenticate(`Bearer ${token}`);
  assert.ok(before);
  const session = [...app.authStore.sessions.values()].find(
    (candidate) => candidate.tokenHash === digestOf(token),
  );
  assert.ok(session, 'session must exist for the issued token');
  const { revoked } = await app.auth.logout(session.id);
  assert.equal(revoked, true);
  await assert.rejects(
    () => app.auth.authenticate(`Bearer ${token}`),
    (error: unknown) => {
      assert.ok(error instanceof AuthError);
      assert.equal((error as AuthError).code, 'UNAUTHENTICATED');
      return true;
    },
  );
});

test('expired sessions fail closed (fail-closed discrimination on expiry)', async () => {
  let clock = new Date('2026-01-01T00:00:00Z').getTime();
  const app = buildIdentityApp({ now: () => new Date(clock) });
  const { token } = await registerAndLogin(app);
  // Still valid just before expiry.
  clock += (SESSION_TTL_SECONDS - 60) * 1000;
  const still = await app.auth.authenticate(`Bearer ${token}`);
  assert.ok(still);
  // Expired one second after.
  clock += 61 * 1000;
  await assert.rejects(
    () => app.auth.authenticate(`Bearer ${token}`),
    (error: unknown) => {
      assert.ok(error instanceof AuthError);
      assert.equal((error as AuthError).code, 'UNAUTHENTICATED');
      return true;
    },
  );
});

test('authenticate rejects missing, malformed and unknown credentials uniformly', async () => {
  const app = buildIdentityApp();
  for (const bad of [undefined, 'Basic abc', 'Bearer ', 'Bearer garbage-token', `Bearer sos_${'x'.repeat(43)}`]) {
    await assert.rejects(
      () => app.auth.authenticate(bad as string | undefined),
      (error: unknown) => {
        assert.ok(error instanceof AuthError);
        assert.equal((error as AuthError).code, 'UNAUTHENTICATED');
        return true;
      },
    );
  }
});

test('machine principals issue hashed API keys that authenticate exactly like humans', async () => {
  const app = buildIdentityApp();
  const machine = await app.auth.createMachinePrincipal({ displayName: 'sync-worker' });
  assert.equal(machine.kind, 'machine');
  assert.equal(machine.email.includes('@machine.serviceos.invalid'), true);
  const issuance = await app.auth.issueApiKey(machine.id);
  assert.match(issuance.secret, /^soak_/);
  // Only the digest is persisted.
  const keyRecord = app.authStore.apiKeys.get(issuance.keyId);
  assert.ok(keyRecord);
  assert.ok(!keyRecord.keyHash.includes(issuance.secret));
  const resolved = await app.auth.authenticate(`Bearer ${issuance.secret}`);
  assert.equal(resolved.id, machine.id);
  assert.equal(resolved.kind, 'machine');
});

test('revoking an API key fails the credential closed', async () => {
  const app = buildIdentityApp();
  const machine = await app.auth.createMachinePrincipal({ displayName: 'svc' });
  const issuance = await app.auth.issueApiKey(machine.id);
  const { revoked } = await app.auth.revokeApiKeysForPrincipal(machine.id);
  assert.equal(revoked, 1);
  await assert.rejects(
    () => app.auth.authenticate(`Bearer ${issuance.secret}`),
    (error: unknown) => {
      assert.ok(error instanceof AuthError);
      assert.equal((error as AuthError).code, 'UNAUTHENTICATED');
      return true;
    },
  );
});

test('parallel logins create independent valid sessions (concurrency)', async () => {
  const app = buildIdentityApp();
  await registerAndLogin(app);
  const issuances = await Promise.all([
    app.auth.login({ email: 'alice@example.com', password: PASSWORD }),
    app.auth.login({ email: 'alice@example.com', password: PASSWORD }),
    app.auth.login({ email: 'alice@example.com', password: PASSWORD }),
  ]);
  const tokens = new Set(issuances.map((issuance) => issuance.token));
  assert.equal(tokens.size, 3);
  for (const token of tokens) {
    const resolved = await app.auth.authenticate(`Bearer ${token}`);
    assert.equal(resolved.email, 'alice@example.com');
  }
});

function digestOf(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
