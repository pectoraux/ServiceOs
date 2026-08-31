# ADR-0002 — No Second Authority

**Status:** Accepted
**Date:** 2026-08-31

A module may consume an authoritative service through a public interface but must not recreate its state, policy engine, workflow, persistence authority, execution engine or evidence authority.

For AI, the prohibition is explicit: ServiceOS cannot create a second Zeck-like AI authority.
