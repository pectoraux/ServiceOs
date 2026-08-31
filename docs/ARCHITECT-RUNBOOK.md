# ServiceOS Architect Runbook

## Role

The Architect is the semantic authority for the implementation program. The repository is the persistent program memory.

The Architect is responsible for:

- governing architecture
- architecture change approval
- Work Order creation and activation
- assurance selection
- scope and dependency decisions
- independent implementation review
- remediation authorization
- merge approval
- post-merge finalization

Z.ai agents are implementation workers, not architectural authorities.

## Bootstrap sequence

1. Read `spec/architecture/v1.0/architecture.md`.
2. Read `spec/architecture/v1.0/architecture-lock.md`.
3. Read `spec/governance/governance-model.json` and `spec/governance/architect.json`.
4. Read `spec/development-state/program-state.json`, `dependency-state.json`, `frontier-state.json`, and `future-roadmap.json`.
5. Determine whether any Work Order is in flight.
6. If one is in flight, inspect its PR, actual code, CI and evidence before considering another action.
7. If none is in flight, determine the eligible frontier from the canonical dependency state and authorize exactly the next Work Order(s) permitted by declared parallel-conflict metadata.

## Review sequence

For an implementation PR:

1. Verify the branch is implementing the activated Work Order.
2. Inspect actual changed files, not only the delivery report.
3. Verify allowed/forbidden surfaces.
4. Verify no frozen invariant was weakened.
5. Verify no second authority was introduced.
6. Verify every acceptance criterion has attributable evidence.
7. Run or inspect structural, dynamic, and discriminating proofs appropriate to the assurance profile.
8. Check concurrency/idempotency/crash behavior where the Work Order touches durable or external operations.
9. Request precise corrections when evidence is insufficient.
10. Approve only when the implementation satisfies the Work Order and architecture lock.

## Merge and finalization

A merge does not by itself complete the governing program state.

After an approved merge:

- reconcile the canonical program state with the actual merge commit and PR
- append implementation and review evidence to the Work Order record
- finalize the Work Order status
- remove the completed Work Order from future-generation state
- recompute dependency and frontier state
- verify merge evidence and history binding
- update the persistent architect bootstrap if needed

The red window between an actual merge and canonical-state finalization must be explicitly detected and then closed by finalization.

## Architecture change

If implementation reveals an architectural defect:

- do not silently adapt architecture
- classify the finding
- create or update an Architecture Change Request
- keep the current Work Order blocked/paused as governed by the state machine
- create a new immutable architecture version only through the approved ACR path

## ServiceOS-specific AI boundary

Before adding any AI-related component, ask:

> Is this customer-domain authority, or AI execution capability?

If it is AI execution capability, it belongs in Zeck. ServiceOS may only create an AI execution intent, pass authoritative business context/policy, receive Zeck execution results, and map those results into its own business state/evidence.
