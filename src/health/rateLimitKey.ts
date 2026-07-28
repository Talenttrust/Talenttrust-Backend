/**
 * @module health/rateLimitKey
 * @description Key extraction function for health-endpoint rate limiting.
 *
 * Prefers the `X-API-Key` header (service-to-service clients such as
 * load-balancers or monitoring agents) so that an entire orchestrator fleet
 * shares one bucket rather than being split across individual IP addresses.
 * Falls back to the first value of `X-Forwarded-For` and finally `req.ip`.
 */

import { Request } from 'express';

/**
 * Derive the per-client rate-limit key for health routes.
 *
 * Resolution order:
 * 1. `X-API-Key` header — stable identity for service clients.
 * 2. First IP in `X-Forwarded-For` — one trusted proxy hop.
 * 3. `req.ip` / socket remote address — direct connections.
 */
export function healthRateLimitKeyFn(req: Request): string {
  const apiKey = req.headers['x-api-key'];
  if (apiKey) {
    return Array.isArray(apiKey) ? apiKey[0] : apiKey;
  }

  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const first = Array.isArray(xff) ? xff[0] : xff.split(',')[0];
    return first.trim();
  }

  return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
}
