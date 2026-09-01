# WORK-009 Activation Record

## Work Order

WORK-009 — Service / Vertical Runtime

## Status

IN_FLIGHT

## Activation

Activated by the Architect on 2026-09-01.

- Activation issue: #31
- Implementation branch: `feat/WORK-009-service-runtime`
- Activation baseline: `65d527b1aba75a025e5c5b4bf23c71bdcb32a3cf`
- Assurance profile: `HIGH_ASSURANCE`
- Implementation authority: Z.ai
- Review / merge / finalization authority: Architect

## Preconditions

- WORK-003 is complete.
- WORK-015 has passed Architect verification and is merged.
- No other Work Order is in flight.

## Authorized Surface

- `/services`
- `/verticals`
- versioned service definitions and package configuration
- work definitions
- workflow-definition bindings
- business policy configuration schema
- outcome contracts
- pricing/metering metadata
- Zeck capability requirement declarations

## Mandatory Invariants

1. Vertical packages specialize domain semantics without weakening horizontal authorities.
2. Service definitions cannot directly implement horizontal workflow authority.
3. Packages are explicitly versioned and duplicate versions converge or reject deterministically.
4. Customer configuration cannot weaken frozen authorization, identity, policy, work, workflow, or interaction invariants.
5. Zeck capability requirements declare capabilities only; service configuration never selects a model/provider.
6. Vertical runtime remains provider-neutral and cannot import AI provider infrastructure.

## Proof Requirement

The delivery must provide `static`, `dynamic`, `discrimination`, and `concurrency` proofs for package registration/versioning and authority-preservation behavior.

## Forbidden Scope

No AI engine implementation, no model/provider selection, no vertical logic leaking into horizontal authorities, and no changes to frozen v1.0 architecture.

## Governance Rule

No architecture change is authorized by this activation. Any change to the frozen v1.0 architecture requires a separate Architect decision and ADR before implementation.