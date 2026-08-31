# ServiceOS Architecture Lock — v1.0

This document contains the load-bearing invariants of the frozen ServiceOS architecture.

## Authority invariants

1. `/work` + `/workflow` are the sole ServiceOS authority for Service Work identity and business-work state transitions.
2. `/policies` is the sole ServiceOS authority for business-policy resolution.
3. `/approvals` is the sole ServiceOS authority for business/human approval state.
4. `/evidence` is the sole ServiceOS authority for ServiceOS business evidence and business outcome verification records.
5. `/zeck` is an integration boundary only; it is not an AI implementation authority inside ServiceOS.
6. Zeck is the sole AI execution authority for ServiceOS AI work.
7. ServiceOS must not implement a second model, agent, AI-tool, context, planning, routing, AI-verification, or AI-learning authority.

## State separation

8. `ServiceWork` state is not copied from Zeck Execution state.
9. Zeck Execution state is never used as a direct Service Work transition without ServiceOS business verification/preconditions.
10. A ServiceOS Work Attempt may reference multiple Zeck executions.
11. A Zeck execution may be retried/converged independently of the Service Work lifecycle.

## External effects

12. Business external side effects require durable intent, authorization, idempotency, adapter execution, observed result, and business evidence when relevant.
13. Zeck invocation itself is an external side effect and must be idempotent from ServiceOS's perspective.
14. ServiceOS must never assume that a successful HTTP/transport response from Zeck means the business objective succeeded.

## Tenancy/security

15. Tenant/project/customer ownership is resolved server-side before reads or writes.
16. Cross-tenant access fails closed.
17. AI provider secrets and model credentials do not reside in ServiceOS.

## Persistence

18. PostgreSQL is the authoritative ServiceOS persistence layer.
19. ServiceOS does not persist an authoritative shadow copy of Zeck's execution lifecycle.
20. External provider identities are preserved verbatim where required for audit/idempotency.

## Architecture governance

21. Frozen architecture cannot be rewritten in place.
22. Architecture changes require an approved ACR and a new architecture version.
23. Work Orders are implementation-program artifacts and are immutable in identity.
24. Implementation agents cannot activate Work Orders or merge their own PRs.
25. Repository state is authoritative over chat/LLM memory.

## Proof requirements

26. Authority-boundary invariants require structural and behavioral proof.
27. External side-effect/idempotency claims require dynamic proof.
28. Concurrency-sensitive claims require independent-actor proof where practical.
29. False-success paths require discriminating tests.
30. Missing reads must be distinguishable from genuine empty results.

## Vertical invariants

31. Vertical packages may define business semantics but may not redefine horizontal Service Work lifecycle authority.
32. Vertical packages may add workflows/policies/entities but may not add AI infrastructure.
33. Customer-specific configuration may specialize policies/workflows but may not weaken frozen authority boundaries.
