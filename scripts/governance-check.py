#!/usr/bin/env python3
"""Fail-closed ServiceOS repository governance sanity checks."""
from __future__ import annotations
import json, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def load(rel):
    return json.loads((ROOT/rel).read_text())

def fail(msg):
    print(f"FAIL: {msg}", file=sys.stderr)
    sys.exit(1)

def main():
    required = [
        'README.md','AGENTS.md','FRESH-ARCHITECT-BOOTSTRAP.md',
        'docs/WORKFLOW.md','docs/ARCHITECT-RUNBOOK.md','docs/IMPLEMENTATION-RUNBOOK.md',
        'spec/architecture/v1.0/architecture.md','spec/architecture/v1.0/architecture-lock.md',
        'spec/architecture/v1.0/authority-matrix.md','spec/architecture/v1.0/zeck-integration-contract.md',
        'spec/requirements.md','spec/requirement-traceability.md'
    ]
    for rel in required:
        if not (ROOT/rel).exists(): fail(f'missing required artifact: {rel}')
    dep = load('spec/development-state/dependency-state.json')
    road = load('spec/governance/future-roadmap.json')
    front = load('spec/development-state/frontier-state.json')
    prog = load('spec/development-state/program-state.json')
    if list(dep['futureGeneration']) != road['sequence']:
        fail('futureGeneration key order != roadmap sequence')
    if set(sum(road['parallelWaves'], [])) != set(road['sequence']):
        fail('parallel waves do not cover exactly the roadmap Work Orders')
    if len(sum(road['parallelWaves'], [])) != len(set(sum(road['parallelWaves'], []))):
        fail('parallel waves contain duplicate Work Order identities')
    wo_files = sorted(p.stem for p in (ROOT/'spec/work-orders').glob('WORK-*.md'))
    if wo_files != sorted(dep['futureGeneration']):
        fail('Work Order files != dependency-state futureGeneration')
    if len(wo_files) != len(set(wo_files)): fail('duplicate Work Order identity')
    if prog['workOrders']:
        # Bootstrap package must begin with no active implementations.
        fail('bootstrap program-state must contain no activated Work Orders')
    if front['plannedNext'] != ['WORK-001']:
        fail('bootstrap frontier must point to WORK-001')
    # Dependency references must point to known Work Orders or be none.
    ids=set(dep['futureGeneration'])
    for wid, deps in dep['futureGeneration'].items():
        for d in deps:
            if d not in ids: fail(f'{wid} depends on unknown {d}')
    # Simple DAG check.
    state={k:0 for k in ids}
    def visit(n):
        if state[n]==1: fail(f'dependency cycle detected at {n}')
        if state[n]==2: return
        state[n]=1
        for d in dep['futureGeneration'][n]: visit(d)
        state[n]=2
    for n in ids: visit(n)
    # Frozen boundary terms must exist in the lock.
    lock=(ROOT/'spec/architecture/v1.0/architecture-lock.md').read_text()
    for needle in ['Zeck is the sole AI execution authority','Frozen architecture cannot be rewritten in place','ServiceOS does not persist an authoritative shadow copy of Zeck']:
        if needle not in lock: fail(f'missing frozen invariant: {needle}')
    # Every Work Order must declare scope, assurance and required proof headings.
    for p in (ROOT/'spec/work-orders').glob('WORK-*.md'):
        s=p.read_text()
        for needle in ['Status: planned','Assurance Profile:','## Scope','## Protected Surfaces','## Required Proof Classes','## Architecture Invariants','## Acceptance Criteria','## Verification Requirements']:
            if needle not in s: fail(f'{p.name} missing {needle}')
        m=re.search(r'^Requires:\s*(.+)$', s, re.M)
        declared=[] if not m or m.group(1).strip().lower()=='none' else [x.strip() for x in m.group(1).split(',')]
        expected=dep['futureGeneration'][p.stem]
        if declared != expected: fail(f'{p.name} Requires list {declared} != dependency-state {expected}')
    print('PASS: ServiceOS governance bootstrap is internally consistent')

if __name__ == '__main__': main()
