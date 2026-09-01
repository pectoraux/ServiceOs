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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  readProgramState,
  readWorkOrderStatus,
  currentLiveWorkOrder,
  GovernanceError,
} from '../src/platform/governance/index.js';

const REPO_ROOT = resolve(process.cwd());

/** The currently in-flight Work Order, resolved from canonical state (era-relative). */
function liveWorkOrderId(): string {
  const program = JSON.parse(readFileSyncText(join(REPO_ROOT, 'spec/development-state/program-state.json')));
  const live = (program.workOrders as { id: string; status: string }[]).find(
    (entry) => entry.status === 'in_flight',
  );
  assert.ok(live, 'expected exactly one in-flight Work Order in canonical state');
  return live.id;
}

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

test('reads the real repository state: the activated Work Order is in flight on the recorded branch', () => {
  const status = readProgramState(REPO_ROOT);
  assert.equal(status.architectureVersion, 'v1.0');
  const liveId = liveWorkOrderId();
  assert.ok(status.frontier.currentLiveImplementation);
  assert.equal(status.frontier.currentLiveImplementation, liveId);
  assert.deepEqual(status.frontier.inFlight, [liveId]);

  const live = currentLiveWorkOrder(status);
  assert.ok(live);
  assert.equal(live.id, liveId);
  assert.equal(live.status, 'in_flight');
  assert.equal(typeof live.branch, 'string');
  assert.match(live.branch as string, /^feat\//);
  assert.ok(['CRITICAL', 'HIGH_ASSURANCE', 'STANDARD', 'LIGHT'].includes(live.assuranceProfile ?? ''));
});

test('reads the real Work Order status line', () => {
  assert.equal(readWorkOrderStatus(join(REPO_ROOT, `spec/work-orders/${liveWorkOrderId()}.md`)), 'in_flight');
});

interface FixtureOptions {
  programState?: (base: any) => any;
  frontierState?: (base: any) => any;
  workOrderStatus?: string;
}

/** Mutate the in-flight record of a program-state copy (era-relative). */
function mutateLiveRecord(program: any, mutate: (live: any) => void): any {
  const live = (program.workOrders as { status: string }[]).find((entry) => entry.status === 'in_flight');
  assert.ok(live, 'fixture base must contain an in-flight Work Order');
  mutate(live);
  return program;
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
  // The reader cross-checks EVERY work-order file, so the fixture copies
  // every work order file from canonical state.
  const workOrderFiles = readdirSync(join(REPO_ROOT, 'spec/work-orders')).filter((name) =>
    /^WORK-\d+\.md$/.test(name),
  );
  const liveId = liveWorkOrderId();

  writeFileSync(
    join(root, 'spec/development-state/program-state.json'),
    JSON.stringify(options.programState ? options.programState(program) : program, null, 2),
  );
  writeFileSync(
    join(root, 'spec/development-state/frontier-state.json'),
    JSON.stringify(options.frontierState ? options.frontierState(frontier) : frontier, null, 2),
  );
  for (const fileName of workOrderFiles) {
    const text = readFileSyncText(join(REPO_ROOT, 'spec/work-orders', fileName));
    const mutated =
      options.workOrderStatus !== undefined && fileName === `${liveId}.md`
        ? text.replace('Status: in_flight', `Status: ${options.workOrderStatus}`)
        : text;
    writeFileSync(join(root, 'spec/work-orders', fileName), mutated);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function readFileSyncText(path: string): string {
  return readFileSync(path, 'utf8');
}

test('consistent fixture copy passes (control)', () => {
  const { root, cleanup } = fixtureState();
  try {
    const status = readProgramState(root);
    assert.equal(status.frontier.currentLiveImplementation, liveWorkOrderId());
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
    programState: (program: any) =>
      mutateLiveRecord(program, (live: any) => {
        live.branch = undefined;
      }),
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
      // Era-independent: a synthetic id that can never be in the in-flight
      // set (the fixture's original hard-coded future id became the live
      // Work Order when that Work Order activated, making the mutation a
      // no-op).
      frontier.currentLiveImplementation = 'WORK-999';
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
    programState: (program: any) =>
      mutateLiveRecord(program, (live: any) => {
        live.status = 'planned';
      }),
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
    programState: (program: any) =>
      mutateLiveRecord(program, (live: any) => {
        program.workOrders.push({ ...live });
      }),
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

