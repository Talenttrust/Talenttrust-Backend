/**
 * @file routes/admin.routes.test.ts
 * @description Unit tests for admin queue health endpoint.
 */

import express from 'express';
import http from 'http';
import jwt from 'jsonwebtoken';
import { adminRouter } from './admin.routes';

const JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret';

interface SimpleResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(
  server: http.Server,
  method: string,
  path: string,
  token?: string
): Promise<SimpleResponse> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const reqOptions: http.RequestOptions = {
      hostname: '127.0.0.1',
      port: addr.port,
      path,
      method,
    };

    const req = http.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () =>
        resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers,
          body: data,
        })
      );
    });

    req.on('error', reject);

    if (token) {
      req.setHeader('Authorization', `Bearer ${token}`);
    }

    req.end();
  });
}

function createToken(role: string): string {
  return jwt.sign(
    { sub: 'test-user-id', email: 'test@example.com', role },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

describe('adminRouter', () => {
  let server: http.Server;

  beforeAll((done) => {
    const a = express();
    a.use('/api/v1/admin', adminRouter);
    const s = a.listen(0, '127.0.0.1', done);
    void (server = s);
  });

  afterAll((done) => {
    void server.close(done);
  });

  describe('GET /queue-health', () => {
    it('returns 401 without Authorization header', async () => {
      const res = await request(server, 'GET', '/api/v1/admin/queue-health');
      expect(res.statusCode).toBe(401);
    });

    it('returns 401 with invalid token', async () => {
      const res = await request(
        server,
        'GET',
        '/api/v1/admin/queue-health',
        'invalid-token'
      );
      expect(res.statusCode).toBe(401);
    });

    it('returns 403 for non-admin role', async () => {
      const token = createToken('client');
      const res = await request(
        server,
        'GET',
        '/api/v1/admin/queue-health',
        token
      );
      expect(res.statusCode).toBe(403);
    });

    it('returns 200 for admin role', async () => {
      const token = createToken('admin');
      const res = await request(
        server,
        'GET',
        '/api/v1/admin/queue-health',
        token
      );
      expect(res.statusCode).toBe(200);
    });

    it('returns queue health structure', async () => {
      const token = createToken('admin');
      const res = await request(
        server,
        'GET',
        '/api/v1/admin/queue-health',
        token
      );
      const body = JSON.parse(res.body);
      expect(body.status).toBe('success');
      expect(body.data).toHaveProperty('queues');
      expect(body.data).toHaveProperty('failures');
      expect(body.data).toHaveProperty('timestamp');
    });
  });

  describe('GET /circuit-breakers', () => {
    it('returns 401 without Authorization header', async () => {
      const res = await request(server, 'GET', '/api/v1/admin/circuit-breakers');
      expect(res.statusCode).toBe(401);
    });

    it('returns 403 for non-admin role', async () => {
      const token = createToken('client');
      const res = await request(server, 'GET', '/api/v1/admin/circuit-breakers', token);
      expect(res.statusCode).toBe(403);
    });

    it('returns 200 with breakers array for admin', async () => {
      const token = createToken('admin');
      const res = await request(server, 'GET', '/api/v1/admin/circuit-breakers', token);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('success');
      expect(Array.isArray(body.data.breakers)).toBe(true);
      expect(typeof body.data.timestamp).toBe('number');
    });
  });
});
