# Service Work Execution Model

ServiceOS turns a service definition into repeated Work instances.

## Example

```text
ServiceDefinition: Subcontractor Compliance
              |
              v
       Trigger/Event
              |
              v
         ServiceWork
              |
              v
          WorkAttempt
         /     |      \
        /      |       \
 deterministic  AI      human
   validation  via Zeck  approval
        \       |       /
         \      |      /
              Evidence
                 |
                 v
        Business Verification
                 |
                 v
           Work Transition
```

## Work attempt protocol

1. Persist durable attempt identity.
2. Evaluate business preconditions.
3. Determine which steps are deterministic, AI-backed, external, or human.
4. Execute deterministic business logic directly.
5. For AI-backed steps, create a Zeck execution intent and persist the foreign execution reference.
6. For external side effects, persist durable intent before execution.
7. Observe results.
8. Persist attributable evidence.
9. Verify the business outcome.
10. Transition Service Work only through the workflow authority.

## Retry protocol

Retries create a distinct attempt identity unless the operation is in a pre-dispatch convergence window where the original durable identity can be safely re-observed.

A late result from a superseded attempt cannot mutate the current Work state.

## Failed work

A failed Zeck execution is an execution failure input. It is not automatically a business failure. ServiceOS may request another Zeck attempt, perform deterministic recovery, request information, request human approval, or mark the business work failed according to the service definition and policy.
