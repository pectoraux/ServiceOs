# ADR-0001 — Zeck Is the Sole AI Execution Authority

**Status:** Accepted
**Date:** 2026-08-31

## Decision

ServiceOS delegates all AI execution to `pectoraux/Zeck`.

ServiceOS will not implement model routing, AI agents, AI tool execution, AI context compilation, AI planning, AI-provider adapters, AI execution verification, AI execution learning, or AI sandbox management.

ServiceOS integrates with Zeck through a thin `/zeck` boundary.

## Rationale

Zeck already defines an execution abstraction spanning models, tools, agents, context, verification, human intervention, isolation and provider federation. Keeping that authority in one platform prevents duplicate infrastructure and allows ServiceOS to remain focused on business-domain execution.
