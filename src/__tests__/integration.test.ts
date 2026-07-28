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
  describe('health endpoint', () => {
    it('returns a successful health response', async () => {
      const res = await request(app).get('/health');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        status: 'ok',
        service: 'talenttrust-backend',
      });
    });

    it('returns a not-found error for an unknown health path', async () => {
      const res = await request(app).get('/health/unknown');

      expect(res.status).toBe(404);
      expect(res.body).toEqual({
        error: expect.objectContaining({
          code: 'not_found',
          message: expect.any(String),
          requestId: expect.any(String),
        }),
      });
    });

    it('returns a validation error envelope for malformed JSON input', async () => {
      const res = await request(app)
        .get('/health')
        .set('Content-Type', 'application/json')
        .send('{');

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: expect.objectContaining({
          code: 'invalid_json',
          message: expect.any(String),
          requestId: expect.any(String),
        }),
      });
    });

    it('returns the same successful response when health is requested repeatedly', async () => {
      const first = await request(app).get('/health');
      const second = await request(app).get('/health');

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.body).toEqual(first.body);
      expect(second.body).toEqual({
        status: 'ok',
        service: 'talenttrust-backend',
      });
    });
  });

  it('GET /api/v1/contracts returns success', async () => {
    const res = await request(app).get('/api/v1/contracts').set(adminAuth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({ status: 'success', data: expect.any(Array) }),
    );
  });
});
