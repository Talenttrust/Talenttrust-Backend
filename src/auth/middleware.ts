/**
 * @module auth/middleware
 * @description Express middleware for wallet-auth JWTs on mutating routes.
 * On success, `req.auth` is populated with the caller's Stellar address; on
 * failure a 401 `unauthorized` error with a `WWW-Authenticate: Bearer`
 * challenge is returned (through the app error handler, so the body carries
 * `requestId`).
 */

import type { Request, Response, NextFunction } from 'express';
import { HttpError } from '../amount-error';
import { verifyWalletToken } from './jwt';

/** Augmented Express request with the authenticated wallet address. */
export interface WalletAuth {
  address: string;
}
export interface WalletAuthRequest extends Request {
  auth?: WalletAuth;
}

/**
 * Create a `requireAuth` middleware bound to the given AUTH_SECRET.
 *
 * @param secret   - The shared secret used to sign/verify wallet JWTs.
 * @param nowFn    - Injectable clock (for testing); defaults to Date.now.
 * @param required - When false, requests without an Authorization header pass
 *                   through unauthenticated (legacy mode); a header that is
 *                   present is still verified and rejected when invalid.
 */
export function createRequireAuth(secret: string, nowFn: () => number = Date.now, required = true) {
  return function requireAuth(req: WalletAuthRequest, res: Response, next: NextFunction): void {
    const header = req.headers.authorization;
    if (!header && !required) return next();
    const fail = (message: string) => {
      res.setHeader('WWW-Authenticate', 'Bearer');
      next(new HttpError(401, 'unauthorized', message));
    };
    if (!header || !header.startsWith('Bearer ')) return fail('Missing or malformed Authorization header.');

    const result = verifyWalletToken(header.slice(7).trim(), secret, nowFn);
    if (!result.ok) return fail('Invalid or expired token.');

    req.auth = { address: result.address };
    next();
  };
}
