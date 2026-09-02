# WORK-007

Status: in_flight
Owner: Architect
Architecture Version: v1.0
Assurance Profile: CRITICAL

## Objective

Implement ServiceOS business evidence and outcome-verification primitives.

## Dependencies

Requires: WORK-004
Enables: WORK-010, WORK-012

## Scope

Allowed:
- /evidence
- business outcome contracts
- deterministic evidence mapping
- domain verification interfaces

Forbidden:
- replacing Zeck's AI execution evidence authority
- AI model evaluator
- vertical-specific outcome rules

## Protected Surfaces

/evidence, business verification contracts, evidence persistence

## Required Proof Classes

`static,dynamic,discrimination,concurrency`

## Architecture Invariants

- Business evidence and outcome verification are distinct from Zeck execution evidence and status.

## Acceptance Criteria

- AC-1 Evidence can be attributed to a specific Service Work/Attempt.
- AC-2 Business outcome verification is distinct from transport/AI execution success.
- AC-3 Evidence provenance is preserved.
- AC-4 Missing evidence cannot become an unearned successful outcome.

## Verification Requirements

### Behavioral
- evidence attach/read
- outcome verification

### Structural
- no parallel Zeck evidence store for AI execution

### Discrimination / Mutation
- fabricated completion without evidence fails
- wrong-work evidence cannot satisfy another Work item

### Concurrency / Crash Safety
- duplicate evidence attachment converges

## Definition Of Done

See TEMPLATE.md.
