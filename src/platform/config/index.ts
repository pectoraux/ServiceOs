/**
 * ServiceOS configuration authority (WORK-001 foundation).
 *
 * Fail-closed environment handling:
 * - every problem is collected and reported together (no partial config);
 * - required values have no silent defaults;
 * - unknown `SERVICEOS_*` variables are rejected to catch typos;
 * - PostgreSQL DSNs are structurally validated before anything opens a pool.
 */
import type { LogLevel } from '../logging/index.js';

export type NodeEnv = 'development' | 'test' | 'production';

export interface ServiceConfig {
  /** TCP port the composed server listens on. */
  readonly port: number;
  /**
   * PostgreSQL connection string. `null` means persistence is not configured;
   * the persistence boundary then fails closed on first use.
   */
  readonly databaseUrl: string | null;
  readonly logLevel: LogLevel;
  readonly nodeEnv: NodeEnv;
}

/** Typed, aggregating configuration error. Never thrown with an empty problem list. */
export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`invalid ServiceOS configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];
const NODE_ENVS: readonly NodeEnv[] = ['development', 'test', 'production'];

/**
 * Environment variables the platform recognizes with the `SERVICEOS_` prefix.
 * Anything else under that prefix is a configuration typo and fails closed.
 * `SERVICEOS_TEST_DATABASE_URL` is a test-harness-only variable; the runtime
 * never reads it.
 */
const KNOWN_SERVICEOS_VARS: readonly string[] = [
  'SERVICEOS_PORT',
  'SERVICEOS_DATABASE_URL',
  'SERVICEOS_LOG_LEVEL',
  'SERVICEOS_NODE_ENV',
  'SERVICEOS_TEST_DATABASE_URL',
];

export interface LoadConfigOptions {
  /**
   * When true the server profile is loaded and `databaseUrl` must be present
   * (the runtime refuses to start without its authoritative persistence layer).
   * Default false: tooling (checks, tests) may run without a database.
   */
  requireDatabase?: boolean;
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  options: LoadConfigOptions = {},
): ServiceConfig {
  const problems: string[] = [];

  // Unknown SERVICEOS_* variables are typos until proven otherwise.
  for (const key of Object.keys(env)) {
    if (key.startsWith('SERVICEOS_') && !KNOWN_SERVICEOS_VARS.includes(key)) {
      problems.push(`unknown environment variable ${key} (unrecognized SERVICEOS_ setting)`);
    }
  }

  const rawPort = env.SERVICEOS_PORT ?? env.PORT;
  let port = 8080;
  if (rawPort !== undefined && rawPort !== '') {
    const trimmed = rawPort.trim();
    if (!/^-?\d+$/.test(trimmed)) {
      problems.push(`PORT must be an integer between 0 and 65535, received ${JSON.stringify(rawPort)}`);
    } else {
      const parsed = Number.parseInt(trimmed, 10);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
        problems.push(`PORT must be an integer between 0 and 65535, received ${parsed}`);
      } else {
        port = parsed;
      }
    }
  }

  const rawDatabaseUrl = env.SERVICEOS_DATABASE_URL ?? env.DATABASE_URL;
  let databaseUrl: string | null = null;
  if (rawDatabaseUrl !== undefined && rawDatabaseUrl !== '') {
    const validation = validatePostgresUrl(rawDatabaseUrl);
    if (!validation.ok) {
      problems.push(validation.problem);
    } else {
      databaseUrl = rawDatabaseUrl;
    }
  } else if (options.requireDatabase) {
    problems.push('SERVICEOS_DATABASE_URL (or DATABASE_URL) is required for the ServiceOS server');
  }

  const rawLogLevel = env.SERVICEOS_LOG_LEVEL ?? env.LOG_LEVEL;
  let logLevel: LogLevel = 'info';
  if (rawLogLevel !== undefined && rawLogLevel !== '') {
    if (!LOG_LEVELS.includes(rawLogLevel as LogLevel)) {
      problems.push(
        `SERVICEOS_LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, received ${JSON.stringify(rawLogLevel)}`,
      );
    } else {
      logLevel = rawLogLevel as LogLevel;
    }
  }

  const rawNodeEnv = env.SERVICEOS_NODE_ENV ?? env.NODE_ENV;
  let nodeEnv: NodeEnv = 'development';
  if (rawNodeEnv !== undefined && rawNodeEnv !== '') {
    if (!NODE_ENVS.includes(rawNodeEnv as NodeEnv)) {
      problems.push(
        `SERVICEOS_NODE_ENV must be one of ${NODE_ENVS.join(', ')}, received ${JSON.stringify(rawNodeEnv)}`,
      );
    } else {
      nodeEnv = rawNodeEnv as NodeEnv;
    }
  }

  if (problems.length > 0) {
    throw new ConfigError(problems);
  }

  return { port, databaseUrl, logLevel, nodeEnv };
}

/** Structural validation of a PostgreSQL DSN. Does not attempt a connection. */
export function validatePostgresUrl(url: string): { ok: true } | { ok: false; problem: string } {
  if (!/^postgres(?:ql)?:\/\//.test(url)) {
    return {
      ok: false,
      problem: `SERVICEOS_DATABASE_URL must use the postgres:// or postgresql:// scheme, received ${JSON.stringify(url.slice(0, 32))}`,
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (cause) {
    return {
      ok: false,
      problem: `SERVICEOS_DATABASE_URL is not a parseable URL: ${(cause as Error).message}`,
    };
  }
  // Empty host is only acceptable for unix-socket DSNs which carry a path.
  if (parsed.hostname === '' && parsed.pathname === '') {
    return { ok: false, problem: 'SERVICEOS_DATABASE_URL has neither a host nor a unix socket path' };
  }
  return { ok: true };
}
