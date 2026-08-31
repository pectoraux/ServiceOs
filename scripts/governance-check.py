#!/usr/bin/env python3
"""Fail-closed ServiceOS governance checks for bootstrap and live program state."""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VALID_WO_STATUSES = {"planned", "in_flight", "blocked", "complete"}


def load(rel: str):
    return json.loads((ROOT / rel).read_text())


def fail(msg: str):
    print(f"FAIL: {msg}", file=sys.stderr)
    sys.exit(1)


def parse_requires(text: str):
    match = re.search(r"^Requires:\s*(.+)$", text, re.MULTILINE)
    if not match:
        return []
    value = match.group(1).strip()
    return [] if value.lower() == "none" else [x.strip() for x in value.split(",") if x.strip()]


def main():
    required = [
        "README.md", "AGENTS.md", "FRESH-ARCHITECT-BOOTSTRAP.md",
        "docs/WORKFLOW.md", "docs/ARCHITECT-RUNBOOK.md", "docs/IMPLEMENTATION-RUNBOOK.md",
        "docs/ACTIVATION-PROTOCOL.md", "spec/requirements.md", "spec/requirement-traceability.md",
        "spec/architecture/v1.0/architecture.md", "spec/architecture/v1.0/architecture-lock.md",
        "spec/architecture/v1.0/authority-matrix.md", "spec/architecture/v1.0/zeck-integration-contract.md",
        "spec/governance/governance-model.json", "spec/governance/architect.json",
        "spec/governance/future-roadmap.json", "spec/development-state/program-state.json",
        "spec/development-state/dependency-state.json", "spec/development-state/frontier-state.json",
        "spec/development-state/checkpoint-state.json",
    ]
    for rel in required:
        if not (ROOT / rel).exists():
            fail(f"missing required artifact: {rel}")

    dep = load("spec/development-state/dependency-state.json")
    road = load("spec/governance/future-roadmap.json")
    front = load("spec/development-state/frontier-state.json")
    prog = load("spec/development-state/program-state.json")
    gov = load("spec/governance/governance-model.json")

    road_ids = road["sequence"]
    if list(dep["futureGeneration"]) != road_ids:
        fail("futureGeneration key order != roadmap sequence")
    waves = sum(road["parallelWaves"], [])
    if set(waves) != set(road_ids) or len(waves) != len(set(waves)):
        fail("parallel waves do not cover each roadmap Work Order exactly once")

    wo_files = sorted(p.stem for p in (ROOT / "spec/work-orders").glob("WORK-*.md"))
    if sorted(wo_files) != sorted(road_ids) or len(wo_files) != len(set(wo_files)):
        fail("Work Order files != canonical roadmap identities")

    ids = set(road_ids)
    current_complete = set(dep["currentGeneration"].get("complete", []))
    current_inflight = set(dep["currentGeneration"].get("inFlight", []))
    future = set(dep["futureGeneration"])
    if current_complete & current_inflight:
        fail("currentGeneration overlaps complete and inFlight")
    if (current_complete | current_inflight) & future:
        fail("a Work Order appears in current and future generation")
    if current_complete | current_inflight | future != ids:
        fail("generation state does not cover exactly all known Work Orders")

    graph = dep["futureGeneration"]
    for wid, deps in graph.items():
        for d in deps:
            if d not in ids:
                fail(f"{wid} depends on unknown {d}")

    state = {k: 0 for k in ids}
    def visit(n: str):
        if state[n] == 1:
            fail(f"dependency cycle detected at {n}")
        if state[n] == 2:
            return
        state[n] = 1
        for d in graph.get(n, []):
            if d in graph:
                visit(d)
        state[n] = 2
    for n in ids:
        visit(n)

    records = {r["id"]: r for r in prog.get("workOrders", [])}
    if len(records) != len(prog.get("workOrders", [])):
        fail("duplicate Work Order identities in program-state")
    for wid, record in records.items():
        if wid not in ids:
            fail(f"program-state contains unknown Work Order {wid}")
        if record.get("status") not in {"in_flight", "blocked", "complete"}:
            fail(f"program-state {wid} has invalid activated status")
        if record.get("branch") is None:
            fail(f"program-state {wid} missing branch")
        if record.get("dependencies") != graph.get(wid, []):
            fail(f"program-state {wid} dependencies != canonical dependency-state")

    for wid in future:
        if wid in records:
            fail(f"future Work Order {wid} also appears in program-state")
    for wid, record in records.items():
        status = record["status"]
        if status in {"in_flight", "blocked"} and wid not in current_inflight:
            fail(f"{wid} is {status} but absent from currentGeneration.inFlight")
        if status == "complete" and wid not in current_complete:
            fail(f"{wid} is complete but absent from currentGeneration.complete")

    planned_next = front.get("plannedNext", [])
    if not planned_next:
        fail("frontier plannedNext must not be empty")
    for wid in planned_next:
        if wid not in future:
            fail(f"frontier plannedNext contains non-future Work Order {wid}")
        for d in graph.get(wid, []):
            if d not in current_complete:
                fail(f"frontier Work Order {wid} is blocked by incomplete dependency {d}")

    if not records and not current_complete and not current_inflight and front.get("currentMain") == "bootstrap":
        if planned_next != ["WORK-001"]:
            fail("bootstrap frontier must point to WORK-001")

    lock = (ROOT / "spec/architecture/v1.0/architecture-lock.md").read_text()
    for needle in [
        "Zeck is the sole AI execution authority",
        "Frozen architecture cannot be rewritten in place",
        "ServiceOS does not persist an authoritative shadow copy of Zeck",
    ]:
        if needle not in lock:
            fail(f"missing frozen invariant: {needle}")

    for p in (ROOT / "spec/work-orders").glob("WORK-*.md"):
        text = p.read_text()
        for needle in [
            "Status:", "Assurance Profile:", "## Scope", "## Protected Surfaces",
            "## Required Proof Classes", "## Architecture Invariants", "## Acceptance Criteria",
            "## Verification Requirements",
        ]:
            if needle not in text:
                fail(f"{p.name} missing {needle}")
        status_match = re.search(r"^Status:\s*(\w+)$", text, re.MULTILINE)
        if not status_match or status_match.group(1) not in VALID_WO_STATUSES:
            fail(f"{p.name} has missing/invalid Status")
        if parse_requires(text) != graph.get(p.stem, []):
            fail(f"{p.name} Requires list != canonical dependency-state")

    for wid, record in records.items():
        text = (ROOT / "spec/work-orders" / f"{wid}.md").read_text()
        status_match = re.search(r"^Status:\s*(\w+)$", text, re.MULTILINE)
        if not status_match or status_match.group(1) != record["status"]:
            fail(f"{wid} spec Status != program-state status")

    expected_loop = ["SENSE", "UNDERSTAND", "PLAN", "CHECK", "EXECUTE", "VERIFY", "REVIEW", "MERGE", "FINALIZE", "LEARN", "SENSE"]
    if gov.get("implementationControlLoop") != expected_loop:
        fail("unexpected implementation control loop")

    print("PASS: ServiceOS governance repository is internally consistent")


if __name__ == "__main__":
    main()
