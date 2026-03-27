import request from 'supertest';
import app from './index';

describe('GET /health', () => {
  it('returns status ok', async () => {
    const res = await request(app).get('/health');
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

describe('GET /api/v1/contracts', () => {
  it('returns contracts array', async () => {
    const res = await request(app).get('/api/v1/contracts');
    expect(res.statusCode).toBe(200);
    expect(res.body.contracts).toEqual([]);
  });
});
