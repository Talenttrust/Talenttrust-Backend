import { NextFunction, Request, Response } from 'express';
import cors, { CorsOptions } from 'cors';
import { config } from './config';
import { HttpError } from './amount-error';

const DEV_ORIGINS = ['http://localhost:3000', 'http://localhost:5173'];

/** Canonicalise a candidate origin: lowercases the host, strips path/query/fragment and default ports. */
export const normalizeOrigin = (value: string): string | undefined => {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    return new URL(trimmed).origin;
  } catch {
    return undefined;
  }
};

/** Parse a comma-separated allowlist (e.g. `CORS_ORIGINS`). Invalid entries are dropped. */
export const parseOrigins = (raw: string | undefined): string[] => {
  const parsed = (raw ?? '')
    .split(',')
    .map(normalizeOrigin)
    .filter((o): o is string => o !== undefined);
  return [...new Set(parsed)];
};

/** Origins allowed without opt-in configuration. Local dev origins are excluded in production. */
export const defaultOrigins = (): string[] => {
  const env = process.env.NODE_ENV;
  const base = [config.frontendUrl];
  if (env !== 'production') base.push(...DEV_ORIGINS);
  return parseOrigins(base.join(','));
};

/** Full allowlist: defaults plus `CORS_ORIGINS`. */
export const allowlist = (): string[] => [...new Set([...defaultOrigins(), ...parseOrigins(config.corsOrigins)])];

const ownOrigin = (req: Request): string | undefined => normalizeOrigin(`${req.protocol}://${req.get('host') ?? ''}`);

/**
 * Reject cross-origin requests whose Origin is not allowlisted with 403 before they
 * reach any handler. Requests without an Origin (curl, server-to-server, same-origin
 * navigations) and same-origin requests are allowed through.
 */
export const originGuard = (origins: string[]) => {
  const allowed = new Set(origins);
  return (req: Request, res: Response, next: NextFunction) => {
    res.vary('Origin'); // responses differ per Origin; keep shared caches honest
    const raw = (req.get('origin') ?? '').trim();
    if (!raw) return next();
    const origin = normalizeOrigin(raw);
    if (origin !== undefined && (allowed.has(origin) || origin === ownOrigin(req))) return next();
    next(new HttpError(403, 'origin_not_allowed', 'Origin is not allowed by CORS policy'));
  };
};

export const corsOptionsFor = (origins: string[]): CorsOptions => {
  const allowed = new Set(origins);
  return {
    origin: (origin, callback) => callback(null, origin === undefined || allowed.has(normalizeOrigin(origin) ?? '')),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Accept',
      'Authorization',
      'Idempotency-Key',
      'If-Match',
      'If-None-Match',
      'X-Request-Id',
    ],
    exposedHeaders: ['ETag', 'Receipt', 'X-Request-Id', 'Idempotent-Replayed', 'Retry-After', 'Location'],
    maxAge: 600,
    credentials: false,
    optionsSuccessStatus: 204,
    // Let optionsHandler answer preflights so they also carry `Allow`.
    preflightContinue: true,
  };
};
