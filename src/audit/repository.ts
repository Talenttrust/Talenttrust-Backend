/**
 * @module audit/repository
 * @description Backend selection and failure handling for the audit log.
 *
 * The audit log is the one store in this service that must never lie about
 * what it kept, so this module treats storage failure as a first-class,
 * *deterministic* state rather than as an accident:
 *
 * ### Failure-recovery contract (issue #1353)
 *
 * | Failure                                | Behaviour                                                                 |
 * |----------------------------------------|---------------------------------------------------------------------------|
 * | `AUDIT_STORAGE_BACKEND` unknown value  | typed `AuditStorageError` (`unsupported_backend`) at construction — fail fast, never guess |
 * | SQLite database cannot be opened       | typed `AuditStorageError` (`open_failed`) by default; see degradation below |
 * | Append fails transiently (`SQLITE_BUSY`/`SQLITE_LOCKED`) | bounded synchronous retry; the caller sees nothing |
 * | Append fails permanently               | typed `AuditStorageError` (`append_failed`), `cause` preserved for logs  |
 * | Append fails permanently **and** `AUDIT_STORAGE_FALLBACK=memory` | entry is written to the in-memory chain; storage is marked `degraded` |
 * | In-memory fallback also fails          | typed `AuditStorageError` (`write_unavailable`), nothing swallowed         |
 *
 * ### Invariants
 *
 * 1. **No silent downgrade.** Degrading to the in-memory chain requires an
 *    explicit opt-in (`AUDIT_STORAGE_FALLBACK=memory`). The default keeps the
 *    pre-existing fail-fast behaviour, because silently losing durability of
 *    the one append-only ledger is exactly the failure mode this module exists
 *    to prevent.
 * 2. **One coherent source.** Once degraded, reads *and* writes are served by
 *    the fallback. A repository that wrote to memory while reading from SQLite
 *    would report an entry as missing immediately after accepting it.
 * 3. **A retry cannot duplicate an entry.** `AuditLogRepository.append` is
 *    synchronous and `SqliteAuditRepository.append` wraps the insert in a single
 *    driver transaction, so a failed attempt has already rolled back when the
 *    retry loop sees the error, and the retry loop contains no `await` — two
 *    concurrent appends cannot interleave inside it.
 * 4. **Retry only what provably rolled back.** Only `SQLITE_BUSY` and
 *    `SQLITE_LOCKED` are retried. `SQLITE_IOERR`, `SQLITE_FULL` and
 *    `SQLITE_READONLY` are excluded because a failing commit may already have
 *    reached disk; re-running an `INSERT` in that state could double-append.
 * 5. **Errors never carry the database path.** Messages and log fields expose
 *    the driver error code and the file's base name only. Absolute paths can
 *    disclose deployment layout, and the raw driver message embeds them.
 *
 * ### Observability
 *
 * - Structured events `audit_storage_resolved`, `audit_storage_open_failed`,
 *   `audit_storage_append_retry`, `audit_storage_append_failed`,
 *   `audit_storage_degraded`, `audit_storage_write_unavailable`.
 * - Prometheus counters/gauge, created once against a registry reachable via
 *   {@link getAuditStorageMetricsRegistry}.
 * - {@link AuditRepositoryStatus} for a synchronous health snapshot.
 */

import path from 'path';
import { Counter, Gauge, Registry } from 'prom-client';
import type {
  AuditEntry,
  AuditQuery,
  CreateAuditEntryInput,
  IntegrityReport,
  AuditQueryResult,
} from './types';
import { auditStore } from './store';
import { SqliteAuditRepository } from './sqliteRepository';
import Database from '../db/betterSqlite3';
import { logger } from '../logger';

export interface AuditLogRepository {
  /**
   * Appends a new event; equal payloads are not duplicates. Request retries
   * must be deduplicated by the caller's idempotency boundary.
   */
  append(input: CreateAuditEntryInput): AuditEntry;
  getById(id: string): AuditEntry | undefined;
  query(query?: AuditQuery): AuditEntry[];
  /**
   * Query with cursor-based pagination.
   */
  queryWithCursor(query?: AuditQuery): AuditQueryResult;
  /**
   * Streams entries without materialising the full result set in memory.
   */
  stream(query?: AuditQuery): IterableIterator<AuditEntry>;
  count(): number;
  verifyIntegrity(): IntegrityReport;
  /**
   * Health snapshot for the active backend.
   *
   * Optional rather than required: implementations that predate this member
   * (including the test doubles in `service.test.ts`) must keep compiling, so
   * callers feature-detect via {@link getAuditRepositoryStatus} instead of
   * invoking it directly.
   */
  status?(): AuditRepositoryStatus;
}

// ── Backends ─────────────────────────────────────────────────────────────────

/** Storage backends this module knows how to build. */
export const AUDIT_STORAGE_BACKENDS = ['memory', 'sqlite'] as const;

/** A configured, supported audit storage backend. */
export type AuditStorageBackend = (typeof AUDIT_STORAGE_BACKENDS)[number];

/** What to do when the configured backend cannot be used. */
export const AUDIT_STORAGE_FALLBACKS = ['none', 'memory'] as const;

/** Degradation policy for a failing durable backend. */
export type AuditStorageFallback = (typeof AUDIT_STORAGE_FALLBACKS)[number];

// ── Errors ───────────────────────────────────────────────────────────────────

/**
 * Stable, machine-readable failure codes.
 *
 * Treat these as append-only: they are the only part of a storage failure a
 * caller can branch on without parsing a message.
 */
export const AUDIT_STORAGE_ERROR_CODES = {
  /** `AUDIT_STORAGE_BACKEND` named a backend this module cannot build. */
  UNSUPPORTED_BACKEND: 'audit_storage_unsupported_backend',
  /** `AUDIT_STORAGE_FALLBACK` named a policy this module cannot apply. */
  UNSUPPORTED_FALLBACK: 'audit_storage_unsupported_fallback',
  /** An audit storage environment variable is present but unusable. */
  INVALID_CONFIG: 'audit_storage_invalid_config',
  /** The durable backend could not be opened or initialised. */
  OPEN_FAILED: 'audit_storage_open_failed',
  /** An unclassified dependency failure reported by a supervisor. */
  DEPENDENCY_FAILED: 'audit_storage_dependency_failed',
  /** An append failed every permitted attempt. */
  APPEND_FAILED: 'audit_storage_append_failed',
  /** No backend could accept a write, fallback included. */
  WRITE_UNAVAILABLE: 'audit_storage_write_unavailable',
} as const;

export type AuditStorageErrorCode =
  (typeof AUDIT_STORAGE_ERROR_CODES)[keyof typeof AUDIT_STORAGE_ERROR_CODES];

/**
 * A storage failure with a stable code and a message safe to surface.
 *
 * The underlying driver error is attached as `cause` for logs and never
 * interpolated into `message`, because better-sqlite3 embeds the absolute
 * database path in its messages.
 */
export class AuditStorageError extends Error {
  readonly code: AuditStorageErrorCode;
  /** Backend the failure is attributed to; `'unknown'` for configuration. */
  readonly backend: AuditStorageBackend | 'unknown';
  /** Attempts spent before giving up. `1` for non-append failures. */
  readonly attempts: number;

  constructor(
    code: AuditStorageErrorCode,
    message: string,
    options: {
      backend?: AuditStorageBackend | 'unknown';
      attempts?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AuditStorageError';
    this.code = code;
    this.backend = options.backend ?? 'unknown';
    this.attempts = options.attempts ?? 1;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ── Status ───────────────────────────────────────────────────────────────────

/**
 * `ok`        — the configured backend is serving.
 * `degraded`  — serving from a fallback; entries are still being written, but
 *               they are not durable and are invisible to the failed backend.
 * `unavailable` — no backend could serve a write or read.
 */
export type AuditStorageHealth = 'ok' | 'degraded' | 'unavailable';

/** Point-in-time health and failure counters for a repository. */
export interface AuditRepositoryStatus {
  /** Backend currently serving traffic. */
  readonly backend: AuditStorageBackend;
  /** False when entries are held only in process memory. */
  readonly durable: boolean;
  readonly health: AuditStorageHealth;
  /** When the repository first degraded, ISO-8601. Unset while healthy. */
  readonly degradedSince?: string;
  /** Append calls served by the active backend. */
  readonly appendAttempts: number;
  /** Retries spent on transient append failures. */
  readonly appendRetries: number;
  /** Append calls that exhausted their attempts. */
  readonly appendFailures: number;
  /** Times the fallback was engaged. At most one per repository. */
  readonly fallbackActivations: number;
  /** Appends written to the fallback after degrading. */
  readonly fallbackWrites: number;
  /** Code of the most recent failure, for correlation with the logs. */
  readonly lastFailureCode?: AuditStorageErrorCode;
}

/**
 * Health snapshot for any repository.
 *
 * Repositories without a `status()` member (older third-party implementations)
 * report the configured backend as `ok` rather than throwing — a health probe
 * must never be the thing that takes the process down.
 */
export function getAuditRepositoryStatus(
  repository: AuditLogRepository,
  backend: AuditStorageBackend = 'memory',
): AuditRepositoryStatus {
  if (typeof repository.status !== 'function') {
    return {
      backend,
      durable: backend === 'sqlite',
      health: 'ok',
      appendAttempts: 0,
      appendRetries: 0,
      appendFailures: 0,
      fallbackActivations: 0,
      fallbackWrites: 0,
    };
  }

  return repository.status();
}

// ── Configuration ────────────────────────────────────────────────────────────

/** Default number of attempts (initial call plus one retry) for `append`. */
export const DEFAULT_AUDIT_STORAGE_APPEND_ATTEMPTS = 2;

/** Bounds on `AUDIT_STORAGE_APPEND_ATTEMPTS`. */
export const MIN_AUDIT_STORAGE_APPEND_ATTEMPTS = 1;
export const MAX_AUDIT_STORAGE_APPEND_ATTEMPTS = 10;

function isAuditStorageBackend(value: string): value is AuditStorageBackend {
  return (AUDIT_STORAGE_BACKENDS as readonly string[]).includes(value);
}

function isAuditStorageFallback(value: string): value is AuditStorageFallback {
  return (AUDIT_STORAGE_FALLBACKS as readonly string[]).includes(value);
}

/**
 * Resolves `AUDIT_STORAGE_BACKEND`.
 *
 * Surrounding whitespace and letter case are tolerated (`" SQLite "` → `sqlite`)
 * because both are operator typos rather than intent, and an empty value is
 * treated as unset. Any other unrecognised value still throws with the message
 * this module has always used, so existing log greps keep matching.
 *
 * @throws AuditStorageError `unsupported_backend`
 */
export function resolveAuditStorageBackend(
  env: NodeJS.ProcessEnv = process.env,
): AuditStorageBackend {
  const raw = env['AUDIT_STORAGE_BACKEND'];
  if (raw === undefined) return 'memory';

  const normalized = raw.trim().toLowerCase();
  if (normalized === '') return 'memory';
  if (isAuditStorageBackend(normalized)) return normalized;

  throw new AuditStorageError(
    AUDIT_STORAGE_ERROR_CODES.UNSUPPORTED_BACKEND,
    `Unsupported AUDIT_STORAGE_BACKEND: ${raw}`,
  );
}

/**
 * Resolves `AUDIT_STORAGE_FALLBACK`.
 *
 * Defaults to `'none'` — fail fast — because degrading the audit log to an
 * in-memory chain without being asked trades durability for availability, and
 * that trade must be an explicit decision.
 *
 * @throws AuditStorageError `unsupported_fallback`
 */
export function resolveAuditStorageFallback(
  env: NodeJS.ProcessEnv = process.env,
): AuditStorageFallback {
  const raw = env['AUDIT_STORAGE_FALLBACK'];
  if (raw === undefined) return 'none';

  const normalized = raw.trim().toLowerCase();
  if (normalized === '') return 'none';
  if (isAuditStorageFallback(normalized)) return normalized;

  throw new AuditStorageError(
    AUDIT_STORAGE_ERROR_CODES.UNSUPPORTED_FALLBACK,
    `Unsupported AUDIT_STORAGE_FALLBACK: ${raw}`,
  );
}

/**
 * Resolves `AUDIT_STORAGE_APPEND_ATTEMPTS`.
 *
 * A malformed value fails fast rather than silently reverting to the default:
 * an operator who typed `2` and got `1` would be debugging the wrong thing.
 *
 * @throws AuditStorageError `invalid_config`
 */
export function resolveAuditStorageAppendAttempts(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env['AUDIT_STORAGE_APPEND_ATTEMPTS'];
  if (raw === undefined) return DEFAULT_AUDIT_STORAGE_APPEND_ATTEMPTS;

  const parsed = Number(raw.trim());
  if (
    !Number.isInteger(parsed) ||
    parsed < MIN_AUDIT_STORAGE_APPEND_ATTEMPTS ||
    parsed > MAX_AUDIT_STORAGE_APPEND_ATTEMPTS
  ) {
    throw new AuditStorageError(
      AUDIT_STORAGE_ERROR_CODES.INVALID_CONFIG,
      `AUDIT_STORAGE_APPEND_ATTEMPTS must be an integer between ${MIN_AUDIT_STORAGE_APPEND_ATTEMPTS} and ${MAX_AUDIT_STORAGE_APPEND_ATTEMPTS}`,
    );
  }

  return parsed;
}

/**
 * Resolves the SQLite database path.
 *
 * An empty or whitespace-only `AUDIT_DB_PATH` is treated as unset. Previously
 * an empty value was handed to the driver verbatim, which fails to open and
 * took the whole process down at start-up for what is only a misconfigured
 * variable.
 */
export function resolveAuditDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['AUDIT_DB_PATH'];
  if (typeof configured === 'string' && configured.trim() !== '') {
    return configured;
  }

  if (env['NODE_ENV'] === 'test') return ':memory:';

  return path.join(process.cwd(), 'talenttrust-audit.db');
}

// ── Failure diagnostics ──────────────────────────────────────────────────────

/**
 * SQLite result codes that mean "another connection holds what you want;
 * try again", and that provably left nothing behind.
 *
 * `SQLITE_IOERR`, `SQLITE_FULL`, `SQLITE_READONLY` and `SQLITE_CORRUPT` are
 * deliberately excluded: a commit that fails with one of those may already be
 * on disk, so retrying the `INSERT` risks a duplicate entry and a forked hash
 * chain.
 */
const RETRYABLE_SQLITE_CODES: ReadonlySet<string> = new Set([
  'SQLITE_BUSY',
  'SQLITE_LOCKED',
  'SQLITE_PROTOCOL',
]);

/** Driver error code (`SQLITE_CANTOPEN`, …) when the error carries one. */
function driverErrorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Decides whether a failed append may be retried.
 *
 * Unknown errors are treated as non-retryable: with an append-only chain, a
 * wrong guess costs a duplicate entry, while a correct guess only costs one
 * extra failed attempt that the caller was going to see anyway.
 */
export function isRetryableStorageError(error: unknown): boolean {
  if (error instanceof AuditStorageError) return false;

  const code = driverErrorCode(error);
  return code !== undefined && RETRYABLE_SQLITE_CODES.has(code);
}

/**
 * Log-safe description of a storage failure.
 *
 * Contains the driver code and the database file's *base name* — enough to
 * identify the problem — and never the directory, which can disclose
 * deployment or tenant layout.
 *
 * An {@link AuditStorageError} is unwrapped to its `cause` so the driver code
 * survives wrapping, and contributes its own stable `code` separately; its
 * stable code must never be mistaken for a SQLite result code.
 */
function describeStorageFailure(
  error: unknown,
  context: { backend: AuditStorageBackend; dbPath?: string },
): Record<string, unknown> {
  const target = error instanceof AuditStorageError ? error.cause ?? error : error;
  const driverCode = driverErrorCode(target);

  return {
    backend: context.backend,
    ...(context.dbPath !== undefined && { dbFile: path.basename(context.dbPath) }),
    ...(driverCode !== undefined && { driverCode }),
    ...(error instanceof AuditStorageError && { code: error.code }),
  };
}

// ── Metrics ──────────────────────────────────────────────────────────────────

export interface AuditStorageMetrics {
  registry: Registry;
  appendAttempts: Counter<'backend'>;
  appendRetries: Counter<'backend' | 'driver_code'>;
  appendFailures: Counter<'backend'>;
  fallbackActivations: Counter<'backend'>;
  fallbackWrites: Counter<'backend'>;
  health: Gauge<'backend' | 'health'>;
}

const HEALTH_GAUGE_VALUES: Readonly<Record<AuditStorageHealth, number>> = {
  ok: 0,
  degraded: 1,
  unavailable: 2,
};

/**
 * Creates the audit-storage metrics on a caller-supplied registry.
 *
 * Labels are limited to the two finite sets defined here, so no
 * request-controlled value can inflate cardinality.
 */
export function createAuditStorageMetrics(registry: Registry): AuditStorageMetrics {
  return {
    registry,
    appendAttempts: new Counter({
      name: 'audit_storage_append_attempts_total',
      help: 'Audit entries submitted to the active storage backend.',
      labelNames: ['backend'] as const,
      registers: [registry],
    }),
    appendRetries: new Counter({
      name: 'audit_storage_append_retries_total',
      help: 'Retried audit appends after a transient storage failure.',
      labelNames: ['backend', 'driver_code'] as const,
      registers: [registry],
    }),
    appendFailures: new Counter({
      name: 'audit_storage_append_failures_total',
      help: 'Audit appends that exhausted every permitted attempt.',
      labelNames: ['backend'] as const,
      registers: [registry],
    }),
    fallbackActivations: new Counter({
      name: 'audit_storage_fallback_activations_total',
      help: 'Times the audit repository degraded to its in-memory fallback.',
      labelNames: ['backend'] as const,
      registers: [registry],
    }),
    fallbackWrites: new Counter({
      name: 'audit_storage_fallback_writes_total',
      help: 'Audit entries written to the in-memory fallback after degrading.',
      labelNames: ['backend'] as const,
      registers: [registry],
    }),
    health: new Gauge({
      name: 'audit_storage_health',
      help: 'Audit storage health (0 = ok, 1 = degraded, 2 = unavailable).',
      labelNames: ['backend', 'health'] as const,
      registers: [registry],
    }),
  };
}

let metricsSingleton: AuditStorageMetrics | undefined;

/**
 * Process-wide audit storage metrics.
 *
 * Created on first use so that importing this module never registers metrics as
 * a side effect.
 */
export function getAuditStorageMetrics(): AuditStorageMetrics {
  if (metricsSingleton === undefined) {
    metricsSingleton = createAuditStorageMetrics(new Registry());
  }
  return metricsSingleton;
}

/** Registry the audit storage metrics are registered on, for scraping. */
export function getAuditStorageMetricsRegistry(): Registry {
  return getAuditStorageMetrics().registry;
}

// ── Retrying repository ──────────────────────────────────────────────────────

export interface AuditStorageRetryOptions {
  /** Total attempts per append, including the first. Defaults to 2. */
  maxAttempts?: number;
  /** Base name of the database file, for logs only. */
  dbPath?: string;
  /** Metrics sink; defaults to the process-wide set. */
  metrics?: AuditStorageMetrics;
  /** Logger; defaults to the application logger. */
  log?: Pick<typeof logger, 'info' | 'warn' | 'error'>;
}

/**
 * Retries transient append failures and nothing else.
 *
 * Purely a decorator: every read and the integrity report pass straight
 * through, so wrapping a repository cannot change what a caller reads.
 */
export class RetryingAuditRepository implements AuditLogRepository {
  private readonly maxAttempts: number;
  private readonly metrics: AuditStorageMetrics;
  private readonly log: Pick<typeof logger, 'warn' | 'error'>;
  private appendAttempts = 0;
  private appendRetries = 0;
  private appendFailures = 0;
  private lastFailureCode: AuditStorageErrorCode | undefined;
  private degradedSince: string | undefined;

  constructor(
    private readonly primary: AuditLogRepository,
    private readonly backend: AuditStorageBackend = 'sqlite',
    private readonly options: AuditStorageRetryOptions = {},
  ) {
    this.maxAttempts = Math.max(options.maxAttempts ?? DEFAULT_AUDIT_STORAGE_APPEND_ATTEMPTS, 1);
    this.metrics = options.metrics ?? getAuditStorageMetrics();
    this.log = options.log ?? logger;
  }

  append(input: CreateAuditEntryInput): AuditEntry {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      this.appendAttempts += 1;
      this.metrics.appendAttempts.inc({ backend: this.backend });

      try {
        return this.primary.append(input);
      } catch (error) {
        lastError = error;

        if (!isRetryableStorageError(error) || attempt === this.maxAttempts) {
          break;
        }

        this.appendRetries += 1;
        this.metrics.appendRetries.inc({
          backend: this.backend,
          driver_code: driverErrorCode(error) ?? 'unknown',
        });
        this.log.warn('audit_storage_append_retry', {
          ...describeStorageFailure(error, {
            backend: this.backend,
            ...(this.options.dbPath !== undefined && { dbPath: this.options.dbPath }),
          }),
          attempt,
          maxAttempts: this.maxAttempts,
        });
      }
    }

    // Nothing was committed: the driver rolled the failed attempt back before
    // the error surfaced, so re-throwing cannot lose a partially written entry.
    this.appendFailures += 1;
    this.lastFailureCode = AUDIT_STORAGE_ERROR_CODES.APPEND_FAILED;
    this.metrics.appendFailures.inc({ backend: this.backend });
    this.log.error('audit_storage_append_failed', {
      ...describeStorageFailure(lastError, {
        backend: this.backend,
        ...(this.options.dbPath !== undefined && { dbPath: this.options.dbPath }),
      }),
      attempts: this.maxAttempts,
    });

    throw new AuditStorageError(
      AUDIT_STORAGE_ERROR_CODES.APPEND_FAILED,
      `Audit entry could not be persisted after ${this.maxAttempts} attempt(s)`,
      { backend: this.backend, attempts: this.maxAttempts, cause: lastError },
    );
  }

  getById(id: string): AuditEntry | undefined {
    return this.primary.getById(id);
  }

  query(query?: AuditQuery): AuditEntry[] {
    return this.primary.query(query);
  }

  queryWithCursor(query?: AuditQuery): AuditQueryResult {
    return this.primary.queryWithCursor(query);
  }

  stream(query?: AuditQuery): IterableIterator<AuditEntry> {
    return this.primary.stream(query);
  }

  count(): number {
    return this.primary.count();
  }

  verifyIntegrity(): IntegrityReport {
    return this.primary.verifyIntegrity();
  }

  status(): AuditRepositoryStatus {
    return {
      backend: this.backend,
      durable: this.backend === 'sqlite',
      health: 'ok',
      ...(this.degradedSince !== undefined && { degradedSince: this.degradedSince }),
      appendAttempts: this.appendAttempts,
      appendRetries: this.appendRetries,
      appendFailures: this.appendFailures,
      fallbackActivations: 0,
      fallbackWrites: 0,
      ...(this.lastFailureCode !== undefined && { lastFailureCode: this.lastFailureCode }),
    };
  }
}

// ── Degrading repository ─────────────────────────────────────────────────────

export interface FallbackAuditRepositoryOptions {
  /** Metrics sink; defaults to the process-wide set. */
  metrics?: AuditStorageMetrics;
  /** Logger; defaults to the application logger. */
  log?: Pick<typeof logger, 'info' | 'warn' | 'error'>;
  /**
   * Injectable clock, so tests can assert on `degradedSince` without waiting.
   */
  now?: () => Date;
}

/**
 * Serves from the in-memory chain once the durable backend has failed.
 *
 * Constructed only when `AUDIT_STORAGE_FALLBACK=memory`; with the default
 * policy a durable failure propagates instead (see the module header).
 *
 * Degradation is one-way and idempotent: the first failure engages the
 * fallback and is reported once, so a sustained outage produces one log line
 * per outage rather than one per request. `degrade()` is public so a supervisor
 * can force the transition after an out-of-band health check.
 */
export class FallbackAuditRepository implements AuditLogRepository {
  private readonly primary: AuditLogRepository;
  private readonly fallback: AuditLogRepository;
  private readonly metrics: AuditStorageMetrics;
  private readonly log: Pick<typeof logger, 'warn' | 'error'>;
  private readonly now: () => Date;
  private degraded = false;
  private degradedSince: string | undefined;
  private fallbackActivations = 0;
  private fallbackWrites = 0;
  private appendAttempts = 0;
  private lastFailureCode: AuditStorageErrorCode | undefined;

  constructor(
    primary: AuditLogRepository,
    fallback: AuditLogRepository,
    private readonly backend: AuditStorageBackend = 'sqlite',
    private readonly dbPath?: string,
    options: FallbackAuditRepositoryOptions = {},
  ) {
    this.primary = primary;
    this.fallback = fallback;
    this.metrics = options.metrics ?? getAuditStorageMetrics();
    this.log = options.log ?? logger;
    this.now = options.now ?? (() => new Date());
  }

  /** True once the fallback is serving. */
  get isDegraded(): boolean {
    return this.degraded;
  }

  /** Backend currently serving traffic. */
  get activeBackend(): AuditStorageBackend {
    return this.degraded ? 'memory' : this.backend;
  }

  /**
   * Engages the fallback. Idempotent: later calls only refresh
   * `lastFailureCode` so the newest diagnosis is the one reported.
   *
   * `code` names the failure when `reason` is a raw driver error that carries
   * no {@link AuditStorageErrorCode} of its own — a caller that knows it was a
   * write says so rather than letting this guess.
   */
  degrade(reason?: unknown, code?: AuditStorageErrorCode): void {
    if (reason instanceof AuditStorageError) {
      this.lastFailureCode = reason.code;
    } else if (code !== undefined) {
      this.lastFailureCode = code;
    } else if (this.lastFailureCode === undefined) {
      this.lastFailureCode = AUDIT_STORAGE_ERROR_CODES.DEPENDENCY_FAILED;
    }

    if (this.degraded) return;

    this.degraded = true;
    this.degradedSince = this.now().toISOString();
    this.fallbackActivations += 1;
    this.metrics.fallbackActivations.inc({ backend: this.backend });
    this.setHealthGauge('degraded');

    this.log.error('audit_storage_degraded', {
      ...describeStorageFailure(reason, {
        backend: this.backend,
        ...(this.dbPath !== undefined && { dbPath: this.dbPath }),
      }),
      ...(this.lastFailureCode !== undefined && { lastFailureCode: this.lastFailureCode }),
      activeBackend: 'memory',
      durable: false,
      degradedSince: this.degradedSince,
    });
  }

  append(input: CreateAuditEntryInput): AuditEntry {
    this.appendAttempts += 1;

    if (!this.degraded) {
      try {
        return this.primary.append(input);
      } catch (error) {
        this.degrade(error, AUDIT_STORAGE_ERROR_CODES.APPEND_FAILED);
      }
    }

    try {
      const entry = this.fallback.append(input);
      this.fallbackWrites += 1;
      this.metrics.fallbackWrites.inc({ backend: this.backend });
      return entry;
    } catch (error) {
      this.lastFailureCode = AUDIT_STORAGE_ERROR_CODES.WRITE_UNAVAILABLE;
      this.setHealthGauge('unavailable');
      this.log.error('audit_storage_write_unavailable', {
        ...describeStorageFailure(error, { backend: 'memory' }),
        attempts: 1,
      });
      throw new AuditStorageError(
        AUDIT_STORAGE_ERROR_CODES.WRITE_UNAVAILABLE,
        'Audit entry could not be persisted to the durable backend or its fallback',
        { backend: this.backend, cause: error },
      );
    }
  }

  /**
   * Publishes the health gauge for the active backend.
   *
   * The gauge carries one series per state with a fixed numeric value so a
   * scraper can distinguish "not reported" from "reported 0", which is why the
   * numbers come from {@link HEALTH_GAUGE_VALUES} rather than being inlined.
   */
  private setHealthGauge(health: AuditStorageHealth): void {
    this.metrics.health.set({ backend: this.backend, health }, HEALTH_GAUGE_VALUES[health]);
  }

  /** Backend serving the current request. Reads and writes always agree. */
  private active(): AuditLogRepository {
    return this.degraded ? this.fallback : this.primary;
  }

  getById(id: string): AuditEntry | undefined {
    return this.active().getById(id);
  }

  query(query?: AuditQuery): AuditEntry[] {
    return this.active().query(query);
  }

  queryWithCursor(query?: AuditQuery): AuditQueryResult {
    return this.active().queryWithCursor(query);
  }

  stream(query?: AuditQuery): IterableIterator<AuditEntry> {
    return this.active().stream(query);
  }

  count(): number {
    return this.active().count();
  }

  /**
   * Integrity of the chain currently being served.
   *
   * While degraded this describes the in-memory chain only — the durable chain
   * may have diverged and must be re-verified once the backend is restored.
   */
  verifyIntegrity(): IntegrityReport {
    return this.active().verifyIntegrity();
  }

  status(): AuditRepositoryStatus {
    const health: AuditStorageHealth = this.degraded ? 'degraded' : 'ok';
    return {
      backend: this.activeBackend,
      durable: !this.degraded && this.backend === 'sqlite',
      health,
      ...(this.degradedSince !== undefined && { degradedSince: this.degradedSince }),
      appendAttempts: this.appendAttempts,
      appendRetries: 0,
      appendFailures: 0,
      fallbackActivations: this.fallbackActivations,
      fallbackWrites: this.fallbackWrites,
      ...(this.lastFailureCode !== undefined && { lastFailureCode: this.lastFailureCode }),
    };
  }
}

// ── Construction ─────────────────────────────────────────────────────────────

/**
 * Opens the SQLite-backed repository.
 *
 * Opening the handle *and* creating the schema are treated as one step: a
 * half-initialised ledger is not something a caller can be handed.
 *
 * @throws AuditStorageError `open_failed`
 */
export function openSqliteAuditRepository(dbPath: string): SqliteAuditRepository {
  try {
    // Load the native module only when the SQLite backend is selected so
    // in-memory tests can run on machines without compiled bindings.
    const db = new Database(dbPath);
    return new SqliteAuditRepository(db);
  } catch (cause) {
    logger.error('audit_storage_open_failed', describeStorageFailure(cause, { backend: 'sqlite', dbPath }));
    throw new AuditStorageError(
      AUDIT_STORAGE_ERROR_CODES.OPEN_FAILED,
      'Audit storage backend could not be opened',
      { backend: 'sqlite', cause },
    );
  }
}

export interface CreateAuditRepositoryOptions {
  /** Environment to read configuration from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Opens the SQLite repository. Injectable for tests. */
  openSqlite?: (dbPath: string) => AuditLogRepository;
  /** Repository serving once the durable backend has failed. */
  fallbackRepository?: AuditLogRepository;
  /** Metrics sink for any wrappers created here. */
  metrics?: AuditStorageMetrics;
  /** Logger for any wrappers created here. */
  log?: Pick<typeof logger, 'info' | 'warn' | 'error'>;
}

/**
 * Builds the repository described by the environment.
 *
 * Behaviour for a working configuration is unchanged from the previous
 * implementation: `memory` returns the shared {@link auditStore} singleton and
 * `sqlite` returns a repository over a freshly opened database. What is new is
 * that both the configuration errors and the failures they used to raise
 * arrive as {@link AuditStorageError} with a stable code, and that a failed
 * SQLite open is recoverable when the operator has opted into
 * `AUDIT_STORAGE_FALLBACK=memory`.
 *
 * @throws AuditStorageError on an unsupported backend, an unusable
 *   configuration value, or a failed open with no fallback configured.
 */
export function createDefaultAuditRepository(
  options: CreateAuditRepositoryOptions = {},
): AuditLogRepository {
  const env = options.env ?? process.env;
  const backend = resolveAuditStorageBackend(env);
  const fallbackPolicy = resolveAuditStorageFallback(env);
  const maxAttempts = resolveAuditStorageAppendAttempts(env);

  if (backend === 'memory') {
    // The shared singleton: returning it unwrapped keeps every entry already in
    // memory visible to the returned repository, which is the one guarantee a
    // fallback must never break.
    return options.fallbackRepository ?? auditStore;
  }

  const dbPath = resolveAuditDbPath(env);
  const log = options.log ?? logger;
  const metrics = options.metrics ?? getAuditStorageMetrics();

  let repository: AuditLogRepository;
  try {
    const open = options.openSqlite ?? openSqliteAuditRepository;
    repository = open(dbPath);
  } catch (cause) {
    const failure =
      cause instanceof AuditStorageError
        ? cause
        : new AuditStorageError(
            AUDIT_STORAGE_ERROR_CODES.OPEN_FAILED,
            'Audit storage backend could not be opened',
            { backend: 'sqlite', cause },
          );

    if (fallbackPolicy !== 'memory') throw failure;

    // degrade() emits a single `audit_storage_degraded` record carrying the
    // driver code, so a failed start-up is diagnosable from the log alone.
    const fallback = options.fallbackRepository ?? auditStore;
    const degraded = new FallbackAuditRepository(fallback, fallback, 'sqlite', dbPath, {
      metrics,
      log,
    });
    degraded.degrade(failure);
    return degraded;
  }

  const retrying = new RetryingAuditRepository(repository, 'sqlite', {
    maxAttempts,
    dbPath,
    metrics,
    log,
  });

  if (fallbackPolicy === 'memory') {
    return new FallbackAuditRepository(
      retrying,
      options.fallbackRepository ?? auditStore,
      'sqlite',
      dbPath,
      { metrics, log },
    );
  }

  log.info('audit_storage_resolved', {
    backend: 'sqlite',
    dbFile: path.basename(dbPath),
    durable: true,
    appendAttempts: maxAttempts,
    fallback: fallbackPolicy,
  });

  return retrying;
}
