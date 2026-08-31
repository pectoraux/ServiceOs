/**
 * ServiceOS architecture structural checks (WORK-001).
 *
 * Machine-enforced boundaries from the frozen v1.0 architecture:
 *
 * AC-2 — the module tree under `src/modules/` must contain exactly the modules
 *        declared in `spec/architecture/v1.0/architecture.md` §6 (parsed from
 *        that document, which stays the single authority for the expected list);
 *
 * AC-3 — no AI provider/model/agent infrastructure may exist in ServiceOS:
 *        - importing AI/LLM SDK packages (including any Zeck SDK) is forbidden;
 *        - the `pg` driver may only be imported inside the persistence boundary;
 *        - raw HTTP serving is confined to the platform HTTP composition;
 *        - non-relative imports must be known platform dependencies (fail closed
 *          against undeclared/unknown packages);
 *        - AI-infrastructure path segments (ai/, llm/, agents/, prompts/ …) are
 *          forbidden anywhere under `src/`;
 *
 * Dependency direction (architecture-lock.md):
 *        - modules may import the platform and other modules' public
 *          interfaces (`index.ts`) only — never another module's internals;
 *        - platform code may never import business modules;
 *        - only the composition root (`src/main.ts`) composes modules from
 *          outside the module tree.
 *
 * The scanner parses import/export/require/dynamic-import specifiers from
 * TypeScript sources without executing them. Violations carry stable codes so
 * tests can assert discrimination behavior (a mutated tree must be rejected).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative, sep } from 'node:path';
import { GovernanceError } from './program-state.js';

export interface ArchitectureViolation {
  code: string;
  file?: string;
  detail: string;
}

export interface ArchitectureCheckOptions {
  /** Root of the TypeScript source tree to scan (contains `modules/`, `platform/`, …). */
  srcRoot: string;
  /** Repository root (used to locate `spec/architecture/v1.0/architecture.md`). */
  repoRoot: string;
  /** Override the expected module list (tests use synthetic trees). */
  expectedModules?: string[];
}

// ---------------------------------------------------------------------------
// Denylists and allowlists (fail closed in every direction)
// ---------------------------------------------------------------------------

/**
 * Package specifiers that indicate AI execution infrastructure. ServiceOS must
 * never depend on these: Zeck is the sole AI execution authority. Includes any
 * Zeck SDK — WORK-001 explicitly forbids direct Zeck SDK usage; the `/zeck`
 * module is a thin integration boundary only.
 */
export const FORBIDDEN_AI_PACKAGES: readonly string[] = [
  'openai',
  '@openai',
  'anthropic',
  '@anthropic-ai',
  'ai',
  '@ai-sdk',
  'langchain',
  '@langchain',
  'llamaindex',
  '@llamaindex',
  'llm',
  '@google/generativeai',
  '@google/genkit',
  '@google-cloud/vertexai',
  'vertexai',
  'mistralai',
  'cohere-ai',
  'groq-sdk',
  'replicate',
  'together-ai',
  'deepseek',
  'ollama',
  'ollama-ai',
  '@tensorflow/tfjs',
  'transformers',
  '@huggingface',
  'tiktoken',
  'js-tiktoken',
  'gpt',
  'agents',
  'zeck',
  '@pectoraux/zeck',
  'zeck-sdk',
  '@pectoraux/zeck-sdk',
];

/**
 * Path segments that indicate AI infrastructure directories or files. The
 * architecture prohibits an AI runtime inside ServiceOS, so these names are
 * architecture violations wherever they appear under `src/`.
 */
export const FORBIDDEN_AI_PATH_SEGMENTS: readonly string[] = [
  'ai',
  'llm',
  'agents',
  'agent',
  'prompts',
  'prompt',
  'embeddings',
  'embedding',
  'model-registry',
  'model-runtime',
  'model-router',
  'provider-registry',
  'ai-runtime',
  'agent-runtime',
  'llm-runtime',
  'context-compiler',
  'sandbox-runtime',
  'openai',
  'anthropic',
  'gpt',
];

/**
 * Runtime dependencies the platform currently allows. Anything else in
 * `dependencies` fails closed; extending this list is a deliberate, reviewed
 * change belonging to the Work Order that owns the new dependency.
 */
export const ALLOWED_RUNTIME_PACKAGES: readonly string[] = ['pg'];

/** Development dependencies allowed for the toolchain. */
export const ALLOWED_DEV_PACKAGES: readonly string[] = ['typescript', '@types/node', '@types/pg'];

// ---------------------------------------------------------------------------
// Architecture module list (parsed from the authoritative document)
// ---------------------------------------------------------------------------

/**
 * Parse the module table of `spec/architecture/v1.0/architecture.md` §6.
 * The architecture document is the single authority for the expected module
 * tree; this parser keeps the structural check tied to it.
 */
export function parseArchitectureModules(architectureMdPath: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(architectureMdPath, 'utf8');
  } catch (cause) {
    throw new GovernanceError(
      `cannot read architecture document ${architectureMdPath}: ${(cause as Error).message}`,
      'architecture-unreadable',
    );
  }
  const modules: string[] = [];
  const rowPattern = /^\|\s*`\/([a-z][a-z0-9-]*)`\s*\|/gm;
  let match: RegExpExecArray | null;
  while ((match = rowPattern.exec(raw)) !== null) {
    const name = match[1] as string;
    if (!modules.includes(name)) modules.push(name);
  }
  if (modules.length === 0) {
    throw new GovernanceError(
      `could not parse any module rows from ${architectureMdPath} (§6 module table format changed?)`,
      'architecture-unparseable',
    );
  }
  return modules;
}

// ---------------------------------------------------------------------------
// Import extraction and resolution
// ---------------------------------------------------------------------------

interface ImportReference {
  specifier: string;
  /** 1-based line number, for actionable violation reports. */
  line: number;
}

const IMPORT_PATTERNS: RegExp[] = [
  /(?:^|[\s;}])import\s+[^;'"()]*?from\s*['"]([^'"]+)['"]/g,
  /(?:^|[\s;}])export\s+[^;'"()]*?from\s*['"]([^'"]+)['"]/g,
  /(?:^|[\s;}])(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /^\s*import\s*['"]([^'"]+)['"]/gm,
];

function extractImports(source: string): ImportReference[] {
  const references: ImportReference[] = [];
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const specifier = match[1] as string;
      const line = source.slice(0, match.index).split('\n').length;
      // Deduplicate (a file can only import a specifier once per line-pattern anyway).
      if (!references.some((r) => r.specifier === specifier)) {
        references.push({ specifier, line });
      }
    }
  }
  return references;
}

/** Resolve a relative import specifier to an existing file, NodeNext-style. */
function resolveRelative(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    base.replace(/\.js$/, '.ts'),
    base.endsWith('/') ? `${base}index.ts` : `${base}/index.ts`,
    base.replace(/\.js$/, '/index.ts'),
    base.replace(/\/$/, '') + '/index.ts',
  ];
  for (const candidate of candidates) {
    if (isFile(candidate)) return candidate;
  }
  return null;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function* walkTsFiles(root: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(root, entry);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      yield* walkTsFiles(full);
    } else if (stats.isFile() && entry.endsWith('.ts')) {
      yield full;
    }
  }
}

function normalizePath(path: string): string {
  return path.split(sep).join('/');
}

// ---------------------------------------------------------------------------
// Boundary classification
// ---------------------------------------------------------------------------

function isForbiddenAiPackage(specifier: string): boolean {
  const scopeOrName = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
  return FORBIDDEN_AI_PACKAGES.some((entry) => scopeOrName === entry || specifier === entry || specifier.startsWith(`${entry}/`));
}

function violation(code: string, detail: string, file?: string): ArchitectureViolation {
  return { code, detail, file };
}

/**
 * Run all structural architecture checks over a source tree.
 * Returns the full violation list (empty = conforming).
 */
export function checkArchitecture(options: ArchitectureCheckOptions): ArchitectureViolation[] {
  const { srcRoot, repoRoot } = options;
  const expectedModules =
    options.expectedModules ?? parseArchitectureModules(join(repoRoot, 'spec/architecture/v1.0/architecture.md'));

  const violations: ArchitectureViolation[] = [];
  const modulesRoot = join(srcRoot, 'modules');
  const actualModules = listDirectories(modulesRoot);

  for (const name of expectedModules) {
    if (!actualModules.includes(name)) {
      violations.push(violation('missing-module', `architecture module /${name} is missing under src/modules/`));
    } else {
      const moduleIndex = join(modulesRoot, name, 'index.ts');
      if (!isFile(moduleIndex)) {
        violations.push(violation('missing-module-index', `module /${name} has no public interface index.ts`, normalizePath(moduleIndex)));
      }
    }
  }
  for (const name of actualModules) {
    if (!expectedModules.includes(name)) {
      violations.push(violation('unknown-module', `src/modules/${name} is not a module declared by the architecture`, normalizePath(join(modulesRoot, name))));
    }
  }

  const platformRoot = normalizePath(join(srcRoot, 'platform'));
  const persistenceRoot = normalizePath(join(srcRoot, 'platform', 'persistence'));
  const httpRoot = normalizePath(join(srcRoot, 'platform', 'http'));
  const modulesRootNormalized = normalizePath(modulesRoot);
  const compositionRoot = normalizePath(join(srcRoot, 'main.ts'));

  for (const file of walkTsFiles(srcRoot)) {
    const normalizedFile = normalizePath(file);

    // AI-infrastructure path segments anywhere in the source tree.
    const segments = normalizedFile.split('/').slice(normalizedFile.split('/').indexOf('src') + 1);
    for (const segment of segments) {
      const baseName = segment.replace(/\.ts$/, '');
      if (FORBIDDEN_AI_PATH_SEGMENTS.includes(baseName)) {
        violations.push(
          violation('forbidden-ai-path', `path segment "${baseName}" indicates forbidden AI infrastructure`, normalizedFile),
        );
        break;
      }
    }

    const source = readFileSync(file, 'utf8');
    for (const reference of extractImports(source)) {
      const { specifier } = reference;

      if (isForbiddenAiPackage(specifier)) {
        violations.push(
          violation(
            'forbidden-ai-import',
            `import of "${specifier}" introduces forbidden AI/Zeck-SDK infrastructure into ServiceOS`,
            `${normalizedFile}:${reference.line}`,
          ),
        );
        continue;
      }

      if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
        // Non-relative specifier: pg and raw HTTP serving are boundary-confined;
        // other builtins are fine anywhere; anything else is an undeclared
        // dependency. The http confinement is checked before the generic
        // node-builtin pass so node:http cannot escape its boundary.
        if (specifier === 'pg') {
          if (!normalizedFile.startsWith(`${persistenceRoot}/`)) {
            violations.push(
              violation(
                'persistence-boundary-violation',
                `"pg" may only be imported inside the persistence boundary (src/platform/persistence/)`,
                `${normalizedFile}:${reference.line}`,
              ),
            );
          }
          continue;
        }
        if (specifier === 'http' || specifier === 'node:http' || specifier === 'https' || specifier === 'node:https') {
          if (!normalizedFile.startsWith(`${httpRoot}/`) && normalizedFile !== compositionRoot) {
            violations.push(
              violation(
                'http-boundary-violation',
                'raw HTTP serving belongs to the platform HTTP composition (src/platform/http/)',
                `${normalizedFile}:${reference.line}`,
              ),
            );
          }
          continue;
        }
        if (specifier.startsWith('node:')) continue;
        violations.push(
          violation(
            'undeclared-dependency',
            `import of "${specifier}" is not a known platform dependency (fail closed; extend the allowlist through the owning Work Order)`,
            `${normalizedFile}:${reference.line}`,
          ),
        );
        continue;
      }

      // Relative import: resolve and enforce direction rules.
      const target = resolveRelative(file, specifier);
      if (target === null) {
        violations.push(
          violation('unresolved-import', `import "${specifier}" does not resolve to a file`, `${normalizedFile}:${reference.line}`),
        );
        continue;
      }
      const normalizedTarget = normalizePath(target);

      const inModulesTree = normalizedTarget.startsWith(`${modulesRootNormalized}/`);
      if (inModulesTree) {
        const targetSegments = normalizedTarget.slice(modulesRootNormalized.length + 1).split('/');
        const targetModule = targetSegments[0] as string;
        const importerInModulesTree = normalizedFile.startsWith(`${modulesRootNormalized}/`);
        const importerSegments = importerInModulesTree
          ? normalizedFile.slice(modulesRootNormalized.length + 1).split('/')
          : null;
        const importerModule = importerSegments?.[0] as string | undefined;

        const isModulePublicInterface = targetSegments.length === 2 && targetSegments[1] === 'index.ts';

        if (importerModule !== undefined) {
          // Importer is inside the module tree.
          if (importerModule === targetModule) {
            // A module's own internals are its private implementation.
            continue;
          }
          if (isModulePublicInterface) {
            // Cross-module access through the public interface is the
            // architecture's composition rule (architecture.md §6).
            continue;
          }
          violations.push(
            violation(
              'module-internal-import',
              `cross-module import of /${targetModule} internals is forbidden; consume the module's public interface (index.ts) instead`,
              `${normalizedFile}:${reference.line}`,
            ),
          );
          continue;
        }
        // Importer is outside the module tree.
        if (normalizedFile.startsWith(`${platformRoot}/`)) {
          violations.push(
            violation(
              'platform-imports-module',
              'platform code must never depend on business modules (dependency direction: modules -> platform)',
              `${normalizedFile}:${reference.line}`,
            ),
          );
          continue;
        }
        if (normalizedFile === compositionRoot) {
          if (!isModulePublicInterface) {
            violations.push(
              violation(
                'module-internal-import',
                'the composition root may only import module public interfaces (index.ts)',
                `${normalizedFile}:${reference.line}`,
              ),
            );
          }
          continue;
        }
        violations.push(
          violation(
            'module-import-outside-composition-root',
            'business modules may only be composed by src/main.ts',
            `${normalizedFile}:${reference.line}`,
          ),
        );
        continue;
      }
      // Relative import into platform or other non-module code: allowed from
      // anywhere inside src (platform is the shared substrate).
    }
  }

  return violations;
}

function listDirectories(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Fail-closed package.json dependency policy: no AI/Zeck packages anywhere, and
 * no dependencies outside the platform allowlists.
 */
export function checkPackageDependencies(packageJsonPath: string): ArchitectureViolation[] {
  const violations: ArchitectureViolation[] = [];
  let parsed: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as typeof parsed;
  } catch (cause) {
    return [violation('package-json-unreadable', `cannot read/parse package.json: ${(cause as Error).message}`, normalizePath(packageJsonPath))];
  }

  for (const [section, allowed] of [
    ['dependencies', ALLOWED_RUNTIME_PACKAGES],
    ['devDependencies', ALLOWED_DEV_PACKAGES],
  ] as const) {
    for (const name of Object.keys(parsed[section] ?? {})) {
      if (isForbiddenAiPackage(name)) {
        violations.push(
          violation('forbidden-ai-dependency', `${section} includes forbidden AI/Zeck package "${name}"`, 'package.json'),
        );
        continue;
      }
      if (!allowed.includes(name)) {
        violations.push(
          violation(
            'undeclared-dependency',
            `${section} includes "${name}" which is not in the platform allowlist; extend the allowlist through the owning Work Order`,
            'package.json',
          ),
        );
      }
    }
  }
  return violations;
}

/** Relative path helper for reporting. */
export function relativeTo(from: string, to: string): string {
  return relative(from, to);
}
