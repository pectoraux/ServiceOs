# WORK-002

Status: complete
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

PR #17: https://github.com/pectoraux/ServiceOs/pull/17

Final implementation branch head: `f23b681bb107c5666840e28120efab241e4f4cb6`.

Merged into `main` as `023a9d520f414a60cedf728db8313226a2b78e75` on 2026-09-01.

### What was implemented

- `/auth` — human principals using email + scrypt password and opaque `sos_` session tokens stored as SHA-256 digests with 12-hour TTL and revocation; machine service-account principals with opaque `soak_` API keys stored as digests and revocation; one credential verification entry point, `authenticate`, with fail-closed uniform 401 semantics.
- `/organizations` — organizations, service tenants, memberships and roles; one authorization chain (`authorize` + capability matrix) and one route-guard factory (`createAuthorizationGuard`).
- Tenant isolation — every non-public customer route is guard-composed; authentication occurs before target resolution; tenant scope is resolved server-side; cross-tenant denial occurs before domain reads; forbidden and missing resources remain distinct typed outcomes.
- Machine credentials — capabilities derive only from the membership chain; service accounts cannot receive owner/admin roles; membership-less machines have zero capabilities.
- Durable schema — `db/migrations/0001_identity_tenancy.sql` creates principals, credential records, organizations, service tenants and memberships with FK, uniqueness and closed-enumeration constraints.
- Persistence hardening — business transactions use a client-pinned `TransactionalExecutor` so multi-statement integrity rules remain atomic under PostgreSQL concurrency.
- Platform wiring — guarded route descriptors, path parameters, strict JSON body parsing, typed HTTP errors, identity/tenancy structural checks and composition-root wiring were added only where required by this Work Order.
- CI — PostgreSQL 17 service and `SERVICEOS_TEST_DATABASE_URL` execute the live integration proofs in GitHub Actions.

### Defects found and fixed

1. The foundation's bare `pg.Pool.query` transaction usage was unsafe because statements could use different clients. Transactions now acquire and pin one client. A previously gated WORK-001 migration proof reproduced the defect when first run against live PostgreSQL; the corrected production boundary and regression proof pass.
2. Parallel live test files shared migration history; each live test now uses a disposable database, preserving production migration semantics while eliminating test interference.
3. The first authorization-guard ordering resolved an organization before authentication and leaked existence information. The test suite caught this and authentication now strictly precedes target resolution.

### Verification results

- `npm run build` — PASS.
- `node dist/src/cli/check.js` — PASS; frozen 16-module architecture, identity/tenancy boundary checks, and branch/frontier validation pass.
- `npm test` — 200/200 PASS in CI, including all 8 live PostgreSQL proofs; locally 192 pass with 8 live-PostgreSQL tests gated because no local PostgreSQL server was available.
- `scripts/governance-check.py` — PASS after the Architect corrected the repository lifecycle invariant so the future roadmap covers only future-generation Work Orders; completed/in-flight Work Orders are represented in current-generation state.
- GitHub Actions run `33457400229` — repository-governance and foundation jobs both PASS; build/check and all behavioral, structural, discrimination and live-PostgreSQL tests PASS.

### Acceptance-criterion evidence

- AC-1 — `test/auth.test.ts` covers register/login/logout lifecycle, expiry discrimination, credential storage and uniform authentication failure semantics; HTTP identity routes are exercised in the tenant-isolation suite.
- AC-2 — `test/organizations.test.ts` and live SQL `test/identity-tenancy.integration.test.ts` cover organization, tenant and membership persistence/lifecycle and uniqueness.
- AC-3 — route enumeration proves all customer routes reject unauthenticated callers; `defineRoute` and composition enforce guards; tenant-scoped store contracts require tenant predicates.
- AC-4 — store read counters prove authorization denials occur before domain data access; live SQL isolation proofs show cross-tenant rows are invisible; 403 and 404 remain distinct.
- AC-5 — machine credential tests prove capability derivation solely through membership, grant-side role restriction, cross-tenant denial and immediate revocation effect.

### Proof classes

- static/structural — identity boundary, one authorization engine, one identity engine, one route-guard factory, module dependency direction, forbidden AI surfaces and compile-time guard enforcement.
- dynamic/behavioral — auth lifecycle, organization/tenant/membership lifecycle, role/action matrix, composed HTTP routes and server readiness behavior.
- discrimination/mutation — second-engine imports, unguarded routes, tenant-predicate removal/wrong-tenant mutations, expired/revoked credentials all fail closed as expected.
- concurrency — parallel same-email registration, same-slug organization creation, same-principal membership creation and last-owner revocation all preserve the required invariants; live PostgreSQL uses independent clients.

### Changed surfaces (allowed scope only)

- `src/modules/auth/**`
- `src/modules/organizations/**`
- `db/migrations/0001_identity_tenancy.sql`
- `db/migrations/README.md`
- additive customer-route guard mechanics in `src/platform/http/index.ts`
- additive client-pinned transaction support in `src/platform/persistence/index.ts`
- identity-boundary governance checks and check CLI wiring
- `src/main.ts` composition wiring
- proof tests under `test/**`
- `.github/workflows/governance.yml` PostgreSQL test service
- `docs/DEVELOPMENT.md`
- this Work Order evidence record

Untouched by design: frozen architecture files, unrelated Work Orders, and business vertical state outside this Work Order.

### Known limitations

- Live PostgreSQL was unavailable locally, but all 8 gated live proofs passed in CI.
- Service-account creation spans multiple module operations and can leave a capability-less orphan principal after a mid-failure; such a principal cannot obtain capabilities by construction.
- Suspension state exists in the authorization model but no operator route changes it yet; that remains outside WORK-002.
- Rate limiting, password reset, email verification and audit-event emission remain outside WORK-002.

## Finalization Record

- Final verdict: `approved`
- Final merge: `023a9d520f414a60cedf728db8313226a2b78e75`
- Finalized by Architect on 2026-09-01.
