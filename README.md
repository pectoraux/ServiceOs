# ServiceOS

ServiceOS is a provider-independent business-service execution platform that turns recurring operational work into governed, software-delivered services.

The platform owns business-domain work, customer/tenant state, business workflow state, business policies, approvals, service definitions, outcomes, and domain evidence. **AI execution is intentionally delegated to Zeck (`pectoraux/Zeck`)**, which is the sole AI execution authority.

## Core thesis

A customer should buy a business outcome rather than an AI tool:

- books closed
- invoices collected
- vendors compliant
- permits submitted
- claims processed
- projects administered

ServiceOS supplies the business-work control plane. Zeck supplies AI execution capabilities such as models, agents, tools, context compilation, execution planning, provider routing, sandboxing, AI verification, and AI execution telemetry.

## Architecture authority

The governing architecture lives under `spec/architecture/v1.0/` and the architecture lock is `spec/architecture/v1.0/architecture-lock.md`.

The architecture is frozen for implementation. Changes require an Architecture Change Request and a new immutable architecture version. Implementation agents may not alter the governing architecture in place.

## Development workflow

ServiceOS deliberately adapts the repository-resident implementation workflow proven in WorkflowOS:

1. The Architect maintains the governing architecture and development state in the repository.
2. The Architect decomposes the architecture into Work Orders.
3. A Work Order is activated only by the Architect.
4. One implementation Work Order uses one branch and one PR.
5. The Z.ai implementation agent inspects the repository, implements only the activated scope, adds evidence/tests, and opens or updates the PR.
6. Verification and structural/discrimination checks run against actual repository evidence.
7. The Architect independently reviews the implementation against the Work Order and architecture lock.
8. Requested corrections are returned to the same Work Order/branch/PR lifecycle.
9. Only the Architect can approve and merge.
10. After merge, repository-resident state is finalized and derived state is reconciled before the next frontier is chosen.

The repository, not chat history, is the persistent program memory.

## AI boundary

All AI functionality is outside ServiceOS unless explicitly proven unavailable in Zeck.

ServiceOS MUST NOT contain:

- LLM provider adapters
- model selection/routing
- prompt execution engines
- agent runtimes
- AI tool runtimes
- AI context compilers
- AI planning engines
- AI provider credentials
- AI verification engines
- model-learning/routing logic

ServiceOS MAY contain deterministic business rules and domain verification that are required to decide business state, because those are customer-domain authorities rather than AI capabilities.

## First commercial vertical

Construction is the first vertical. The initial service is subcontractor/vendor compliance, with a planned expansion into construction project administration.

## Start here

### Architect

Read:

1. `AGENTS.md`
2. `docs/ARCHITECT-RUNBOOK.md`
3. `spec/architecture/v1.0/architecture.md`
4. `spec/architecture/v1.0/authority-matrix.md`
5. `spec/architecture/v1.0/zeck-integration-contract.md`
6. `spec/architecture/v1.0/architecture-lock.md`
7. `spec/governance/governance-model.json`
8. `spec/development-state/program-state.json`
9. `spec/development-state/frontier-state.json`
10. the relevant Work Order in `spec/work-orders/`

### Implementation agent

Read `AGENTS.md`, then `docs/IMPLEMENTATION-RUNBOOK.md`, then the activated Work Order. Never infer scope from conversational context.

## Status

Architecture v1.0 is the governing baseline. Runtime implementation has not started in this repository; all 15 Work Orders are planned until the Architect activates them.
