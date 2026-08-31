/**
 * Dynamic AC-4 proof: governance validation identifies the current frontier
 * and Work Order identity from canonical repository state.
 *
 * The first tests run against the real repository checkout; the remaining
 * tests mutate fixture copies of the governance state and prove the reader
 * fails closed on every inconsistency class (a false-success reading of a
 * corrupted state would be a governance bypass).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  readProgramState,
  readWorkOrderStatus,
  currentLiveWorkOrder,
  GovernanceError,
} from '../src/platform/governance/index.js';

const REPO_ROOT = resolve(process.cwd());

function assertGovernanceError(block: () => unknown, code: string): void {
  assert.throws(
    block,
    (error: unknown) => {
      assert.ok(error instanceof GovernanceError, `expected GovernanceError, got ${String(error)}`);
      assert.equal(error.code, code);
      return true;
    },
  );
}

test('reads the real repository state: WORK-001 is in flight on the recorded branch', () => {
  const status = readProgramState(REPO_ROOT);
  assert.equal(status.architectureVersion, 'v1.0');
  assert.equal(status.frontier.currentLiveImplementation, 'WORK-001');
  assert.deepEqual(status.frontier.inFlight, ['WORK-001']);

  const live = currentLiveWorkOrder(status);
  assert.ok(live);
  assert.equal(live.id, 'WORK-001');
  assert.equal(live.status, 'in_flight');
  assert.equal(live.branch, 'feat/WORK-001-foundation');
  assert.equal(live.assuranceProfile, 'HIGH_ASSURANCE');
  assert.deepEqual(live.dependencies, []);
});

test('reads the real Work Order status line', () => {
  assert.equal(readWorkOrderStatus(join(REPO_ROOT, 'spec/work-orders/WORK-001.md')), 'in_flight');
});

interface FixtureOptions {
  programState?: (base: any) => any;
  frontierState?: (base: any) => any;
  workOrderStatus?: string;
}

/** Materialize a mutated copy of the real governance state in a temp repo. */
function fixtureState(options: FixtureOptions = {}): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'serviceos-gov-'));
  mkdirSync(join(root, 'spec/development-state'), { recursive: true });
  mkdirSync(join(root, 'spec/work-orders'), { recursive: true });

  const program = JSON.parse(
    readFileSyncText(join(REPO_ROOT, 'spec/development-state/program-state.json')),
  );
  const frontier = JSON.parse(
    readFileSyncText(join(REPO_ROOT, 'spec/development-state/frontier-state.json')),
  );
  const workOrder = readFileSyncText(join(REPO_ROOT, 'spec/work-orders/WORK-001.md'));

  writeFileSync(
    join(root, 'spec/development-state/program-state.json'),
    JSON.stringify(options.programState ? options.programState(program) : program, null, 2),
  );
  writeFileSync(
    join(root, 'spec/development-state/frontier-state.json'),
    JSON.stringify(options.frontierState ? options.frontierState(frontier) : frontier, null, 2),
  );
  writeFileSync(
    join(root, 'spec/work-orders/WORK-001.md'),
    options.workOrderStatus ? workOrder.replace('Status: in_flight', `Status: ${options.workOrderStatus}`) : workOrder,
  );
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function readFileSyncText(path: string): string {
  return readFileSync(path, 'utf8');
}

test('consistent fixture copy passes (control)', () => {
  const { root, cleanup } = fixtureState();
  try {
    const status = readProgramState(root);
    assert.equal(status.frontier.currentLiveImplementation, 'WORK-001');
  } finally {
    cleanup();
  }
});

test('status mismatch between program-state and Work Order file fails closed', () => {
  const { root, cleanup } = fixtureState({ workOrderStatus: 'planned' });
  try {
    assertGovernanceError(() => readProgramState(root), 'work-order-status-mismatch');
  } finally {
    cleanup();
  }
});

test('in-flight record without a branch fails closed', () => {
  const { root, cleanup } = fixtureState({
    programState: (program: any) => {
      program.workOrders[0].branch = undefined;
      return program;
    },
  });
  try {
    assertGovernanceError(() => readProgramState(root), 'program-state-missing-branch');
  } finally {
    cleanup();
  }
});

test('frontier/program in-flight set mismatch fails closed', () => {
  const { root, cleanup } = fixtureState({
    frontierState: (frontier: any) => {
      frontier.inFlight = [];
      return frontier;
    },
  });
  try {
    assertGovernanceError(() => readProgramState(root), 'frontier-state-mismatch');
  } finally {
    cleanup();
  }
});

test('currentLiveImplementation outside the in-flight set fails closed', () => {
  const { root, cleanup } = fixtureState({
    frontierState: (frontier: any) => {
      frontier.currentLiveImplementation = 'WORK-009';
      return frontier;
    },
  });
  try {
    assertGovernanceError(() => readProgramState(root), 'frontier-state-invalid-live');
  } finally {
    cleanup();
  }
});

test('invalid activated status fails closed', () => {
  const { root, cleanup } = fixtureState({
    programState: (program: any) => {
      program.workOrders[0].status = 'planned';
      return program;
    },
  });
  try {
    assertGovernanceError(() => readProgramState(root), 'program-state-invalid-status');
  } finally {
    cleanup();
  }
});

test('unparseable program-state fails closed', () => {
  const { root, cleanup } = fixtureState();
  writeFileSync(join(root, 'spec/development-state/program-state.json'), '{not json');
  try {
    assertGovernanceError(() => readProgramState(root), 'governance-file-invalid-json');
  } finally {
    cleanup();
  }
});

test('missing program-state file fails closed', () => {
  const { root, cleanup } = fixtureState();
  rmSync(join(root, 'spec/development-state/program-state.json'));
  try {
    assertGovernanceError(() => readProgramState(root), 'governance-file-unreadable');
  } finally {
    cleanup();
  }
});

test('duplicate Work Order records fail closed', () => {
  const { root, cleanup } = fixtureState({
    programState: (program: any) => {
      program.workOrders.push({ ...program.workOrders[0] });
      return program;
    },
  });
  try {
    assertGovernanceError(() => readProgramState(root), 'program-state-duplicate');
  } finally {
    cleanup();
  }
});

test('currentLiveWorkOrder returns null when nothing is in flight', () => {
  const { root, cleanup } = fixtureState({
    programState: (program: any) => {
      program.workOrders = [];
      return program;
    },
    frontierState: (frontier: any) => {
      frontier.inFlight = [];
      frontier.currentLiveImplementation = null;
      return frontier;
    },
  });
  try {
    const status = readProgramState(root);
    assert.equal(currentLiveWorkOrder(status), null);
  } finally {
    cleanup();
  }
});

