# ADR-0005 — Business State and Zeck Execution State Stay Separate

**Status:** Accepted
**Date:** 2026-08-31

ServiceOS `ServiceWork` state is not a projection of Zeck execution state. A Zeck execution may succeed, fail, wait, retry or complete without directly determining the business result.

ServiceOS decides business completion using domain policy and business evidence.
