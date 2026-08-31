/**
 * Base ServiceOS API/server composition (WORK-001).
 *
 * This is the platform's HTTP composition root mechanics — deliberately minimal
 * and dependency-free (Node built-ins only). It composes:
 * - the registered business modules (exposed as metadata, no business routes yet);
 * - the persistence readiness probe (fail-closed: `/readyz` reports 503 unless
 *   the authoritative persistence layer is actually reachable);
 * - a health endpoint that never touches the database.
 *
 * It contains no domain logic and no framework lock-in: the full control-plane
 * API surface is owned by a later Work Order (WORK-012). Route handlers return
 * JSON only; errors never leak stack traces in production.
 */
import * as http from 'node:http';
import type { ServiceConfig } from '../config/index.js';
import type { Logger } from '../logging/index.js';
import type { RegisteredModules } from '../module-registry/index.js';

/** Minimal readiness contract the server needs from the persistence boundary. */
export interface ReadinessProbe {
  isConfigured(): boolean;
  ready(): Promise<{ ok: boolean; detail?: string }>;
}

export interface ServerOptions {
  modules: RegisteredModules;
  readiness: ReadinessProbe;
  config: ServiceConfig;
  logger: Logger;
}

export interface ServerHandle {
  /** Start listening on the configured port. Port 0 picks an ephemeral port. */
  start(): Promise<{ port: number }>;
  stop(): Promise<void>;
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> | void;

interface RouteTable {
  /** `${method} ${path}` -> handler */
  routes: Map<string, Handler>;
  /** path -> allowed methods (for 405 responses) */
  paths: Map<string, string[]>;
}

function buildRoutes(options: ServerOptions): RouteTable {
  const routes = new Map<string, Handler>();
  const paths = new Map<string, string[]>();

  function register(method: string, path: string, handler: Handler): void {
    routes.set(`${method} ${path}`, handler);
    paths.set(path, [...(paths.get(path) ?? []), method]);
  }

  register('GET', '/healthz', (_req, res) => {
    sendJson(res, 200, { status: 'ok', service: 'serviceos', uptimeSeconds: process.uptime() });
  });

  register('GET', '/readyz', async (_req, res) => {
    // Fail closed: any uncertainty (not configured, unreachable, probe error)
    // reports 503 with the truthful reason instead of fabricating readiness.
    if (!options.readiness.isConfigured()) {
      sendJson(res, 503, { status: 'unavailable', reason: 'persistence is not configured' });
      return;
    }
    try {
      const probe = await options.readiness.ready();
      if (probe.ok) {
        sendJson(res, 200, { status: 'ready' });
      } else {
        sendJson(res, 503, { status: 'unavailable', reason: probe.detail ?? 'persistence is not ready' });
      }
    } catch (error) {
      sendJson(res, 503, { status: 'unavailable', reason: (error as Error).message });
    }
  });

  register('GET', '/api/_meta', (_req, res) => {
    sendJson(res, 200, {
      service: 'serviceos',
      architectureVersion: 'v1.0',
      modules: options.modules.modules.map((m) => ({
        name: m.manifest.name,
        version: m.manifest.version,
        description: m.manifest.description,
      })),
    });
  });

  return { routes, paths };
}

function sendJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function requestPath(req: http.IncomingMessage): string {
  const raw = req.url ?? '/';
  try {
    return new URL(raw, 'http://serviceos.invalid').pathname;
  } catch {
    return '/';
  }
}

export function composeServer(options: ServerOptions): ServerHandle {
  const { routes, paths } = buildRoutes(options);
  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const method = req.method ?? 'GET';
    const path = requestPath(req);

    try {
      const handler = routes.get(`${method} ${path}`);
      if (handler) {
        await handler(req, res);
      } else if (paths.has(path)) {
        sendJson(res, 405, {
          error: { code: 'METHOD_NOT_ALLOWED', allowed: paths.get(path) },
        });
      } else {
        sendJson(res, 404, { error: { code: 'NOT_FOUND', path } });
      }
    } catch (error) {
      options.logger.error('request failed', {
        method,
        path,
        error: (error as Error).message,
      });
      if (!res.headersSent) {
        sendJson(res, 500, {
          error: {
            code: 'INTERNAL',
            message: options.config.nodeEnv === 'development' ? (error as Error).message : 'internal error',
          },
        });
      } else {
        res.end();
      }
    } finally {
      options.logger.info('request', {
        method,
        path,
        status: res.statusCode,
        durationMs: Date.now() - started,
      });
    }
  });

  return {
    start: () =>
      new Promise<{ port: number }>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.removeListener('listening', onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.removeListener('error', onError);
          const address = server.address();
          const port = typeof address === 'object' && address !== null ? address.port : options.config.port;
          resolve({ port });
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(options.config.port);
      }),
    stop: () =>
      new Promise<void>((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
