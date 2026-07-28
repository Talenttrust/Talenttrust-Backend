/**
 * @module auth
 * @description Legacy authentication middleware.
 *
 * This module previously contained insecure backdoor token handling.
 * It now simply re‑exports the verified JWT middleware `requireAuth`
 * from `authorization.ts` for backward compatibility.
 */

import type { Request, Response, NextFunction } from 'express';
import { requireAuth } from './authorization';
import { requirePermission } from './authorization';

/**
 * Request type extended with optional `user` payload populated by
 * the authentication middleware. The shape mirrors the `User`
 * type used throughout the codebase.
 */
export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: 'user' | 'admin';
  };
}

/**
 * Backwards‑compatible authentication middleware. Delegates to the
 * verified JWT implementation `requireAuth`. Existing imports of
 * `authMiddleware` continue to work without code changes.
 */
export const authMiddleware = requireAuth as (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => void;

/**
 * Permission guard for contract updates. Kept unchanged.
 */
export const requireContractAccess = requirePermission('contracts', 'update');
