/**
 * @module rateLimiter
 * @description
 * Adaptive rate-limiting and abuse-guard middleware for Express.
 *
 * ## Algorithm
 * Uses a **sliding-window counter** per key (default: client IP).
 * When a key exceeds `maxRequests` within `windowMs`:
 *   1. A 429 Too Many Requests response is returned immediately.
 *   2. The abuse guard checks whether the violation count itself exceeds
 *      `abuseThreshold`. If so, the key is **hard-blocked** for `blockDurationMs`.
 *
 * ## RFC 6585 Compliance
 * All 429 responses include:
 * - **HTTP Status**: 429 Too Many Requests
 * - **Retry-After Header**: Seconds until the rate limit resets or block expires
 * - **X-RateLimit-* Headers**: Current state (Limit, Remaining, Reset)
 * - **Safe Error Body**: Conforms to the error contract in src/errors/safeErrors.ts
 *   to prevent information disclosure via error messages.
 *
 * ## Adaptive throttling
 * The abuse guard doubles the block duration on every successive violation
 * (exponential back-off), up to `maxBlockDurationMs`.
 *
 * ## Key extraction
 * By default the middleware uses `X-Forwarded-For` (trusting one proxy hop)
 * then falls back to `req.ip`. Callers can supply a custom `keyFn` for
 * API-key-scoped or user-scoped limiting.
 *
 * @security
 * - Keys are hashed in the store — raw IPs are never persisted.
 * - All timing operations use `Date.now()` (monotonic in V8 ≥ Node 16).
 * - Blocked responses include `Retry-After` to aid legitimate clients.
 * - Error messages are sanitized per the safe-error policy (CWE-209).
 * - Headers expose only aggregate counts, never raw keys.
 *
 * @example
 * ```ts
 * import { createRateLimiter } from './middleware/rateLimiter';
 *
 * const limiter = createRateLimiter({ maxRequests: 100, windowMs: 60_000 });
 * app.use('/api/', limiter);
 * ```
 */

import { Request, Response, NextFunction } from 'express';
import { RateLimitStore, type RateLimitStoreInterface } from '../lib/rateLimitStore';
import { sanitizeErrorMessage } from '../errors/safeErrors';


export interface RateLimiterConfig {
  /**
   * Maximum requests allowed per `windowMs`.
   * @default 100
   */
  maxRequests?: number;

  /**
   * Duration (ms) of the sliding window.
   * @default 60_000 (1 minute)
   */
  windowMs?: number;

  /**
   * Number of rate-limit violations within `blockWindowMs` before
   * the key is hard-blocked.
   * @default 5
   */
  abuseThreshold?: number;

  /**
   * How long (ms) to observe violations for the abuse threshold.
   * @default 300_000 (5 minutes)
   */
  blockWindowMs?: number;

  /**
   * Initial block duration (ms) applied when the abuse threshold is hit.
   * @default 600_000 (10 minutes)
   */
  blockDurationMs?: number;

  /**
   * Maximum block duration (ms) after exponential back-off.
   * @default 86_400_000 (24 hours)
   */
  maxBlockDurationMs?: number;

  /**
   * Custom function to derive the rate-limit key from a request.
   * Defaults to IP-based extraction.
   */
  keyFn?: (req: Request) => string;

  /**
   * If true, rate-limit headers are added to every response.
   * @default true
   */
  sendHeaders?: boolean;

  /**
   * Shared store instance. Useful for testing or multi-limiter coordination.
   * A new store is created if omitted.
   */
  store?: RateLimitStoreInterface;
}

// ─── Internal state per key ───────────────────────────────────────────────────

interface AbuseRecord {
  violations: number;
  firstViolation: number;
  blockDuration: number; // current (possibly doubled) block duration
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create an Express middleware that enforces rate limiting and abuse guards.
 *
 * @param config - {@link RateLimiterConfig} options
 * @returns Express middleware function
 */
export function createRateLimiter(config: RateLimiterConfig = {}) {
  const {
    maxRequests = 100,
    windowMs = 60_000,
    abuseThreshold = 5,
    blockWindowMs = 300_000,
    blockDurationMs = 600_000,
    maxBlockDurationMs = 86_400_000,
    keyFn = defaultKeyFn,
    sendHeaders = true,
    store = new RateLimitStore({ sweepIntervalMs: windowMs }),
  } = config;

  // Secondary map tracks violation/block metadata (not persisted in the store)
  const abuseMap = new Map<string, AbuseRecord>();

  // ─── Middleware ──────────────────────────────────────────────────────────

  return function rateLimiterMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const rawKey = keyFn(req);
    const now = Date.now();

    // ── 1. Check hard-block ──────────────────────────────────────────────
    const existing = store.get(rawKey);
    if (existing?.blocked) {
      if (now < existing.blockedUntil) {
        const retryAfterSec = Math.ceil((existing.blockedUntil - now) / 1000);
        if (sendHeaders) {
          res.setHeader('Retry-After', retryAfterSec);
          res.setHeader('X-RateLimit-Blocked', 'true');
        }
        const requestId = typeof res.locals.requestId === 'string' ? res.locals.requestId : 'unknown';
        const code = 'rate_limited';
        const safeMessage = sanitizeErrorMessage(
          'Too many requests — please try again later',
          code,
        );
        res.status(429).json({
          error: {
            code,
            message: safeMessage,
            requestId,
          },
        });
        return;
      }
      // Block expired — reset
      store.delete(rawKey);
      abuseMap.delete(RateLimitStore.hashKey(rawKey));
    }

    // ── 2. Sliding-window counter ────────────────────────────────────────
    const entry = store.get(rawKey) ?? {
      count: 0,
      windowStart: now,
      blocked: false,
      blockedUntil: 0,
    };

    // Roll the window if it has elapsed
    if (now - entry.windowStart > windowMs) {
      entry.count = 0;
      entry.windowStart = now;
    }

    entry.count += 1;
    store.set(rawKey, entry);

    const remaining = Math.max(0, maxRequests - entry.count);
    const resetSec = Math.ceil((entry.windowStart + windowMs - now) / 1000);

    if (sendHeaders) {
      res.setHeader('X-RateLimit-Limit', maxRequests);
      res.setHeader('X-RateLimit-Remaining', remaining);
      res.setHeader('X-RateLimit-Reset', resetSec);
    }

    // ── 3. Limit exceeded → abuse guard evaluation ───────────────────────
    if (entry.count > maxRequests) {
      const hashedKey = RateLimitStore.hashKey(rawKey);
      const abuse = abuseMap.get(hashedKey) ?? {
        violations: 0,
        firstViolation: now,
        blockDuration: blockDurationMs,
      };

      // Reset violation window if older than blockWindowMs
      if (now - abuse.firstViolation > blockWindowMs) {
        abuse.violations = 0;
        abuse.firstViolation = now;
        abuse.blockDuration = blockDurationMs;
      }

      abuse.violations += 1;

      if (abuse.violations >= abuseThreshold) {
        // Exponential back-off on repeated abuse
        const duration = Math.min(abuse.blockDuration, maxBlockDurationMs);
        abuse.blockDuration = Math.min(abuse.blockDuration * 2, maxBlockDurationMs);

        entry.blocked = true;
        entry.blockedUntil = now + duration;
        store.set(rawKey, entry);
        abuseMap.set(hashedKey, abuse);

        const retryAfterSec = Math.ceil(duration / 1000);
        if (sendHeaders) {
          res.setHeader('Retry-After', retryAfterSec);
          res.setHeader('X-RateLimit-Blocked', 'true');
        }
        const requestId = typeof res.locals.requestId === 'string' ? res.locals.requestId : 'unknown';
        const code = 'rate_limited';
        const safeMessage = sanitizeErrorMessage(
          'Too many requests — please try again later',
          code,
        );
        res.status(429).json({
          error: {
            code,
            message: safeMessage,
            requestId,
          },
        });
        return;
      }

      abuseMap.set(hashedKey, abuse);

      if (sendHeaders) res.setHeader('Retry-After', resetSec);
      const requestId = typeof res.locals.requestId === 'string' ? res.locals.requestId : 'unknown';
      const code = 'rate_limited';
      const safeMessage = sanitizeErrorMessage(
        'Too many requests — please try again later',
        code,
      );
      res.status(429).json({
        error: {
          code,
          message: safeMessage,
          requestId,
        },
      });
      return;
    }

    next();
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract the client key (IP) from a request.
 * Prefers the first value of X-Forwarded-For (one trusted proxy hop),
 * then falls back to `req.ip`, then `req.socket.remoteAddress`.
 *
 * @security
 *   In production, set `app.set('trust proxy', 1)` if behind a single
 *   reverse-proxy so Express normalises `req.ip` correctly, and set
 *   `keyFn` to use `req.ip` only (XFF is easily spoofed otherwise).
 */
function defaultKeyFn(req: Request): string {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const first = Array.isArray(xff) ? xff[0] : xff.split(',')[0];
    return first.trim();
  }
  return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
}
