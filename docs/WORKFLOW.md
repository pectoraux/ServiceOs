# ServiceOS Implementation Workflow

This workflow is adapted from the repository-resident development system proven in WorkflowOS.

```text
Frozen Architecture
      |
      v
Requirements + Acceptance Criteria
      |
      v
Work Order
      |
      | Architect activation
      v
Canonical Program State: in_flight
      |
      v
Z.ai Implementation Worker
      |
      v
One Branch / One PR
      |
      v
Verification + Structural Proof + Discrimination
      |
      v
Architect Independent Review
   |                 |
changes             approve
   |                 |
   v                 v
same Work Order     Merge
   |                 |
   +-----------------+
                     |
                     v
           Post-Merge Finalization
                     |
                     v
              Derived State Rebuild
                     |
                     v
                 Next Frontier
```

## Adaptations from WorkflowOS

### Runtime object naming

The term **Work Order** is reserved for an implementation-program artifact.

The term **Service Work** is the customer runtime object representing a business job performed by ServiceOS.

### AI boundary

WorkflowOS historically included its own LLM and agent integration layers. ServiceOS intentionally does not.

The ServiceOS implementation workflow therefore treats Zeck as the external AI execution provider and verifies that ServiceOS contains no duplicate AI authority.

### Completion rule

An implementation is complete only when:

- the actual code satisfies the activated Work Order
- all required proofs pass
- the Architect approves
- the PR is merged
- canonical repository state is finalized against actual Git history

Claims in chat, a PR description, or an agent response are not completion authority.
