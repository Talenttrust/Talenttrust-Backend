/**
 * @file auth.routes.contract.test.ts
 * @description Schema/contract tests for the `/auth/*` response bodies — issue auth-21.
 *
 * `auth.routes.test.ts` already covers status codes and individual field
 * values; this file adds a distinct layer: every response body is parsed
 * against the Zod schemas in `auth.responseSchemas.ts` (`.strict()`, so an
 * unexpected extra field fails validation just like a missing one), plus
 * "teeth" tests proving those schemas actually reject drift rather than
 * rubber-stamping anything object-shaped.
 *
 * No runtime behaviour is changed by this file — see the module doc comment
 * in `auth.responseSchemas.ts` for the one known pre-existing inconsistency
 * (missing `requestId` on three of the four auth-route error paths) that is
 * intentionally codified as-is rather than "fixed" here.
 *
 * Coverage:
 * 1. Success shapes — register/login/refresh token pairs (+ decoded JWT
 *    payload contract), logout message.
 * 2. Error shapes — local `authError()` shape (401/409), shared
 *    `validation_error` shape (400), shared `unauthorized` shape (401),
 *    shared `rate_limited` shape (429).
 * 3. Optional fields — register's optional `role` request field always
 *    produces a required, schema-valid `role` claim in the issued token,
 *    whether provided or defaulted.
 * 4. Schema teeth — mutated copies of real response bodies (extra field /
 *    missing field) are rejected, proving the `.strict()` schemas would
 *    actually catch accidental drift.
 */

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import type { ZodTypeAny } from 'zod';
import { getDb, closeDb } from '../db/database';
import authRouter from './auth.routes';
import { notFoundHandler, errorHandler } from '../middleware/errorHandlers';
import { requestIdMiddleware } from '../middleware/requestId';
import {
  authTokensResponseSchema,
  logoutResponseSchema,
  authLocalErrorResponseSchema,
  validationErrorResponseSchema,
  rateLimitedErrorResponseSchema,
  unauthorizedErrorResponseSchema,
  accessTokenPayloadSchema,
  refreshTokenPayloadSchema,
} from './auth.responseSchemas';

// ── Suppress rate limiting for every test except the dedicated 429 block ────
jest.mock('../middleware/rateLimiter', () => ({
  createRateLimiter: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

// ── Assertion helper ─────────────────────────────────────────────────────────

/** Parses `body` against `schema`, failing with the Zod issues on mismatch. */
function expectValid<T extends ZodTypeAny>(schema: T, body: unknown): void {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new Error(`Response did not match contract schema:\n${JSON.stringify(result.error.issues, null, 2)}`);
  }
}

// ── App factory ───────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(requestIdMiddleware);
  app.use(express.json());
  app.use('/auth', authRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

let app: express.Application;

beforeEach(() => {
  getDb(':memory:');
  app = buildApp();
  process.env.JWT_SECRET = 'test-secret-at-least-8-chars';
});

afterEach(() => {
  closeDb();
  jest.clearAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. Success shapes
// ═══════════════════════════════════════════════════════════════════════════

describe('Auth response contract — success shapes', () => {
  it('POST /auth/register 201 matches the token-pair contract, including decoded JWT claims', async () => {
    const res = await request(app)
      .post('/auth/register')
      .send({ email: 'alice@example.com', password: 'Password1!', username: 'alice' });

    expect(res.status).toBe(201);
    expectValid(authTokensResponseSchema, res.body);

    const access = jwt.decode(res.body.accessToken as string);
    expectValid(accessTokenPayloadSchema, access);

    const refresh = jwt.decode(res.body.refreshToken as string);
    expectValid(refreshTokenPayloadSchema, refresh);
  });

  it('POST /auth/login 200 matches the token-pair contract, including decoded JWT claims', async () => {
    await request(app)
      .post('/auth/register')
      .send({ email: 'bob@example.com', password: 'Password1!', username: 'bob' });

    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'bob@example.com', password: 'Password1!' });

    expect(res.status).toBe(200);
    expectValid(authTokensResponseSchema, res.body);

    const access = jwt.decode(res.body.accessToken as string);
    expectValid(accessTokenPayloadSchema, access);
  });

  it('POST /auth/refresh 200 matches the token-pair contract', async () => {
    await request(app)
      .post('/auth/register')
      .send({ email: 'carol@example.com', password: 'Password1!', username: 'carol' });
    const loginRes = await request(app)
      .post('/auth/login')
      .send({ email: 'carol@example.com', password: 'Password1!' });

    const res = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: loginRes.body.refreshToken });

    expect(res.status).toBe(200);
    expectValid(authTokensResponseSchema, res.body);
  });

  it('POST /auth/logout 200 matches the message-only contract', async () => {
    await request(app)
      .post('/auth/register')
      .send({ email: 'dave@example.com', password: 'Password1!', username: 'dave' });
    const loginRes = await request(app)
      .post('/auth/login')
      .send({ email: 'dave@example.com', password: 'Password1!' });

    const res = await request(app)
      .post('/auth/logout')
      .set('Authorization', `Bearer ${loginRes.body.accessToken}`);

    expect(res.status).toBe(200);
    expectValid(logoutResponseSchema, res.body);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Error shapes
// ═══════════════════════════════════════════════════════════════════════════

describe('Auth response contract — error shapes', () => {
  it('POST /auth/register 409 (duplicate email) matches the local-error contract', async () => {
    const body = { email: 'dupe@example.com', password: 'Password1!', username: 'dupe' };
    await request(app).post('/auth/register').send(body);

    const res = await request(app).post('/auth/register').send(body);

    expect(res.status).toBe(409);
    expectValid(authLocalErrorResponseSchema, res.body);
  });

  it('POST /auth/login 401 (invalid credentials) matches the local-error contract', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'nobody@example.com', password: 'WrongPass1!' });

    expect(res.status).toBe(401);
    expectValid(authLocalErrorResponseSchema, res.body);
  });

  it('POST /auth/refresh 401 (invalid token) matches the local-error contract', async () => {
    const res = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: 'not-a-real-token' });

    expect(res.status).toBe(401);
    expectValid(authLocalErrorResponseSchema, res.body);
  });

  // The 500 `internal_error` branches of `/login`, `/register`, and `/refresh`
  // (auth.routes.ts's authError(res, 500, 'internal_error', ...)) share the
  // exact same { error: { code, message } } shape already exercised above —
  // forcing a genuine internal failure would require whitebox DB-mocking
  // disproportionate to what schema coverage actually needs here.

  it('POST /auth/register 400 (missing field) matches the shared validation-error contract', async () => {
    const res = await request(app)
      .post('/auth/register')
      .send({ password: 'Password1!', username: 'bob' });

    expect(res.status).toBe(400);
    expectValid(validationErrorResponseSchema, res.body);
  });

  it('POST /auth/login 400 (unknown field) matches the shared validation-error contract', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'x@example.com', password: 'Password1!', extra: 'nope' });

    expect(res.status).toBe(400);
    expectValid(validationErrorResponseSchema, res.body);
  });

  it('POST /auth/refresh 400 (missing field) matches the shared validation-error contract', async () => {
    const res = await request(app).post('/auth/refresh').send({});

    expect(res.status).toBe(400);
    expectValid(validationErrorResponseSchema, res.body);
  });

  it('POST /auth/logout 401 (no auth header) matches the shared unauthorized contract', async () => {
    const res = await request(app).post('/auth/logout');

    expect(res.status).toBe(401);
    expectValid(unauthorizedErrorResponseSchema, res.body);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Rate-limit shape (429) — real limiter, isolated from the mocked routes above
// ═══════════════════════════════════════════════════════════════════════════

describe('Auth response contract — rate-limit shape', () => {
  it('a real 429 from createRateLimiter matches the shared rate-limited contract', async () => {
    // Bypasses the file-level jest.mock above to get the real implementation,
    // without touching global module/mock state (unlike resetModules).
    const { createRateLimiter: realCreateRateLimiter } =
      jest.requireActual('../middleware/rateLimiter') as typeof import('../middleware/rateLimiter');

    const limiter = realCreateRateLimiter({
      maxRequests: 1,
      windowMs: 60_000,
      abuseThreshold: 10,
      blockWindowMs: 60_000,
      blockDurationMs: 60_000,
      maxBlockDurationMs: 60_000,
    });

    const probeApp = express();
    probeApp.use(requestIdMiddleware);
    probeApp.get('/probe', limiter, (_req, res) => res.status(200).json({ ok: true }));

    await request(probeApp).get('/probe').expect(200);
    const res = await request(probeApp).get('/probe').expect(429);

    expectValid(rateLimitedErrorResponseSchema, res.body);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Optional fields — register's optional `role`
// ═══════════════════════════════════════════════════════════════════════════

describe('Auth response contract — optional `role` field', () => {
  it('defaults to a schema-valid "client" role claim when role is omitted', async () => {
    const res = await request(app)
      .post('/auth/register')
      .send({ email: 'norole@example.com', password: 'Password1!', username: 'norole' });

    expect(res.status).toBe(201);
    const access = jwt.decode(res.body.accessToken as string);
    expectValid(accessTokenPayloadSchema, access);
    expect((access as { role: string }).role).toBe('client');
  });

  it('carries a schema-valid role claim when role is explicitly provided', async () => {
    const res = await request(app)
      .post('/auth/register')
      .send({ email: 'freelancer@example.com', password: 'Password1!', username: 'fr', role: 'freelancer' });

    expect(res.status).toBe(201);
    const access = jwt.decode(res.body.accessToken as string);
    expectValid(accessTokenPayloadSchema, access);
    expect((access as { role: string }).role).toBe('freelancer');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Schema teeth — prove the .strict() schemas actually reject drift
// ═══════════════════════════════════════════════════════════════════════════

describe('Auth response contract — schema teeth (extra/missing fields)', () => {
  it('rejects a token-pair response with an unexpected extra field', async () => {
    const res = await request(app)
      .post('/auth/register')
      .send({ email: 'teeth1@example.com', password: 'Password1!', username: 'teeth1' });

    const mutated = { ...res.body, tokenType: 'Bearer' };
    const result = authTokensResponseSchema.safeParse(mutated);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.code === 'unrecognized_keys')).toBe(true);
    }
  });

  it('rejects a token-pair response missing a required field', async () => {
    const res = await request(app)
      .post('/auth/register')
      .send({ email: 'teeth2@example.com', password: 'Password1!', username: 'teeth2' });

    const { refreshToken: _refreshToken, ...mutated } = res.body;
    const result = authTokensResponseSchema.safeParse(mutated);

    expect(result.success).toBe(false);
  });

  it('rejects a local-error response with an unexpected extra field (e.g. a stray requestId)', async () => {
    const body = { email: 'teeth3@example.com', password: 'Password1!', username: 'teeth3' };
    await request(app).post('/auth/register').send(body);
    const res = await request(app).post('/auth/register').send(body);

    const mutated = { error: { ...res.body.error, requestId: 'unexpected' } };
    const result = authLocalErrorResponseSchema.safeParse(mutated);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.code === 'unrecognized_keys')).toBe(true);
    }
  });

  it('rejects a local-error response missing the required message field', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'nobody2@example.com', password: 'WrongPass1!' });

    const { message: _message, ...errorRest } = res.body.error;
    const result = authLocalErrorResponseSchema.safeParse({ error: errorRest });

    expect(result.success).toBe(false);
  });
});
