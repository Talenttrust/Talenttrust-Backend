/**
 * @module auth/rateLimitKey
 * @description
 * Per-client key derivation for the auth rate limiter (issue #756).
 *
 * Auth endpoints are unauthenticated by definition, so the natural keying
 * is the client IP. Service-to-service callers may additionally send an
 * `X-API-Key` header (e.g. internal tooling calling `/auth/refresh`); keys
 * receive their own bucket so a single misbehaving service key cannot crowd
 * out browser traffic from the same egress IP.
 *
 * Product specs for issue #756:
 *   - "per-client" — the keying function looks at API key first, then IP.
 *   - Make the key function a named export so the unit tests can exercise
 *     every input combination (header present, XFF chain, unknown IP).
 *   - Never persist a raw value — the `RateLimitStore` hashes with SHA-256
 *     internally, so we only need to produce a stable, opaque key string.
 *
 * @security
 * - A request with no API key, no usable IP, and no socket address is
 *   bucketed under a per-process random suffix (`unknown:<rand>`) so an
 *   attacker stripping identifiers cannot DoS every other anonymous
 *   client by exhausting the shared bucket. This means an unidentified
 *   request gets its own throwaway namespace per server instance.
 * - Whitespace-only `X-API-Key` headers are treated as absent (after
 *   trim) so spray attackers cannot bypass IP-based bucketing with an
 *   empty string.
 * - The function never logs the resolved key to any sink outside the
 *   rate-limit store.
 */

import { randomBytes } from 'crypto';

/** Prefix used for API-key-derived buckets. Visible in
 * diagnostic output and lets ops dashboards split key traffic from IP
 * traffic with a single substring match. */
export const AUTH_RATE_LIMIT_KEY_PREFIX = {
  apiKey: 'apikey',
  ip: 'ip',
  unknown: 'unknown',
} as const;

/**
 * Headers consulted for key derivation, in priority order.
 *
 * Exposed for tests so they can verify the priority order without
 * duplicating the header-name strings.
 */
export const AUTH_RATE_LIMIT_HEADERS = {
  apiKey: 'x-api-key',
  forwardedFor: 'x-forwarded-for',
} as const;

/**
 * Minimal request shape consumed by {@link createAuthKeyFn}. Lets tests
 * pass a hand-built object instead of relying on Express's full Request.
 */
export interface AuthKeyRequest {
  headers: Record<string, string | string[] | undefined>;
  ip?: string | null;
  socket?: { remoteAddress?: string | null } | null;
}

/**
 * Factory that produces a key-derivation function. Returning a closure
 * keeps the per-process random suffix stable across calls within the
 * same process while still segregating unidentified traffic.
 */
export function createAuthKeyFn(): (req: AuthKeyRequest) => string {
  // Per-process random suffix for unidentified traffic. 16 hex chars
  // (64 bits) is enough to make collision-driven DoS amplification
  // infeasible while still being cheap to allocate.
  const unknownSuffix = randomBytes(8).toString('hex');

  return function authRateLimitKeyFn(req: AuthKeyRequest): string {
    const apiKey = readNonEmptyHeader(req, AUTH_RATE_LIMIT_HEADERS.apiKey);
    if (apiKey) {
      return `${AUTH_RATE_LIMIT_KEY_PREFIX.apiKey}:${apiKey}`;
    }

    const xff = readNonEmptyHeader(req, AUTH_RATE_LIMIT_HEADERS.forwardedFor);
    if (xff) {
      const firstHop = Array.isArray(xff) ? xff[0] : xff.split(',')[0];
      const trimmed = firstHop?.trim();
      if (trimmed) {
        return `${AUTH_RATE_LIMIT_KEY_PREFIX.ip}:${trimmed}`;
      }
    }

    const ip = req.ip?.trim();
    if (ip) {
      return `${AUTH_RATE_LIMIT_KEY_PREFIX.ip}:${ip}`;
    }

    const remote = req.socket?.remoteAddress?.trim();
    if (remote) {
      return `${AUTH_RATE_LIMIT_KEY_PREFIX.ip}:${remote}`;
    }

    // Per-process random bucket (see security note above).
    return `${AUTH_RATE_LIMIT_KEY_PREFIX.unknown}:${unknownSuffix}`;
  };
}

/**
 * Default instance used by the auth router. Tests that need a custom
 * key function (e.g. to inspect the suffix deterministically) should
 * call {@link createAuthKeyFn} directly.
 */
export const authRateLimitKeyFn = createAuthKeyFn();

/**
 * Reads a header value, trimming surrounding whitespace and rejecting
 * empty strings so a whitespace-only header cannot short-circuit the
 * priority chain.
 */
function readNonEmptyHeader(
  req: AuthKeyRequest,
  name: string,
): string | undefined {
  const raw = req.headers[name.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
