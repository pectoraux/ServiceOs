/**
 * End-to-end proof of the check entrypoint (WORK-001).
 *
 * Spawns `dist/src/cli/check.js` as a subprocess against the real repository
 * with a controlled minimal environment. This is the regression that would
 * have caught the CI failure where an unknown SERVICEOS_* tooling variable
 * tripped the configuration typo guard: the CLI must validate exactly the
 * documented environment contract and exit 0 on a conforming repository.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

function runCheckCli(env: Record<string, string>): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [resolve('dist/src/cli/check.js')], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

test('check CLI exits 0 on the real repository with a clean environment', () => {
  const result = runCheckCli({
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
  });
  assert.equal(
    result.status,
    0,
    `expected exit 0\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.match(result.stdout, /PASS: ServiceOS build, architecture, configuration and governance checks/);
  assert.match(result.stdout, /currentLiveImplementation=WORK-001/);
  assert.match(result.stdout, /feat\/WORK-001-foundation/);
});

test('check CLI exits 0 when EXPECT_BRANCH matches the in-flight Work Order branch', () => {
  const result = runCheckCli({
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    EXPECT_BRANCH: 'feat/WORK-001-foundation',
  });
  assert.equal(result.status, 0, result.stderr);
});

test('check CLI fails closed when EXPECT_BRANCH contradicts the in-flight branch', () => {
  const result = runCheckCli({
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    EXPECT_BRANCH: 'feat/some-other-branch',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not match the in-flight Work Order branch/);
});

test('check CLI fails closed on unknown SERVICEOS_* variables (typo guard)', () => {
  const result = runCheckCli({
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    SERVICEOS_EXPECT_BRANCH: 'feat/WORK-001-foundation',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown environment variable SERVICEOS_EXPECT_BRANCH/);
});

test('check CLI fails closed when run outside the repository root', () => {
  const result = spawnSync(process.execPath, [resolve('dist/src/cli/check.js')], {
    cwd: resolve('dist'),
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr ?? '', /expected to run from the repository root/);
});
