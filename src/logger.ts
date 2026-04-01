/**
 * @module logger
 * @description Structured JSON logger for TalentTrust Backend.
 *
 * Provides a singleton logger that emits newline-delimited JSON records to
 * stdout (errors to stderr).  Every record includes a mandatory set of
 * correlation fields so that log lines can be joined across services:
 *
 *   - timestamp  – ISO-8601 UTC
 *   - level      – debug | info | warn | error
 *   - message    – human-readable description
 *   - requestId  – per-request UUID (injected by middleware, optional here)
 *   - correlationId – caller-supplied trace ID (optional)
 *   - service    – constant "talenttrust-backend"
 *   - ...extra   – any additional context fields
 *
 * Security note: the logger never serialises Error.stack in production to
 * avoid leaking internal file paths.  In non-production environments the
 * stack is included to aid debugging.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Fields that every log record must carry. */
export interface BaseLogRecord {
  timestamp: string;
  level: LogLevel;
  message: string;
  service: string;
  requestId?: string;
  correlationId?: string;
}

/** A complete log record – base fields plus arbitrary context. */
export type LogRecord = BaseLogRecord & Record<string, unknown>;

/** Context that can be bound to a child logger instance. */
export interface LogContext {
  requestId?: string;
  correlationId?: string;
  [key: string]: unknown;
}

const SERVICE_NAME = 'talenttrust-backend';

/**
 * Safely serialise an Error into a plain object.
 * Stack traces are omitted in production to prevent path disclosure.
 */
function serializeError(err: Error): Record<string, unknown> {
  const obj: Record<string, unknown> = {
    name: err.name,
    message: err.message,
  };
  if (process.env.NODE_ENV !== 'production' && err.stack) {
    obj.stack = err.stack;
  }
  return obj;
}

/**
 * Sanitise a context object so that sensitive keys are never logged.
 * Extend this list as the domain grows.
 */
const SENSITIVE_KEYS = new Set([
  'password',
  'secret',
  'token',
  'authorization',
  'cookie',
  'privatekey',
  'mnemonic',
  'seed',
]);

function sanitize(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(k.toLowerCase())) {
      out[k] = '[REDACTED]';
    } else if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = sanitize(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Core write function – separated so tests can spy on it. */
export function writeRecord(record: LogRecord): void {
  const line = JSON.stringify(record);
  if (record.level === 'error') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

/**
 * Logger class.
 *
 * Instantiate via `createLogger()` or use the default `logger` singleton.
 * Use `logger.child(ctx)` to create a request-scoped child that automatically
 * includes `requestId` / `correlationId` on every record.
 */
export class Logger {
  private readonly context: LogContext;

  constructor(context: LogContext = {}) {
    this.context = context;
  }

  /**
   * Create a child logger that merges additional context into every record.
   *
   * @param ctx - Extra fields to bind (e.g. `{ requestId, correlationId }`).
   */
  child(ctx: LogContext): Logger {
    return new Logger({ ...this.context, ...ctx });
  }

  /** @internal Build and emit a log record. */
  private log(
    level: LogLevel,
    message: string,
    extra: Record<string, unknown> = {},
  ): void {
    const { requestId, correlationId, ...rest } = this.context;

    // Merge context + caller extras, then sanitise the whole thing.
    const merged = sanitize({ ...rest, ...extra });

    const record: LogRecord = {
      timestamp: new Date().toISOString(),
      level,
      message,
      service: SERVICE_NAME,
      ...(requestId !== undefined && { requestId }),
      ...(correlationId !== undefined && { correlationId }),
      ...merged,
    };

    writeRecord(record);
  }

  debug(message: string, extra?: Record<string, unknown>): void {
    this.log('debug', message, extra);
  }

  info(message: string, extra?: Record<string, unknown>): void {
    this.log('info', message, extra);
  }

  warn(message: string, extra?: Record<string, unknown>): void {
    this.log('warn', message, extra);
  }

  /**
   * Log at error level.  Pass an `Error` instance via `extra.err` and it will
   * be serialised safely.
   */
  error(message: string, extra?: Record<string, unknown>): void {
    const safeExtra: Record<string, unknown> = { ...extra };
    if (safeExtra['err'] instanceof Error) {
      safeExtra['err'] = serializeError(safeExtra['err'] as Error);
    }
    this.log('error', message, safeExtra);
  }
}

/** Application-wide default logger (no request context). */
export const logger = new Logger();

/** Factory for creating named loggers with pre-bound context. */
export function createLogger(context: LogContext = {}): Logger {
  return new Logger(context);
}
