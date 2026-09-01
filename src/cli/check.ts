/**
 * ServiceOS check entrypoint (WORK-001 governance wiring).
 *
 * The single development check command (`npm run check`) runs, in order:
 *   1. the TypeScript build (compile is the first proof);
 *   2. configuration validation on the current environment (fail closed);
 *   3. architecture structural checks: module tree vs frozen architecture,
 *      dependency direction, forbidden AI/Zeck surfaces, dependency policy;
 *   4. canonical governance state validation: the current frontier and
 *      in-flight Work Order identity (AC-4), with branch conformance;
 *   5. the repository-resident governance checker (scripts/governance-check.py)
 *      is run by the surrounding npm script — the repository stays the
 *      authority, this CLI never mutates governance state.
 *
 * Exit code 0 only when everything passes. Prints a concise frontier report.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../platform/config/index.js';
import {
  checkArchitecture,
  checkIdentityTenancyBoundaries,
  checkPackageDependencies,
  checkWorkBoundaries,
  readProgramState,
  currentLiveWorkOrder,
  GovernanceError,
} from '../platform/governance/index.js';

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function gitBranch(): string | null {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
    return branch === 'HEAD' ? null : branch;
  } catch {
    return null;
  }
}

function main(): void {
  const repoRoot = process.cwd();
  const srcRoot = resolve(repoRoot, 'src');
  if (!existsSync(resolve(repoRoot, 'spec')) || !existsSync(srcRoot)) {
    fail(`expected to run from the repository root (spec/ and src/ not found under ${repoRoot})`);
  }

  // 1. Environment hygiene: validate configuration even in check mode.
  try {
    const config = loadConfig(process.env, { requireDatabase: false });
    console.log(
      `config: valid (port=${config.port}, databaseUrl=${config.databaseUrl === null ? 'not set' : 'set'}, logLevel=${config.logLevel})`,
    );
  } catch (error) {
    fail(`configuration validation failed: ${(error as Error).message}`);
  }

  // 2. Architecture structural checks against the real tree.
  const violations = [
    ...checkArchitecture({ srcRoot, repoRoot }),
    ...checkPackageDependencies(resolve(repoRoot, 'package.json')),
    ...checkIdentityTenancyBoundaries(srcRoot),
    ...checkWorkBoundaries({ srcRoot, migrationsDir: resolve(repoRoot, 'db/migrations') }),
  ];
  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(`FAIL [${violation.code}] ${violation.file ? `${violation.file}: ` : ''}${violation.detail}`);
    }
    fail(`architecture structural checks found ${violations.length} violation(s)`);
  }
  const moduleCount = checkArchitectureModuleCount(srcRoot);
  console.log(
    `architecture: module tree conforms to frozen v1.0 architecture (${moduleCount} modules, no violations)`,
  );
  console.log(
    `identity/tenancy: single authorization chain, single identity engine, single route-guard factory (no violations)`,
  );
  console.log(
    `work: no transition engine in /work, no Zeck state machine, migration prefixes conform (no violations)`,
  );

  // 3. Canonical governance state: frontier + Work Order identity (AC-4).
  let status;
  try {
    status = readProgramState(repoRoot);
  } catch (error) {
    if (error instanceof GovernanceError) {
      fail(`governance state invalid [${error.code}]: ${error.message}`);
    }
    throw error;
  }
  console.log(
    `frontier: currentMain=${status.frontier.currentMain} currentLiveImplementation=${status.frontier.currentLiveImplementation ?? 'none'}`,
  );
  console.log(
    `in-flight: ${status.frontier.inFlight.length === 0 ? 'none' : status.frontier.inFlight.join(', ')}`,
  );

  const live = currentLiveWorkOrder(status);
  if (status.frontier.inFlight.length > 1) {
    console.log('note: multiple Work Orders are in flight; coordination state should be inspected');
  }

  // 4. Branch conformance for the in-flight Work Order (worker guard).
  // EXPECT_BRANCH is deliberately unprefixed: it is a tooling/CI concern, not
  // ServiceOS runtime configuration, and the config typo guard fails closed on
  // unknown SERVICEOS_* variables.
  const expectedBranch = process.env.EXPECT_BRANCH ?? gitBranch();
  if (live !== null) {
    console.log(
      `work order: ${live.id} [${live.status}] on branch ${live.branch} (assurance ${live.assuranceProfile ?? 'unknown'})`,
    );
    if (expectedBranch !== null) {
      if (expectedBranch === 'main') {
        console.log(
          `note: running on main while ${live.id} is in flight on ${live.branch}; post-merge finalization may be pending`,
        );
      } else if (expectedBranch !== live.branch) {
        fail(
          `current branch "${expectedBranch}" does not match the in-flight Work Order branch "${live.branch}"; implementation work belongs on the Work Order branch`,
        );
      }
    }
  } else if (status.frontier.inFlight.length === 0) {
    console.log('work order: no Work Order in flight (planned specs do not authorize implementation)');
  }

  console.log('PASS: ServiceOS build, architecture, configuration and governance checks');
}

function checkArchitectureModuleCount(srcRoot: string): number {
  // Cheap recount for reporting; checkArchitecture already validated equality.
  try {
    return readdirSync(resolve(srcRoot, 'modules'), { withFileTypes: true }).filter((e) => e.isDirectory()).length;
  } catch {
    return 0;
  }
}

main();
