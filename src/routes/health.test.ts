/**
 * @file routes/health.test.ts
 * @description Unit tests for the health router in isolation.
 *
 * Mounts only the health router on a minimal Express app so failures here
 * are unambiguously scoped to the health route logic.
 */

import express from 'express';
import request from 'supertest';
import { healthRouter } from './health';

describe('healthRouter', () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/', healthRouter);
  });

  describe('GET /', () => {
    it('returns 200 and { status: "ok", service: "talenttrust-backend" }', async () => {
      const res = await request(app).get('/');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok', service: 'talenttrust-backend' });
      expect(res.headers['content-type']).toMatch(/application\/json/);
    });
  });

  describe('POST /', () => {
    it('first write: returns 200 and healthy payload', async () => {
      const res = await request(app)
        .post('/')
        .set('idempotency-key', 'test-key-1')
        .send({ service: 'test-svc-1', status: 'ok', uptimeSeconds: 100 });
      
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('healthy');
      expect(res.body.timestamp).toBeDefined();
      expect(res.body.version).toBeDefined();
    });

    it('exact replay: returns original response', async () => {
      // First request
      const firstRes = await request(app)
        .post('/')
        .set('idempotency-key', 'test-key-2')
        .send({ service: 'test-svc-2', status: 'ok', uptimeSeconds: 200 });
      
      expect(firstRes.status).toBe(200);
      
      // Wait a bit to ensure timestamp would be different if not cached
      await new Promise(r => setTimeout(r, 10));

      // Second request (exact replay)
      const secondRes = await request(app)
        .post('/')
        .set('idempotency-key', 'test-key-2')
        .send({ service: 'test-svc-2', status: 'ok', uptimeSeconds: 200 });

      expect(secondRes.status).toBe(200);
      expect(secondRes.body).toEqual(firstRes.body);
    });

    it('key reuse with different body: returns 409 conflict', async () => {
      // First request
      await request(app)
        .post('/')
        .set('idempotency-key', 'test-key-3')
        .send({ service: 'test-svc-3', status: 'ok', uptimeSeconds: 300 });

      // Second request (different body, same key)
      const conflictRes = await request(app)
        .post('/')
        .set('idempotency-key', 'test-key-3')
        .send({ service: 'test-svc-different', status: 'ok', uptimeSeconds: 400 });

      expect(conflictRes.status).toBe(409);
      expect(conflictRes.body).toEqual({
        error: {
          code: 'conflict',
          message: 'Idempotency key already used for a different request',
        },
      });
    });
  });
});
