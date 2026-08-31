/**
 * Behavioral proof: configuration validation (WORK-001 verification
 * requirement "configuration validation").
 *
 * Proves loadConfig is fail-closed: valid environments produce config; every
 * invalid input class produces a typed ConfigError that names the field; all
 * problems are aggregated; unknown SERVICEOS_* variables are rejected.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, validatePostgresUrl, ConfigError } from '../src/platform/config/index.js';

test('valid environment produces configuration', () => {
  const config = loadConfig({
    SERVICEOS_PORT: '9090',
    SERVICEOS_DATABASE_URL: 'postgresql://serviceos:secret@db.example.com:5432/serviceos',
    SERVICEOS_LOG_LEVEL: 'debug',
    SERVICEOS_NODE_ENV: 'production',
  });
  assert.equal(config.port, 9090);
  assert.equal(config.databaseUrl, 'postgresql://serviceos:secret@db.example.com:5432/serviceos');
  assert.equal(config.logLevel, 'debug');
  assert.equal(config.nodeEnv, 'production');
});

test('unprefixed variables are accepted as fallbacks', () => {
  const config = loadConfig({
    PORT: '3000',
    DATABASE_URL: 'postgres://localhost/serviceos',
    NODE_ENV: 'test',
  });
  assert.equal(config.port, 3000);
  assert.equal(config.databaseUrl, 'postgres://localhost/serviceos');
  assert.equal(config.nodeEnv, 'test');
});

test('SERVICEOS_ prefixed variables take precedence over unprefixed', () => {
  const config = loadConfig({
    SERVICEOS_PORT: '9091',
    PORT: '3000',
    SERVICEOS_LOG_LEVEL: 'warn',
    LOG_LEVEL: 'debug',
  });
  assert.equal(config.port, 9091);
  assert.equal(config.logLevel, 'warn');
});

test('defaults apply when optional variables are absent', () => {
  const config = loadConfig({});
  assert.equal(config.port, 8080);
  assert.equal(config.databaseUrl, null);
  assert.equal(config.logLevel, 'info');
  assert.equal(config.nodeEnv, 'development');
});

test('server profile requires a database URL (fail closed)', () => {
  assert.throws(
    () => loadConfig({}, { requireDatabase: true }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.ok(error.problems.some((p) => p.includes('SERVICEOS_DATABASE_URL') && p.includes('required')));
      return true;
    },
  );
});

test('empty string values are treated as absent, not as values', () => {
  const config = loadConfig({ SERVICEOS_DATABASE_URL: '', PORT: '' });
  assert.equal(config.databaseUrl, null);
  assert.equal(config.port, 8080);
});

for (const badPort of ['abc', '-1', '65536', '80.5', ' 999999 ']) {
  test(`invalid PORT rejected: ${JSON.stringify(badPort)}`, () => {
    assert.throws(
      () => loadConfig({ PORT: badPort }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.ok(error.problems.some((p) => p.startsWith('PORT must be an integer')));
        return true;
      },
    );
  });
}

test('PORT 0 is valid and requests an ephemeral listen port', () => {
  const config = loadConfig({ SERVICEOS_PORT: '0' });
  assert.equal(config.port, 0);
});

test('port 8080 style whitespace-padded integers are trimmed', () => {
  const config = loadConfig({ PORT: ' 9092 ' });
  assert.equal(config.port, 9092);
});

for (const badUrl of [
  'mysql://localhost/serviceos',
  'file:/home/z/my-project/db/custom.db',
  'postgres://',
  'postgresql://',
  'not a url at all',
]) {
  test(`non-postgres DATABASE_URL rejected: ${JSON.stringify(badUrl.slice(0, 24))}`, () => {
    assert.throws(
      () => loadConfig({ SERVICEOS_DATABASE_URL: badUrl }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.ok(error.problems.some((p) => p.includes('SERVICEOS_DATABASE_URL')));
        return true;
      },
    );
  });
}

test('unix-socket postgres DSN is accepted', () => {
  const result = validatePostgresUrl('postgresql:///run/postgresql/serviceos');
  assert.equal(result.ok, true);
});

test('invalid log level rejected', () => {
  assert.throws(
    () => loadConfig({ SERVICEOS_LOG_LEVEL: 'verbose' }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.ok(error.problems.some((p) => p.includes('SERVICEOS_LOG_LEVEL')));
      return true;
    },
  );
});

test('invalid node environment rejected', () => {
  assert.throws(
    () => loadConfig({ SERVICEOS_NODE_ENV: 'staging' }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.ok(error.problems.some((p) => p.includes('SERVICEOS_NODE_ENV')));
      return true;
    },
  );
});

test('unknown SERVICEOS_* variable is rejected as a typo (fail closed)', () => {
  assert.throws(
    () => loadConfig({ SERVICEOS_LOG_LVL: 'info' }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.ok(error.problems.some((p) => p.includes('SERVICEOS_LOG_LVL') && p.includes('unknown environment variable')));
      return true;
    },
  );
});

test('multiple problems are aggregated into one report', () => {
  assert.throws(
    () => loadConfig({ PORT: 'nope', SERVICEOS_LOG_LEVEL: 'loud', SERVICEOS_DATABASE_URL: 'sqlite://x' }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.problems.length, 3);
      return true;
    },
  );
});

test('SERVICEOS_TEST_DATABASE_URL is a recognized (test-only) variable', () => {
  const config = loadConfig({ SERVICEOS_TEST_DATABASE_URL: 'postgres://localhost/test' });
  assert.equal(config.databaseUrl, null);
});
