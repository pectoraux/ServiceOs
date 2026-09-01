/**
 * ServiceOS base API/server composition (WORK-001) with the customer route
 * guard machinery (WORK-002).
 *
 * The platform owns HTTP transport mechanics only — routing, path parameters,
 * request bodies, error serialization — and contains no business logic and no
 * framework lock-in (Node built-ins only). The full control-plane API surface
 * is owned by WORK-012; WORK-002 adds the minimum mechanics needed to mount
 * guarded customer routes:
 *
 * - `defineRoute` builds route descriptors. Non-public routes (access
 *   `principal` | `organization` | `tenant`) REQUIRE a guard function at both
 *   compile time (overloaded signature) and composition time (fail-closed
 *   validation with stable error codes). This is the structural "customer
 *   route guards" surface: an unguarded customer route cannot be composed.
 * - Guards resolve the request context server-side (authentication +
 *   authorization chain) and run BEFORE handlers, so a rejected request never
 *   reaches domain data (architecture.md §19, architecture-lock.md #15/#16).
 * - `RouteHttpError` lets modules surface typed, safe error envelopes; other
 *   failures map to 500 without leaking stack traces in production.
 *
 * Route handlers return JSON only. The server never auto-initializes durable
 * state; readiness stays truthful and fail-closed.
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
  /**
   * Customer-route descriptors contributed by business modules through their
   * public interfaces (WORK-002). Each non-public descriptor must carry a
   * guard; composition fails closed otherwise.
   */
  customerRoutes?: readonly RouteDescriptor[];
}

export interface RouteInfo {
  method: string;
  path: string;
  access: RouteAccess;
  guarded: boolean;
}

export interface ServerHandle {
  /** Start listening on the configured port. Port 0 picks an ephemeral port. */
  start(): Promise<{ port: number }>;
  stop(): Promise<void>;
  /** Machine-readable route inventory (used by structural proof tests). */
  describeRoutes(): RouteInfo[];
}

// ---------------------------------------------------------------------------
// Route descriptor contract (customer route guards, WORK-002)
// ---------------------------------------------------------------------------

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/**
 * Route access levels. `public` skips the guard entirely. Every other level is
 * a customer/identity route and MUST carry a guard that resolves the request
 * context server-side before the handler runs.
 */
export type RouteAccess = 'public' | 'principal' | 'organization' | 'tenant';

const HTTP_METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'];
const ROUTE_ACCESS_LEVELS: readonly RouteAccess[] = ['public', 'principal', 'organization', 'tenant'];

/** Typed, intentional route error. Serialized as `{error:{code,message}}`. */
export class RouteHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'RouteHttpError';
  }
}

/** Composition-time failure (programming error). Fails closed with stable codes. */
export class HttpCompositionError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'HttpCompositionError';
  }
}

/**
 * The request surface visible to route guards and handlers. Modules never
 * touch `node:http` types: headers are lower-cased single values, path
 * parameters are extracted by the router, and the body is lazily read with a
 * size cap and strict JSON parsing.
 */
export interface RouteRequest {
  readonly method: string;
  readonly path: string;
  /** Path parameters captured from `:param` route segments. */
  readonly params: Readonly<Record<string, string>>;
  /** Lower-cased header map (duplicates joined with ", "). */
  readonly headers: Readonly<Record<string, string>>;
  /** Read and parse the request body (JSON, capped). Null when empty. */
  readBody(): Promise<unknown>;
}

export interface RouteResponse {
  readonly status: number;
  readonly body?: unknown;
}

export type RouteGuard<C> = (req: RouteRequest) => Promise<C>;
export type RouteHandler<C> = (req: RouteRequest, ctx: C) => Promise<RouteResponse>;

/** Validated, context-erased route descriptor consumed by the composition. */
export interface RouteDescriptor {
  readonly access: RouteAccess;
  readonly method: HttpMethod;
  readonly path: string;
  readonly guard: RouteGuard<unknown> | null;
  readonly handler: RouteHandler<unknown>;
}

export interface PublicRouteSpec {
  readonly access: 'public';
  readonly method: HttpMethod;
  readonly path: string;
  readonly handler: (req: RouteRequest) => Promise<RouteResponse>;
}

export interface GuardedRouteSpec<C> {
  readonly access: Exclude<RouteAccess, 'public'>;
  readonly method: HttpMethod;
  readonly path: string;
  readonly guard: RouteGuard<C>;
  readonly handler: RouteHandler<C>;
}

/** Loose runtime shape used by fail-closed descriptor validation. */
interface LooseRouteSpec {
  readonly access?: unknown;
  readonly method?: unknown;
  readonly path?: unknown;
  readonly guard?: unknown;
  readonly handler?: unknown;
}

/** Implementation parameter: structural supertype of every overload input. */
type AnyRouteSpec =
  | PublicRouteSpec
  | {
      readonly access: Exclude<RouteAccess, 'public'>;
      readonly method: HttpMethod;
      readonly path: string;
      readonly guard: unknown;
      readonly handler: unknown;
    };

export function defineRoute(spec: PublicRouteSpec): RouteDescriptor;
export function defineRoute<C>(spec: GuardedRouteSpec<C>): RouteDescriptor;
export function defineRoute(spec: AnyRouteSpec): RouteDescriptor {
  validateRouteSpec(spec as LooseRouteSpec);
  if (spec.access === 'public') {
    const publicSpec = spec as PublicRouteSpec;
    const handler = publicSpec.handler as unknown as RouteHandler<unknown>;
    return Object.freeze({
      access: 'public' as const,
      method: publicSpec.method,
      path: publicSpec.path,
      guard: null,
      handler,
    });
  }
  const guarded = spec as unknown as GuardedRouteSpec<unknown>;
  return Object.freeze({
    access: spec.access as RouteAccess,
    method: guarded.method,
    path: guarded.path,
    guard: guarded.guard as RouteGuard<unknown>,
    handler: guarded.handler as RouteHandler<unknown>,
  });
}

/** Fail-closed spec validation with stable codes (discrimination-proof). */
function validateRouteSpec(spec: LooseRouteSpec): void {
  if (
    typeof spec.access !== 'string' ||
    !ROUTE_ACCESS_LEVELS.includes(spec.access as RouteAccess)
  ) {
    throw new HttpCompositionError(
      `route access must be one of ${ROUTE_ACCESS_LEVELS.join(', ')}, received ${JSON.stringify(spec.access)}`,
      'invalid-route-access',
    );
  }
  if (typeof spec.method !== 'string' || !HTTP_METHODS.includes(spec.method as HttpMethod)) {
    throw new HttpCompositionError(
      `route method must be one of ${HTTP_METHODS.join(', ')}, received ${JSON.stringify(spec.method)}`,
      'invalid-route-method',
    );
  }
  if (typeof spec.path !== 'string' || !/^\/[A-Za-z0-9:_/-]*$/.test(spec.path) || spec.path.includes(' ')) {
    throw new HttpCompositionError(
      `route path must start with "/" and contain only path-safe characters, received ${JSON.stringify(spec.path)}`,
      'invalid-route-path',
    );
  }
  if (spec.access !== 'public' && typeof spec.guard !== 'function') {
    throw new HttpCompositionError(
      `route ${String(spec.method)} ${String(spec.path)} has access "${String(spec.access)}" but no guard; customer routes must resolve their context server-side through the authorization chain`,
      'unguarded-route',
    );
  }
  if (typeof spec.handler !== 'function') {
    throw new HttpCompositionError(
      `route ${String(spec.method)} ${String(spec.path)} has no handler function`,
      'invalid-route-handler',
    );
  }
}

/** Re-validate an already-built descriptor (defense in depth at composition). */
function assertDescriptorValid(descriptor: RouteDescriptor): void {
  if (
    typeof descriptor.access !== 'string' ||
    !ROUTE_ACCESS_LEVELS.includes(descriptor.access) ||
    typeof descriptor.method !== 'string' ||
    !HTTP_METHODS.includes(descriptor.method) ||
    typeof descriptor.path !== 'string' ||
    typeof descriptor.handler !== 'function'
  ) {
    throw new HttpCompositionError(
      `route descriptor ${descriptor.method} ${descriptor.path} is malformed`,
      'invalid-route',
    );
  }
  if (descriptor.access !== 'public' && typeof descriptor.guard !== 'function') {
    throw new HttpCompositionError(
      `route ${descriptor.method} ${descriptor.path} has access "${descriptor.access}" but no guard; customer routes must resolve their context server-side through the authorization chain`,
      'unguarded-route',
    );
  }
}

// ---------------------------------------------------------------------------
// Router (exact platform routes + parameterized customer routes)
// ---------------------------------------------------------------------------

type PlatformHandler = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> | void;

interface RouteTable {
  /** `${method} ${path}` -> platform handler (exact paths). */
  platformRoutes: Map<string, PlatformHandler>;
  /** path -> allowed methods (for 405 responses). */
  paths: Map<string, string[]>;
  /** Compiled customer routes with `:param` segment support. */
  customerRoutes: CompiledRoute[];
}

interface CompiledRoute {
  descriptor: RouteDescriptor;
  segments: string[];
}

function compilePath(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '');
}

/** Path skeleton with parameters erased — used for duplicate detection. */
function routeSkeleton(method: string, segments: string[]): string {
  return `${method} /${segments.map((segment) => (segment.startsWith(':') ? ':param' : segment)).join('/')}`;
}

function matchSegments(routeSegments: string[], pathSegments: string[]): Record<string, string> | null {
  if (routeSegments.length !== pathSegments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < routeSegments.length; i += 1) {
    const expected = routeSegments[i] as string;
    const actual = pathSegments[i] as string;
    if (expected.startsWith(':')) {
      if (actual === '') return null;
      params[expected.slice(1)] = decodeURIComponent(actual);
    } else if (expected !== actual) {
      return null;
    }
  }
  return params;
}

function buildRoutes(options: ServerOptions): RouteTable {
  const platformRoutes = new Map<string, PlatformHandler>();
  const paths = new Map<string, string[]>();
  const customerRoutes: CompiledRoute[] = [];

  function register(method: string, path: string, handler: PlatformHandler): void {
    platformRoutes.set(`${method} ${path}`, handler);
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

  // Customer routes: validated again at composition (defense in depth — the
  // descriptor factory already validated once). Duplicates fail closed.
  const skeletons = new Set<string>();
  for (const descriptor of options.customerRoutes ?? []) {
    assertDescriptorValid(descriptor);
    const segments = compilePath(descriptor.path);
    const skeleton = routeSkeleton(descriptor.method, segments);
    if (skeletons.has(skeleton)) {
      throw new HttpCompositionError(`duplicate route registration for ${skeleton}`, 'duplicate-route');
    }
    skeletons.add(skeleton);
    customerRoutes.push({ descriptor, segments });
    const flatPath = `/${segments.join('/')}`;
    paths.set(flatPath, [...(paths.get(flatPath) ?? []), descriptor.method]);
  }

  return { platformRoutes, paths, customerRoutes };
}

// ---------------------------------------------------------------------------
// Request body reading (strict, capped, lazy)
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 262144;

function createBodyReader(req: http.IncomingMessage): () => Promise<unknown> {
  let cached: Promise<unknown> | null = null;
  return () => {
    if (cached === null) {
      cached = readBody(req);
    }
    return cached;
  };
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const declared = Number.parseInt(String(req.headers['content-length'] ?? ''), 10);
  if (Number.isInteger(declared) && declared > MAX_BODY_BYTES) {
    throw new RouteHttpError(413, 'BODY_TOO_LARGE', `request body exceeds ${MAX_BODY_BYTES} bytes`);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      throw new RouteHttpError(413, 'BODY_TOO_LARGE', `request body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new RouteHttpError(400, 'INVALID_BODY', 'request body is not valid JSON');
  }
}

/**
 * Read the request body and require a JSON object shape. Field-level domain
 * validation stays in the owning module; this is transport mechanics only.
 */
export async function readJsonObject(req: RouteRequest): Promise<Record<string, unknown>> {
  const body = await req.readBody();
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new RouteHttpError(400, 'INVALID_BODY', 'request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Server composition
// ---------------------------------------------------------------------------

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

function requestHeaders(req: http.IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return headers;
}

/** Result of attempting one compiled route against an incoming request. */
type RouteMatchResult = 'none' | 'wrong-method' | 'handled';

async function runCustomerRoute(
  compiled: CompiledRoute,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  path: string,
): Promise<RouteMatchResult> {
  const pathSegments = compilePath(path);
  const params = matchSegments(compiled.segments, pathSegments);
  if (params === null) return 'none';
  if (compiled.descriptor.method !== (req.method ?? 'GET')) return 'wrong-method';
  const routeRequest: RouteRequest = {
    method: req.method ?? 'GET',
    path,
    params,
    headers: requestHeaders(req),
    readBody: createBodyReader(req),
  };
  let context: unknown = undefined;
  if (compiled.descriptor.access !== 'public') {
    if (compiled.descriptor.guard === null) {
      // Unreachable after validation; kept as a fail-closed backstop.
      throw new HttpCompositionError(
        `route ${compiled.descriptor.method} ${compiled.descriptor.path} lost its guard`,
        'unguarded-route',
      );
    }
    context = await compiled.descriptor.guard(routeRequest);
  }
  const response = await compiled.descriptor.handler(routeRequest, context);
  if (!res.writableEnded) {
    sendJson(res, response.status, response.body);
  }
  return 'handled';
}

export function composeServer(options: ServerOptions): ServerHandle {
  const { platformRoutes, paths, customerRoutes } = buildRoutes(options);
  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const method = req.method ?? 'GET';
    const path = requestPath(req);

    try {
      const platformHandler = platformRoutes.get(`${method} ${path}`);
      if (platformHandler) {
        await platformHandler(req, res);
      } else {
        let handled = false;
        const allowedForPath: string[] = [];
        for (const compiled of customerRoutes) {
          try {
            const result = await runCustomerRoute(compiled, req, res, path);
            if (result === 'handled') {
              handled = true;
              break;
            }
            if (result === 'wrong-method') {
              allowedForPath.push(compiled.descriptor.method);
            }
          } catch (error) {
            if (error instanceof RouteHttpError) {
              sendJson(res, error.status, { error: { code: error.code, message: error.message } });
              handled = true;
              break;
            }
            throw error;
          }
        }
        if (!handled && !res.writableEnded) {
          if (allowedForPath.length > 0 || paths.has(path)) {
            const allowed = paths.get(path) ?? [...new Set(allowedForPath)];
            sendJson(res, 405, {
              error: { code: 'METHOD_NOT_ALLOWED', allowed },
            });
          } else {
            sendJson(res, 404, { error: { code: 'NOT_FOUND', path } });
          }
        }
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
    describeRoutes: (): RouteInfo[] => [
      ...[...platformRoutes.keys()].map((key): RouteInfo => {
        const [method, path] = key.split(' ');
        return { method: method as string, path: path as string, access: 'public', guarded: false };
      }),
      ...customerRoutes.map((compiled): RouteInfo => ({
        method: compiled.descriptor.method,
        path: compiled.descriptor.path,
        access: compiled.descriptor.access,
        guarded: compiled.descriptor.access === 'public' || compiled.descriptor.guard !== null,
      })),
    ],
  };
}
