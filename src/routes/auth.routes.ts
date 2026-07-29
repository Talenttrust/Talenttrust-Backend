/**
 * @module routes/auth
 * @description Authentication routes (login, register, refresh, logout).
 *
 * Each route is fronted by the auth rate limiter (issue #756) which:
 *   - Uses the dedicated `auth` tier in `rateLimitConfig` so its cap is
 *     lower and tunable independently of the generic `strict` tier.
 *   - Keys by `X-API-Key` when provided, otherwise by client IP so
 *     internal services and browser clients each get their own bucket.
 *   - Returns 429 with a `Retry-After` header when the per-client cap
 *     is exceeded, and escalates to a hard block after repeated abuse.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { createRateLimiter } from '../middleware/rateLimiter';
import { rateLimitConfig } from '../config/rateLimit';
import { validateSchema } from '../middleware/validate.middleware';
import { AuthService } from '../services/auth.service';
import { getDb } from '../db/database';
import { requireAuth } from '../middleware/authorization';
import { authRateLimitKeyFn } from '../auth/rateLimitKey';
import { accountLockout } from '../auth/accountLockout';
import idempotencyMiddleware from '../middleware/idempotency.middleware';
import type { AuthenticatedRequest } from '../lib/types';

const router = Router();

// Issue #756 — dedicated auth tier so the auth cap stays independent of
// any other route that uses the generic `strict` tier. The `keyFn`
// ensures distinct API keys get isolated buckets even when sharing an IP.
const authLimiter = createRateLimiter({
  ...rateLimitConfig.auth,
  keyFn: authRateLimitKeyFn,
});

// ─── Zod schemas ─────────────────────────────────────────────────────────────

const loginSchema = z.object({
  body: z.object({
    email: z.string().email().max(254),
    password: z.string().min(8).max(128),
  }).strict(),
});

const registerSchema = z.object({
  body: z.object({
    email: z.string().email().max(254),
    password: z.string().min(8).max(128),
    username: z.string().min(2).max(50),
    role: z.enum(['client', 'freelancer', 'both']).optional(),
  }).strict(),
});

const refreshSchema = z.object({
  body: z.object({
    refreshToken: z.string().min(1).max(1024),
  }).strict(),
});

const bulkAuthItemSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('login'),
    payload: loginSchema.shape.body,
  }),
  z.object({
    operation: z.literal('register'),
    payload: registerSchema.shape.body,
  }),
  z.object({
    operation: z.literal('refresh'),
    payload: refreshSchema.shape.body,
  }),
]);

const bulkAuthSchema = z.object({
  body: z.array(bulkAuthItemSchema).min(1).max(100),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getAuthService(): AuthService {
  return new AuthService(getDb());
}

function authError(res: Response, status: number, code: string, message: string): Response {
  res.locals.errorCause = code;
  return res.status(status).json({ error: { code, message } });
}

/**
 * Pads the response time to a target duration. Used by the lockout
 * integration to mask the difference between a freshly-failed attempt,
 * a currently-locked account, and a successful login (uniform timing
 * across the lockout boundary). Tests that want to "do nothing" pass
 * `targetMs = 0`.
 */
async function padResponseTime(startMs: number, targetMs: number): Promise<void> {
  if (targetMs <= 0) return;
  const elapsed = Date.now() - startMs;
  const remaining = targetMs - elapsed;
  if (remaining > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, remaining));
  }
}

// ─── Routes ──────────────────────────────────────────────────────────────────

router.post(
  '/login',
  authLimiter,
  idempotencyMiddleware,
  validateSchema(loginSchema),
  async (req: Request, res: Response) => {
    const { email, password } = req.body as { email: string; password: string };
    const startMs = Date.now();

    // Capture correlation/IP context once so lockout audit entries can
    // be cross-referenced to the originating request without forcing
    // every audit call site to re-derive it.
    const ipAddress =
      typeof req.ip === 'string' && req.ip.length > 0 ? req.ip : undefined;
    const correlationId =
      (typeof res.locals.requestId === 'string' && (res.locals.requestId as string)) ||
      (typeof req.headers['x-correlation-id'] === 'string'
        ? (req.headers['x-correlation-id'] as string)
        : undefined);
    const lockoutCtx = {
      ...(ipAddress !== undefined ? { ipAddress } : {}),
      ...(correlationId !== undefined ? { correlationId } : {}),
    };

    // SECURITY: snapshot lockout state BEFORE running scrypt so the
    // route can use a single `preDelayMs` value across every exit path.
    // Doing the assess() up-front (instead of after scrypt) closes the
    // timing oracle where a high-failure success would respond
    // noticeably faster than the next high-failure failure attempt.
    // `assess()` is a pure read — flushed pre-scrypt, valid post-scrypt.
    const pre = accountLockout.assess(email);

    try {
      // SECURITY: always run authService.login (constant-time scrypt +
      // dummy-hash path) regardless of whether the account is currently
      // locked. Skipping this would create a different timing oracle
      // that lets an attacker enumerate accounts (locked vs. missing
      // would respond at conspicuously different latencies).
      const tokens = await getAuthService().login(email, password);

      // Re-assess live state after scrypt completes: `pre` was
      // captured ~100ms ago and the lockout deadline may have lapsed
      // during the wait. Without this re-check, a user with the
      // correct password arriving 1ms before lockout-expiry would be
      // unjustly rejected. We still pad to `pre.preDelayMs` so the
      // timing surface (from the attacker's perspective) is uniformly
      // determined by the request's start-of-flight state.
      const live = accountLockout.assess(email);

      if (live.isLocked) {
        // Lockout still active — honor the policy: suppress token
        // issuance and return the same uniform `invalid_credentials`
        // shape. The record is NOT cleared — the next eligible user
        // login will emit AUTH_LOCKOUT_RELEASED via `recordSuccess`.
        await padResponseTime(startMs, pre.preDelayMs);
        return authError(res, 401, 'invalid_credentials', 'Request validation failed');
      }

      // Lockout was cleared between snapshot and now (or never
      // present) — issue tokens. Padding remains `pre.preDelayMs` so
      // wall time matches what the request would have taken had the
      // lockout still been active at the start of the request.
      // (Note: this is a deliberate security/UX tradeoff — a legit
      // user who fat-fingers their password N times and then enters
      // it correctly will wait `computeDelay(N)` ms after the last
      // failed attempt. The alternative (no success padding) re-
      // introduces a high-failure timing oracle — see issue #631.)
      accountLockout.recordSuccess(email, lockoutCtx);
      await padResponseTime(startMs, pre.preDelayMs);
      return res.status(200).json(tokens);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'invalid_credentials') {
        return authError(res, 500, 'internal_error', 'An unexpected error occurred.');
      }
      // Apply per-account throttling. recordFailure is a synchronous,
      // map-only mutation: it may emit AUTH_LOCKOUT_TRIGGERED if this
      // attempt crossed the threshold (strict equality), or be a no-op
      // if the account is already locked (the lockout deadline is
      // deliberately not extended by additional failed attempts during
      // its window — issue #631).
      const failure = accountLockout.recordFailure(email, lockoutCtx);
      // Pad the failure response to the post-throttling waitMs so a
      // failure of N grows progressively slower across the streak.
      // When the account is currently locked `failure.waitMs ===
      // maxDelayMs` and matches the live-locked post-scrypt padding
      // for the same identity.
      await padResponseTime(startMs, failure.waitMs);
      return authError(res, 401, 'invalid_credentials', 'Request validation failed');
    }
  }
);

router.post(
  '/register',
  authLimiter,
  idempotencyMiddleware,
  validateSchema(registerSchema),
  async (req: Request, res: Response) => {
    try {
      const { email, password, username, role } = req.body as {
        email: string;
        password: string;
        username: string;
        role?: string;
      };
      const tokens = await getAuthService().register(email, password, username, role);
      return res.status(201).json(tokens);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'duplicate_email') {
        // Generic message — no user-enumeration
        return authError(res, 409, 'conflict', 'Registration failed. Please try again.');
      }
      return authError(res, 500, 'internal_error', 'An unexpected error occurred.');
    }
  }
);

router.post(
  '/refresh',
  authLimiter,
  idempotencyMiddleware,
  validateSchema(refreshSchema),
  async (req: Request, res: Response) => {
    try {
      const { refreshToken } = req.body as { refreshToken: string };
      const tokens = await getAuthService().refresh(refreshToken);
      return res.status(200).json(tokens);
    } catch {
      return authError(res, 401, 'invalid_refresh_token', 'Invalid or expired refresh token.');
    }
  }
);

router.post(
  '/logout',
  authLimiter,
  requireAuth,
  idempotencyMiddleware,
  (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).user?.id;
    if (userId) {
      getAuthService().logout(userId);
    }
    return res.status(200).json({ message: 'Logged out successfully' });
  }
);

router.post(
  '/bulk',
  authLimiter,
  idempotencyMiddleware,
  validateSchema(bulkAuthSchema),
  async (req: Request, res: Response) => {
    const batch = req.body as Array<{
      operation: 'login' | 'register' | 'refresh';
      payload: any;
    }>;
    const results = [];
    const authService = getAuthService();

    const ipAddress =
      typeof req.ip === 'string' && req.ip.length > 0 ? req.ip : undefined;
    const correlationId =
      (typeof res.locals.requestId === 'string' && (res.locals.requestId as string)) ||
      (typeof req.headers['x-correlation-id'] === 'string'
        ? (req.headers['x-correlation-id'] as string)
        : undefined);
    const lockoutCtx = {
      ...(ipAddress !== undefined ? { ipAddress } : {}),
      ...(correlationId !== undefined ? { correlationId } : {}),
    };

    for (const item of batch) {
      if (item.operation === 'login') {
        const { email, password } = item.payload;
        const startMs = Date.now();
        const pre = accountLockout.assess(email);
        try {
          const tokens = await authService.login(email, password);
          const live = accountLockout.assess(email);
          if (live.isLocked) {
            await padResponseTime(startMs, pre.preDelayMs);
            results.push({ status: 'error', error: { code: 'invalid_credentials', message: 'Request validation failed' } });
            continue;
          }
          accountLockout.recordSuccess(email, lockoutCtx);
          await padResponseTime(startMs, pre.preDelayMs);
          results.push({ status: 'success', data: tokens });
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== 'invalid_credentials') {
            results.push({ status: 'error', error: { code: 'internal_error', message: 'An unexpected error occurred.' } });
            continue;
          }
          const failure = accountLockout.recordFailure(email, lockoutCtx);
          await padResponseTime(startMs, failure.waitMs);
          results.push({ status: 'error', error: { code: 'invalid_credentials', message: 'Request validation failed' } });
        }
      } else if (item.operation === 'register') {
        const { email, password, username, role } = item.payload;
        try {
          const tokens = await authService.register(email, password, username, role);
          results.push({ status: 'success', data: tokens });
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'duplicate_email') {
            results.push({ status: 'error', error: { code: 'conflict', message: 'Registration failed. Please try again.' } });
          } else {
            results.push({ status: 'error', error: { code: 'internal_error', message: 'An unexpected error occurred.' } });
          }
        }
      } else if (item.operation === 'refresh') {
        const { refreshToken } = item.payload;
        try {
          const tokens = await authService.refresh(refreshToken);
          results.push({ status: 'success', data: tokens });
        } catch {
          results.push({ status: 'error', error: { code: 'invalid_refresh_token', message: 'Invalid or expired refresh token.' } });
        }
      }
    }

    return res.status(200).json({ items: results });
  }
);

export default router;
