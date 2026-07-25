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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getAuthService(): AuthService {
  return new AuthService(getDb());
}

function authError(res: Response, status: number, code: string, message: string): Response {
  return res.status(status).json({ error: { code, message } });
}

// ─── Routes ──────────────────────────────────────────────────────────────────

router.post(
  '/login',
  authLimiter,
  validateSchema(loginSchema),
  async (req: Request, res: Response) => {
    try {
      const { email, password } = req.body as { email: string; password: string };
      const tokens = await getAuthService().login(email, password);
      return res.status(200).json(tokens);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'invalid_credentials') {
        return authError(res, 401, 'invalid_credentials', 'Invalid email or password.');
      }
      return authError(res, 500, 'internal_error', 'An unexpected error occurred.');
    }
  }
);

router.post(
  '/register',
  authLimiter,
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
  (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).user?.id;
    if (userId) {
      getAuthService().logout(userId);
    }
    return res.status(200).json({ message: 'Logged out successfully' });
  }
);

export default router;
