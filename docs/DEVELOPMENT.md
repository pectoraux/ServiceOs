# ServiceOS Development (WORK-001 foundation)

This document defines the canonical development entrypoint and the proof
toolchain for the ServiceOS modular monolith. It is the operational reference
for implementation workers; architecture authority remains in
`spec/architecture/v1.0/` and governance authority in `spec/`.

## Prerequisites

- Node.js ≥ 22
- npm ≥ 10
- Python ≥ 3.10 (for the repository governance checker)
- A PostgreSQL instance (only when actually running the server or migrations —
  not needed for builds, checks, or tests)

## Entrypoint commands

| Command | What it proves |
|---|---|
| `npm install` | install toolchain and runtime dependencies |
| `npm run build` | the repository compiles (`tsc` → `dist/`) |
| `npm run check` | build + configuration validation + architecture structural checks + governance frontier/Work Order validation + `scripts/governance-check.py` |
| `npm test` | build + full test suite: behavioral, structural, and discrimination/mutation proofs (`node --test`) |
| `npm start` | start the composed server (requires `SERVICEOS_DATABASE_URL`; fails closed otherwise) |
| `npm run migrate` | apply pending SQL migrations from `db/migrations/` (explicit operator action) |

`npm run check` is the single documented development entrypoint for AC-1: it
must exit 0 before any PR is considered ready for Architect review.

## Configuration

Environment variables (fail-closed; `SERVICEOS_` prefixed forms take
precedence over the unprefixed fallbacks):

| Variable | Fallback | Default | Validation |
|---|---|---|---|
| `SERVICEOS_PORT` | `PORT` | `8080` | integer 0–65535 (0 = ephemeral) |
| `SERVICEOS_DATABASE_URL` | `DATABASE_URL` | none (server requires it) | `postgres://` / `postgresql://` URL |
| `SERVICEOS_LOG_LEVEL` | `LOG_LEVEL` | `info` | `debug` `info` `warn` `error` |
| `SERVICEOS_NODE_ENV` | `NODE_ENV` | `development` | `development` `test` `production` |

Unknown `SERVICEOS_*` variables are rejected (typo guard). All problems are
reported together in a single `ConfigError`.

`SERVICEOS_TEST_DATABASE_URL` is a test-harness-only variable: when set, the
gated live-database integration tests run against it (disposable database).

## Repository layout

```
src/
├── main.ts                 # composition root: config -> persistence -> modules -> HTTP server
├── cli/
│   ├── check.ts            # `npm run check` entrypoint (AC-4 report lives here)
│   └── migrate.ts          # explicit migration operator action
├── platform/
│   ├── config/             # fail-closed environment handling
│   ├── logging/            # structured JSON logging
│   ├── persistence/        # PostgreSQL boundary: the only place `pg` may be imported
│   │   └── migrations.ts   # advisory-lock-guarded idempotent migration runner
│   ├── governance/         # program-state reader (AC-4) + architecture checks (AC-2/AC-3)
│   ├── module-registry/    # ServiceModule contract and composition validation
│   └── http/               # base server composition: /healthz /readyz /api/_meta
└── modules/                # the 16 architecture.md §6 business modules (public index.ts each)
test/                       # behavioral + structural + discrimination proofs
db/migrations/              # SQL migrations (NNNN_name.sql); empty until WORK-002/003
```

## Architectural rules enforced by tooling

The architecture checks (`src/platform/governance/architecture-checks.ts`,
executed by `npm run check` and asserted by tests) enforce:

1. **Module tree conformance (AC-2)** — `src/modules/` contains exactly the
   modules declared in `spec/architecture/v1.0/architecture.md` §6 (parsed from
   the document itself, so the spec stays the single authority). Missing or
   unknown modules fail the check.
2. **Dependency direction** — modules may import the platform and other
   modules' public interfaces (`index.ts`) only. Cross-module internal imports,
   platform→module imports, and module composition outside `src/main.ts` are
   violations.
3. **No AI authority in ServiceOS (AC-3)** — importing any AI/LLM SDK package
   (openai, anthropic, langchain, …), any Zeck SDK, or creating AI
   infrastructure paths (`ai/`, `llm/`, `agents/`, `prompts/`, …) under `src/`
   is a violation. The Zeck boundary stays thin by construction.
4. **Single persistence authority** — `pg` may only be imported inside
   `src/platform/persistence/`. Raw HTTP serving is confined to
   `src/platform/http/`.
5. **Fail-closed dependency policy** — `package.json` may only depend on the
   platform allowlist (`pg` runtime; `typescript`, `@types/node`, `@types/pg`
   dev). New dependencies are added through the Work Order that owns them, by
   extending the allowlist in a reviewed change.

## Discrimination / mutation proofs

`test/architecture-checks.test.ts` builds deliberately violating source trees
(forbidden AI imports, deep cross-module imports, platform→module imports,
boundary escapes, AI paths, …) in temp directories and asserts each is rejected
with the matching violation code. This proves the structural checks discriminate
real violations instead of passing vacuously — the required
"known forbidden AI import is rejected" proof class.

## Migrations

- Files: `db/migrations/NNNN_name.sql` (e.g. `0002_work_tables.sql`).
- Application: `npm run migrate` (never automatic on server start).
- Semantics: whole batch in one transaction guarded by
  `pg_advisory_xact_lock(740021)`; versions recorded in
  `serviceos_schema_history`; re-runs are no-ops; history tampering (removed or
  gapped applied versions) fails closed.
- WORK-001 shipped no business schema by design. WORK-002 ships
  `0001_identity_tenancy.sql` — principals, credentials, organizations,
  service tenants and memberships with the tenant-integrity constraints
  (unique slugs, unique memberships, FK discipline, closed role/status
  enumerations). Later customer-domain tables MUST follow the tenancy
  discipline: `tenant_id UUID NOT NULL REFERENCES org_service_tenants(id)`
  queried only through a mandatory tenant predicate.
- Transactions issued by business modules run client-pinned through the
  persistence boundary's `TransactionalExecutor` (one acquired PostgreSQL
  client per transaction), so multi-statement tenant-integrity rules are
  atomic under real concurrency.

## Identity and tenancy (WORK-002)

- Identity mechanism: humans register with email + scrypt password and log
  in to receive an opaque bearer session token (SHA-256 digest at rest,
  revocable, 12-hour TTL). Machine service accounts are password-less
  principals with opaque API keys (`soak_…`, digest at rest, revocable).
- One authorization chain: `/auth` verifies credentials
  (`authenticate`); `/organizations` resolves membership server-side and
  applies the single capability matrix (`authorize`, guard factory). No other
  module may export authorization/credential decision entry points — the
  identity-boundary structural checks fail closed on this.
- Customer routes: every non-public route is defined with a guard
  (compile-time requirement, composition-time validation with the
  `unguarded-route` code). Guards authenticate BEFORE resolving targets, so
  unauthenticated callers never learn whether an organization/tenant exists.
  Cross-tenant denials are 403 (`*_FORBIDDEN`), missing resources 404, and
  denial happens before any domain data is read.
- Machine credentials derive capabilities only from the membership chain
  (member/viewer only) — there is no machine-specific grant path (AC-5).

## Server surface (foundation + identity/tenancy)

- `GET /healthz` — liveness; never touches the database.
- `GET /readyz` — truthful readiness: 503 with reason when persistence is
  unconfigured or unreachable (fail closed), 200 only when `SELECT 1` succeeds.
- `GET /api/_meta` — composed module metadata (the 16 architecture modules).
- Identity routes: `POST /api/auth/register`, `POST /api/auth/login`,
  `POST /api/auth/logout`, `GET /api/auth/me`.
- Tenancy routes: organization/tenant/membership/service-account management
  under `/api/organizations/:orgSlug…` and `/api/tenants/:tenantSlug…`, all
  guard-composed (see WORK-002's route inventory).
- 404/405/500 JSON error mapping; no stack traces in production.

The control-plane API surface beyond this is owned by WORK-012.

## Notes and deliberate boundaries

- No ESLint is configured; boundary linting is performed by the architecture
  structural checker (which is stricter and architecture-aware), including the
  WORK-002 identity/tenancy boundary checks (`second-authorization-engine`,
  `second-identity-engine`, `second-route-guard`).
- The HTTP layer uses Node built-ins only (no framework lock-in); WORK-012 may
  introduce a framework through a governed change.
- Live-PostgreSQL integration tests are gated on `SERVICEOS_TEST_DATABASE_URL`
  and execute in CI (the governance workflow provisions a PostgreSQL service).
