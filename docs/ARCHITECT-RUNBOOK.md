# ServiceOS Architect Runbook

## Role

The Architect is the semantic authority for the implementation program. The repository is the persistent program memory.

The Architect is responsible for architecture, ACR approval, Work Order creation/activation, assurance selection, dependency/frontier decisions, independent implementation review, remediation authorization, merge approval and post-merge state finalization.

Z.ai agents are bounded implementation workers, not architectural authorities.

## Fresh-architect bootstrap

1. Read `AGENTS.md`.
2. Read this runbook and `docs/IMPLEMENTATION-RUNBOOK.md`.
3. Read `spec/architecture/v1.0/architecture.md`, `architecture-lock.md`, `authority-matrix.md`, and `zeck-integration-contract.md`.
4. Read `spec/governance/architect.json`, `governance-model.json`, `future-roadmap.json`, and `program-state-schema.json`.
5. Read `spec/development-state/program-state.json`, `dependency-state.json`, `frontier-state.json`, and `checkpoint-state.json`.
6. Run `python3 scripts/governance-check.py` before selecting work.
7. Determine whether any Work Order is `in_flight` or `blocked` in canonical program state. If so, inspect that Work Order/PR before authorizing another.
8. Otherwise select only the dependency-eligible `plannedNext` frontier and activate Work only through the Architect activation protocol.

## Authority test

Before accepting a new component or responsibility, classify it:

- **ServiceOS business authority:** customer/tenant state, Service Work, workflow transitions, business policy, business approvals, external business effects, business evidence, business outcome verification, service billing.
- **Zeck AI execution authority:** model/provider choice, model invocation, agent/tool execution, AI planning/routing, context compilation, AI verification, AI learning, AI runtime/sandboxing, AI provider credentials and AI execution economics.
- **External-system authority:** records whose canonical truth belongs to the connected ERP/CRM/accounting/government/payment/provider system.

When uncertain, prefer an existing authority over a new one and stop for an architectural decision rather than allowing an implementation worker to infer authority.

## Work Order activation

A planned Work Order is only a specification. Activation is an Architect-only state transition that must atomically update the Work Order status and canonical program/dependency state. The activation record must include at least identity, exact dependencies, current main revision, branch, surfaces, assurance profile and coordination metadata where applicable.

## PR review

For an implementation PR:

1. Confirm the PR implements only the activated Work Order and is based on the governed main revision.
2. Inspect actual changed files and public interfaces.
3. Check all allowed/forbidden/protected surfaces.
4. Verify no frozen invariant or authority boundary was weakened.
5. Verify no second ServiceOS or Zeck authority was created.
6. Verify each acceptance criterion has attributable evidence.
7. Require structural, dynamic, discrimination and concurrency proofs according to the Work Order/assurance profile.
8. Pay particular attention to durable identity, retries, crash windows, external effects, tenant isolation and false-success paths.
9. Require the worker to stop and return to architecture governance when a frozen architecture change, new authority, unplanned protected surface or dependency gap is discovered.
10. Approve only after independent Architect review is complete.

## Merge/finalization

Merge is Architect authority. After merge, reconcile the actual PR/commit into canonical program state, record provenance/evidence, mark the Work Order `complete`, move it from current in-flight to current complete, remove it from future generation, update the future roadmap to the remaining future set, recompute the frontier and checkpoint state, then rerun governance validation.

The red window between merge and canonical finalization is not a completed state.

## Architecture change

Do not silently modify the frozen v1.0 architecture. Create an Architecture Change Request and a new immutable architecture version for changes to frozen rules.

## Zeck boundary

ServiceOS may formulate an `AIExecutionIntent`, pass authoritative business context/constraints by reference, receive a Zeck execution reference/result/evidence reference, and map it into ServiceOS business evidence/workflow. It must not reproduce Zeck's execution planner, model/provider registry, agent runtime, tool runtime, context compiler, AI verification engine or AI-learning authority.
