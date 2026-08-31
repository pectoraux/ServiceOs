# ServiceOS Architect Activation Protocol

A Work Order file being `planned` does not authorize implementation. Activation is an Architect-only program-state transition.

## Preconditions

The Architect must confirm:

1. every dependency is complete and finalized;
2. the Work Order identity is unique;
3. the current main revision is known;
4. protected surfaces and assurance profile are declared in the Work Order;
5. no uncoordinated protected-surface conflict exists;
6. required proof classes are feasible in the current repository topology.

## Activation record

The Architect records the activation in `spec/development-state/program-state.json` with:

- `id`
- `title`
- `status: in_flight`
- `dependencies`
- `branch`
- `surfaceFlags`
- `assuranceProfile`
- `surfaces`
- `currentMainRevision`
- optional coordination metadata for parallel work

The corresponding Work Order status is updated to `in_flight` only as part of the same governed activation change.

## Implementation boundary

The Z.ai worker may implement only the activated Work Order on its recorded branch. A worker must stop and return control to the Architect when implementation requires any of:

- a frozen architecture change;
- a new authority not named by the architecture;
- weakened assurance;
- a new AI capability inside ServiceOS that belongs to Zeck;
- an unplanned protected surface;
- a dependency that is not complete.

## Completion

A worker completion report is evidence, not completion authority. Completion requires verification, independent Architect review, Architect approval/merge, and post-merge canonical state finalization against actual Git history.
