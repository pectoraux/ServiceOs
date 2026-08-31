# ServiceOS v1.0 Authority Matrix

This is a normative companion to `architecture.md` and `architecture-lock.md`.
It answers one question before implementation: **which system is allowed to decide each fact or mutate each state?**

| Concern | Authoritative owner | Allowed ServiceOS interaction | Forbidden implementation pattern |
|---|---|---|---|
| User identity | `/auth` | authenticate/resolve principal | second identity store in a vertical |
| Organization/membership | `/organizations` | read/change through its public contract | route-local membership logic |
| Tenant scope | `/organizations` + authorization contract | server-resolved scope | client-supplied trust boundary |
| Service definition/version | `/services` | create/register/read versions | vertical-local competing catalog |
| Vertical package | `/verticals` | register/version/resolve package | hard-coded industry authority in horizontal modules |
| Business entity | `/entities` | tenant-bound entity CRUD | cross-tenant entity lookup |
| Service Work identity | `/work` | create/read/attempt/dependency contracts | workflow module creating a second work store |
| Service Work state transition | `/workflow` | submit authorized transition | direct row update from another module |
| Business policy decision | `/policies` | resolve/evaluate policy contract | workflow/vertical duplicate policy engine |
| Human/business approval | `/approvals` | request/decide approval | treating AI output as approval |
| External interaction ledger | `/interactions` | create/observe idempotent interaction | direct provider mutation from domain module |
| Email/SMS/voice/etc. | `/integrations` + adapters | provider-neutral effect ports | SDK calls from business modules |
| Notifications | `/notifications` | delivery request/status through owned interface | UI or vertical owning delivery state |
| AI execution | `pectoraux/Zeck` | submit intent, receive/correlate execution reference/result | models, agents, tools, AI routing/planning/verification inside ServiceOS |
| AI execution identity/state | Zeck | reference only | shadow lifecycle/state machine in ServiceOS |
| Business evidence | `/evidence` | attach/read/verify business evidence | using Zeck evidence as automatic business acceptance |
| Business outcome | `/work` + `/evidence` + vertical outcome contract | verify and transition | Zeck success directly changing business state |
| Service billing/metering | `/billing` | bill/measure service work | duplicating Zeck's AI usage ledger |
| AI usage/cost | Zeck | consume references needed for service economics | ServiceOS becoming AI cost authority |
| Audit trail | `/audit` | append/read privileged ServiceOS events | mutable activity log treated as authority |
| Program/architecture governance | repository + Architect | Work Orders, ACRs, state finalization | implementation agent changing governing state |

## AI classification rule

A requested capability belongs in Zeck when its primary purpose is to determine **how AI computes or executes**: model selection, prompting, context compilation, tool use, agent execution, AI planning, provider routing, AI verification, AI learning or AI runtime isolation.

A capability remains in ServiceOS when it determines **what the business means**: business state, authorization, policy, approval, contractual/business outcome, deterministic domain rule, external business side effect, or business evidence.

When a requirement appears to straddle the boundary, create an ADR/ACR rather than resolving the ambiguity inside an implementation PR.
