/**
 * @module auth/challenge
 * @description SEP-10-style stateless wallet authentication challenge.
 *
 * A challenge proves control of a Stellar ed25519 key by having the wallet
 * sign a server-issued string. The string encodes a short-lived payload and
 * a server-computed HMAC so it cannot be forged, and a nonce so it can be
 * used only once per process (see replay protection note).
 *
 * Challenge format:
 *   `talenttrust-auth:<base64url(payload)>.<hex(hmac)>`
 *
 * where payload = JSON({ address, nonce, iat, exp, aud }) and
 * hmac = HMAC-SHA256(payloadB64, AUTH_SECRET).
 *
 * @security
 *  - HMAC comparison uses `crypto.timingSafeEqual` to prevent timing attacks.
 *  - Nonces are 16 random bytes (128 bits) from `crypto.randomBytes`.
 *  - Challenges expire after 300 seconds (5 minutes).
 *  - Cross-instance replay is bounded by the 5-minute expiry window; within
 *    a single process, nonces are tracked in a bounded LRU cache until expiry.
 */

import { createHmac, timingSafeEqual, randomBytes } from 'crypto';
import { LRUCache } from 'lru-cache';

export const CHALLENGE_TTL_SECONDS = 300; // 5 minutes
export const CHALLENGE_AUD = 'talenttrust-api';
export const CHALLENGE_PREFIX = 'talenttrust-auth:';

/**
 * Payload embedded in the challenge string.
 */
export interface ChallengePayload {
  address: string;
  nonce: string; // hex-encoded 16 random bytes
  iat: number; // epoch seconds
  exp: number; // epoch seconds (iat + CHALLENGE_TTL_SECONDS)
  aud: string; // 'talenttrust-api'
}

/**
 * Bounded LRU cache of used nonces for replay protection within a single
 * process instance. Size is capped at 10 000 entries (well above the number
 * of challenges a single process can issue in 5 minutes under load).
 *
 * TTL = CHALLENGE_TTL_SECONDS * 1000 (ms) so entries are evicted once they
 * can no longer be replayed.
 *
 * Cross-instance replay is acceptable: the 5-minute challenge expiry is the
 * maximum replay window across serverless instances that do not share memory.
 */
export const usedNonces = new LRUCache<string, true>({
  max: 10_000,
  ttl: CHALLENGE_TTL_SECONDS * 1000,
});

/** Reset the nonce cache — used by tests to isolate replay checks. */
export function resetNonces(): void {
  usedNonces.clear();
}

/**
 * Build the signed challenge string for a given address.
 *
 * @param address - Stellar G-address (already validated as ed25519).
 * @param secret   - AUTH_SECRET used for HMAC.
 * @param nowFn    - Injectable clock; defaults to Date.now.
 * @returns        - The full challenge string and its ISO expiry timestamp.
 */
export function buildChallenge(
  address: string,
  secret: string,
  nowFn: () => number = Date.now,
): { challenge: string; expiresAt: string } {
  const iat = Math.floor(nowFn() / 1000);
  const exp = iat + CHALLENGE_TTL_SECONDS;
  const nonce = randomBytes(16).toString('hex');
  const payload: ChallengePayload = { address, nonce, iat, exp, aud: CHALLENGE_AUD };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const hmac = createHmac('sha256', secret).update(payloadB64).digest('hex');
  return {
    challenge: `${CHALLENGE_PREFIX}${payloadB64}.${hmac}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

/**
 * Failure codes returned by verifyChallenge.
 */
export type ChallengeError =
  | 'invalid_challenge' // malformed string, bad HMAC, or wrong address
  | 'challenge_expired' // exp < now
  | 'challenge_replayed'; // nonce already seen in this process

/**
 * Verify a challenge string.
 *
 * Steps:
 *  1. Parse the `talenttrust-auth:<payload>.<hmac>` format.
 *  2. Recompute the HMAC and compare constant-time.
 *  3. Decode and validate the payload structure.
 *  4. Check that payload.address matches the claimed address.
 *  5. Check expiry.
 *  6. Check replay (nonce not previously consumed).
 *
 * @param challenge - The raw challenge string from the client.
 * @param address   - The address the client claims to be.
 * @param secret    - AUTH_SECRET used for HMAC.
 * @param nowFn     - Injectable clock; defaults to Date.now.
 * @returns         - `{ ok: true, payload }` or `{ ok: false, error }`.
 */
export function verifyChallenge(
  challenge: string,
  address: string,
  secret: string,
  nowFn: () => number = Date.now,
): { ok: true; payload: ChallengePayload } | { ok: false; error: ChallengeError } {
  // 1. Parse format
  if (!challenge.startsWith(CHALLENGE_PREFIX)) {
    return { ok: false, error: 'invalid_challenge' };
  }
  const body = challenge.slice(CHALLENGE_PREFIX.length);
  const dotIdx = body.lastIndexOf('.');
  if (dotIdx === -1) {
    return { ok: false, error: 'invalid_challenge' };
  }

  const payloadB64 = body.slice(0, dotIdx);
  const providedHmac = body.slice(dotIdx + 1);

  // 2. Constant-time HMAC verification
  const expectedHmac = createHmac('sha256', secret).update(payloadB64).digest('hex');
  let hmacValid: boolean;
  try {
    hmacValid = timingSafeEqual(
      Buffer.from(expectedHmac, 'utf-8'),
      Buffer.from(providedHmac, 'utf-8'),
    );
  } catch {
    return { ok: false, error: 'invalid_challenge' };
  }
  if (!hmacValid) {
    return { ok: false, error: 'invalid_challenge' };
  }

  // 3. Decode payload
  let payload: ChallengePayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8')) as ChallengePayload;
  } catch {
    return { ok: false, error: 'invalid_challenge' };
  }

  // 4. Validate payload structure
  if (
    typeof payload.address !== 'string' ||
    typeof payload.nonce !== 'string' ||
    typeof payload.iat !== 'number' ||
    typeof payload.exp !== 'number' ||
    payload.aud !== CHALLENGE_AUD
  ) {
    return { ok: false, error: 'invalid_challenge' };
  }

  // 5. Check address match — a challenge for A cannot be used for B
  if (payload.address !== address) {
    return { ok: false, error: 'invalid_challenge' };
  }

  // 6. Check expiry
  const nowSec = Math.floor(nowFn() / 1000);
  if (payload.exp < nowSec) {
    return { ok: false, error: 'challenge_expired' };
  }

  // 7. Replay protection (within this process)
  if (usedNonces.has(payload.nonce)) {
    return { ok: false, error: 'challenge_replayed' };
  }

  return { ok: true, payload };
}

/**
 * Mark a nonce as used. Call this after a challenge is successfully exchanged
 * for a token to prevent replay within this process instance.
 */
export function consumeNonce(nonce: string): void {
  usedNonces.set(nonce, true);
}
