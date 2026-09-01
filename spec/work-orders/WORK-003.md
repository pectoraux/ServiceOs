# WORK-003

Status: in_flight
Owner: Architect
Architecture Version: v1.0
Assurance Profile: CRITICAL

## Objective

Implement Service Work identity, lifecycle records, work attempts, dependencies, durable identities and safe retry primitives.

## Dependencies

Requires: WORK-001
Enables: WORK-004, WORK-009, WORK-014

## Scope

Allowed:
- /work module
- ServiceWork persistence
- WorkAttempt persistence
- dependency records
- durable idempotency primitives

Forbidden:
- business state transition engine beyond the domain model; WORK-004 owns that
- AI execution runtime
- vertical-specific work types

## Protected Surfaces

/work, ServiceWork persistence, WorkAttempt persistence, dependency/idempotency records

## Required Proof Classes

`static,dynamic,discrimination,concurrency`

## Architecture Invariants

- ServiceWork and WorkAttempt identities are separate; no workflow state machine or Zeck lifecycle is owned here.

## Acceptance Criteria

- AC-1 Service Work has durable tenant-bound identity.
- AC-2 Work Attempts are distinct from Service Work and external/Zeck executions.
- AC-3 Work dependencies are durable and cycle-safe.
- AC-4 Retry/convergence identities prevent duplicate Work Attempts under the defined retry protocol.
- AC-5 Stale attempts cannot mutate current-work state after supersession.

## Verification Requirements

### Behavioral
- create/read work
- attempt creation
- dependencies

### Structural
- no workflow engine in /work
- no Zeck state machine in ServiceOS

### Discrimination / Mutation
- stale-attempt mutation regression
- duplicate identity regression

### Concurrency / Crash Safety
- two actors creating the same logical work must converge
- late prior attempt cannot win over current attempt

## Definition Of Done

See TEMPLATE.md.

## Activation Record

Activated by Architect on 2026-09-01.

- Branch: `feat/WORK-003-service-work`
- Base revision: `ce771414d698b6bd846da575c1ca32e29608d4b5`
- Activation issue: `#18`
- Implementation authority: Z.ai
- Review/merge/finalization authority: Architect

The activation decision was made from the frozen v1.0 architecture and the completed WORK-002 state. No architecture change is authorized by this Work Order.

## Implementation Status

Implementation delivered for Architect verification on 2026-09-01. This Work Order is the sole active implementation frontier; Z.ai implemented only the scope above and returned implementation PR #24 with the four required proof classes.

## Evidence

Status: delivered for Architect verification on 2026-09-01.

Implementation branch: `feat/WORK-003-service-work` (activation baseline `ce771414d698b6bd846da575c1ca32e29608d4b5`, activation issue #18).

Implementation PR: #24.

### What was implemented

- `/work` module public contract — `createWork`, `getWork`, `listWorks`, `addDependency`, `listDependencies`, `createAttempt`, `listAttempts`, `dispatchAttempt`, `recordAttemptResult` — consuming the single authorization chain from `/organizations`' public interface (tenant scope resolved server-side before any work data access; read action for reads, write action for mutations).
- ServiceWork identity and persistence — tenant-bound durable rows with actor provenance, timestamps, and durable idempotency-key convergence; the current-attempt pointer is forward-only.
- WorkAttempt identity and persistence — separate durable identity with per-work monotonic numbering, dispatch boundary (pre-dispatch convergence window), observed-outcome record and supersession chain; no Zeck/execution reference exists anywhere in `/work` (the linkage belongs to `/zeck`, WORK-005).
- Durable dependencies — same-tenant edges with duplicate-edge convergence, self-dependency rejection, and cycle safety serialized by a per-tenant advisory transaction lock (racing opposite edges commit at most one; no phantom cycles).
- Durable idempotency primitives — partial unique indexes (tenant idempotency keys, one live attempt per work, one live attempt per work+key) with insert-or-converge store semantics; idempotent dispatch re-observation; idempotent duplicate result delivery with divergent-result conflict.
- Work-state authority stays with `/workflow` — the works table status enumeration is closed at `'draft'`; `/work` never writes it (schema-level CHECK plus structural tripwires).
- Structural boundary checks — `checkWorkBoundaries` (transition-engine exports in `/work`, work-status mutation SQL in `/work`, `/work -> /workflow|/zeck` imports, Zeck execution lifecycle exports in any module, Zeck-named exports in `/work`, zeck tables in migrations, migration table-prefix discipline), wired into `cli/check.ts`.
- Durable schema — `db/migrations/0002_service_work.sql` (`work_service_works`, `work_attempts`, `work_dependencies` with FKs, closed enumerations and the three partial unique indexes).
- Store port + SQL store + faithful in-memory double (exposed on the module's public interface so test doubles implement the same contract).
- Composition-root wiring in `src/main.ts` (work module composed; its HTTP surface deliberately belongs to WORK-012).

### Verification results

- `npm run build` — PASS.
- `node dist/src/cli/check.js` — PASS: frozen 16-module architecture, identity/tenancy boundary checks, work boundary checks, branch/frontier validation.
- `scripts/governance-check.py` — PASS.
- `npm test` locally — 243 pass, 0 fail; 16 live-PostgreSQL proofs gated locally (no PostgreSQL service in the implementation environment).
- `npm test` in CI (GitHub Actions run 33472862212, postgres:17 service) — **259/259 pass, 0 fail, 0 skipped**: all 16 live-PostgreSQL proofs executed, including the 8 WORK-003 proofs (migrations with closed work-status CHECK, full work lifecycle, cross-tenant SQL isolation, parallel work-identity convergence, parallel retry convergence, late-attempt FOR UPDATE rejection, opposite-edge dependency serialization, schema backstops).
- Server smoke — `workAuthority: composed` in the startup log; `/healthz` 200; `/readyz` truthfully 503 with the database down; guarded customer routes reject unauthenticated callers 401 before any data access.
- GitHub Actions — run on the PR (tests + repository-governance jobs).

### Acceptance-criterion evidence

- AC-1 (durable tenant-bound ServiceWork identity) — `test/work-service-work.test.ts` (identity, provenance, tenant binding, idempotency convergence); `test/work-tenant-isolation.test.ts` (tenant predicates, cross-tenant invisibility); live SQL proofs in `test/service-work.integration.test.ts`.
- AC-2 (WorkAttempt distinct from ServiceWork and external/Zeck executions) — behavioral attempt tests (separate identity, numbering, work pointer); attempt record shape assertion (ServiceOS-owned fields only); structural checks `zeck-state-in-work` and `zeck-state-machine`; schema contains no zeck columns (live proof pins the created tables).
- AC-3 (durable, cycle-safe dependencies) — dependency behavioral tests (durability, convergence, self/cycle rejection); concurrency proofs for opposite-edge races (in-memory and live); live schema backstop proof.
- AC-4 (retry/convergence prevents duplicate attempts) — pre-dispatch convergence and post-dispatch distinct-identity tests; parallel-retry convergence (in-memory and live, separate pools); partial unique index backstops proven directly against live SQL.
- AC-5 (stale attempts cannot mutate current-work state) — supersession rejections for dispatch and results; late-result races (in-memory interleavings and live parallel actors); work status proven never mutated by attempt paths (behavioral + live closed-enumeration proof).

### Proof classes

- static/structural — work-boundary governance checks (real tree passes; mutated synthetic trees rejected with stable codes); closed work-status enumeration pinned; migration prefix discipline; check CLI end-to-end.
- dynamic/behavioral — full work/attempt/dependency lifecycle, retry protocol, idempotent results, input validation, capability derivation through the membership chain.
- discrimination/mutation — tenant-predicate sensitivity, duplicate-identity regression (non-converging store double-inserts observably), stale-attempt mutation regression, suspended-tenant vs missing distinction, structural tripwires with exact violation codes.
- concurrency — same-key work creation convergence, parallel retry convergence, late-attempt rejection under interleaving, opposite-edge dependency serialization, duplicate result convergence; live-PostgreSQL equivalents with independent pooled clients.

### Changed surfaces (allowed scope only)

- `src/modules/work/**` (store port, SQL store, module public contract)
- `db/migrations/0002_service_work.sql`
- `db/migrations/README.md`
- additive work-boundary governance checks and check CLI wiring
- additive composition-root wiring in `src/main.ts`
- test helpers (in-memory `/work` store) and the four proof-class suites
