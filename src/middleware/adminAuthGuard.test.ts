/**
 * @module adminAuthGuard.test
 * @description Tests for admin authentication guard middleware.
 *
 * Covers: missing credentials, invalid JWT, expired JWT, role checks,
 * API key auth, scope checks, demo tokens, and credential redaction.
 */

process.env.JWT_SECRET = 'talenttrust-test-secret';

import express, { type Request, type Response } from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { adminAuthGuard } from '../middleware/adminAuthGuard';
import { database } from '../database';
import { generateApiKey, hashApiKey } from '../auth/apiKeys';

const JWT_SECRET = process.env.JWT_SECRET || 'talenttrust-test-secret';

// ─── Token helpers ────────────────────────────────────────────────────────────

function makeJwt(role: string, sub = 'user-1', opts: { secret?: string; expiresIn?: string | number } = {}): string {
  return jwt.sign(
    { sub, email: 'test@tt.com', role },
    opts.secret ?? JWT_SECRET,
    { expiresIn: (opts.expiresIn ?? '1h') as any },
  );
}

function makeApp(middlewares: any[], handler = (_req: Request, res: Response) => res.json({ ok: true })) {
  const app = express();
  app.use(express.json());
  app.get('/test', ...middlewares, handler);
  return app;
}

// ─── Database setup ───────────────────────────────────────────────────────────

beforeAll(async () => {
  await database.clearDatabase();
});

afterEach(async () => {
  await database.clearDatabase();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('adminAuthGuard', () => {
  // ── Missing / invalid credentials ──────────────────────────────────────────

  it('returns 401 when no credentials are provided', async () => {
    const app = makeApp([adminAuthGuard]);
    const res = await request(app).get('/test');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('returns 401 for malformed Authorization header (no Bearer prefix)', async () => {
    const app = makeApp([adminAuthGuard]);
    const res = await request(app).get('/test').set('Authorization', 'NotBearer token');
    expect(res.status).toBe(401);
  });

  // ── JWT: invalid tokens ────────────────────────────────────────────────────

  it('returns 401 for JWT signed with wrong secret', async () => {
    const forged = makeJwt('admin', 'attacker', { secret: 'wrong-secret' });
    const app = makeApp([adminAuthGuard]);
    const res = await request(app).get('/test').set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
  });

  it('returns 401 for expired JWT', async () => {
    const expired = makeJwt('admin', 'user-1', { expiresIn: -1 });
    const app = makeApp([adminAuthGuard]);
    const res = await request(app).get('/test').set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(401);
  });

  it('returns 401 for JWT with non-admin role (avoids leaking role info)', async () => {
    const userToken = makeJwt('user', 'user-1');
    const app = makeApp([adminAuthGuard]);
    const res = await request(app).get('/test').set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(401);
  });

  // ── JWT: demo tokens ───────────────────────────────────────────────────────

  it('allows demo-admin-token', async () => {
    const app = makeApp([adminAuthGuard]);
    const res = await request(app).get('/test').set('Authorization', 'Bearer demo-admin-token');
    expect(res.status).toBe(200);
  });

  it('rejects demo-user-token with 403', async () => {
    const app = makeApp([adminAuthGuard]);
    const res = await request(app).get('/test').set('Authorization', 'Bearer demo-user-token');
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe('Admin role required.');
  });

  // ── JWT: valid admin ───────────────────────────────────────────────────────

  it('allows valid admin JWT and attaches req.user', async () => {
    const adminToken = makeJwt('admin', 'admin-1');
    const app = makeApp(
      [adminAuthGuard],
      (req: Request & { user?: { id: string } }, res: Response) => res.json({ userId: req.user?.id }),
    );
    const res = await request(app).get('/test').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe('admin-1');
  });

  // ── API key: missing ───────────────────────────────────────────────────────

  it('returns 401 when X-API-Key header is empty', async () => {
    const app = makeApp([adminAuthGuard]);
    const res = await request(app).get('/test').set('X-API-Key', '');
    expect(res.status).toBe(401);
  });

  // ── API key: invalid ───────────────────────────────────────────────────────

  it('returns 401 for invalid API key', async () => {
    const app = makeApp([adminAuthGuard]);
    const res = await request(app).get('/test').set('X-API-Key', 'nonexistent-key');
    expect(res.status).toBe(401);
  });

  // ── API key: valid but insufficient scope ──────────────────────────────────

  it('returns 403 for valid API key without admin scope', async () => {
    const apiKey = generateApiKey();
    const { salt, hash } = hashApiKey(apiKey);
    await database.createApiKey({
      name: 'Limited Key',
      key_hash: `${salt}:${hash}`,
      scope: ['contracts:read'],
      created_by: 'user-123',
      is_active: true,
    });

    const app = makeApp([adminAuthGuard]);
    const res = await request(app).get('/test').set('X-API-Key', apiKey);
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe('API key does not have admin scope.');
  });

  // ── API key: valid with admin scope ────────────────────────────────────────

  it('allows valid API key with deploy:* scope', async () => {
    const apiKey = generateApiKey();
    const { salt, hash } = hashApiKey(apiKey);
    await database.createApiKey({
      name: 'Deploy Key',
      key_hash: `${salt}:${hash}`,
      scope: ['deploy:*'],
      created_by: 'service-1',
      is_active: true,
    });

    const app = makeApp([adminAuthGuard]);
    const res = await request(app).get('/test').set('X-API-Key', apiKey);
    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
  });

  it('allows valid API key with * (full wildcard) scope', async () => {
    const apiKey = generateApiKey();
    const { salt, hash } = hashApiKey(apiKey);
    await database.createApiKey({
      name: 'Full Access Key',
      key_hash: `${salt}:${hash}`,
      scope: ['*'],
      created_by: 'service-2',
      is_active: true,
    });

    const app = makeApp([adminAuthGuard]);
    const res = await request(app).get('/test').set('X-API-Key', apiKey);
    expect(res.status).toBe(200);
  });

  it('allows valid API key with jobs:admin scope', async () => {
    const apiKey = generateApiKey();
    const { salt, hash } = hashApiKey(apiKey);
    await database.createApiKey({
      name: 'Jobs Admin Key',
      key_hash: `${salt}:${hash}`,
      scope: ['jobs:admin'],
      created_by: 'service-3',
      is_active: true,
    });

    const app = makeApp([adminAuthGuard]);
    const res = await request(app).get('/test').set('X-API-Key', apiKey);
    expect(res.status).toBe(200);
  });

  // ── API key: expired ───────────────────────────────────────────────────────

  it('returns 401 for expired API key', async () => {
    const apiKey = generateApiKey();
    const { salt, hash } = hashApiKey(apiKey);
    await database.createApiKey({
      name: 'Expired Key',
      key_hash: `${salt}:${hash}`,
      scope: ['deploy:*'],
      created_by: 'service-4',
      expires_at: new Date('2020-01-01T00:00:00Z'),
      is_active: true,
    });

    const app = makeApp([adminAuthGuard]);
    const res = await request(app).get('/test').set('X-API-Key', apiKey);
    expect(res.status).toBe(401);
  });

  // ── Security: no token leakage ─────────────────────────────────────────────

  it('does not echo raw credentials in error responses', async () => {
    const forged = makeJwt('admin', 'u1', { secret: 'wrong-secret' });
    const { salt, hash } = hashApiKey('some-api-key');
    await database.createApiKey({
      name: 'Some Key',
      key_hash: `${salt}:${hash}`,
      scope: ['contracts:read'],
      created_by: 'u2',
      is_active: true,
    });

    const app = makeApp([adminAuthGuard]);

    const jwtRes = await request(app).get('/test').set('Authorization', `Bearer ${forged}`);
    expect(JSON.stringify(jwtRes.body)).not.toContain(forged);

    const keyRes = await request(app).get('/test').set('X-API-Key', 'some-api-key');
    expect(JSON.stringify(keyRes.body)).not.toContain('some-api-key');
  });

  // ── Request ID in error responses ──────────────────────────────────────────

  it('includes requestId in 401 responses', async () => {
    const app = makeApp([adminAuthGuard]);
    const res = await request(app).get('/test');
    expect(res.status).toBe(401);
    expect(res.body.error).toHaveProperty('requestId');
  });
});
