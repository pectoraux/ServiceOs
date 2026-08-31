/**
 * ServiceOS program-state governance reader (WORK-001).
 *
 * Provides read-side, fail-closed access to the canonical repository governance
 * state under `spec/development-state/` so tooling and CI can identify:
 * - the current frontier (current main revision, current live implementation);
 * - the identity, branch and status of every activated Work Order.
 *
 * This module deliberately does NOT reimplement the authoritative repository
 * governance checker (`scripts/governance-check.py`). It reads and validates
 * the same canonical files, reports the current frontier and Work Order
 * identity, and fails closed on inconsistency. It never mutates program state:
 * activation and finalization are Architect-only transitions.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export class GovernanceError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'GovernanceError';
  }
}

export interface WorkOrderRecord {
  id: string;
  status: 'in_flight' | 'blocked' | 'complete';
  branch: string | null;
  dependencies: string[];
  assuranceProfile?: string;
  activationIssue?: number | null;
  currentMainRevision?: string | null;
  implementationRevision?: string | null;
  pr?: number | null;
}

export interface ProgramStatus {
  architectureVersion: string;
  frontier: {
    currentMain: string;
    currentLiveImplementation: string | null;
    inFlight: string[];
    plannedFuture: string[];
  };
  workOrders: WorkOrderRecord[];
}

interface ProgramStateFile {
  architectureVersion?: string;
  workOrders?: {
    id?: string;
    status?: string;
    branch?: string;
    dependencies?: string[];
    assuranceProfile?: string;
    activationIssue?: number;
    currentMainRevision?: string;
    implementationRevision?: string | null;
    pr?: number | null;
  }[];
}

interface FrontierStateFile {
  currentMain?: string;
  currentLiveImplementation?: string | null;
  inFlight?: string[];
  plannedFuture?: string[];
}

const VALID_ACTIVATED_STATUSES = new Set(['in_flight', 'blocked', 'complete']);

function readJsonFile(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new GovernanceError(`cannot read ${path}: ${(cause as Error).message}`, 'governance-file-unreadable');
  }
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new GovernanceError(`${path} is not valid JSON: ${(cause as Error).message}`, 'governance-file-invalid-json');
  }
}

/** Parse the `Status:` line of a Work Order markdown file. */
export function readWorkOrderStatus(workOrderPath: string): string {
  let raw: string;
  try {
    raw = readFileSync(workOrderPath, 'utf8');
  } catch (cause) {
    throw new GovernanceError(`cannot read ${workOrderPath}: ${(cause as Error).message}`, 'work-order-unreadable');
  }
  const match = /^Status:\s*(\w+)\s*$/m.exec(raw);
  if (!match) {
    throw new GovernanceError(`${workOrderPath} has no Status line`, 'work-order-status-missing');
  }
  return match[1] as string;
}

/**
 * Read and validate the canonical development state for a repository checkout.
 * Throws `GovernanceError` (fail closed) when the state is internally
 * inconsistent; returns the frontier and activated Work Orders otherwise.
 */
export function readProgramState(repoRoot: string): ProgramStatus {
  const programPath = join(repoRoot, 'spec/development-state/program-state.json');
  const frontierPath = join(repoRoot, 'spec/development-state/frontier-state.json');

  const program = readJsonFile(programPath) as ProgramStateFile;
  const frontier = readJsonFile(frontierPath) as FrontierStateFile;

  if (typeof program.architectureVersion !== 'string' || program.architectureVersion === '') {
    throw new GovernanceError(`${programPath} is missing architectureVersion`, 'program-state-invalid');
  }

  const workOrders: WorkOrderRecord[] = [];
  const seen = new Set<string>();
  for (const entry of program.workOrders ?? []) {
    if (typeof entry.id !== 'string' || entry.id === '') {
      throw new GovernanceError(`${programPath} contains a Work Order record without an id`, 'program-state-invalid');
    }
    if (seen.has(entry.id)) {
      throw new GovernanceError(`duplicate Work Order record ${entry.id} in program-state`, 'program-state-duplicate');
    }
    seen.add(entry.id);
    if (typeof entry.status !== 'string' || !VALID_ACTIVATED_STATUSES.has(entry.status)) {
      throw new GovernanceError(
        `${entry.id} has invalid activated status ${JSON.stringify(entry.status)}`,
        'program-state-invalid-status',
      );
    }
    const status = entry.status as WorkOrderRecord['status'];
    if ((status === 'in_flight' || status === 'blocked') && typeof entry.branch !== 'string') {
      throw new GovernanceError(`${entry.id} is ${status} but records no branch`, 'program-state-missing-branch');
    }
    const specStatus = readWorkOrderStatus(join(repoRoot, 'spec/work-orders', `${entry.id}.md`));
    if (specStatus !== status) {
      throw new GovernanceError(
        `${entry.id} status mismatch: program-state says ${status}, Work Order file says ${specStatus}`,
        'work-order-status-mismatch',
      );
    }
    workOrders.push({
      id: entry.id,
      status,
      branch: entry.branch ?? null,
      dependencies: entry.dependencies ?? [],
      assuranceProfile: entry.assuranceProfile,
      activationIssue: entry.activationIssue ?? null,
      currentMainRevision: entry.currentMainRevision ?? null,
      implementationRevision: entry.implementationRevision ?? null,
      pr: entry.pr ?? null,
    });
  }

  const inFlight = frontier.inFlight ?? [];
  const programInFlight = new Set(
    workOrders.filter((w) => w.status === 'in_flight' || w.status === 'blocked').map((w) => w.id),
  );
  const frontierInFlight = new Set(inFlight);
  for (const id of programInFlight) {
    if (!frontierInFlight.has(id)) {
      throw new GovernanceError(
        `${id} is in_flight/blocked in program-state but absent from frontier-state.inFlight`,
        'frontier-state-mismatch',
      );
    }
  }
  for (const id of frontierInFlight) {
    if (!programInFlight.has(id)) {
      throw new GovernanceError(
        `${id} is inFlight in frontier-state but has no in_flight program-state record`,
        'frontier-state-mismatch',
      );
    }
  }

  const currentLive = frontier.currentLiveImplementation ?? null;
  if (currentLive !== null && !frontierInFlight.has(currentLive)) {
    throw new GovernanceError(
      `frontier currentLiveImplementation ${currentLive} is not in the in-flight set`,
      'frontier-state-invalid-live',
    );
  }

  return {
    architectureVersion: program.architectureVersion,
    frontier: {
      currentMain: frontier.currentMain ?? 'unknown',
      currentLiveImplementation: currentLive,
      inFlight: [...inFlight],
      plannedFuture: frontier.plannedFuture ?? [],
    },
    workOrders,
  };
}

/** The single live Work Order, when exactly one is in flight. */
export function currentLiveWorkOrder(status: ProgramStatus): WorkOrderRecord | null {
  const live = status.workOrders.filter((w) => w.status === 'in_flight');
  return live.length === 1 ? (live[0] as WorkOrderRecord) : null;
}
