/**
 * Minimal structured logging for the ServiceOS foundation (WORK-001).
 *
 * JSON lines to stdout/stderr with level filtering. The sink is injectable so
 * tests can observe output without capturing the real console.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;
export type LogSink = (line: string, level: LogLevel) => void;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

function defaultSink(line: string, level: LogLevel): void {
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}

function emit(
  sink: LogSink,
  threshold: LogLevel,
  bindings: LogFields,
  level: LogLevel,
  msg: string,
  fields?: LogFields,
): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[threshold]) return;
  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...bindings,
    ...(fields ?? {}),
  };
  sink(JSON.stringify(record), level);
}

export function createLogger(
  level: LogLevel,
  bindings: LogFields = {},
  sink: LogSink = defaultSink,
): Logger {
  return {
    debug: (msg, fields) => emit(sink, level, bindings, 'debug', msg, fields),
    info: (msg, fields) => emit(sink, level, bindings, 'info', msg, fields),
    warn: (msg, fields) => emit(sink, level, bindings, 'warn', msg, fields),
    error: (msg, fields) => emit(sink, level, bindings, 'error', msg, fields),
    child: (childBindings) => createLogger(level, { ...bindings, ...childBindings }, sink),
  };
}
