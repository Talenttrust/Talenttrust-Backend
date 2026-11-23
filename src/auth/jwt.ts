/**
 * @module auth/jwt
 * @description Tiny HS256 JWT implementation for wallet auth tokens.
 *
 * Uses Node's `crypto` directly so there is no dependency on a JWT library
 * that might accept `alg: none` or other algorithms by default. The verify
 * function hard-codes HS256 and rejects any other header algorithm.
 *
 * @security
 *  - Only HS256 is accepted; `alg: none` is rejected explicitly.
 *  - Signature comparison is constant-time via `crypto.timingSafeEqual`.
 *  - `exp` is enforced so tokens cannot outlive their stated lifetime.
 */

import { createHmac, timingSafeEqual, randomUUID } from 'crypto';

export const WALLET_TOKEN_TTL = 3600; // 1 hour

export interface WalletTokenClaims {
  sub: string; // Stellar address (the authenticated caller)
  iat: number; // issued-at (epoch seconds)
  exp: number; // expiry (epoch seconds, iat + WALLET_TOKEN_TTL)
  jti: string; // unique token id
}

/**
 * Issue an HS256 JWT for the given address.
 *
 * @param address - Stellar G-address to embed as `sub`.
 * @param secret   - AUTH_SECRET (>= 32 bytes in production).
 * @param nowFn    - Injectable clock; defaults to Date.now.
 * @returns        - `{ token, expiresAt }` where token is a compact JWT string.
 */
export function issueWalletToken(
  address: string,
  secret: string,
  nowFn: () => number = Date.now,
): { token: string; expiresAt: string } {
  const iat = Math.floor(nowFn() / 1000);
  const exp = iat + WALLET_TOKEN_TTL;
  const claims: WalletTokenClaims = { sub: address, iat, exp, jti: randomUUID() };

  const header = { alg: 'HS256', typ: 'JWT' };
  const encHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encPayload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signingInput = `${encHeader}.${encPayload}`;
  const sig = createHmac('sha256', secret).update(signingInput).digest('base64url');

  return {
    token: `${signingInput}.${sig}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

/**
 * Verify an HS256 JWT.
 *
 * Rejects:
 *  - tokens that don't have exactly 3 dot-separated parts,
 *  - any header `alg` other than `HS256` (including `none`),
 *  - headers with `typ` present and not equal to 'JWT',
 *  - a signature that doesn't match (constant-time compare),
 *  - expired tokens (exp < now),
 *  - tokens with a missing/empty `sub`,
 *  - tokens with missing, non-numeric, or non-finite `iat`,
 *  - tokens with `iat` more than 60s in the future,
 *  - tokens with missing/empty `jti`,
 *  - tokens with lifetime (exp - iat) exceeding WALLET_TOKEN_TTL.
 *
 * @param token  - The compact JWT string.
 * @param secret - AUTH_SECRET used to sign.
 * @param nowFn  - Injectable clock; defaults to Date.now.
 * @returns      - `{ ok: true, address }` or `{ ok: false }`.
 */
export function verifyWalletToken(
  token: string,
  secret: string,
  nowFn: () => number = Date.now,
): { ok: true; address: string } | { ok: false } {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false };

  const [encHeader, encPayload, providedSig] = parts;

  // Parse and validate the header — only HS256 is accepted.
  let header: { alg?: string; typ?: string };
  try {
    header = JSON.parse(Buffer.from(encHeader, 'base64url').toString('utf-8'));
  } catch {
    return { ok: false };
  }
  if (header.alg !== 'HS256') return { ok: false }; // rejects alg: none
  if ('typ' in header && header.typ !== 'JWT') return { ok: false }; // reject non-JWT typ

  // Constant-time signature verification.
  const signingInput = `${encHeader}.${encPayload}`;
  const expectedSig = createHmac('sha256', secret).update(signingInput).digest('base64url');
  let sigValid: boolean;
  try {
    sigValid = timingSafeEqual(
      Buffer.from(expectedSig, 'utf-8'),
      Buffer.from(providedSig, 'utf-8'),
    );
  } catch {
    return { ok: false };
  }
  if (!sigValid) return { ok: false };

  // Parse and validate the payload.
  let claims: WalletTokenClaims;
  try {
    claims = JSON.parse(Buffer.from(encPayload, 'base64url').toString('utf-8'));
  } catch {
    return { ok: false };
  }
  if (typeof claims.sub !== 'string' || !claims.sub) return { ok: false };
  if (typeof claims.exp !== 'number') return { ok: false };

  // Validate iat: must be numeric, finite, and not more than 60s in the future.
  if (typeof claims.iat !== 'number' || !isFinite(claims.iat)) return { ok: false };
  const nowSec = Math.floor(nowFn() / 1000);
  const skewSec = 60;
  if (claims.iat > nowSec + skewSec) return { ok: false };

  // Validate jti: must be non-empty string.
  if (typeof claims.jti !== 'string' || !claims.jti) return { ok: false };

  // Validate lifetime: exp - iat must not exceed WALLET_TOKEN_TTL.
  if (claims.exp - claims.iat > WALLET_TOKEN_TTL) return { ok: false };

  // Enforce expiry.
  if (claims.exp < nowSec) return { ok: false };

  return { ok: true, address: claims.sub };
}
