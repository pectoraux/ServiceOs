# WORK-009

Status: in_flight
Owner: Architect
Architecture Version: v1.0
Assurance Profile: HIGH_ASSURANCE

## Objective

Implement the versioned service-definition and vertical-package runtime that describes business services without embedding them in the horizontal core.

## Dependencies

Requires: WORK-003
Enables: WORK-010, WORK-012

## Scope

Allowed:
- service definitions
- vertical registration
- work definitions
- workflow-definition bindings
- business policy configuration schema
- outcome contracts
- pricing/metering metadata
- Zeck capability requirement declarations

Forbidden:
- AI engine implementation
- vertical workflow logic leaking into horizontal authority

## Protected Surfaces

/services, /verticals, versioned service definitions and package configuration

## Required Proof Classes

`static,dynamic,discrimination,concurrency`

## Architecture Invariants

- Verticals specialize domain semantics but cannot weaken horizontal authorities or select AI providers/models.

## Acceptance Criteria

- AC-1 A service definition can define entities, work types, workflow and outcome requirements.
- AC-2 Vertical packages are versioned.
- AC-3 Customer configuration cannot weaken horizontal authority invariants.
- AC-4 A service can declare Zeck capability requirements without selecting a model/provider.

## Verification Requirements

### Behavioral
- package registration/versioning

### Structural
- vertical package does not import AI provider infrastructure

### Discrimination / Mutation
- attempt to weaken a frozen horizontal invariant is rejected

### Concurrency / Crash Safety
- duplicate package/version registration converges or rejects deterministically

## Definition Of Done

See TEMPLATE.md.

## Activation Record

Activated by Architect on 2026-09-01.

- Branch: `feat/WORK-009-service-runtime`
- Base revision: `65d527b1aba75a025e5c5b4bf23c71bdcb32a3cf`
- Activation issue: `#31`
- Implementation authority: Z.ai
- Review/merge/finalization authority: Architect
- Assurance profile: `HIGH_ASSURANCE`

The activation decision was made from frozen v1.0 architecture with WORK-003 complete and WORK-015 now finalized in the mainline. No architecture change is authorized by this Work Order.