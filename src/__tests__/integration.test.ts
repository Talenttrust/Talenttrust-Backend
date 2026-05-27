/**
 * API smoke / integration tests against the exported `app` from `index`.
 */
import request from 'supertest';
import { app } from '../index';

describe('API integration (smoke)', () => {
  it('GET /health is public', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', service: 'talenttrust-backend' });
  });

  it('GET /api/v1/contracts returns success', async () => {
    const res = await request(app).get('/api/v1/contracts');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({ status: 'success', data: expect.any(Array) }),
    );
  });
});
