/**
 * Integration tests for auth routes.
 *
 * Uses an isolated in-memory SQLite database via the shared getDb singleton.
 * The rate limiter is mocked to keep tests fast and deterministic.
 */

import express from 'express';
import request from 'supertest';
import { getDb, closeDb } from '../db/database';
import authRouter from './auth.routes';
import { notFoundHandler, errorHandler } from '../middleware/errorHandlers';
import { requestIdMiddleware } from '../middleware/requestId';

// ── Suppress rate limiting in tests ──────────────────────────────────────────
jest.mock('../middleware/rateLimiter', () => ({
  createRateLimiter: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

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

// ── Test setup ────────────────────────────────────────────────────────────────

let app: express.Application;

beforeEach(() => {
  // fresh in-memory DB per test
  getDb(':memory:');
  app = buildApp();
  process.env.JWT_SECRET = 'test-secret-at-least-8-chars';
});

afterEach(() => {
  closeDb();
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /auth/register', () => {
  const validBody = {
    email: 'alice@example.com',
    password: 'Password1!',
    username: 'alice',
  };

  it('returns 201 with accessToken and refreshToken on success', async () => {
    const res = await request(app).post('/auth/register').send(validBody);
    expect(res.status).toBe(201);
    expect(typeof res.body.accessToken).toBe('string');
    expect(typeof res.body.refreshToken).toBe('string');
  });

  it('returns 409 on duplicate email (no user-enumeration in message)', async () => {
    await request(app).post('/auth/register').send(validBody);
    const res = await request(app).post('/auth/register').send(validBody);
    expect(res.status).toBe(409);
    // Must NOT reveal "email already exists"
    expect(res.body.error.message).not.toMatch(/email already/i);
  });

  it('returns 400 when email is missing', async () => {
    const res = await request(app)
      .post('/auth/register')
      .send({ password: 'Password1!', username: 'bob' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when password is too short (< 8 chars)', async () => {
    const res = await request(app)
      .post('/auth/register')
      .send({ email: 'b@b.com', password: 'short', username: 'bob' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('returns 400 when email is malformed', async () => {
    const res = await request(app)
      .post('/auth/register')
      .send({ email: 'not-an-email', password: 'Password1!', username: 'bob' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('returns 400 when password exceeds maximum length', async () => {
    const res = await request(app)
      .post('/auth/register')
      .send({ email: 'large@example.com', password: 'p'.repeat(129), username: 'bob' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when unknown fields are included', async () => {
    const res = await request(app)
      .post('/auth/register')
      .send({ ...validBody, extra: 'not-allowed' });
    expect(res.status).toBe(400);
  });

  it('accepts role when provided at upper boundary of allowed username length', async () => {
    const res = await request(app)
      .post('/auth/register')
      .send({ ...validBody, email: 'fr@example.com', username: 'a'.repeat(50), role: 'freelancer' });
    expect(res.status).toBe(201);
  });

  it('accepts a password at maximum allowed length', async () => {
    const res = await request(app)
      .post('/auth/register')
      .send({ email: 'maxpass@example.com', password: 'p'.repeat(128), username: 'bob' });
    expect(res.status).toBe(201);
  });

  it('returns 400 for invalid role values', async () => {
    const res = await request(app)
      .post('/auth/register')
      .send({ ...validBody, role: 'admin' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when body is empty', async () => {
    const res = await request(app).post('/auth/register').send({});
    expect(res.status).toBe(400);
  });

  it('accepts optional role field', async () => {
    const res = await request(app)
      .post('/auth/register')
      .send({ ...validBody, email: 'fr@example.com', username: 'freebob', role: 'freelancer' });
    expect(res.status).toBe(201);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Login
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /auth/login', () => {
  const creds = { email: 'alice@example.com', password: 'Password1!' };

  beforeEach(async () => {
    await request(app)
      .post('/auth/register')
      .send({ ...creds, username: 'alice' });
  });

  it('returns 200 with tokens on correct credentials', async () => {
    const res = await request(app).post('/auth/login').send(creds);
    expect(res.status).toBe(200);
    expect(typeof res.body.accessToken).toBe('string');
    expect(typeof res.body.refreshToken).toBe('string');
  });

  it('returns 400 when password is too short (< 8 chars)', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ email: creds.email, password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('returns 400 when login payload contains unknown fields', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ ...creds, extra: 123 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('returns 401 on wrong password (same message as unknown email)', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ email: creds.email, password: 'WrongPass1!' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('invalid_credentials');
  });

  it('returns 400 when fields are missing', async () => {
    const res = await request(app).post('/auth/login').send({ email: creds.email });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('returns 400 when email is malformed', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'not-email', password: 'Password1!' });
    expect(res.status).toBe(400);
  });

  it('login error message does not distinguish missing user from wrong password', async () => {
    const wrongPass = await request(app)
      .post('/auth/login')
      .send({ email: creds.email, password: 'wrong' });
    const unknownUser = await request(app)
      .post('/auth/login')
      .send({ email: 'nobody@example.com', password: 'anything1' });

    expect(wrongPass.body.error.message).toBe(unknownUser.body.error.message);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Refresh
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /auth/refresh', () => {
  let refreshToken: string;

  beforeEach(async () => {
    await request(app)
      .post('/auth/register')
      .send({ email: 'alice@example.com', password: 'Password1!', username: 'alice' });
    const loginRes = await request(app)
      .post('/auth/login')
      .send({ email: 'alice@example.com', password: 'Password1!' });
    refreshToken = loginRes.body.refreshToken as string;
  });

  it('returns 200 with new token pair on valid refresh token', async () => {
    const res = await request(app).post('/auth/refresh').send({ refreshToken });
    expect(res.status).toBe(200);
    expect(typeof res.body.accessToken).toBe('string');
    expect(typeof res.body.refreshToken).toBe('string');
  });

  it('issues a different refresh token on each rotation', async () => {
    const res = await request(app).post('/auth/refresh').send({ refreshToken });
    expect(res.body.refreshToken).not.toBe(refreshToken);
  });

  it('returns 401 when the same refresh token is reused (rotation)', async () => {
    await request(app).post('/auth/refresh').send({ refreshToken });
    const res = await request(app).post('/auth/refresh').send({ refreshToken });
    expect(res.status).toBe(401);
  });

  it('returns 401 for a completely invalid token', async () => {
    const res = await request(app).post('/auth/refresh').send({ refreshToken: 'garbage' });
    expect(res.status).toBe(401);
  });

  it('returns 401 for a token signed with a different secret', async () => {
    const jwt = await import('jsonwebtoken');
    const spoofed = jwt.sign({ sub: 'fake-id' }, 'other-secret', { expiresIn: '7d' });
    const res = await request(app).post('/auth/refresh').send({ refreshToken: spoofed });
    expect(res.status).toBe(401);
  });

  it('returns 400 when refreshToken field is missing', async () => {
    const res = await request(app).post('/auth/refresh').send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('returns 400 when refreshToken is too long', async () => {
    const res = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: 'a'.repeat(1025) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('returns 400 when refresh payload contains unknown fields', async () => {
    const res = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken, extra: 'not-allowed' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Logout
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /auth/logout', () => {
  let accessToken: string;
  let refreshToken: string;

  beforeEach(async () => {
    await request(app)
      .post('/auth/register')
      .send({ email: 'alice@example.com', password: 'Password1!', username: 'alice' });
    const loginRes = await request(app)
      .post('/auth/login')
      .send({ email: 'alice@example.com', password: 'Password1!' });
    accessToken = loginRes.body.accessToken as string;
    refreshToken = loginRes.body.refreshToken as string;
  });

  it('returns 200 when authenticated', async () => {
    const res = await request(app)
      .post('/auth/logout')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
  });

  it('returns 401 without auth header', async () => {
    const res = await request(app).post('/auth/logout');
    expect(res.status).toBe(401);
  });

  it('refresh token is invalid after logout', async () => {
    await request(app)
      .post('/auth/logout')
      .set('Authorization', `Bearer ${accessToken}`);
    const res = await request(app).post('/auth/refresh').send({ refreshToken });
    expect(res.status).toBe(401);
  });
});
