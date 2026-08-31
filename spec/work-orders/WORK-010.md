# WORK-010

Status: planned
Owner: Architect
Architecture Version: v1.0
Assurance Profile: CRITICAL

## Objective

Implement the first commercial service: Construction Subcontractor Compliance.

## Dependencies

Requires: WORK-005, WORK-006, WORK-007, WORK-009, WORK-014, WORK-015
Enables: WORK-013

## Scope

Allowed:
- Construction vertical package
- subcontractor/vendor entities
- compliance requirements
- document collection workflow
- insurance certificate validation
- license validation
- automated follow-up
- exception escalation
- compliance package output
- Zeck-backed document reasoning only through WORK-005

Forbidden:
- AI provider/model code
- generic workflow engine replacement
- direct email/SMS/provider SDKs from domain modules
- changing Service Work lifecycle

## Protected Surfaces

construction vertical, compliance entities/work types, integrations via public ports, Zeck boundary consumption

## Required Proof Classes

`static,dynamic,discrimination,concurrency`

## Architecture Invariants

- Construction logic consumes horizontal authorities and Zeck through public contracts; it owns no replacement engines.

## Acceptance Criteria

- AC-1 A subcontractor can be onboarded into a project.
- AC-2 Required compliance documents can be requested, received and tracked.
- AC-3 Insurance certificates are checked against project requirements using deterministic business rules and/or Zeck AI execution where document understanding is needed.
- AC-4 Missing/expired/noncompliant evidence creates governed follow-up work.
- AC-5 Automated follow-up uses durable interaction identity and is replay-safe.
- AC-6 Final compliance status is based on ServiceOS business verification, not merely an AI claim.
- AC-7 The service produces an auditable compliance package.

## Verification Requirements

### Behavioral
- happy path onboarding to compliant
- missing document
- expired insurance
- noncompliant limits
- vendor correction/retry

### Structural
- vertical package uses horizontal authorities
- AI functionality flows only through Zeck

### Discrimination / Mutation
- direct provider SDK import must fail
- fabricated AI success cannot mark compliant
- stale vendor attempt cannot overwrite a newer compliance decision

### Concurrency / Crash Safety
- duplicate document callbacks converge
- concurrent follow-up workers do not double-contact the vendor
- duplicate Zeck requests converge by idempotency key

## Definition Of Done

See TEMPLATE.md.
