# WorkflowOS → ServiceOS Development Pattern

This is the explicit adaptation of the implementation workflow observed in `pectoraux/WorkflowOS`.

## Preserved

- repository-resident architecture as persistent truth
- frozen architecture + immutable versioning
- Work Orders as the implementation unit
- one Work Order / branch / PR
- explicit activation by Architect
- dependency-aware frontier
- declared change surfaces and conflict metadata
- assurance profiles selected deterministically from impact
- structural architecture checks
- behavioral tests
- discrimination/mutation tests for false-success paths
- concurrency/crash proofs for durable/external boundaries
- evidence over implementation claims
- Architect independent review
- corrections return to the same governed Work Order/PR lifecycle
- architect-only merge
- post-merge finalization against actual Git history
- fresh-architect bootstrap from repository state

## Removed/reassigned

WorkflowOS historically contained `/llm` and `/agents` capabilities because it was itself an AI-assisted software-engineering product.

ServiceOS does not reproduce those capabilities. They are externalized to Zeck.

The ServiceOS implementation worker is Z.ai, but Z.ai is a development worker, not the ServiceOS runtime AI authority.

## New boundary

The customer runtime has two independent durable concepts:

- **Service Work** — ServiceOS business authority
- **Zeck Execution** — Zeck AI execution authority

The implementation-program runtime also has Work Orders, but those are governance artifacts and must not be confused with customer Service Work.
