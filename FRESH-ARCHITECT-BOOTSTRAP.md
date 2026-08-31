# ServiceOS — Fresh Architect Bootstrap

> The repository, not the previous conversation, is authoritative.

A new LLM Architect should be able to take over from this repository alone.

## 1. Read in order

1. `README.md`
2. `AGENTS.md`
3. `docs/ARCHITECT-RUNBOOK.md`
4. `docs/IMPLEMENTATION-HANDOFF.md`
5. `spec/architecture/v1.0/architecture.md`
6. `spec/architecture/v1.0/architecture-lock.md`
7. `spec/architecture/v1.0/authority-matrix.md`
8. `spec/architecture/v1.0/zeck-boundary.md`
9. `spec/architecture/v1.0/zeck-integration-contract.md`
10. `spec/architecture/v1.0/domain-model.md`
11. `spec/architecture/v1.0/work-execution-model.md`
12. `spec/architecture/v1.0/vertical-model.md`
13. `spec/architecture/v1.0/integration-model.md`
14. `spec/governance/*.json`
15. `spec/development-state/*.json`
16. the relevant `spec/work-orders/WORK-NNN.md`

Run `python3 scripts/governance-check.py` before authorizing implementation.

## 2. Governing architecture

Architecture v1.0 is frozen for implementation. Do not edit frozen rules in place. A frozen architecture change requires an Architecture Change Request and a new immutable architecture version.

## 3. AI authority

`pectoraux/Zeck` is the sole AI execution authority.

ServiceOS owns business-domain consequences. The `/zeck` module is only an integration boundary. Never introduce a local AI runtime, model/provider routing, agent/tool runtime, AI context compiler, AI planner, AI verification authority or AI-learning authority.

## 4. Program state

`spec/development-state/program-state.json` is the lifecycle record for activated Work Orders. `dependency-state.json` is the canonical dependency graph. `frontier-state.json` is derived eligibility. `checkpoint-state.json` records proof/checkpoint state.

At bootstrap all Work Orders are planned and `WORK-001` is the only dependency-eligible frontier head. After activation/completion the same artifacts evolve; the governance checker is intentionally lifecycle-aware and must continue to pass.

## 5. Naming and authority separation

- **Work Order** — implementation-program artifact governed by the Architect.
- **Service Work** — customer runtime business job governed by ServiceOS workflow authority.
- **Zeck Execution** — external AI execution object governed by Zeck.

Never collapse these identities or state machines.

## 6. Implementation workflow

The workflow is adapted from WorkflowOS:

```text
Frozen Architecture
  -> Requirements
  -> Work Order
  -> Architect Activation
  -> Z.ai implementation branch/PR
  -> Proof/evidence
  -> Architect independent review
  -> Architect merge
  -> Post-merge finalization
  -> Derived-state rebuild
  -> Next frontier
```

One activated Work Order maps to one branch and one PR. Z.ai implements. The Architect controls activation, architecture, review, approval, merge and finalization.

## 7. Authority decision rule for new features

```text
How AI computes/routes/reasons/uses tools/compiles context/selects providers?
    -> Zeck

What the customer/business is allowed to do, what state it is in,
what policy applies, whether a business outcome occurred?
    -> ServiceOS

What record is canonically owned by an external business system?
    -> external system, accessed through a ServiceOS adapter
```

When uncertain, stop rather than inventing an authority.

## 8. Current implementation frontier

`WORK-001` is the first eligible Work Order. `WORK-014` establishes the business-policy authority and `WORK-015` establishes the external-interaction/integration authority before downstream consumer work.

No Work Order is activated merely because it is present in `spec/work-orders/`.
