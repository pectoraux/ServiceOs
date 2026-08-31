/**
 * Behavioral proof: logging level filtering and structured fields.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, type LogLevel, type LogSink } from '../src/platform/logging/index.js';

function collector(): { sink: LogSink; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  return { sink: (line) => lines.push(JSON.parse(line)), lines };
}

test('info threshold suppresses debug but passes info/warn/error', () => {
  const { sink, lines } = collector();
  const logger = createLogger('info', {}, sink);
  logger.debug('hidden');
  logger.info('shown-info');
  logger.warn('shown-warn');
  logger.error('shown-error');
  assert.equal(lines.length, 3);
  assert.deepEqual(
    lines.map((l) => l.level),
    ['info', 'warn', 'error'],
  );
});

test('debug threshold passes everything', () => {
  const { sink, lines } = collector();
  const logger = createLogger('debug', {}, sink);
  logger.debug('a');
  logger.info('b');
  assert.equal(lines.length, 2);
});

test('error threshold suppresses info', () => {
  const { sink, lines } = collector();
  const logger = createLogger('error' as LogLevel, {}, sink);
  logger.info('hidden');
  logger.error('shown');
  assert.equal(lines.length, 1);
});

test('records carry timestamp, level, message and fields', () => {
  const { sink, lines } = collector();
  const logger = createLogger('info', {}, sink);
  logger.info('something happened', { requestId: 'req-1', attempts: 2 });
  const line = lines[0] as { ts: string; level: string; msg: string; requestId: string; attempts: number };
  assert.equal(line.level, 'info');
  assert.equal(line.msg, 'something happened');
  assert.equal(line.requestId, 'req-1');
  assert.equal(line.attempts, 2);
  assert.ok(typeof line.ts === 'string' && line.ts.length > 0);
});

test('child loggers inherit bindings and add their own', () => {
  const { sink, lines } = collector();
  const logger = createLogger('info', { component: 'http' }, sink).child({ requestId: 'req-9' });
  logger.info('routed');
  const line = lines[0] as { component: string; requestId: string };
  assert.equal(line.component, 'http');
  assert.equal(line.requestId, 'req-9');
});
