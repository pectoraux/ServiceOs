# ServiceOS

ServiceOS is a provider-independent business-service execution platform that turns recurring operational work into governed, software-delivered services.

The fundamental boundary is deliberate: **ServiceOS owns business work and business authority; Zeck (`pectoraux/Zeck`) owns AI execution.**

## Core thesis

Customers buy business outcomes—books closed, invoices collected, vendors compliant, permits submitted, claims processed, projects administered—not model calls or agent infrastructure.

ServiceOS therefore owns customer/tenant state, Service Work, business workflows, business policies, approvals, business-side external effects, business evidence, business outcome verification, service definitions, vertical packages and service economics.

Zeck owns AI execution capabilities: model/provider selection and calls, agents, tools, context compilation, AI planning/routing, AI verification, AI learning/telemetry, sandbox/runtime selection and AI execution economics.

## Architecture authority

The frozen v1.0 architecture is under `spec/architecture/v1.0/`. Read `architecture.md` and `architecture-lock.md` before implementation. Architecture changes require an Architecture Change Request and a new immutable architecture version.

## Development workflow

ServiceOS adapts the repository-resident implementation workflow proven in WorkflowOS:

1. Architect maintains architecture, requirements, Work Orders and canonical development state in GitHub.
2. Architect activates Work Orders; planned specs alone do not authorize implementation.
3. One activated Work Order maps to one implementation branch and one PR.
4. Z.ai workers implement only the activated scope and provide attributable evidence.
5. Structural, behavioral, discrimination and concurrency proofs are required according to the Work Order/assurance profile.
6. Architect independently reviews actual implementation evidence.
7. Only the Architect can approve/merge and finalize canonical program state.
8. A merge is not complete program state until post-merge finalization reconciles Git history and derived frontier state.

## AI rule

Before adding an AI-related feature, classify it. If it changes **how AI computes, routes, reasons, uses tools, compiles context, selects models/providers, verifies AI execution, or learns**, it belongs in Zeck. If it is required to establish **customer-domain authority or business consequences**, it remains in ServiceOS.

The ServiceOS `/zeck` module is a thin integration boundary. It must never become a second AI runtime.

## First commercial vertical

Construction, starting with subcontractor/vendor compliance and expanding toward construction project administration.

## Start here — Architect

1. `AGENTS.md`
2. `docs/ARCHITECT-RUNBOOK.md`
3. `docs/IMPLEMENTATION-HANDOFF.md`
4. `spec/architecture/v1.0/architecture.md`
5. `spec/architecture/v1.0/architecture-lock.md`
6. `spec/architecture/v1.0/authority-matrix.md`
7. `spec/architecture/v1.0/zeck-boundary.md`
8. `spec/architecture/v1.0/zeck-integration-contract.md`
9. `spec/architecture/v1.0/domain-model.md`
10. `spec/architecture/v1.0/work-execution-model.md`
11. `spec/architecture/v1.0/vertical-model.md`
12. `spec/architecture/v1.0/integration-model.md`
13. `spec/governance/*.json`
14. `spec/development-state/*.json`
15. relevant `spec/work-orders/WORK-NNN.md`
16. `python3 scripts/governance-check.py`

## Start here — Z.ai implementation worker

Read `AGENTS.md`, `docs/IMPLEMENTATION-RUNBOOK.md`, `docs/IMPLEMENTATION-HANDOFF.md`, and the **activated** Work Order. Do not infer scope from chat. Stop and return control to the Architect if implementation requires an unplanned authority, frozen-architecture change, unplanned protected surface, incomplete dependency, or AI capability that belongs in Zeck.

## Program status

Architecture v1.0 is frozen for implementation. The repository begins with 15 planned Work Orders and no activated runtime implementation. `WORK-001` is the initial dependency-eligible frontier head. Program state evolves in `spec/development-state/`; the governance checker is designed for both bootstrap and post-activation states.
