# WORK-001

Status: in_flight
Owner: Architect
Architecture Version: v1.0
Assurance Profile: HIGH_ASSURANCE

## Objective

Create the ServiceOS modular-monolith foundation, repository structure, development runtime, persistence boundary and governance/checkpoint wiring required for subsequent Work Orders.

## Context

This is the platform foundation. It must support the frozen ServiceOS architecture and the repository-resident implementation workflow without implementing vertical business logic.

## Dependencies

Requires: none
Enables: WORK-002, WORK-003, WORK-011

## Scope

Allowed:
- TypeScript modular-monolith foundation
- PostgreSQL persistence boundary
- configuration and environment handling
- test harness
- governance checks required by the repository protocol
- base API/server composition

Forbidden:
- AI provider/model/agent infrastructure
- construction-specific logic
- customer business workflows
- direct Zeck SDK usage

## Protected Surfaces

platform, repository governance, persistence bootstrap, API composition

## Required Proof Classes

`static,dynamic,discrimination`

## Architecture Invariants

Must preserve:
- architecture lock
- module dependency direction
- PostgreSQL authority
- no AI authority in ServiceOS
- no tenant bypass

## Acceptance Criteria

- AC-1 Repository builds and tests through the documented development entrypoint.
- AC-2 The modular boundary structure matches the architecture.
- AC-3 No AI provider/model/agent code exists in ServiceOS.
- AC-4 Governance validation can identify the current frontier and Work Order identity.

## Verification Requirements

### Behavioral
- build/test startup
- configuration validation

### Structural
- module tree and dependency direction
- forbidden AI surfaces absent

### Discrimination / Mutation
- known forbidden AI import is rejected by the structural checks

### Concurrency / Crash Safety
- not required unless persistence bootstrap includes shared durable initialization

## Definition Of Done

See TEMPLATE.md.

## Activation Record

Activated by Architect on 2026-08-31.

- Branch: `feat/WORK-001-foundation`
- Base revision: `9b577575dee0e257112405d4f3a4f874cb9de0d4`
- Activation issue: `#1`
- Implementation authority: Z.ai
- Review/merge authority: Architect

## Implementation Evidence (Z.ai delivery record)

Implementation revision: `d94d3c7` (+ evidence commits on `feat/WORK-001-foundation`).
Delivery date: 2026-08-31. PR: #15 (https://github.com/pectoraux/ServiceOs/pull/15).

### Changed surfaces (allowed scope only)

- `src/**` — TypeScript modular-monolith foundation (platform: config, logging, persistence boundary, migrations, governance, module registry, HTTP composition; 16 module public interfaces; composition root; check/migrate CLIs)
- `test/**` — behavioral, structural and discrimination/mutation proofs
- `db/migrations/README.md` — migration convention (no business schema shipped)
- `docs/DEVELOPMENT.md` — documented development entrypoint (AC-1)
- `README.md` — development entrypoint section only (authority text untouched)
- `.github/workflows/governance.yml` — fixed broken YAML (`branches: ain]` typo) and wired the full check/test suite into CI
- `package.json`, `package-lock.json`, `tsconfig.json`, `.env.example` — toolchain
- `spec/work-orders/WORK-001.md` — this evidence section only

Untouched by design: `spec/architecture/**`, `spec/governance/**`, `spec/development-state/**`, other Work Orders, `AGENTS.md` (Architect authority preserved).

### Checks run and results

- `npm run build` — PASS (tsc, strict, 46 source/test files)
- `npm run check` — PASS (build + config validation + architecture structural checks + governance frontier/Work Order validation + `scripts/governance-check.py`)
- `npm test` — PASS: 118 tests, 116 pass, 0 fail, 2 skipped (gated live-PostgreSQL integration tests; no PostgreSQL available in the implementation environment)
- Server smoke (unreachable database): `/healthz` 200, `/api/_meta` 200 (16 modules), `/readyz` 503 with truthful reason, 404/405/500 JSON errors, fail-closed startup without `SERVICEOS_DATABASE_URL` (exit 1)

### Acceptance criteria evidence

- AC-1 Repository builds and tests through the documented entrypoint — `npm run check` / `npm test` documented in `docs/DEVELOPMENT.md`, executed green at the implementation revision; wired into CI.
- AC-2 Modular boundary structure matches the architecture — structural check parses the module table from `spec/architecture/v1.0/architecture.md` §6 and asserts the `src/modules` tree equals it; dynamic test asserts the composed module registry matches the same parsed list (16/16).
- AC-3 No AI provider/model/agent code exists in ServiceOS — structural check rejects AI/LLM SDK imports (including any Zeck SDK), AI-infrastructure path segments, and non-allowlisted package dependencies; the real tree passes with zero violations; `package.json` contains only `pg` (runtime) + toolchain devDependencies.
- AC-4 Governance validation identifies the current frontier and Work Order identity — `npm run check` reports `currentLiveImplementation=WORK-001`, in-flight branch `feat/WORK-001-foundation`, assurance profile, and validates branch conformance; dynamic tests prove the reader returns WORK-001 from the real repository state and fails closed on tampered state fixtures.

### Proof classes (HIGH_ASSURANCE)

- static/structural — module tree conformance, dependency direction, forbidden AI surfaces absent, dependency policy (all asserted against the real tree by `npm run check` and by tests).
- dynamic/behavioral — build/test startup, configuration validation (aggregated fail-closed ConfigError classes), server composition (health/ready/meta, 404/405/500, truthful readiness), transaction and migration semantics via injected executors.
- discrimination/mutation — synthetic trees containing a known forbidden AI import (openai, @anthropic-ai/sdk, @langchain/core, @pectoraux/zeck, zeck, ai), deep cross-module internal imports, platform→module imports, module imports outside the composition root, `pg` outside the persistence boundary, raw `node:http` outside the platform HTTP composition, unknown dependencies, AI path segments, unresolved imports, and tampered governance state are each rejected with the matching violation code; clean control trees produce zero violations (the checks are not vacuous).

### Known limitations

- The implementation environment had no PostgreSQL instance: the gated live-database integration tests (`test/persistence.integration.test.ts`, activated by `SERVICEOS_TEST_DATABASE_URL`) were not executed locally and are available for CI/Architect verification.
- No durable business schema ships in this Work Order (owned by WORK-002/003+); the migration runner is proven with scripted executors.
- The base HTTP layer is intentionally minimal (Node built-ins, GET-only platform routes); the control-plane API surface is owned by WORK-012.
- Concurrency/crash proofs are out of scope per this Work Order's verification requirements (no shared durable initialization is performed by the runtime).
