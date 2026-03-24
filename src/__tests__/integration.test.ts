/**
 * Integration tests for the TalentTrust API.
 *
 * Exercises every protected endpoint through the full middleware stack
 * (authenticate → requirePermission → handler) using supertest.
 *
 * Test categories:
 *   1. Public endpoints (no auth required).
 *   2. Positive cases – authenticated role with sufficient permission.
 *   3. Negative cases – missing auth, wrong role, insufficient permission.
 *   4. Edge cases – malformed headers, tampered tokens.
 */

import request from 'supertest';
import { app } from '../index';
import { createToken } from '../auth';

// ---- helpers ----

const adminToken = createToken('admin-1', 'admin');
const freelancerToken = createToken('freelancer-1', 'freelancer');
const clientToken = createToken('client-1', 'client');
const guestToken = createToken('guest-1', 'guest');

function bearer(token: string) {
  return `Bearer ${token}`;
}

// ---- Public endpoints ----

describe('GET /health (public)', () => {
  it('should return 200 without auth', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', service: 'talenttrust-backend' });
  });
});

// ---- GET /api/v1/contracts ----

describe('GET /api/v1/contracts', () => {
  // Positive cases
  it('admin can read contracts', async () => {
    const res = await request(app)
      .get('/api/v1/contracts')
      .set('Authorization', bearer(adminToken));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('contracts');
  });

  it('freelancer can read contracts', async () => {
    const res = await request(app)
      .get('/api/v1/contracts')
      .set('Authorization', bearer(freelancerToken));
    expect(res.status).toBe(200);
  });

  it('client can read contracts', async () => {
    const res = await request(app)
      .get('/api/v1/contracts')
      .set('Authorization', bearer(clientToken));
    expect(res.status).toBe(200);
  });

  // Negative cases
  it('guest is denied access (403)', async () => {
    const res = await request(app)
      .get('/api/v1/contracts')
      .set('Authorization', bearer(guestToken));
    expect(res.status).toBe(403);
  });

  it('unauthenticated request returns 401', async () => {
    const res = await request(app).get('/api/v1/contracts');
    expect(res.status).toBe(401);
  });
});

// ---- POST /api/v1/contracts ----

describe('POST /api/v1/contracts', () => {
  it('admin can create contracts', async () => {
    const res = await request(app)
      .post('/api/v1/contracts')
      .set('Authorization', bearer(adminToken))
      .send({ title: 'New Contract' });
    expect(res.status).toBe(201);
  });

  it('freelancer can create contracts', async () => {
    const res = await request(app)
      .post('/api/v1/contracts')
      .set('Authorization', bearer(freelancerToken))
      .send({ title: 'New Contract' });
    expect(res.status).toBe(201);
  });

  it('client can create contracts', async () => {
    const res = await request(app)
      .post('/api/v1/contracts')
      .set('Authorization', bearer(clientToken))
      .send({ title: 'New Contract' });
    expect(res.status).toBe(201);
  });

  it('guest cannot create contracts (403)', async () => {
    const res = await request(app)
      .post('/api/v1/contracts')
      .set('Authorization', bearer(guestToken))
      .send({ title: 'New Contract' });
    expect(res.status).toBe(403);
  });
});

// ---- GET /api/v1/users ----

describe('GET /api/v1/users', () => {
  it('admin can read users', async () => {
    const res = await request(app)
      .get('/api/v1/users')
      .set('Authorization', bearer(adminToken));
    expect(res.status).toBe(200);
  });

  it('freelancer can read users', async () => {
    const res = await request(app)
      .get('/api/v1/users')
      .set('Authorization', bearer(freelancerToken));
    expect(res.status).toBe(200);
  });

  it('guest cannot read users (403)', async () => {
    const res = await request(app)
      .get('/api/v1/users')
      .set('Authorization', bearer(guestToken));
    expect(res.status).toBe(403);
  });
});

// ---- DELETE /api/v1/users/:id ----

describe('DELETE /api/v1/users/:id', () => {
  it('admin can delete users', async () => {
    const res = await request(app)
      .delete('/api/v1/users/42')
      .set('Authorization', bearer(adminToken));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: '42' });
  });

  it('freelancer cannot delete users (403)', async () => {
    const res = await request(app)
      .delete('/api/v1/users/42')
      .set('Authorization', bearer(freelancerToken));
    expect(res.status).toBe(403);
  });

  it('client cannot delete users (403)', async () => {
    const res = await request(app)
      .delete('/api/v1/users/42')
      .set('Authorization', bearer(clientToken));
    expect(res.status).toBe(403);
  });

  it('guest cannot delete users (403)', async () => {
    const res = await request(app)
      .delete('/api/v1/users/42')
      .set('Authorization', bearer(guestToken));
    expect(res.status).toBe(403);
  });
});

// ---- GET /api/v1/disputes ----

describe('GET /api/v1/disputes', () => {
  it('admin can read disputes', async () => {
    const res = await request(app)
      .get('/api/v1/disputes')
      .set('Authorization', bearer(adminToken));
    expect(res.status).toBe(200);
  });

  it('freelancer can read disputes', async () => {
    const res = await request(app)
      .get('/api/v1/disputes')
      .set('Authorization', bearer(freelancerToken));
    expect(res.status).toBe(200);
  });

  it('guest cannot read disputes (403)', async () => {
    const res = await request(app)
      .get('/api/v1/disputes')
      .set('Authorization', bearer(guestToken));
    expect(res.status).toBe(403);
  });
});

// ---- DELETE /api/v1/disputes/:id ----

describe('DELETE /api/v1/disputes/:id', () => {
  it('admin can delete disputes', async () => {
    const res = await request(app)
      .delete('/api/v1/disputes/99')
      .set('Authorization', bearer(adminToken));
    expect(res.status).toBe(200);
  });

  it('freelancer cannot delete disputes (403)', async () => {
    const res = await request(app)
      .delete('/api/v1/disputes/99')
      .set('Authorization', bearer(freelancerToken));
    expect(res.status).toBe(403);
  });

  it('client cannot delete disputes (403)', async () => {
    const res = await request(app)
      .delete('/api/v1/disputes/99')
      .set('Authorization', bearer(clientToken));
    expect(res.status).toBe(403);
  });
});

// ---- Edge-case / security scenarios ----

describe('Security edge cases', () => {
  it('should return 401 for Bearer with no token value', async () => {
    const res = await request(app)
      .get('/api/v1/contracts')
      .set('Authorization', 'Bearer ');
    expect(res.status).toBe(401);
  });

  it('should return 401 for malformed JSON in token', async () => {
    const bad = Buffer.from('not json').toString('base64');
    const res = await request(app)
      .get('/api/v1/contracts')
      .set('Authorization', `Bearer ${bad}`);
    expect(res.status).toBe(401);
  });

  it('should return 401 for token with unknown role', async () => {
    const bad = Buffer.from(JSON.stringify({ userId: 'u1', role: 'superadmin' })).toString('base64');
    const res = await request(app)
      .get('/api/v1/contracts')
      .set('Authorization', `Bearer ${bad}`);
    expect(res.status).toBe(401);
  });

  it('should return 401 for completely missing Authorization header', async () => {
    const res = await request(app).get('/api/v1/users');
    expect(res.status).toBe(401);
  });

  it('should return 401 for non-Bearer scheme', async () => {
    const res = await request(app)
      .get('/api/v1/users')
      .set('Authorization', 'Basic dXNlcjpwYXNz');
    expect(res.status).toBe(401);
  });
});
