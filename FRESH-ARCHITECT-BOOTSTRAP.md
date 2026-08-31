# ServiceOS — Fresh Architect Bootstrap

> The repository, not the previous conversation, is authoritative.

A new Architect LLM should be able to start from this repository alone.

## 1. Governing architecture

Read in this order:

1. `spec/architecture/v1.0/architecture.md`
2. `spec/architecture/v1.0/architecture-lock.md`
3. `spec/architecture/v1.0/zeck-boundary.md`
4. `spec/architecture/v1.0/domain-model.md`
5. `spec/architecture/v1.0/work-execution-model.md`
6. `spec/architecture/v1.0/vertical-model.md`
7. `spec/architecture/v1.0/integration-model.md`

v1.0 is the frozen implementation baseline.

## 2. AI authority

`pectoraux/Zeck` is the sole AI execution authority.

The ServiceOS `/zeck` module is only an integration boundary. It must never become a second AI runtime.

## 3. Program state

Read:

- `spec/development-state/program-state.json`
- `spec/development-state/dependency-state.json`
- `spec/development-state/frontier-state.json`
- `spec/development-state/checkpoint-state.json`
- `spec/governance/future-roadmap.json`

At bootstrap all 15 Work Orders are `planned`; no runtime implementation has been activated. `WORK-001` is the only dependency-eligible frontier head.

## 4. Implementation workflow

The implementation workflow is documented in `docs/WORKFLOW.md` and adapted from WorkflowOS. The canonical worker constraints are in `spec/governance/worker-protocol.json`.

One activated Work Order = one branch + one active PR.

Z.ai implements. The Architect reviews and controls architecture/merge decisions.

## 5. Runtime/domain naming

Do not confuse:

- **Work Order** — implementation-program artifact.
- **Service Work** — customer business-work runtime object.
- **Zeck Execution** — external AI execution object owned by Zeck.

These are separate authorities and identities.

## 6. Current frontier

`WORK-001` is the first dependency-eligible Work Order. `WORK-014` (Business Policy Authority) and `WORK-015` (External Interaction & Integration Authority) are deliberately scheduled before the vertical consumer layer so no implementer is forced to invent missing horizontal authorities.

It is not activated until the Architect records activation in `program-state.json`.

## 7. When AI-related requests appear

First classify the requested behavior:

- business authority/rules/state → ServiceOS
- AI reasoning/execution/model/tool/context/planning/AI verification/AI learning → Zeck

Do not accept an AI feature into ServiceOS simply because it is used by a vertical. A vertical declares its required Zeck capabilities; it does not implement them.

## 8. Architecture change

Never edit v1.0 in place to solve an implementation problem. Record an ACR and create a new immutable architecture version.
