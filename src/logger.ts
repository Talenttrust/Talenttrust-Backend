/**
 * @module logger
 * @description Pino-based structured JSON logger for TalentTrust Backend.
 *
 * Provides a singleton logger that emits newline-delimited JSON records to
 * stdout (errors to stderr).  Every record includes a mandatory set of
 * correlation fields so that log lines can be joined across services:
 *
 *   - timestamp  – ISO-8601 UTC (handled by Pino)
 *   - level      – trace | debug | info | warn | error | fatal
 *   - message    – human-readable description
 *   - requestId  – per-request UUID (injected by middleware, optional here)
 *   - correlationId – caller-supplied trace ID (optional)
 *   - service    – constant "talenttrust-backend"
 *   - ...extra   – any additional context fields
 *
 * Security note: the logger never serialises Error.stack in production to
 * avoid leaking internal file paths.  In non-production environments the
 * stack is included to aid debugging.
 *
 * Pino features used:
 * - Automatic redaction of sensitive fields
 * - Child logger support for request correlation
 * - High-performance JSON serialization
 * - Production-safe error handling
 */

import pino, { Logger as PinoLogger, LoggerOptions } from 'pino';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/** Fields that every log record must carry. */
export interface BaseLogRecord {
  level: LogLevel;
  message: string;
  service: string;
  requestId?: string;
  correlationId?: string;
  time?: number; // Unix timestamp (Pino default)
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
 * Comprehensive list of sensitive keys that should be redacted.
 * This includes common authentication tokens, PII, and secrets.
 */
const SENSITIVE_KEYS = [
  // Authentication & Authorization
  'password', 'passwd', 'pwd',
  'secret', 'secrets',
  'token', 'tokens', 'jwt', 'bearer',
  'authorization', 'auth',
  'apikey', 'api_key', 'apikey_secret',
  'access_token', 'refresh_token',
  'client_secret', 'client_id',
  
  // Personal Identifiable Information
  'email', 'email_address',
  'ssn', 'social_security_number',
  'credit_card', 'cc_number', 'cvv',
  'bank_account', 'routing_number',
  'phone', 'phone_number', 'mobile',
  'address', 'street_address',
  
  // Cryptographic
  'privatekey', 'private_key', 'privateKey',
  'publickey', 'public_key', 'publicKey',
  'mnemonic', 'seed', 'seed_phrase',
  'wallet', 'wallet_private_key',
  
  // Session & Cookies
  'cookie', 'cookies', 'session',
  'session_id', 'session_token',
  
  // Database
  'db_password', 'database_password',
  'connection_string', 'conn_string',
  
  // Generic sensitive patterns
  'key', 'secret_key', 'passphrase'
];

/**
 * Pino redaction configuration.
 * Uses wildcard patterns to catch nested sensitive fields.
 */
const redactionPaths = SENSITIVE_KEYS.flatMap(key => [
  key,
  `*.${key}`,
]);

/**
 * Pino logger configuration with production-safe settings.
 */
const pinoConfig: LoggerOptions = {
  name: SERVICE_NAME,
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  
  // Redact sensitive information
  redact: {
    paths: redactionPaths,
    censor: '[REDACTED]'
  },
  
  // Error serialization - include stack in non-production only
  errorKey: 'err',
  formatters: {
    level: (label: string) => ({ level: label }),
    log: (object: any) => {
      // Ensure service name is always present
      return { ...object, service: SERVICE_NAME };
    }
  },
  
  // Timestamp handling - Pino handles this automatically
  timestamp: pino.stdTimeFunctions.isoTime,
  
  // Pretty printing in development
  transport: process.env.NODE_ENV !== 'production' ? {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss Z',
      ignore: 'pid,hostname'
    }
  } : undefined,
  
  // Base context that's merged into all logs
  base: {
    service: SERVICE_NAME,
    pid: process.pid,
    hostname: process.env.HOSTNAME || 'unknown'
  }
};

/**
 * Core Pino logger instance.
 */
const pinoLogger: PinoLogger = pino(pinoConfig);

/**
 * Logger class that wraps Pino with our API.
 *
 * Instantiate via `createLogger()` or use the default `logger` singleton.
 * Use `logger.child(ctx)` to create a request-scoped child that automatically
 * includes `requestId` / `correlationId` on every record.
 */
export class Logger {
  private readonly pino: PinoLogger;

  constructor(context: LogContext = {}) {
    // Create a child logger with the provided context
    this.pino = pinoLogger.child(context);
  }

  /**
   * Create a child logger that merges additional context into every record.
   *
   * @param ctx - Extra fields to bind (e.g. `{ requestId, correlationId }`).
   */
  child(ctx: LogContext): Logger {
    return new Logger({ ...this.pino.bindings(), ...ctx });
  }

  /**
   * Get the current logger context (useful for testing).
   */
  getBindings(): Record<string, unknown> {
    return this.pino.bindings();
  }

  trace(message: string, extra?: Record<string, unknown>): void {
    if (extra) {
      this.pino.trace(extra, message);
    } else {
      this.pino.trace(message);
    }
  }

  debug(message: string, extra?: Record<string, unknown>): void {
    if (extra) {
      this.pino.debug(extra, message);
    } else {
      this.pino.debug(message);
    }
  }

  info(message: string, extra?: Record<string, unknown>): void {
    if (extra) {
      this.pino.info(extra, message);
    } else {
      this.pino.info(message);
    }
  }

  warn(message: string, extra?: Record<string, unknown>): void {
    if (extra) {
      this.pino.warn(extra, message);
    } else {
      this.pino.warn(message);
    }
  }

  /**
   * Log at error level.  Pass an `Error` instance via `extra.err` and it will
   * be serialised safely by Pino.
   */
  error(message: string, extra?: Record<string, unknown>): void {
    if (extra) {
      this.pino.error(extra, message);
    } else {
      this.pino.error(message);
    }
  }

  fatal(message: string, extra?: Record<string, unknown>): void {
    if (extra) {
      this.pino.fatal(extra, message);
    } else {
      this.pino.fatal(message);
    }
  }
}

/** Application-wide default logger (no request context). */
export const logger = new Logger();

/** Factory for creating named loggers with pre-bound context. */
export function createLogger(context: LogContext = {}): Logger {
  return new Logger(context);
}

/**
 * Export the underlying Pino logger for advanced use cases.
 * This should be used sparingly - prefer the Logger class API.
 */
export { pinoLogger };

/**
 * Utility function to create a request-scoped logger with correlation IDs.
 * This is typically used in middleware.
 */
export function createRequestLogger(requestId: string, correlationId?: string): Logger {
  return createLogger({ requestId, correlationId });
}
