# WORK-008 Activation Record

## Work Order

WORK-008 — Business/Human Approval

## Status

IN_FLIGHT

## Activation

Activated by the Architect on 2026-09-02.

- Activation issue: #55
- Implementation branch: `feat/WORK-008-business-approval`
- Activation baseline: `04cf82d618fe006e8cc1f31bc03105c3a1e7c5a2`
- Assurance profile: `HIGH_ASSURANCE`
- Implementation authority: Z.ai
- Review / merge / finalization authority: Architect
- Pull request: pending
- Implementation revision: pending
- Merge commit: pending
- Architect verdict: pending

## Preconditions

- WORK-004 is complete.
- WORK-014 is complete.
- Maintenance Issue #53 is resolved by PR #54 and canonical post-merge CI run `33649718873` is green on merge commit `04cf82d618fe006e8cc1f31bc03105c3a1e7c5a2`.
- No other Work Order is in flight at activation.

## Authorized Surface

- `/approvals`
- approval request and decision persistence
- authenticated approval routes / authorization integration
- approval policy hooks

## Mandatory Invariants

1. Business approval is an explicit human authority in ServiceOS.
2. Approval requests are bound to the specific Service Work/Attempt and applicable policy.
3. Only authorized humans can approve or reject.
4. Approval is durable and auditable.
5. AI or agent output can never constitute business approval.
6. Simultaneous approval/rejection converges deterministically to one terminal decision.

## Forbidden Scope

No replacement of Zeck's optional AI human-escalation execution primitive, no implicit approval from agent claims, no provider/model/agent ownership, no architecture change, and no unrelated business-module changes.

## Proof Requirement

Required proof classes: `static`, `dynamic`, `discrimination`, `concurrency`.

## Verification Requirements

- Behavioral: request/approve/reject/review lifecycle.
- Structural: approval authority exists only in ServiceOS for business decisions.
- Discrimination / Mutation: unauthorized approval fails.
- Concurrency / Crash Safety: simultaneous approval/rejection has deterministic terminal arbitration.

## Governance Rule

Only this Work Order may be in flight. Any architecture change requires a separate Architect decision and ADR before implementation. Zeck remains the sole AI execution authority.
