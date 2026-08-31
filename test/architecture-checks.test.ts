/**
 * Structural + discrimination proofs for the architecture checks (WORK-001).
 *
 * Structural (AC-2, AC-3): the real source tree conforms — the module set
 * equals the architecture §6 table, dependency direction is legal, no AI
 * provider/model/agent surface exists, and package dependencies follow the
 * platform policy.
 *
 * Discrimination / mutation (Work Order requirement: "known forbidden AI import
 * is rejected by the structural checks"): synthetic trees that deliberately
 * violate each boundary are built in temp directories, and each must be
 * rejected with the matching violation code. A vacuously-passing checker
 * would fail every one of these tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import {
  checkArchitecture,
  checkPackageDependencies,
  parseArchitectureModules,
  type ArchitectureViolation,
} from '../src/platform/governance/index.js';
import { makeTempTree, moduleFile } from './helpers/tree.js';

const REPO_ROOT = resolve(process.cwd());
const REAL_SRC_ROOT = resolve(REPO_ROOT, 'src');

// ---------------------------------------------------------------------------
// Structural proofs against the real repository
// ---------------------------------------------------------------------------

test('real source tree conforms to the frozen architecture (structural)', () => {
  const violations = checkArchitecture({ srcRoot: REAL_SRC_ROOT, repoRoot: REPO_ROOT });
  assert.deepEqual(violations, []);
});

test('architecture module list parsed from the frozen document has the 16 v1.0 modules', () => {
  const modules = parseArchitectureModules(join(REPO_ROOT, 'spec/architecture/v1.0/architecture.md'));
  assert.deepEqual(modules, [
    'auth',
    'organizations',
    'services',
    'verticals',
    'entities',
    'work',
    'workflow',
    'policies',
    'approvals',
    'interactions',
    'zeck',
    'evidence',
    'billing',
    'audit',
    'integrations',
    'notifications',
  ]);
});

test('package dependencies follow the platform policy (structural)', () => {
  const violations = checkPackageDependencies(join(REPO_ROOT, 'package.json'));
  assert.deepEqual(violations, []);
});

test('unparseable architecture document fails closed', () => {
  const { root, cleanup } = makeTempTree({
    'spec/architecture/v1.0/architecture.md': '# no module table here\n',
    'src/modules/auth/index.ts': moduleFile('auth'),
  });
  try {
    assert.throws(
      () => checkArchitecture({ srcRoot: join(root, 'src'), repoRoot: root }),
      /could not parse any module rows/,
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Synthetic tree helpers (discrimination)
// ---------------------------------------------------------------------------

function minimalTree(extra: Record<string, string>): Record<string, string> {
  return {
    'src/main.ts': `import auth from './modules/auth/index.js';\nimport work from './modules/work/index.js';\nimport { defineModule } from './platform/module-registry/index.js';\nexport default defineModule({ name: 'root', version: '0.0.0', description: 'synthetic' });\nvoid auth; void work;\n`,
    'src/platform/module-registry/index.ts':
      "export function defineModule(m: { name: string; version: string; description: string }) { return { manifest: m }; }\n",
    'src/platform/persistence/index.ts':
      "export function boundary(): null { return null; }\n",
    'src/platform/http/index.ts': "export function compose(): null { return null; }\n",
    'src/modules/auth/index.ts': moduleFile('auth'),
    'src/modules/work/index.ts': moduleFile('work'),
    ...extra,
  };
}

function runChecks(files: Record<string, string>): ArchitectureViolation[] {
  const { root, cleanup } = makeTempTree(files);
  try {
    return checkArchitecture({
      srcRoot: join(root, 'src'),
      repoRoot: root,
      // Synthetic trees use their own module expectation.
      expectedModules: ['auth', 'work'],
    });
  } finally {
    cleanup();
  }
}

function expectViolation(files: Record<string, string>, code: string, detailPattern?: RegExp): void {
  const violations = runChecks(files);
  const hit = violations.find((v) => v.code === code);
  assert.ok(
    hit,
    `expected violation code "${code}" but got: ${JSON.stringify(violations)}`,
  );
  if (detailPattern) {
    assert.match(hit.detail, detailPattern);
  }
}

test('control: a clean synthetic tree produces zero violations', () => {
  const violations = runChecks(minimalTree({}));
  assert.deepEqual(violations, []);
});

// --- AC-3 discrimination: forbidden AI imports ---------------------------------

test('discrimination: import of a known AI SDK is rejected', () => {
  expectViolation(
    minimalTree({
      'src/modules/work/index.ts':
        "import OpenAI from 'openai';\n" + moduleFile('work'),
    }),
    'forbidden-ai-import',
    /openai/,
  );
});

test('discrimination: import of an Anthropic SDK is rejected', () => {
  expectViolation(
    minimalTree({
      'src/modules/auth/index.ts':
        "import Anthropic from '@anthropic-ai/sdk';\n" + moduleFile('auth'),
    }),
    'forbidden-ai-import',
    /anthropic/i,
  );
});

test('discrimination: import of a LangChain package is rejected', () => {
  expectViolation(
    minimalTree({
      'src/modules/work/index.ts':
        "import { RunnableSequence } from '@langchain/core/runnables';\n" + moduleFile('work'),
    }),
    'forbidden-ai-import',
    /langchain/i,
  );
});

test('discrimination: direct Zeck SDK usage is rejected', () => {
  expectViolation(
    minimalTree({
      'src/modules/zeck-placeholder.ts': "import { ZeckClient } from '@pectoraux/zeck';\n",
    }),
    'forbidden-ai-import',
    /zeck/i,
  );
});

test('discrimination: a bare `zeck` package import is rejected', () => {
  expectViolation(
    minimalTree({
      'src/modules/work/index.ts': "import zeck from 'zeck';\n" + moduleFile('work'),
    }),
    'forbidden-ai-import',
    /zeck/,
  );
});

test('discrimination: vercel "ai" package is rejected', () => {
  expectViolation(
    minimalTree({
      'src/modules/evidence/index.ts': "import { generateText } from 'ai';\n",
    }),
    'forbidden-ai-import',
    /"ai"/,
  );
});

// --- module tree discrimination -------------------------------------------------

test('discrimination: a missing architecture module is reported', () => {
  const files = minimalTree({});
  delete (files as Record<string, string>)['src/modules/work/index.ts'];
  const violations = runChecks(files);
  assert.ok(
    violations.some((v) => v.code === 'missing-module' && /work/.test(v.detail)),
    `expected missing-module for /work, got ${JSON.stringify(violations)}`,
  );
});

test('discrimination: an unknown module outside the architecture is reported', () => {
  expectViolation(
    minimalTree({
      'src/modules/concrete/index.ts': moduleFile('concrete'),
    }),
    'unknown-module',
    /concrete/,
  );
});

test('discrimination: a module without a public interface is reported', () => {
  const files = minimalTree({
    'src/modules/work/README.md': 'no public interface here',
  });
  delete (files as Record<string, string>)['src/modules/work/index.ts'];
  const violations = runChecks(files);
  assert.ok(violations.some((v) => v.code === 'missing-module-index'));
});

// --- dependency direction discrimination ---------------------------------------

test('discrimination: cross-module import of internals is rejected', () => {
  expectViolation(
    minimalTree({
      'src/modules/work/internal/state.ts': 'export const state = 1;\n',
      'src/modules/auth/index.ts':
        "import { state } from '../work/internal/state.js';\n" + moduleFile('auth'),
    }),
    'module-internal-import',
    /work/,
  );
});

test('cross-module import of the public interface is allowed (control)', () => {
  const violations = runChecks(
    minimalTree({
      'src/modules/auth/index.ts':
        "import work from '../work/index.js';\n" + moduleFile('auth') + '\nvoid work;\n',
    }),
  );
  assert.deepEqual(violations, []);
});

test('discrimination: platform code importing a business module is rejected', () => {
  expectViolation(
    minimalTree({
      'src/platform/http/server-extra.ts':
        "import auth from '../../modules/auth/index.js';\nvoid auth;\n",
    }),
    'platform-imports-module',
  );
});

test('discrimination: module import from outside the composition root is rejected', () => {
  expectViolation(
    minimalTree({
      'src/cli/thing.ts': "import auth from '../modules/auth/index.js';\nvoid auth;\n",
    }),
    'module-import-outside-composition-root',
  );
});

test('discrimination: composition root deep-import into module internals is rejected', () => {
  expectViolation(
    minimalTree({
      'src/modules/work/internal/secret.ts': 'export const secret = 1;\n',
      'src/other-root.ts': "import { secret } from './modules/work/internal/secret.js';\n",
    }),
    'module-import-outside-composition-root',
  );
});

// --- persistence / http boundary discrimination ---------------------------------

test('discrimination: pg import outside the persistence boundary is rejected', () => {
  expectViolation(
    minimalTree({
      'src/modules/work/index.ts': "import pg from 'pg';\n" + moduleFile('work'),
    }),
    'persistence-boundary-violation',
  );
});

test('pg import inside the persistence boundary is allowed (control)', () => {
  const violations = runChecks(
    minimalTree({
      'src/platform/persistence/pool.ts': "import pg from 'pg';\nexport const pool = pg.Pool;\n",
    }),
  );
  assert.deepEqual(violations, []);
});

test('discrimination: raw http import outside the platform http composition is rejected', () => {
  expectViolation(
    minimalTree({
      'src/modules/work/index.ts': "import * as http from 'node:http';\n" + moduleFile('work'),
    }),
    'http-boundary-violation',
  );
});

// --- fail-closed dependency policy ----------------------------------------------

test('discrimination: unknown third-party dependency is rejected (fail closed)', () => {
  expectViolation(
    minimalTree({
      'src/modules/work/index.ts': "import lodash from 'lodash';\n" + moduleFile('work'),
    }),
    'undeclared-dependency',
    /lodash/,
  );
});

test('node builtins are allowed anywhere (control)', () => {
  const violations = runChecks(
    minimalTree({
      'src/modules/work/util.ts': "import { readFileSync } from 'node:fs';\nexport const x = readFileSync;\n",
    }),
  );
  assert.deepEqual(violations, []);
});

// --- AI path discrimination -------------------------------------------------------

test('discrimination: an ai/ directory under src is rejected by path scan', () => {
  expectViolation(
    minimalTree({
      'src/modules/work/ai/index.ts': 'export const intelligence = 0;\n',
    }),
    'forbidden-ai-path',
    /"ai"/,
  );
});

test('discrimination: an llm/ directory is rejected by path scan', () => {
  expectViolation(
    minimalTree({
      'src/platform/llm/runtime.ts': 'export const runtime = 0;\n',
    }),
    'forbidden-ai-path',
    /llm/,
  );
});

test('discrimination: an agents/ directory is rejected by path scan', () => {
  expectViolation(
    minimalTree({
      'src/modules/auth/agents/registry.ts': 'export const registry = 0;\n',
    }),
    'forbidden-ai-path',
    /agents/,
  );
});

test('discrimination: a prompts/ directory is rejected by path scan', () => {
  expectViolation(
    minimalTree({
      'src/modules/interactions/prompts/index.ts': 'export const prompts = 0;\n',
    }),
    'forbidden-ai-path',
    /prompts/,
  );
});

// --- unresolved imports -----------------------------------------------------------

test('discrimination: imports that do not resolve fail closed', () => {
  expectViolation(
    minimalTree({
      'src/modules/work/index.ts': "import { missing } from './does-not-exist.js';\n" + moduleFile('work'),
    }),
    'unresolved-import',
  );
});

// --- package.json policy discrimination -------------------------------------------

function withPackageJson(root: string, contents: unknown): string {
  const pkgPath = join(root, 'package.json');
  mkdirSync(root, { recursive: true });
  writeFileSync(pkgPath, JSON.stringify(contents, null, 2));
  return pkgPath;
}

test('discrimination: an AI SDK in dependencies is rejected', () => {
  const { root, cleanup } = makeTempTree({});
  try {
    const path = withPackageJson(root, { dependencies: { pg: '8.0.0', openai: '4.0.0' } });
    const violations = checkPackageDependencies(path);
    assert.ok(
      violations.some((v) => v.code === 'forbidden-ai-dependency' && /openai/.test(v.detail)),
      JSON.stringify(violations),
    );
  } finally {
    cleanup();
  }
});

test('discrimination: a Zeck SDK in devDependencies is rejected', () => {
  const { root, cleanup } = makeTempTree({});
  try {
    const path = withPackageJson(root, { devDependencies: { typescript: '5.0.0', '@pectoraux/zeck': '1.0.0' } });
    const violations = checkPackageDependencies(path);
    assert.ok(
      violations.some((v) => v.code === 'forbidden-ai-dependency' && /zeck/.test(v.detail)),
      JSON.stringify(violations),
    );
  } finally {
    cleanup();
  }
});

test('discrimination: an unknown dependency fails closed', () => {
  const { root, cleanup } = makeTempTree({});
  try {
    const path = withPackageJson(root, { dependencies: { express: '4.0.0' } });
    const violations = checkPackageDependencies(path);
    assert.ok(
      violations.some((v) => v.code === 'undeclared-dependency' && /express/.test(v.detail)),
      JSON.stringify(violations),
    );
  } finally {
    cleanup();
  }
});

test('discrimination: unparseable package.json fails closed', () => {
  const { root, cleanup } = makeTempTree({});
  try {
    const path = join(root, 'package.json');
    writeFileSync(path, 'not json');
    const violations = checkPackageDependencies(path);
    assert.ok(violations.some((v) => v.code === 'package-json-unreadable'));
  } finally {
    cleanup();
  }
});
