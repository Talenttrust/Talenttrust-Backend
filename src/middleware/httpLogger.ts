/**
 * @module middleware/httpLogger
 * @description Express middleware that emits structured access-log records for
 * every HTTP request/response pair.
 *
 * Each record includes:
 *   - requestId / correlationId  (from res.locals, set by requestIdMiddleware)
 *   - method, url, statusCode
 *   - durationMs  – wall-clock time from request receipt to response finish
 *   - userAgent   – sanitised User-Agent string (truncated to 256 chars)
 *   - ip          – client IP (trusts X-Forwarded-For only when
 *                   `TRUST_PROXY=true` env var is set, to avoid spoofing)
 *
 * Security note: the `url` field is logged as-is from `req.originalUrl`.
 * Ensure that sensitive data is never placed in query strings (e.g. tokens).
 * This middleware does NOT log request/response bodies to prevent accidental
 * credential exposure.
 *
 * Must be registered AFTER `requestIdMiddleware`.
 */

import { Request, Response, NextFunction } from 'express';
import { Logger, logger as rootLogger } from '../logger';

const MAX_UA_LENGTH = 256;

/** Resolve the client IP, optionally honouring X-Forwarded-For. */
function resolveClientIp(req: Request): string {
  if (process.env['TRUST_PROXY'] === 'true') {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') {
      // Take the first (leftmost) address – the original client.
      return forwarded.split(',')[0]?.trim() ?? req.socket.remoteAddress ?? 'unknown';
    }
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/**
 * Express middleware: log HTTP access records with timing and correlation IDs.
 */
export function httpLoggerMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const startAt = process.hrtime.bigint();

  res.on('finish', () => {
    const durationNs = process.hrtime.bigint() - startAt;
    const durationMs = Number(durationNs) / 1_000_000;

    // Prefer the request-scoped logger if requestIdMiddleware ran first.
    const log: Logger =
      (res.locals['log'] as Logger | undefined) ?? rootLogger;

    const ua = req.headers['user-agent'] ?? '';
    const userAgent =
      ua.length > MAX_UA_LENGTH ? ua.slice(0, MAX_UA_LENGTH) + '…' : ua;

    log.info('http request', {
      method: req.method,
      url: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: parseFloat(durationMs.toFixed(3)),
      userAgent,
      ip: resolveClientIp(req),
    });
  });

  next();
}
