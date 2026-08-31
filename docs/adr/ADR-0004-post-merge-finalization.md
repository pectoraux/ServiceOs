# ADR-0004 — Post-Merge Finalization Is Mandatory

**Status:** Accepted
**Date:** 2026-08-31

GitHub merge evidence and canonical program state are separate facts. A merged PR whose Work Order remains `in_flight` is a detected red window. The Architect must finalize program state against the actual merge commit before the Work Order becomes `complete`.
