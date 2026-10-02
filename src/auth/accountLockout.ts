/**
 * @module auth/accountLockout
 * @description
 * Per-account progressive lockout for the login endpoint (issue #631).
 *
 * ## Problem
 * The IP-based rate limiter in `src/middleware/rateLimiter.ts` keeps a single
 * account safe from a botnet running from one address, but it cannot stop a
 * distributed credential-stuffing run from hammering one account from many
 * IPs. `AuthService.login` previously tracked no failed-attempt state per
 * identity, so a single attacker could try thousands of passwords against one
 * victim without anything slowing them down.
 *
 * ## Solution
 * Track **consecutive failures** keyed by normalized email (trim+lowercase)
 * via a SHA-256-keyed in-memory map. After `maxFailures` failures, lock the
 * account for `lockoutDurationMs`. Each failure (and locked-state response)
 * is padded with an `exponential-min(maxDelay)` delay so the response time
 * scales with attacker cost without ever revealing either the live failure
 * count or the remaining lockout duration.
 *
 * ## Security properties
 * - Identity is normalized via `normalizeEmail` so case-variant or
 *   whitespace-padded variants of the same email collide on the same key.
 * - Storage keys are SHA-256-hashed before insertion; raw emails are not
 *   retained as keys. Callers and audit sinks can still hold raw identities.
 * - Lockout is **per-account**, deliberately independent of IP — this is
 *   the property that defeats distributed credential stuffing. A change
 *   of IP after triggering lockout does NOT release the lockout; only
 *   deadline expiry or a trusted successful-login reset does.
 * - Failures during an active lockout are a no-op. They do not extend the
 *   lockout (whose deadline is fixed at trigger time) and they do not
 *   re-emit the trigger audit. This bounds how many audit entries one
 *   attacker can generate per streak.
 * - Trigger and successful-login release audits are best effort; sweep
 *   does not emit release events. The error response shape
 *   (code + message + status) is kept identical to a non-locked invalid
 *   credential so the response cannot be used to probe lockout state.
 * - Successful logins clear the record. A login that follows a previously
 *   locked streak emits `AUTH_LOCKOUT_RELEASED`; a clean login with no
 *   prior lockout emits nothing extra (the standard `AUTH_LOGIN` event is
 *   logged by the auth middleware).
 * - Assessment and failure transitions are synchronous within one process.
 *   Routes must reassess after asynchronous credential checks. The Map is
 *   neither durable nor shared across workers.
 * - A periodic sweep (`sweep`) purges expired locks and decayed unlocked
 *   streaks. It does not impose a hard capacity limit.
 *
 * ## Configuration
 * All knobs are env-driven via `loadAccountLockoutConfig()`, which
 * validates values defensively (invalid values fall back with a stderr
 * warning rather than crashing the process).
 */

import { createHash } from 'crypto';
import { auditService, type AuditService } from '../audit/service';
import { normalizeEmail } from '../repositories/userRepository';

/**
 * Tunable, env-driven configuration for `AccountLockoutTracker`.
 *
 * @property enabled - Master switch. When false, all tracker methods are
 *   no-ops so the route can degrade gracefully in emergencies.
 * @property maxFailures - Consecutive-failure threshold that locks the
 *   account. Active locks reject further failures, so one trigger audit
 *   is emitted per streak even after a threshold reduction.
 * @property decayWindowMs - Sliding window since the LAST recorded
 *   failure. If exceeded, the failure counter resets to zero. Decay is
 *   evaluated both at `assess`/`recordFailure` time and by the GC
 *   sweep.
 * @property lockoutDurationMs - How long the lockout lasts once
 *   triggered. Does NOT extend when additional failed attempts arrive
 *   during the lockout window — the deadline is fixed at trigger time.
 * @property baseDelayMs - First-failure response delay. Doubles on each
 *   subsequent consecutive failure (capped at `maxDelayMs`).
 * @property delayMultiplier - Multiplier per failure. Must be >= 1; a
 *   value of 1 effectively disables the progressive effect.
 * @property maxDelayMs - Hard cap on the response delay. Also the delay
 *   applied to a request rejected because the account is currently
 *   locked. Chosen large enough to deter brute-force at human-detectable
 *   latency while keeping legitimate bursty clients usable.
 */
export interface AccountLockoutConfig {
  enabled: boolean;
  maxFailures: number;
  decayWindowMs: number;
  lockoutDurationMs: number;
  baseDelayMs: number;
  delayMultiplier: number;
  maxDelayMs: number;
}

/** Defaults — overridden per deployment via env vars (see {@link loadAccountLockoutConfig}). */
export const DEFAULT_ACCOUNT_LOCKOUT_CONFIG: Readonly<AccountLockoutConfig> = Object.freeze({
  enabled: true,
  maxFailures: 5,
  decayWindowMs: 15 * 60 * 1000,
  lockoutDurationMs: 15 * 60 * 1000,
  baseDelayMs: 250,
  delayMultiplier: 2,
  maxDelayMs: 5000,
});

/** Internal state per normalized identity. */
interface FailureRecord {
  /** Consecutive failure count for the current streak. */
  failed: number;
  /** Timestamp (epoch ms) of the first failure in the current streak. */
  firstFailureAt: number;
  /** Timestamp (epoch ms) of the most recent failure in the current streak. */
  lastFailureAt: number;
  /** Lockout deadline (epoch ms). 0 when no lockout is active. */
  lockedUntil: number;
}

/**
 * Read-only snapshot returned by `assess()`. The route uses `isLocked`
 * to short-circuit obvious rejects and `preDelayMs` to compute the
 * uniform padding the route applies after `authService.login`.
 */
export interface AccountAssessment {
  isLocked: boolean;
  /** Live (post-decay) consecutive failure count. */
  failures: number;
  /** ms remaining until the lockout expires. 0 when not locked. */
  remainingLockoutMs: number;
  /**
   * Delay the route should pad to on the next response for this identity.
   * Equals `computeDelay(failures)` so the padding grows with each
   * consecutive failure.
   */
  preDelayMs: number;
}

/**
 * Context that the route forwards from each request — propagated to the
 * audit entry so security operators can correlate lockout events with
 * the originating request.
 */
export interface AuditContext {
  ipAddress?: string | undefined;
  correlationId?: string | undefined;
}

/** Result returned by `recordFailure()`. */
export interface FailureRecordResult {
  isNowLocked: boolean;
  failures: number;
  /**
   * Delay the route should pad to on this response. Equals
   * `maxDelayMs` when the account is currently locked OR when this
   * attempt just triggered the lockout; equals `computeDelay(N)`
   * otherwise.
   */
  waitMs: number;
  /** True iff THIS attempt transitioned the account into lockout. */
  triggeredLockout: boolean;
}

/** Result returned by `recordSuccess()`. */
export interface SuccessRecordResult {
  releasedLockout: boolean;
  previousFailures: number;
}

/** Constructor options — all fields are optional and default to production values. */
export interface AccountLockoutTrackerOptions {
  /** Audit sink; defaults to the `auditService` singleton. */
  audit?: Pick<AuditService, 'log'>;
  /** Clock; defaults to `() => Date.now()`. Injected for tests. */
  now?: () => number;
  /** Async sleep; defaults to `setTimeout`. Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Interval (ms) at which `sweep()` runs in the background to GC
   * expired records. Set to 0 to disable the sweep timer entirely
   * (useful for tests; production keeps it enabled).
   */
  sweepIntervalMs?: number;
}

/**
 * Per-account lockout state machine.
 *
 * The route wires this into `POST /auth/login`. Other entry points
 * (refresh, logout) deliberately do NOT consult the tracker — only the
 * login attempt can be used to brute-force a password.
 */
export class AccountLockoutTracker {
  private currentConfig!: Readonly<AccountLockoutConfig>;

  /** Immutable policy snapshot. Replace the whole policy to reconfigure. */
  get config(): Readonly<AccountLockoutConfig> {
    return this.currentConfig;
  }

  set config(value: AccountLockoutConfig) {
    // Validate/copy before publication: invalid updates leave policy and
    // records intact; caller-owned objects cannot change thresholds later.
    this.currentConfig = validatedConfig(value);
  }

  private readonly records = new Map<string, FailureRecord>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly audit: Pick<AuditService, 'log'>;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  /** Guards against overlapping sweep executions from the interval timer. */
  private sweeping = false;

  constructor(
    config: AccountLockoutConfig,
    options: AccountLockoutTrackerOptions = {},
  ) {
    this.config = config;
    this.audit = options.audit ?? auditService;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultSleep;

    if (this.config.enabled) {
      const sweepInterval =
        options.sweepIntervalMs ??
        Math.max(
          60_000,
          Math.min(Math.floor(this.config.decayWindowMs / 5), 300_000),
        );
      if (sweepInterval > 0) {
        const timer: ReturnType<typeof setInterval> = setInterval(
          () => this.sweep(),
          sweepInterval,
        );
        if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
          (timer as unknown as { unref: () => void }).unref();
        }
        this.sweepTimer = timer;
      }
    }
  }

  // ── Public methods ────────────────────────────────────────────────────────

  /**
   * Serializes concurrent asynchronous operations for the same identity.
   * This prevents TOCTOU (Time-of-Check to Time-of-Use) bypasses where
   * concurrent requests might bypass the `assess()` check before the
   * first failure is recorded.
   */
  async withLock<T>(rawEmail: string, fn: () => Promise<T>): Promise<T> {
    if (!this.config.enabled) {
      return fn();
    }
    const key = this.keyFor(rawEmail);
    if (!key) {
      return fn();
    }

    const existingLock = this.locks.get(key) || Promise.resolve();
    let release: () => void;
    const newLock = new Promise<void>((resolve) => {
      release = resolve;
    });

    this.locks.set(key, existingLock.then(() => newLock));

    try {
      await existingLock;
      return await fn();
    } finally {
      release!();
      if (this.locks.get(key) === newLock) {
        this.locks.delete(key);
      }
    }
  }

  /**
   * Read-only check. Returns the LIVE (post-decay) state for the given
   * identity WITHOUT mutating the underlying record. The record's
   * `lockedUntil` marker is preserved across the expiry boundary so a
   * later `recordSuccess` can correctly emit `AUTH_LOCKOUT_RELEASED`.
   *
   * Whether the lockout is "still active" is derived from the live
   * clock (`now < lockedUntil`); the marker itself persists until
   * `recordSuccess` clears the record or the GC sweep reaps it.
   */
  assess(rawEmail: string): AccountAssessment {
    if (!this.config.enabled) {
      return zeroAssessment();
    }
    const key = this.keyFor(rawEmail);
    if (!key) {
      return zeroAssessment();
    }
    const record = this.records.get(key);
    if (!record) {
      return zeroAssessment();
    }

    const now = this.now();
    const isLocked = record.lockedUntil > 0 && now < record.lockedUntil;

    // The `failed` counter is the historical streak count. For UI /
    // logging purposes the LIVE count is what callers want: a streak
    // whose lockout has already expired is "fresh" for retry-pacing,
    // and a streak whose last failure is past the decay window is
    // effectively a new identity for retry purposes.
    let liveFailures = record.failed;
    if (record.lockedUntil > 0 && now >= record.lockedUntil) {
      // Lockout has elapsed — fresh streak, no live failures.
      liveFailures = 0;
    } else if (
      !isLocked &&
      record.failed > 0 &&
      now - record.lastFailureAt > this.config.decayWindowMs
    ) {
      liveFailures = 0;
    }

    return {
      isLocked,
      failures: liveFailures,
      // Equal to maxDelayMs when `isLocked` — keeps the response
      // timing uniform across locked attempts regardless of how
      // much lockout time is left.
      preDelayMs: isLocked ? this.config.maxDelayMs : this.computeDelay(liveFailures),
      remainingLockoutMs: isLocked ? record.lockedUntil - now : 0,
    };
  }

  /**
   * Synchronous state mutation. Increments the failure counter,
   * evaluates the lockout trigger condition, and returns the delay the
   * route should pad to on this response.
   *
   * Idempotency under burst: while the account is already locked, this
   * method returns early WITHOUT incrementing `failed` and WITHOUT
   * extending the lockout. This bounds audit churn from a single
   * attacker hammering one locked account.
   */
  recordFailure(rawEmail: string, ctx: AuditContext = {}): FailureRecordResult {
    if (!this.config.enabled) {
      return { isNowLocked: false, failures: 0, waitMs: 0, triggeredLockout: false };
    }

    const key = this.keyFor(rawEmail);
    if (!key) {
      return { isNowLocked: false, failures: 0, waitMs: 0, triggeredLockout: false };
    }

    const now = this.now();
    let record = this.records.get(key);
    if (!record) {
      record = emptyRecord();
      this.records.set(key, record);
    }

    // Decay first so the increment always reflects the live counter.
    this.refreshInPlace(record, now);

    const wasLocked = record.lockedUntil > 0 && now < record.lockedUntil;
    if (wasLocked) {
      // Already locked — uniform max delay, no state mutation, no audit.
      return {
        isNowLocked: true,
        failures: record.failed,
        waitMs: this.config.maxDelayMs,
        triggeredLockout: false,
      };
    }

    record.failed += 1;
    record.lastFailureAt = now;
    if (record.failed === 1) {
      record.firstFailureAt = now;
    }

    // Active locks returned above, so >= also handles a policy update that
    // lowers the threshold below an existing unlocked failure count.
    let triggeredLockout = false;
    if (record.failed >= this.config.maxFailures) {
      record.lockedUntil = now + this.config.lockoutDurationMs;
      triggeredLockout = true;
    }

    const result = {
      isNowLocked: record.lockedUntil > 0 && now < record.lockedUntil,
      failures: record.failed,
      waitMs: triggeredLockout ? this.config.maxDelayMs : this.computeDelay(record.failed),
      triggeredLockout,
    };
    // Capture the transition before calling the external audit sink; a
    // reentrant sink must not change this operation's returned snapshot.
    if (triggeredLockout) this.emitTriggerAudit(rawEmail, record, ctx);
    return result;
  }

  /**
   * Synchronous state mutation. Clears the record and, if it represented
   * a previously locked streak, emits `AUTH_LOCKOUT_RELEASED`.
   *
   * The "previously locked" detection anchors on `record.lockedUntil > 0`
   * regardless of whether the lockout has expired. This guarantees one
   * release audit per streak even if the user is logging in for the
   * first time after a 15-minute lockout has elapsed.
   */
  recordSuccess(rawEmail: string, ctx: AuditContext = {}): SuccessRecordResult {
    if (!this.config.enabled) {
      return { releasedLockout: false, previousFailures: 0 };
    }

    const key = this.keyFor(rawEmail);
    if (!key) {
      return { releasedLockout: false, previousFailures: 0 };
    }

    const record = this.records.get(key);
    if (!record) {
      return { releasedLockout: false, previousFailures: 0 };
    }

    const wasLocked = record.lockedUntil > 0;
    const previousFailures = record.failed;
    // Full delete so a stale record can't re-fire a release audit on a
    // future login (issue surfaced in design review — see P1 finding).
    this.records.delete(key);

    if (wasLocked) {
      this.emitReleaseAudit(rawEmail, previousFailures, ctx);
    }

    return { releasedLockout: wasLocked, previousFailures };
  }

  /**
   * Pure delay-from-count calculator.
   *
   * Encodes the curve:
   *   delay(N) = min(baseDelay * multiplier^(N-1), maxDelay)
   * with `delay(0) = 0`.
   *
   * Exposed as a method (not a private helper) so tests can assert the
   * curve independently of the rest of the state machine.
   */
  computeDelay(failures: number): number {
    if (
      !Number.isSafeInteger(failures) ||
      failures <= 0 ||
      this.config.baseDelayMs === 0
    ) return 0;
    const exponential =
      this.config.baseDelayMs * Math.pow(this.config.delayMultiplier, failures - 1);
    return Math.min(exponential, this.config.maxDelayMs);
  }

  /**
   * Garbage-collect records that have outlived both their lockout and
   * the decay window. Called automatically by the sweep timer and from
   * tests for deterministic assertions.
   *
   * @returns Number of records removed.
   */
  sweep(): number {
    if (this.sweeping) {
      return 0;
    }
    this.sweeping = true;
    try {
    const now = this.now();
    const decayCutoff = now - this.config.decayWindowMs;
    let removed = 0;
    for (const [key, record] of this.records) {
      const lockoutExpired = record.lockedUntil > 0 && now >= record.lockedUntil;
      const decayed =
        record.lockedUntil === 0 &&
        record.failed > 0 &&
        record.lastFailureAt < decayCutoff;
      if (lockoutExpired || decayed) {
        this.records.delete(key);
        removed += 1;
      }
    }
    return removed;
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * Test helper: clears all tracked state. Does NOT stop the sweep
   * timer. Use `destroy()` if you also need to release timer handles.
   */
  reset(): void {
    this.records.clear();
    this.sweeping = false;
  }

  /** Stops the sweep timer and clears all stored records. */
  destroy(): void {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.records.clear();
    this.sweeping = false;
  }

  /** Number of identities currently being tracked (test introspection). */
  get size(): number {
    return this.records.size;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * Normalize the email and hash the result. Returns `null` for inputs
   * that cannot be turned into a meaningful identity (empty after
   * trim, missing, etc) so the tracker does not create records for
   * invalid payloads.
   */
  private keyFor(raw: string): string | null {
    if (typeof raw !== 'string') return null;
    const norm = normalizeEmail(raw);
    if (norm.length === 0) return null;
    return createHash('sha256').update(norm).digest('hex');
  }

  /**
   * Mutates `record` to reflect any pending decay / lockout expiry.
   * Important: clears `lockedUntil = 0` so a stale record cannot re-fire
   * a release audit on a future login (see P1 in design review).
   */
  private refreshInPlace(record: FailureRecord, now: number): void {
    // An active fixed deadline always wins over sliding counter decay.
    // Rejected attempts cannot shorten or extend it, even when the decay
    // window is configured shorter than the lockout duration.
    if (record.lockedUntil > 0 && now < record.lockedUntil) return;

    // Lockout has elapsed — full reset; record is fresh.
    if (record.lockedUntil > 0 && now >= record.lockedUntil) {
      record.failed = 0;
      record.firstFailureAt = 0;
      record.lastFailureAt = 0;
      record.lockedUntil = 0;
      return;
    }

    // Decay window elapsed since last failure — counter resets.
    if (
      record.failed > 0 &&
      now - record.lastFailureAt > this.config.decayWindowMs
    ) {
      record.failed = 0;
      record.firstFailureAt = 0;
      record.lastFailureAt = 0;
      record.lockedUntil = 0;
    }
  }

  private emitTriggerAudit(
    rawEmail: string,
    record: FailureRecord,
    ctx: AuditContext,
  ): void {
    try {
      const normalized = normalizeEmail(rawEmail);
      // Use the raw (potentially empty-post-trim) input only when
      // normalizeEmail returns a usable string; otherwise emit the
      // placeholder so the audit log always has an identifiable field.
      const actor = normalized.length > 0 ? normalized : 'unknown';
      this.audit.log({
        action: 'AUTH_LOCKOUT_TRIGGERED',
        severity: 'WARNING',
        actor,
        resource: 'auth',
        resourceId: actor,
        metadata: {
          failures: record.failed,
          decayWindowMs: this.config.decayWindowMs,
          lockoutDurationMs: this.config.lockoutDurationMs,
          lockedUntilIso: new Date(record.lockedUntil).toISOString(),
          reason: 'consecutive_failures',
        },
        ...(ctx.ipAddress !== undefined && { ipAddress: ctx.ipAddress }),
        ...(ctx.correlationId !== undefined && { correlationId: ctx.correlationId }),
      });
    } catch {
      // Audit failures must not break the auth flow. Surface for ops
      // visibility on stderr so they can correlate the auth response
      // with the missing audit entry during incident review.
      // eslint-disable-next-line no-console
      console.error(
        '[accountLockout] failed to write AUTH_LOCKOUT_TRIGGERED audit entry',
      );
    }
  }

  private emitReleaseAudit(
    rawEmail: string,
    previousFailures: number,
    ctx: AuditContext,
  ): void {
    try {
      const normalized = normalizeEmail(rawEmail);
      const actor = normalized.length > 0 ? normalized : 'unknown';
      this.audit.log({
        action: 'AUTH_LOCKOUT_RELEASED',
        severity: 'INFO',
        actor,
        resource: 'auth',
        resourceId: actor,
        metadata: {
          previousFailures,
          lockoutDurationMs: this.config.lockoutDurationMs,
          reason: 'successful_login',
        },
        ...(ctx.ipAddress !== undefined && { ipAddress: ctx.ipAddress }),
        ...(ctx.correlationId !== undefined && { correlationId: ctx.correlationId }),
      });
    } catch {
      // eslint-disable-next-line no-console
      console.error(
        '[accountLockout] failed to write AUTH_LOCKOUT_RELEASED audit entry',
      );
    }
  }
}

// ── Helpers & exported singleton ─────────────────────────────────────────────

function emptyRecord(): FailureRecord {
  return { failed: 0, firstFailureAt: 0, lastFailureAt: 0, lockedUntil: 0 };
}

function zeroAssessment(): AccountAssessment {
  return { isLocked: false, failures: 0, remainingLockoutMs: 0, preDelayMs: 0 };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MAX_TIMER_MS = 2_147_483_647;

const NUMERIC_CONFIG_BOUNDS = {
  maxFailures: [1, Number.MAX_SAFE_INTEGER],
  decayWindowMs: [1, MAX_TIMER_MS],
  lockoutDurationMs: [1, MAX_TIMER_MS],
  baseDelayMs: [0, MAX_TIMER_MS],
  delayMultiplier: [1, 16],
  maxDelayMs: [0, MAX_TIMER_MS],
} as const;

function validatedConfig(
  config: AccountLockoutConfig,
): Readonly<AccountLockoutConfig> {
  const snapshot = { ...config };
  if (!config || typeof snapshot.enabled !== 'boolean') {
    throw new RangeError('Invalid account lockout configuration: enabled');
  }
  const fields = Object.keys(NUMERIC_CONFIG_BOUNDS) as Array<
    keyof typeof NUMERIC_CONFIG_BOUNDS
  >;
  for (const field of fields) {
    const [min, max] = NUMERIC_CONFIG_BOUNDS[field];
    const value = snapshot[field];
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new RangeError(`Invalid account lockout configuration: ${field}`);
    }
  }
  return Object.freeze(snapshot);
}

function warnInvalid(field: string, fallback: number | boolean): void {
  // Setting names are fixed by the parser; never echo untrusted values.
  console.warn(`[accountLockout] Invalid ${field}; using fallback ${fallback}`);
}

function toBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const lower = value.trim().toLowerCase();
  if (lower === 'true' || lower === '1' || lower === 'yes') return true;
  if (lower === 'false' || lower === '0' || lower === 'no') return false;
  warnInvalid('AUTH_LOCKOUT_ENABLED', fallback);
  return fallback;
}

function toCount(
  value: string | undefined,
  fallback: number,
  field: string,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value.trim());
  if (
    !/^\d+$/.test(value.trim()) ||
    !Number.isSafeInteger(parsed) ||
    parsed < min ||
    parsed > max
  ) {
    warnInvalid(field, fallback);
    return fallback;
  }
  return parsed;
}

/**
 * Parse env vars into a validated config object. Invalid values fall
 * back to the default with a stderr warning rather than crashing the
 * process — this matches the lenient pattern used by
 * `loadAccountLockoutConfig` sibling files in `src/config/`.
 */
export function loadAccountLockoutConfig(
  env: NodeJS.ProcessEnv = process.env,
): AccountLockoutConfig {
  return {
    enabled: toBool(env.AUTH_LOCKOUT_ENABLED, true),
    maxFailures: toCount(
      env.AUTH_LOCKOUT_MAX_FAILURES,
      DEFAULT_ACCOUNT_LOCKOUT_CONFIG.maxFailures,
      'AUTH_LOCKOUT_MAX_FAILURES',
      ...NUMERIC_CONFIG_BOUNDS.maxFailures,
    ),
    decayWindowMs: toCount(
      env.AUTH_LOCKOUT_DECAY_WINDOW_MS,
      DEFAULT_ACCOUNT_LOCKOUT_CONFIG.decayWindowMs,
      'AUTH_LOCKOUT_DECAY_WINDOW_MS',
      ...NUMERIC_CONFIG_BOUNDS.decayWindowMs,
    ),
    lockoutDurationMs: toCount(
      env.AUTH_LOCKOUT_LOCKOUT_DURATION_MS,
      DEFAULT_ACCOUNT_LOCKOUT_CONFIG.lockoutDurationMs,
      'AUTH_LOCKOUT_LOCKOUT_DURATION_MS',
      ...NUMERIC_CONFIG_BOUNDS.lockoutDurationMs,
    ),
    baseDelayMs: toCount(
      env.AUTH_LOCKOUT_BASE_DELAY_MS,
      DEFAULT_ACCOUNT_LOCKOUT_CONFIG.baseDelayMs,
      'AUTH_LOCKOUT_BASE_DELAY_MS',
      ...NUMERIC_CONFIG_BOUNDS.baseDelayMs,
    ),
    delayMultiplier: toCount(
      env.AUTH_LOCKOUT_DELAY_MULTIPLIER,
      DEFAULT_ACCOUNT_LOCKOUT_CONFIG.delayMultiplier,
      'AUTH_LOCKOUT_DELAY_MULTIPLIER',
      ...NUMERIC_CONFIG_BOUNDS.delayMultiplier,
    ),
    maxDelayMs: toCount(
      env.AUTH_LOCKOUT_MAX_DELAY_MS,
      DEFAULT_ACCOUNT_LOCKOUT_CONFIG.maxDelayMs,
      'AUTH_LOCKOUT_MAX_DELAY_MS',
      ...NUMERIC_CONFIG_BOUNDS.maxDelayMs,
    ),
  };
}

/**
 * Singleton tracker used by `src/routes/auth.routes.ts`.
 *
 * Constructed at module load from env vars. Tests should NOT import
 * this directly for behavioral assertions — use `AccountLockoutTracker`
 * with injected clock / audit / sleep so timing is deterministic and
 * audits can be captured per case.
 *
 * (Note: tests that need to override `config` or reset state can
 * replace `accountLockout.config` / call `accountLockout.reset()` —
 * both are exposed for test-time use, but production code should not
 * touch them.)
 */
export const accountLockout: AccountLockoutTracker = new AccountLockoutTracker(
  loadAccountLockoutConfig(),
);
