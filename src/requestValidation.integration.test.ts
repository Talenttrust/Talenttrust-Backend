process.env.JWT_SECRET = process.env.JWT_SECRET || 'integration-test-secret';

import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from './index';

// The contracts list route enforces the deny-by-default authorization matrix,
// so this smoke request authenticates as an admin.
const adminToken = jwt.sign(
  { sub: 'admin-1', email: 'admin@test.com', role: 'admin' },
  process.env.JWT_SECRET as string,
  { expiresIn: '1h' },
);
const adminAuth = { Authorization: `Bearer ${adminToken}` };

/**
 * Current contracts router does not use query/params Zod layers that older tests
 * expected. Keep a minimal integration check.
 */
describe('request validation (contracts route smoke)', () => {
  it('GET /api/v1/contracts responds with JSON', async () => {
    const response = await request(app).get('/api/v1/contracts').set(adminAuth);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/json/);
  });
});
