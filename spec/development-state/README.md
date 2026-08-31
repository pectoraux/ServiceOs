# ServiceOS Development State

The development-state directory is repository-resident program state.

## Canonical artifacts

- `program-state.json` — activated Work Orders and architect decisions
- `dependency-state.json` — canonical dependency mapping and eligibility
- `frontier-state.json` — current implementation frontier
- `checkpoint-state.json` — checkpoint/proof state
- `future-roadmap.json` — planned sequence and parallel waves
- `program-state.json` — only activated Work Orders belong in `workOrders[]`; planned Work Orders remain spec-only

## Rules

- A planned Work Order exists as a spec file but is not activated.
- An activated Work Order is recorded in `program-state.json` with `status: in_flight`.
- The dependency graph must remain acyclic.
- `futureGeneration` in dependency-state must equal the IDs represented in the future roadmap sequence.
- Work Order identity is unique.
- Post-merge finalization reconciles canonical state with actual Git history.
- The repository is the persistent architect memory; chat is not authoritative.
