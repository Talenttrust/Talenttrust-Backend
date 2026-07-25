/**
 * API smoke / integration tests against the exported `app` from `index`.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'integration-test-secret';

import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../index';

// The contracts list route enforces the deny-by-default authorization matrix,
// so smoke requests authenticate as an admin.
const adminToken = jwt.sign(
  { sub: 'admin-1', email: 'admin@test.com', role: 'admin' },
  process.env.JWT_SECRET as string,
  { expiresIn: '1h' },
);
const adminAuth = { Authorization: `Bearer ${adminToken}` };

describe('API integration (smoke)', () => {
  it('GET /health is public', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', service: 'talenttrust-backend' });
  });

  it('GET /api/v1/contracts returns success', async () => {
    const res = await request(app).get('/api/v1/contracts').set(adminAuth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({ status: 'success', data: expect.any(Array) }),
    );
  });
});
