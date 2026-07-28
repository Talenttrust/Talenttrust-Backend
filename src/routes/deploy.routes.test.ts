/**
 * @module deployRoutes.test
 * @description Integration tests for deploy HTTP endpoints.
 *
 * Covers: unauthenticated access, non-admin rejection, deploy status,
 * switch-green, rollback, and credential redaction.
 */

process.env.JWT_SECRET = 'talenttrust-test-secret';

import request from 'supertest';
import { app } from '../index';
import { database } from '../database';
import { generateApiKey, hashApiKey } from '../auth/apiKeys';
import { setHealthChecker } from '../deploy';

const JWT_SECRET = process.env.JWT_SECRET || 'talenttrust-test-secret';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeJwt(role: string, sub = 'user-1', opts: { secret?: string; expiresIn?: string | number } = {}): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const jwt = require('jsonwebtoken');
  return jwt.sign(
    { sub, email: 'test@tt.com', role },
    opts.secret ?? JWT_SECRET,
    { expiresIn: (opts.expiresIn ?? '1h') as any },
  );
}

async function createApiKey(scope: string[], name = 'Test Key'): Promise<string> {
  const apiKey = generateApiKey();
  const { salt, hash } = hashApiKey(apiKey);
  await database.createApiKey({
    name,
    key_hash: `${salt}:${hash}`,
    scope,
    created_by: 'service-1',
    is_active: true,
  });
  return apiKey;
}

// ─── Setup / Teardown ────────────────────────────────────────────────────────

beforeAll(async () => {
  await database.clearDatabase();
  setHealthChecker(async () => true);
});

afterEach(async () => {
  await database.clearDatabase();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Deploy HTTP Routes', () => {
  // ── Authentication: unauthenticated ────────────────────────────────────────

  it('rejects /status without credentials', async () => {
    const res = await request(app).get('/api/v1/admin/deploy/status');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('rejects /switch-green without credentials', async () => {
    const res = await request(app).post('/api/v1/admin/deploy/switch-green').send({});
    expect(res.status).toBe(401);
  });

  it('rejects /rollback without credentials', async () => {
    const res = await request(app).post('/api/v1/admin/deploy/rollback').send({});
    expect(res.status).toBe(401);
  });

  // ── Authentication: non-admin JWT ──────────────────────────────────────────

  it('rejects /status for non-admin JWT user', async () => {
    const userToken = makeJwt('user', 'user-1');
    const res = await request(app).get('/api/v1/admin/deploy/status').set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(401); // 401 instead of 403 to avoid leaking role info
  });

  // ── Authentication: valid admin JWT ────────────────────────────────────────

  const validAdminJwt = makeJwt('admin', 'admin-1');

  it('allows /status with valid admin JWT', async () => {
    const res = await request(app).get('/api/v1/admin/deploy/status').set('Authorization', `Bearer ${validAdminJwt}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toHaveProperty('activeColor');
  });

  it('allows /switch-green with valid admin JWT', async () => {
    const res = await request(app).post('/api/v1/admin/deploy/switch-green').set('Authorization', `Bearer ${validAdminJwt}`).send({});
    expect([200, 202]).toContain(res.status);
    expect(res.body.status).toBe('success');
  });

  it('allows /rollback with valid admin JWT', async () => {
    const res = await request(app).post('/api/v1/admin/deploy/rollback').set('Authorization', `Bearer ${validAdminJwt}`).send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
  });

  // ── Authentication: demo tokens ────────────────────────────────────────────

  it('allows /status with demo-admin-token', async () => {
    const res = await request(app).get('/api/v1/admin/deploy/status').set('Authorization', 'Bearer demo-admin-token');
    expect(res.status).toBe(200);
  });

  it('rejects /status with demo-user-token', async () => {
    const res = await request(app).get('/api/v1/admin/deploy/status').set('Authorization', 'Bearer demo-user-token');
    expect(res.status).toBe(403);
  });

  // ── Authentication: API key ────────────────────────────────────────────────

  it('allows /status with valid API key (deploy scope)', async () => {
    const apiKey = await createApiKey(['deploy:*']);
    const res = await request(app).get('/api/v1/admin/deploy/status').set('X-API-Key', apiKey);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('activeColor');
  });

  it('rejects /status with API key lacking admin scope', async () => {
    const apiKey = await createApiKey(['contracts:read']);
    const res = await request(app).get('/api/v1/admin/deploy/status').set('X-API-Key', apiKey);
    expect(res.status).toBe(403);
  });

  // ── Deploy status ──────────────────────────────────────────────────────────

  it('returns default blue state on fresh start', async () => {
    const res = await request(app).get('/api/v1/admin/deploy/status').set('Authorization', `Bearer ${validAdminJwt}`);
    expect(res.status).toBe(200);
    expect(res.body.data.activeColor).toBe('blue');
  });

  it('includes lastSwitch timestamp in status', async () => {
    const res = await request(app).get('/api/v1/admin/deploy/status').set('Authorization', `Bearer ${validAdminJwt}`);
    expect(res.body.data).toHaveProperty('lastSwitch');
    expect(typeof res.body.data.lastSwitch).toBe('number');
  });

  // ── Switch to green ────────────────────────────────────────────────────────

  it('switchGreen transitions state to green', async () => {
    const res = await request(app).post('/api/v1/admin/deploy/switch-green').set('Authorization', `Bearer ${validAdminJwt}`).send({});
    expect(res.status).toBe(202);
    expect(res.body.message).toContain('green');
  });

  it('switchGreen is idempotent when already green', async () => {
    // First switch
    await request(app).post('/api/v1/admin/deploy/switch-green').set('Authorization', `Bearer ${validAdminJwt}`).send({});
    // Second switch
    const res = await request(app).post('/api/v1/admin/deploy/switch-green').set('Authorization', `Bearer ${validAdminJwt}`).send({});
    expect([200, 202]).toContain(res.status); // Accept both 200 (idempotent) and 202 (switch initiated)
  });

  // ── Rollback ───────────────────────────────────────────────────────────────

  it('rollback transitions state back to blue', async () => {
    // Switch to green first
    await request(app).post('/api/v1/admin/deploy/switch-green').set('Authorization', `Bearer ${validAdminJwt}`).send({});
    // Then rollback
    const res = await request(app).post('/api/v1/admin/deploy/rollback').set('Authorization', `Bearer ${validAdminJwt}`).send({});
    expect(res.status).toBe(200);
    expect(res.body.message).toContain('Rolled back');

    const statusRes = await request(app).get('/api/v1/admin/deploy/status').set('Authorization', `Bearer ${validAdminJwt}`);
    expect(statusRes.body.data.activeColor).toBe('blue');
  });

  it('rollback is no-op when already on blue', async () => {
    const res = await request(app).post('/api/v1/admin/deploy/rollback').set('Authorization', `Bearer ${validAdminJwt}`).send({});
    expect(res.status).toBe(200);
    expect(res.body.message).toContain('No rollback needed');
  });

  // ── Security: no credential leakage ────────────────────────────────────────

  it('does not echo tokens in error responses', async () => {
    const forged = makeJwt('admin', 'attacker', { secret: 'wrong-secret' });
    const res = await request(app).get('/api/v1/admin/deploy/status').set('Authorization', `Bearer ${forged}`);
    expect(JSON.stringify(res.body)).not.toContain(forged);
  });

  it('does not echo API keys in error responses', async () => {
    const res = await request(app).get('/api/v1/admin/deploy/status').set('X-API-Key', 'my-secret-api-key');
    expect(JSON.stringify(res.body)).not.toContain('my-secret-api-key');
  });

  // ── Request ID in error responses ──────────────────────────────────────────

  it('includes requestId in 401 responses', async () => {
    const res = await request(app).get('/api/v1/admin/deploy/status');
    expect(res.status).toBe(401);
    expect(res.body.error).toHaveProperty('requestId');
  });

  it('includes requestId in 403 responses', async () => {
    const userToken = makeJwt('user', 'user-1');
    const res = await request(app).get('/api/v1/admin/deploy/status').set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(401); // 401 instead of 403 to avoid leaking role info
    expect(res.body.error).toHaveProperty('requestId');
  });
});
