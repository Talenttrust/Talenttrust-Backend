/**
 * @module routes/auth.responseSchemas
 * @description Zod schemas documenting the response contract of `src/routes/auth.routes.ts`.
 *
 * These schemas did not exist before — `auth.routes.ts` has request-body
 * validation but no declared response contract, and `/auth/*` is absent from
 * `docs/openapi.yaml` entirely. Each schema below codifies the response shape
 * `auth.routes.ts` actually produces today (verified against the literal
 * `res.json(...)` calls in that file), so contract tests can assert against
 * it and catch accidental drift (extra/missing/retyped fields).
 *
 * All object schemas are `.strict()` so an unexpected extra field fails
 * validation, not just a missing one.
 *
 * Known inconsistency (not fixed here — no behaviour change): `authError()`
 * in `auth.routes.ts` (login 401/500, register 409/500, refresh 401) emits
 * `{ error: { code, message } }` without `requestId`/`details`, unlike the
 * rest of the app's `ErrorPayload` shape (`src/errors/appError.ts`) which
 * `validateSchema`, the rate limiter, and `requireAuth` all include. This is
 * intentionally captured as two distinct schemas below rather than papered
 * over, so a future fix that unifies them is a visible, deliberate schema
 * change instead of a silent one.
 */

import { z } from 'zod';

/** `POST /login` (200), `POST /register` (201), `POST /refresh` (200). */
export const authTokensResponseSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
}).strict();

/** `POST /logout` (200). */
export const logoutResponseSchema = z.object({
  message: z.string().min(1),
}).strict();

/**
 * Error shape emitted by `auth.routes.ts`'s local `authError()` helper:
 * login 401 (`invalid_credentials`) / 500 (`internal_error`),
 * register 409 (`conflict`) / 500 (`internal_error`),
 * refresh 401 (`invalid_refresh_token`).
 *
 * Deliberately has no `requestId`/`details` — see module doc comment.
 */
export const authLocalErrorResponseSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
  }).strict(),
}).strict();

/** 400 responses from `validateSchema` (`src/middleware/validate.middleware.ts`). */
export const validationErrorResponseSchema = z.object({
  error: z.object({
    code: z.literal('validation_error'),
    message: z.string().min(1),
    requestId: z.string().min(1),
    details: z.array(z.object({
      path: z.array(z.string()),
      message: z.string(),
      code: z.string(),
    }).strict()),
  }).strict(),
}).strict();

/** 429 responses from `createRateLimiter` (`src/middleware/rateLimiter.ts`). */
export const rateLimitedErrorResponseSchema = z.object({
  error: z.object({
    code: z.literal('rate_limited'),
    message: z.string().min(1),
    requestId: z.string().min(1),
  }).strict(),
}).strict();

/** `POST /logout`'s 401 via `requireAuth` (`src/lib/authHelpers.ts` `sendUnauthorized`). */
export const unauthorizedErrorResponseSchema = z.object({
  error: z.object({
    code: z.literal('unauthorized'),
    message: z.string().min(1),
    requestId: z.string().min(1),
  }).strict(),
}).strict();

/**
 * Decoded access-token payload (`TokenPayload` in `src/services/auth.service.ts`
 * plus the `iat`/`exp` claims `jsonwebtoken` adds automatically).
 */
export const accessTokenPayloadSchema = z.object({
  sub: z.string().min(1),
  email: z.string().email(),
  role: z.string().min(1),
  iat: z.number(),
  exp: z.number(),
}).strict();

/**
 * Decoded refresh-token payload — deliberately a *different* shape from the
 * access token (no `email`/`role`; carries the opaque rotation token `tok`
 * instead). See `issueTokens()` in `src/services/auth.service.ts`.
 */
export const refreshTokenPayloadSchema = z.object({
  sub: z.string().min(1),
  tok: z.string().min(1),
  iat: z.number(),
  exp: z.number(),
}).strict();
