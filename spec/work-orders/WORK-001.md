# WORK-001

Status: complete
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

Implementation revision: `d94d3c7` (implementation), plus evidence/CI-fix commits `c13688d`, `3f3f43e`, `5153146` on `feat/WORK-001-foundation`; final PR delivery head before merge: `a994f24d909c6db7e0d876553e4329a071fa36b7`.
Delivery date: 2026-08-31. PR: #15 (https://github.com/pectoraux/ServiceOs/pull/15).

### Changed surfaces (allowed scope only)

- `src/**` — TypeScript modular-monolith foundation (platform: config, logging, persistence boundary, migrations, governance, module registry, HTTP composition; 16 module public interfaces; composition root; check/migrate CLIs)
- `test/**` — behavioral, structural and discrimination/mutation proofs
- `db/migrations/README.md` — migration convention (no business schema shipped)
- `docs/DEVELOPMENT.md` — documented development entrypoint (AC-1)
- `README.md` — development entrypoint section only (authority text untouched)
- `.github/workflows/governance.yml` — fixed broken YAML (`branches: ain]` typo) and wired the full check/test suite into CI
- `package.json`, `package-lock.json`, `tsconfig.json`, `.env.example` — toolchain
- `spec/work-orders/WORK-001.md` — evidence/finalization record only

Untouched by design: `spec/architecture/**`, `spec/governance/**` (except persistent state needed for activation/finalization), other Work Orders, `AGENTS.md` (Architect authority preserved).

### Checks and verification

- `npm run build` — PASS (strict TypeScript compile)
- `npm run check` — PASS (build + config validation + architecture structural checks + governance validation + repository checker)
- `npm test` — PASS: 118 tests, 116 pass, 0 fail, 2 skipped (gated live-PostgreSQL tests)
- Server smoke — PASS: `/healthz` 200, `/api/_meta` 200, truthful `/readyz` 503 when DB unreachable, JSON 404/405/500, fail-closed startup without DSN
- GitHub CI on PR #15 head `a994f24` — `ServiceOS Governance` run #23 completed successfully.

### Acceptance criteria evidence

- AC-1 — development and proof entrypoints are documented and passed locally/CI.
- AC-2 — module tree is parsed from the authoritative architecture document and matched by structural and module-registry tests (16/16).
- AC-3 — forbidden AI/Zeck SDK imports, AI infrastructure paths and non-allowlisted dependencies are structurally rejected; real tree passes.
- AC-4 — governance reader identifies WORK-001 and its branch from canonical repository state; mutation fixtures fail closed.

### Proof classes

- static/structural — module-tree conformance, dependency direction, forbidden AI surfaces, package dependency policy, persistence/HTTP boundary enforcement.
- dynamic/behavioral — configuration, logging, server composition/readiness, transaction and migration semantics, governance state reading.
- discrimination/mutation — synthetic violating source trees and tampered governance states are rejected with stable violation/error codes; clean controls pass.

### Known limitations

- No PostgreSQL instance existed in the implementation environment, so the two live-database integration tests were gated/skipped locally. They remain available for an environment with `SERVICEOS_TEST_DATABASE_URL`.
- No business schema is part of this foundation; durable business state belongs to later Work Orders.
- Control-plane API surface remains deliberately minimal; WORK-012 owns the larger API.

## Architect Verification

Architect verification: **APPROVED**

Verification basis:
- PR #15 inspected against the frozen v1.0 architecture and WORK-001 scope.
- AI authority boundary preserved; no second AI/persistence/workflow authority introduced.
- Structural and discrimination proofs are substantive and non-vacuous.
- PR head CI run #23 passed.
- No unresolved review threads or PR comments requiring remediation were present.
- Merge completed by Architect with merge commit `8bf0336b25eaebed416eacb7236233149885d181`.

## Post-Merge Finalization

- Finalized by Architect on 2026-08-31.
- Merged PR: `#15`
- Merge commit: `8bf0336b25eaebed416eacb7236233149885d181`
- Status transitioned: `in_flight -> complete`
- Future-generation membership removed.
- Next frontier recomputed to dependency-eligible Work Orders.
