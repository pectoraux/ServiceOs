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
