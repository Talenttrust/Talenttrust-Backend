/**
 * Smoke tests for the exported Express app in index.ts.
 */
import request from 'supertest';
import { app } from './index';

describe('index app wiring', () => {
  it('GET /health returns 200 and service identity', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', service: 'talenttrust-backend' });
  });

  it('GET /api/v1/reputation/:id returns default profile', async () => {
    const res = await request(app).get('/api/v1/reputation/demo-user');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
  });

  it('GET /api/v1/contracts returns success envelope', async () => {
    const res = await request(app).get('/api/v1/contracts');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({ status: 'success', data: expect.anything() }),
    );
  });
});
