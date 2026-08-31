# ServiceOS Development State

`spec/development-state/` is the repository-resident program state. It is the persistent memory of the Architect and implementation program; chat and PR comments are coordination only.

## Canonical artifacts

- `program-state.json` — lifecycle records for activated Work Orders, architect decisions and resumption metadata.
- `dependency-state.json` — canonical current/future Work Order dependency mapping.
- `frontier-state.json` — derived eligible implementation frontier.
- `checkpoint-state.json` — checkpoint/proof state bound to implementation revisions.
- `../governance/future-roadmap.json` — approved future sequence and illustrative parallel waves.
- `../governance/program-state-schema.json` — schema for activated Work Order records.

## Lifecycle rules

1. A Work Order spec file may exist with `Status: planned` without being activated.
2. Activation is Architect authority and creates one `program-state.workOrders[]` record with `status: in_flight` and its exact canonical dependency list.
3. A blocked Work Order remains represented in `program-state.workOrders[]` with `status: blocked` and remains in `currentGeneration.inFlight`.
4. A merged Work Order becomes `complete` only after the Architect verifies merge evidence and performs post-merge finalization. It moves to `currentGeneration.complete` and is removed from `futureGeneration`.
5. The Work Order spec `Status:` must match the activated/complete lifecycle status recorded in `program-state.json`.
6. `futureGeneration` contains only Work Orders not yet activated/completed. Its ordered keys equal the roadmap sequence for those planned Work Orders.
7. `frontier-state.json` is derived: `plannedNext` contains only future Work Orders whose dependencies are complete; Architect activation is still required.
8. One Work Order identity maps to one branch/PR lifecycle. The implementation worker may not activate or merge its own Work Order.
9. Any actual merge without state finalization is a red window and must be reconciled before another frontier is authorized.
10. The governance checker validates these rules and must remain valid beyond bootstrap; it must never assume `workOrders[]` is permanently empty.
