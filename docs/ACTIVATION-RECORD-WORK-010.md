# WORK-010 Activation Record

## Work Order

WORK-010 — Construction Subcontractor Compliance

## Status

IN_FLIGHT

## Activation

Activated by the Architect on 2026-09-02.

- Activation issue: #61
- Implementation branch: `feat/WORK-010-construction-compliance`
- Activation baseline: `0ef7148900572be30fc88af590e16633911aec61`
- Assurance profile: `CRITICAL`
- Implementation authority: Z.ai
- Review / merge / finalization authority: Architect
- Pull request: pending
- Implementation revision: pending
- Merge commit: pending
- Architect verdict: pending

## Preconditions

- WORK-005 is complete.
- WORK-006 is complete and canonical finalization CI is green on merge commit `0ef7148900572be30fc88af590e16633911aec61`.
- WORK-007 is complete.
- WORK-009 is complete.
- WORK-014 is complete.
- WORK-015 is complete.
- No other Work Order is in flight at activation.

## Authorized Surface

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

## Mandatory Invariants

1. Construction logic consumes horizontal authorities and Zeck through public contracts; it owns no replacement engines.
2. Service Work lifecycle remains owned by `/workflow` and is not redefined here.
3. AI functionality flows only through Zeck; no provider/model/agent ownership is introduced in ServiceOS.
4. Final compliance status is based on ServiceOS business verification, not merely an AI claim.
5. Automated follow-up uses durable interaction identity and is replay-safe.

## Forbidden Scope

No AI provider/model code, no generic workflow engine replacement, no direct email/SMS/provider SDKs from domain modules, no Service Work lifecycle change, and no architecture change.

## Proof Requirement

Required proof classes: `static`, `dynamic`, `discrimination`, `concurrency`.

## Verification Requirements

- Behavioral: happy path onboarding to compliant; missing document; expired insurance; noncompliant limits; vendor correction/retry.
- Structural: vertical package uses horizontal authorities; AI functionality flows only through Zeck.
- Discrimination / Mutation: direct provider SDK import fails; fabricated AI success cannot mark compliant; stale vendor attempt cannot overwrite a newer compliance decision.
- Concurrency / Crash Safety: duplicate document callbacks converge; concurrent follow-up workers do not double-contact the vendor; duplicate Zeck requests converge by idempotency key.

## Governance Rule

Only this Work Order may be in flight. Any architecture change requires a separate Architect decision and ADR before implementation. Zeck remains the sole AI execution authority.

## Activation Gate Note

Activation state was reconciled across main and the implementation branch before the exact-head governance rerun. The note exists only to force the repository governance workflow to execute again; it changes no scope or authority.
