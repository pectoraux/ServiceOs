# ServiceOS Implementation Runbook

Implementation agents are stateless workers. The repository is the source of truth.

## Before implementation

Read `AGENTS.md`, then the activated `spec/work-orders/WORK-NNN.md`.

Verify:

- Work Order status is `in_flight`.
- Your branch is the Work Order branch.
- The dependency frontier permits the Work Order.
- The architecture version matches the Work Order.
- Allowed and forbidden surfaces are explicit.
- Zeck is the AI authority wherever AI capability is required.

## Implementation loop

1. Inspect current repository state.
2. Map the Work Order to existing modules/ports.
3. Identify authority boundaries before coding.
4. Implement the minimum coherent slice.
5. Add behavioral tests.
6. Add structural tests for frozen boundaries.
7. Add discrimination tests where a false-success path is plausible.
8. Add concurrency or crash tests for durable/external boundaries.
9. Run required checks.
10. Update the Work Order evidence record.
11. Open/update the PR.

## Do not

- create a parallel workflow state machine
- create a second persistence authority
- create an AI planner/router/model registry in ServiceOS
- call a model/provider SDK from ServiceOS
- persist provider-specific AI credentials in ServiceOS
- treat a successful Zeck request as proof that the business outcome succeeded
- turn a missing read into an empty result
- use PR comments as the authoritative Work Order state

## Zeck interaction rule

ServiceOS owns the **business Work** lifecycle.

Zeck owns the **AI Execution** lifecycle.

A ServiceOS implementation may persist a service-level `executionRef` and business-side evidence/reference, but the authoritative AI execution record remains in Zeck.

## Delivery report

The PR description must state:

- what was implemented
- what was deliberately not implemented
- the exact implementation revision
- tests/checks run
- evidence for every acceptance criterion
- known limitations and blocked dependencies
