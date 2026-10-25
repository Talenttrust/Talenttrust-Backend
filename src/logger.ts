import { randomUUID } from 'node:crypto';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

const SENSITIVE_HEADERS = new Set(['authorization', 'x-api-key', 'cookie']);

function redactHeaders(headers: Record<string, string | string[] | undefined>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (SENSITIVE_HEADERS.has(lower)) {
      out[key] = '[redacted]';
    } else if (Array.isArray(value)) {
      out[key] = value;
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function createLogger(opts: { level?: LogLevel; stream?: NodeJS.WriteStream } = {}): Logger {
  const envLevel = (process.env.LOG_LEVEL || '').toLowerCase() as LogLevel | undefined;
  const defaultLevel = process.env.NODE_ENV === 'test' ? 'silent' : 'info';
  const level = opts.level ?? envLevel ?? defaultLevel;
  const min = LEVELS[level] ?? LEVELS.info;
  const stream = opts.stream ?? process.stdout;

  const log = (lvl: LogLevel, msg: string, fields: Record<string, unknown> = {}) => {
    if (LEVELS[lvl] < min) return;
    const line: Record<string, unknown> = { ts: new Date().toISOString(), level: lvl, msg, ...fields };
    stream.write(JSON.stringify(line) + '\n');
  };

  return {
    debug: (msg: string, fields?: Record<string, unknown>) => log('debug', msg, fields),
    info: (msg: string, fields?: Record<string, unknown>) => log('info', msg, fields),
    warn: (msg: string, fields?: Record<string, unknown>) => log('warn', msg, fields),
    error: (msg: string, fields?: Record<string, unknown>) => log('error', msg, fields),
  };
}

export { redactHeaders, randomUUID };
