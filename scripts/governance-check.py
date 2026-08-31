#!/usr/bin/env python3
"""Fail-closed ServiceOS governance checks for bootstrap and live program state."""
from __future__ import annotations
import json, re, sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
VALID_WO_STATUSES={"planned","in_flight","blocked","complete"}

def load(rel): return json.loads((ROOT/rel).read_text())
def fail(msg): print(f"FAIL: {msg}", file=sys.stderr); sys.exit(1)
def parse_requires(text):
    m=re.search(r"^Requires:\s*(.+)$", text, re.M)
    if not m: return []
    v=m.group(1).strip()
    return [] if v.lower()=="none" else [x.strip() for x in v.split(",") if x.strip()]

def main():
    required=[
        "README.md","AGENTS.md","FRESH-ARCHITECT-BOOTSTRAP.md",
        "docs/WORKFLOW.md","docs/ARCHITECT-RUNBOOK.md","docs/IMPLEMENTATION-RUNBOOK.md",
        "docs/ACTIVATION-PROTOCOL.md","docs/IMPLEMENTATION-HANDOFF.md",
        "spec/requirements.md","spec/requirement-traceability.md",
        "spec/architecture/v1.0/architecture.md","spec/architecture/v1.0/architecture-lock.md",
        "spec/architecture/v1.0/authority-matrix.md","spec/architecture/v1.0/zeck-boundary.md",
        "spec/architecture/v1.0/zeck-integration-contract.md","spec/architecture/v1.0/domain-model.md",
        "spec/architecture/v1.0/work-execution-model.md","spec/architecture/v1.0/vertical-model.md",
        "spec/architecture/v1.0/integration-model.md",
        "spec/governance/governance-model.json","spec/governance/architect.json",
        "spec/governance/future-roadmap.json","spec/governance/program-state-schema.json",
        "spec/development-state/program-state.json","spec/development-state/dependency-state.json",
        "spec/development-state/frontier-state.json","spec/development-state/checkpoint-state.json"]
    for rel in required:
        if not (ROOT/rel).exists(): fail(f"missing required artifact: {rel}")
    dep=load("spec/development-state/dependency-state.json"); road=load("spec/governance/future-roadmap.json")
    front=load("spec/development-state/frontier-state.json"); prog=load("spec/development-state/program-state.json")
    gov=load("spec/governance/governance-model.json")
    wo_files=sorted(p.stem for p in (ROOT/"spec/work-orders").glob("WORK-*.md")); all_ids=set(wo_files)
    road_ids=road["sequence"]
    if set(road_ids)!=all_ids or len(road_ids)!=len(set(road_ids)): fail("future roadmap must cover every Work Order file exactly once")
    future=list(dep["futureGeneration"]); current_complete=set(dep["currentGeneration"].get("complete",[])); current_inflight=set(dep["currentGeneration"].get("inFlight",[])); future_set=set(future)
    if current_complete & current_inflight: fail("currentGeneration overlaps complete and inFlight")
    if (current_complete|current_inflight)&future_set: fail("a Work Order appears in current and future generation")
    if current_complete|current_inflight|future_set!=all_ids: fail("generation state does not cover exactly all Work Order files")
    waves=sum(road["parallelWaves"],[])
    if set(waves)!=set(road_ids) or len(waves)!=len(set(waves)): fail("parallel waves must cover every Work Order exactly once")
    graph=dict(dep["futureGeneration"])
    records={r["id"]:r for r in prog.get("workOrders",[])}
    if len(records)!=len(prog.get("workOrders",[])): fail("duplicate Work Order identities in program-state")
    # Activated records carry the canonical dependency list even after they leave futureGeneration.
    full_graph={}
    full_graph.update(graph)
    for wid,r in records.items(): full_graph[wid]=r.get("dependencies",[])
    for wid in all_ids:
        full_graph.setdefault(wid,[])
    for wid,deps in full_graph.items():
        for d in deps:
            if d not in all_ids: fail(f"{wid} depends on unknown Work Order {d}")
    state={k:0 for k in all_ids}
    def visit(n):
        if state[n]==1: fail(f"dependency cycle detected at {n}")
        if state[n]==2: return
        state[n]=1
        for d in full_graph.get(n,[]): visit(d)
        state[n]=2
    for n in all_ids: visit(n)
    for wid,r in records.items():
        if wid not in all_ids: fail(f"program-state contains unknown Work Order {wid}")
        if r.get("status") not in {"in_flight","blocked","complete"}: fail(f"program-state {wid} has invalid activated status")
        if not r.get("branch") or "dependencies" not in r: fail(f"program-state {wid} missing branch/dependencies")
        if r["dependencies"]!=full_graph.get(wid,[]): fail(f"program-state {wid} dependencies != canonical dependency graph")
        if r["status"] in {"in_flight","blocked"} and not r.get("currentMainRevision"): fail(f"program-state {wid} missing currentMainRevision")
        if r["status"]=="complete" and not r.get("mergedAs"): fail(f"program-state {wid} complete without mergedAs provenance")
    for wid in future_set:
        if wid in records: fail(f"future Work Order {wid} also appears in program-state")
    for wid,r in records.items():
        if r["status"] in {"in_flight","blocked"} and wid not in current_inflight: fail(f"{wid} is {r['status']} but absent from currentGeneration.inFlight")
        if r["status"]=="complete" and wid not in current_complete: fail(f"{wid} is complete but absent from currentGeneration.complete")
    planned_next=front.get("plannedNext",[])
    if current_inflight:
        if planned_next: fail("frontier plannedNext must be empty while a Work Order is in flight")
    else:
        if not planned_next: fail("frontier plannedNext must identify the next eligible frontier")
        for wid in planned_next:
            if wid not in future_set: fail(f"frontier plannedNext contains non-future Work Order {wid}")
            if any(d not in current_complete for d in graph.get(wid,[])): fail(f"frontier Work Order {wid} is not dependency-eligible")
    if not records and not current_complete and not current_inflight and front.get("currentMain")=="bootstrap" and planned_next!=["WORK-001"]: fail("bootstrap frontier must point to WORK-001")
    lock=(ROOT/"spec/architecture/v1.0/architecture-lock.md").read_text()
    for needle in ["Zeck is the sole AI execution authority","Frozen architecture cannot be rewritten in place","ServiceOS does not persist an authoritative shadow copy of Zeck"]:
        if needle not in lock: fail(f"missing frozen invariant: {needle}")
    for p in (ROOT/"spec/work-orders").glob("WORK-*.md"):
        text=p.read_text()
        for needle in ["Status:","Assurance Profile:","## Scope","## Protected Surfaces","## Required Proof Classes","## Architecture Invariants","## Acceptance Criteria","## Verification Requirements"]:
            if needle not in text: fail(f"{p.name} missing {needle}")
        m=re.search(r"^Status:\s*(\w+)$",text,re.M)
        if not m or m.group(1) not in VALID_WO_STATUSES: fail(f"{p.name} has missing/invalid Status")
        expected=full_graph.get(p.stem,[])
        if parse_requires(text)!=expected: fail(f"{p.name} Requires list != canonical dependency graph")
    for wid,r in records.items():
        text=(ROOT/"spec/work-orders"/f"{wid}.md").read_text(); m=re.search(r"^Status:\s*(\w+)$",text,re.M)
        if not m or m.group(1)!=r["status"]: fail(f"{wid} spec Status != program-state status")
    expected_loop=["SENSE","UNDERSTAND","PLAN","CHECK","EXECUTE","VERIFY","REVIEW","MERGE","FINALIZE","LEARN","SENSE"]
    if gov.get("implementationControlLoop")!=expected_loop: fail("unexpected implementation control loop")
    print("PASS: ServiceOS governance repository is internally consistent")

if __name__=="__main__": main()
