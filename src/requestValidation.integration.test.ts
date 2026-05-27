import request from 'supertest';
import app from './index';

/**
 * Current contracts router does not use query/params Zod layers that older tests
 * expected. Keep a minimal integration check.
 */
describe('request validation (contracts route smoke)', () => {
  it('GET /api/v1/contracts responds with JSON', async () => {
    const response = await request(app).get('/api/v1/contracts');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/json/);
  });
});
