# WORK-002

Status: in_flight
Owner: Architect
Architecture Version: v1.0
Assurance Profile: CRITICAL

## Objective

Implement ServiceOS identity, organizations, memberships, tenant isolation and server-side authorization foundations.

## Dependencies

Requires: WORK-001
Enables: WORK-010, WORK-012, WORK-014, WORK-015

## Scope

Allowed:
- auth/org/membership modules
- tenant identifiers and authorization
- database constraints needed for tenant integrity

Forbidden:
- AI identity/provider credentials
- vertical business state
- second authorization engine

## Protected Surfaces

/auth, /organizations, authorization, tenant-scoped persistence, customer route guards

## Required Proof Classes

`static,dynamic,discrimination,concurrency`

## Architecture Invariants

- tenant ownership resolved server-side
- one authorization chain
- no cross-tenant reads/writes
- no AI credentials stored in ServiceOS

## Acceptance Criteria

- AC-1 Users can authenticate through the selected ServiceOS identity mechanism.
- AC-2 Organizations and memberships are persisted.
- AC-3 Every customer-domain resource is server-side tenant scoped.
- AC-4 Cross-tenant access is rejected before domain data is returned.
- AC-5 Machine credentials cannot gain ungranted capabilities.

## Verification Requirements

### Behavioral
- auth lifecycle
- membership lifecycle
- tenant isolation

### Structural
- one authorization boundary
- all customer routes require scope

### Discrimination / Mutation
- cross-tenant fixture must fail
- removing tenant predicate must make a discrimination test fail

### Concurrency / Crash Safety
- concurrent identity creation/linking must converge on one identity where applicable

## Definition Of Done

See TEMPLATE.md.

## Activation Record

Activated by Architect on 2026-08-31.

- Branch: `feat/WORK-002-identity-tenancy`
- Base revision: `9602ee474a13e7a4b1ee8daa276a64491a183cea`
- Activation issue: `#16`
- Implementation authority: Z.ai
- Review/merge authority: Architect

## Implementation Evidence (Z.ai delivery record)

Implementation revision: see the PR head recorded below (delivery on
`feat/WORK-002-identity-tenancy`, branched from the activation tip `29b281c`).
Delivery date: 2026-08-31.

### What was implemented

- `/auth` — the identity substrate: human principals (email + scrypt
  password, opaque `sos_` session tokens stored as SHA-256 digests, 12h TTL,
  revocable), machine service-account principals (password-less, opaque
  `soak_` API keys stored as digests, revocable), the single credential
  verification entry point `authenticate` (fail-closed uniform 401-class
  semantics), identity reads for the tenancy module, and the public identity
  routes (`/api/auth/register|login|logout|me`).
- `/organizations` — the tenancy authority: organizations, service tenants
  (the isolated customer-domain boundary), memberships and roles; the ONE
  authorization chain (`authorize` + the capability matrix
  owner/admin/member/viewer × read/write/administer); the single route-guard
  factory (`createAuthorizationGuard`); org/tenant/member/service-account
  management routes (14 customer routes total, all guard-composed).
- Tenant-scoped persistence: the store-port contract with mandatory tenant
  predicates on tenant-scoped reads, unique-constraint surfacing
  (`StoreConflictError`), atomic per-call operations
  (`createOrganizationWithTenant`, `updateMembership` under the
  last-active-owner rule with `FOR UPDATE` serialization).
- Migration `0001_identity_tenancy.sql`: principals, credential digests,
  organizations, service tenants, memberships — FK discipline, globally
  unique slugs, unique `(organization, principal)` membership, closed
  role/status/kind enumerations (the Work Order's "database constraints
  needed for tenant integrity").
- Platform wiring (minimum, additive): HTTP route descriptors with a
  REQUIRED guard for non-public access (compile-time overload + composition
  validation with stable `unguarded-route` code), path parameters, strict
  capped JSON bodies, typed `RouteHttpError` envelopes; persistence boundary
  gained `TransactionalExecutor` (client-pinned transactions) after a latent
  defect was found (see below); governance gained the identity-boundary
  structural checks; the composition root wires `/auth` into
  `/organizations` and mounts the guarded customer routes.
- CI: a PostgreSQL service + `SERVICEOS_TEST_DATABASE_URL` so the gated live
  integration proofs execute for real in the governance workflow.

### Defect found and fixed in the foundation

`pg.Pool.query` checks out a client per statement, so `BEGIN`/work/`COMMIT`
issued through a bare pool are only coincidentally serialized and racy under
concurrency. WORK-002's atomic tenant-integrity rules exposed this: the
persistence boundary now pins transactions to one acquired client
(`withPinnedClient`/`transactional()`), and `migrate`/`withTransaction` use
it — preserving the documented WORK-001 semantics (guarded, idempotent
migration batch) under real concurrency.

Empirical confirmation: WORK-001's gated migration proof, which had never
executed anywhere (no PostgreSQL service existed in CI before WORK-002),
failed on its first live run with `42P01 relation … does not exist` when
driving `applyMigrations` through a raw pool — the seed INSERT ran in a
session that could not see the CREATE TABLE. The proof now drives the
production path (the boundary's client-pinned `migrate`) and a second proof
pins a client by hand; all live proofs pass.

### Checks and verification

- `npm run build` — PASS (strict TypeScript compile).
- `node dist/src/cli/check.js` — PASS: configuration validation, module-tree
  conformance (16 modules), identity/tenancy boundary checks (one
  authorization chain, one identity engine, one guard factory), governance
  frontier (WORK-002 in flight on this branch), branch conformance.
- `npm test` — PASS: 200 tests, 192 pass, 0 fail, 8 skipped locally (the
  gated live-PostgreSQL integrations — which execute in CI through the
  provisioned PostgreSQL service; the first live CI run confirmed all five
  WORK-002 live proofs pass against real PostgreSQL, including true
  parallel-client convergence and FOR UPDATE last-owner serialization).
- Server smoke — PASS: `/healthz` 200 without DB, `/readyz` 503 (truthful,
  unreachable DB), `/api/_meta` 200, customer routes answer 401 before any
  data access even with the database down, register fails closed (500, no
  leak).
- `scripts/governance-check.py` — FAILS on a PRE-EXISTING governance-state
  inconsistency, present at the activation tip `29b281c` and introduced by
  architect commit `777f9ab` ("advance future roadmap after WORK-001
  completion"): WORK-001 was removed from
  `spec/governance/future-roadmap.json`'s `sequence`, but the checker
  requires the sequence to cover every `WORK-*.md` file exactly once. This is
  Architect-owned governing state; the implementation did not modify it and
  returns the reconciliation decision (restore WORK-001 in the sequence or
  update the checker's invariant) to the Architect.

### Acceptance criteria evidence

- AC-1 — `test/auth.test.ts` (register/login/logout lifecycle, session
  expiry discrimination, uniform 401 semantics) and route-level proofs in
  `test/tenant-isolation.test.ts` (login/register over HTTP).
- AC-2 — `test/organizations.test.ts` (organization + default tenant + owner
  membership persisted with schema-equivalent uniqueness; membership
  lifecycle); live SQL in `test/identity-tenancy.integration.test.ts`
  (gated, CI).
- AC-3 — every customer route resolves its scope server-side through the
  guard (enumeration proof: all non-public routes reject unauthenticated
  callers, `test/tenant-isolation.test.ts`); `defineRoute` requires a guard
  at compile time and composition time (`test/http-routes.test.ts`); the
  tenant-scoped store contract forces the tenant predicate
  (`test/tenant-scoped-persistence.test.ts`).
- AC-4 — cross-tenant requests are 403/404 BEFORE any domain data read
  (store read counters prove handlers never ran after a denial,
  `test/tenant-isolation.test.ts`); 403 (forbidden) is distinct from 404
  (missing); tenant directories never contain other tenants' members.
- AC-5 — machine credentials resolve capabilities only through the membership
  chain (`test/authorization.test.ts`): service accounts may only hold
  member/viewer roles (grant-side guard), an API key grants exactly its
  principal's role capabilities, membership-less machines have zero
  capabilities, revocation kills credential and membership; over HTTP in
  `test/tenant-isolation.test.ts` (viewer account denied administration;
  revoked key 401).

### Proof classes

- static/structural — real-tree identity-boundary checks (one authorization
  engine in /organizations, one identity engine in /auth, one guard
  factory), module tree + dependency direction + forbidden AI surfaces
  unchanged and passing; the `defineRoute` guard requirement is
  compile-time enforced.
- dynamic/behavioral — auth lifecycle, org/tenant/membership lifecycle,
  authorization decisions for every role/action pair, route behavior over
  the composed server (registration → login → organization → tenant
  directory), server smoke.
- discrimination/mutation — synthetic second engines rejected with stable
  codes (`second-authorization-engine`, `second-identity-engine`,
  `second-route-guard`); unguarded customer route rejected
  (`unguarded-route` at definition and composition); the tenant-predicate
  discriminator rejects the shipped SQL with the predicate removed, the
  WHERE clause removed, or the wrong tenant bound (mutation sensitivity);
  expired/revoked credentials fail closed distinctly from valid ones.
- concurrency — parallel same-email registration, same-slug organization
  creation and same-principal membership converge on exactly one durable
  identity with typed outcomes; parallel last-owner revocations preserve the
  rule; parallel logins produce independent valid sessions; the gated live
  proofs repeat the convergence and last-owner races against real PostgreSQL
  with independent pooled clients.

### Changed surfaces (allowed scope only)

- `src/modules/auth/**`, `src/modules/organizations/**` — the Work Order's
  allowed modules (public interfaces, ports, SQL stores, guard, routes).
- `db/migrations/0001_identity_tenancy.sql` + `db/migrations/README.md` —
  tenant-integrity schema and the tenancy discipline for later tables.
- `src/platform/http/index.ts` — additive customer-route guard mechanics
  (protected surface "customer route guards").
- `src/platform/persistence/index.ts` — additive `TransactionalExecutor`
  plus the client-pinning fix (preserves WORK-001's documented semantics).
- `src/platform/governance/**`, `src/cli/check.ts` — identity-boundary
  structural checks wired into the check entrypoint.
- `src/main.ts` — composition wiring of the two modules and their routes.
- `test/**` — proof classes above (in-memory store doubles implement the
  public store ports).
- `.github/workflows/governance.yml` — PostgreSQL service for the gated
  live proofs.
- `docs/DEVELOPMENT.md` — identity/tenancy documentation.
- `spec/work-orders/WORK-002.md` — this evidence record only.

Untouched by design: `spec/architecture/**`, `spec/governance/**` (including
the pre-existing roadmap inconsistency, reported above), other Work Orders,
`AGENTS.md`.

### Known limitations

- No local PostgreSQL in the implementation environment: the 8 gated live
  integrations were skipped locally and execute in CI (provisioned
  PostgreSQL service). Everything not requiring a live database is proven
  locally through faithful store doubles that implement the same ports.
- `scripts/governance-check.py` fails on the pre-existing roadmap/state
  inconsistency described above (present at the activation tip; Architect
  reconciliation required for a fully green `npm run check`).
- Org/tenant suspension state exists in the schema and authorization chain
  but no operator route flips it yet (no Work Order authorizes that surface;
  the chain denies through it deterministically when set).
- Cross-module service-account creation (auth principal + org membership +
  key) is not single-transaction; a mid-failure can leave a capability-less
  orphan principal (harmless by AC-5 construction), documented in the
  module.
- Rate limiting, password-reset, email verification and audit-event
  emission are not part of this Work Order's surfaces.

