# WORK-008 Activation Record

## Work Order

WORK-008 — Business Approvals

## Status

IN_FLIGHT

## Activation

Activated by the Architect on 2026-09-02.

- Activation issue: #38
- Implementation branch: `feat/WORK-008-business-approvals`
- Activation baseline: `bd11baa497574e576db57c0bc8d6035bb91eec6d`
- Activation checkpoint: `4a82f3cb3b492443b10873fa3804d2af3aa79303`
- Assurance profile: `HIGH_ASSURANCE`
- Implementation authority: Z.ai
- Review / merge / finalization authority: Architect

## Authorized Surface

- `/approvals`
- approval request/decision records
- approval policy hooks
- authenticated human approval surface

## Mandatory Invariants

1. Business approval is an explicit human authority; AI/agent output is never approval.
2. Approval requests are bound to specific Service Work/Attempt and applicable policy.
3. Only authorized humans may approve or reject.
4. Approval decisions are durable and auditable.
5. AI results cannot satisfy the approval authority.
6. Simultaneous approval/rejection has deterministic terminal arbitration.
7. No replacement of Zeck's optional AI human-escalation execution primitive is created.

## Forbidden Scope

No implicit approval from agent claims and no replacement of Zeck's optional AI human-escalation execution primitive. No frozen v1.0 architecture change.

## Proof Requirement

The delivery must provide `static`, `dynamic`, `discrimination`, and `concurrency` proofs for approval binding, authorization, auditability, fabricated/unauthorized decisions, and deterministic terminal arbitration.

## Governance Rule

No architecture change is authorized by this activation. Any change to the frozen v1.0 architecture requires a separate Architect decision and ADR before implementation.
