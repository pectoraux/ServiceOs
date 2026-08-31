/**
 * Test helpers: synthetic source trees and in-memory SQL executors.
 *
 * Discrimination/mutation proofs build deliberately violating source trees in
 * temporary directories and assert the architecture checker rejects them; the
 * fake executors let transaction/migration semantics be proven without a live
 * PostgreSQL instance.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import type { PooledExecutor, QueryResult, SqlExecutor } from '../../src/platform/persistence/index.js';

export interface TreeSpec {
  [path: string]: string;
}

/** Write a { relativePath: contents } tree under a fresh temp directory. */
export function makeTempTree(files: TreeSpec): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'serviceos-check-'));
  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** A well-formed module public interface file for synthetic trees. */
export function moduleFile(name: string, extra = ''): string {
  return `import { defineModule } from '../../platform/module-registry/index.js';\n\nexport default defineModule({ name: '${name}', version: '0.1.0', description: 'synthetic ${name}' });\n${extra}`;
}

/**
 * In-memory SQL executor. Records every statement; answers scripted queries.
 * `failOn` can throw to simulate failures.
 */
export interface ScriptedAnswer {
  match: RegExp;
  rows?: Record<string, unknown>[];
  rowCount?: number;
}

export interface FakeExecutorOptions {
  answers?: ScriptedAnswer[];
  onQuery?: (sql: string, params?: unknown[]) => void;
  failOn?: RegExp;
}

export class FakeExecutor implements SqlExecutor {
  readonly statements: { sql: string; params?: unknown[] }[] = [];

  constructor(private readonly options: FakeExecutorOptions = {}) {}

  async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    this.statements.push({ sql, params });
    this.options.onQuery?.(sql, params);
    if (this.options.failOn && this.options.failOn.test(sql)) {
      throw new Error(`scripted failure on: ${sql}`);
    }
    for (const answer of this.options.answers ?? []) {
      if (answer.match.test(sql)) {
        return { rows: answer.rows ?? [], rowCount: answer.rowCount ?? (answer.rows ?? []).length };
      }
    }
    return { rows: [], rowCount: 0 };
  }

  sqlTrace(): string[] {
    return this.statements.map((s) => s.sql);
  }
}

/** Fake pooled executor for boundary tests (adds `end()`). */
export class FakePool extends FakeExecutor implements PooledExecutor {
  endCalls = 0;
  async end(): Promise<void> {
    this.endCalls += 1;
  }
}

export function sqlOf(statements: { sql: string; params?: unknown[] }[]): string[] {
  return statements.map((s) => s.sql);
}
