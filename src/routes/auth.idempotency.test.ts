/**
 * Tests for idempotency behaviour on auth write endpoints.
 */
import express from 'express';
import request from 'supertest';
import { getDb, closeDb } from '../db/database';
import authRouter from './auth.routes';
import { notFoundHandler, errorHandler } from '../middleware/errorHandlers';
import { requestIdMiddleware } from '../middleware/requestId';

jest.mock('../middleware/rateLimiter', () => ({
  createRateLimiter: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

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

describe('Idempotency on /auth/register', () => {
  const body = { email: 'ida@example.com', password: 'Password1!', username: 'ida' };

  it('replays same response for repeated Idempotency-Key', async () => {
    const key = 'idem-key-1';
    const r1 = await request(app).post('/auth/register').set('Idempotency-Key', key).send(body);
    expect(r1.status).toBe(201);
    const r2 = await request(app).post('/auth/register').set('Idempotency-Key', key).send(body);
    expect(r2.status).toBe(201);
    expect(r2.body).toEqual(r1.body);

    // Without key, duplicate registration should fail
    const r3 = await request(app).post('/auth/register').send(body);
    expect(r3.status).toBe(409);
  });

  it('returns conflict when same key used with different body', async () => {
    const key = 'idem-key-2';
    const r1 = await request(app).post('/auth/register').set('Idempotency-Key', key).send(body);
    expect(r1.status).toBe(201);
    const r2 = await request(app).post('/auth/register').set('Idempotency-Key', key).send({ ...body, username: 'changed' });
    expect(r2.status).toBe(409);
    expect(r2.body.error.code).toBe('idempotency_key_conflict');
  });
});

describe('Idempotency on /auth/refresh', () => {
  it('replays token rotation and prevents double rotation', async () => {
    // register and login
    await request(app).post('/auth/register').send({ email: 'r1@example.com', password: 'Password1!', username: 'r1' });
    const loginRes = await request(app).post('/auth/login').send({ email: 'r1@example.com', password: 'Password1!' });
    const refreshToken = loginRes.body.refreshToken as string;

    const key = 'refresh-key-1';
    const r1 = await request(app).post('/auth/refresh').set('Idempotency-Key', key).send({ refreshToken });
    expect(r1.status).toBe(200);
    const r2 = await request(app).post('/auth/refresh').set('Idempotency-Key', key).send({ refreshToken });
    expect(r2.status).toBe(200);
    expect(r2.body).toEqual(r1.body);

    // Using the same original refresh token without idempotency should fail (rotation consumed it)
    const r3 = await request(app).post('/auth/refresh').send({ refreshToken });
    expect(r3.status).toBe(401);
  });
});
