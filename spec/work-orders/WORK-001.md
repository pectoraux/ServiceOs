# WORK-001

Status: planned
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
