/**
 * @file routes/health.test.ts
 * @description Unit tests for the health router in isolation.
 *
 * Mounts only the health router on a minimal Express app so failures here
 * are unambiguously scoped to the health route logic.
 */

import express from 'express';
import http from 'http';
import { healthRouter } from './health';

interface SimpleResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(server: http.Server, method: string, path: string): Promise<SimpleResponse> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const req = http.request(
      { hostname: '127.0.0.1', port: addr.port, path, method },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () =>
          resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body: data }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('healthRouter', () => {
  let server: http.Server;

  beforeAll((done) => {
    const app = express();
    app.use('/', healthRouter);
    server = app.listen(0, '127.0.0.1', done);
  });

  afterAll((done) => server.close(done));

  it('GET / → 200', async () => {
    const res = await request(server, 'GET', '/');
    expect(res.statusCode).toBe(200);
  });

  it('returns { status: "ok", service: "talenttrust-backend" }', async () => {
    const res = await request(server, 'GET', '/');
    expect(JSON.parse(res.body)).toEqual({ status: 'ok', service: 'talenttrust-backend' });
  });

  it('content-type is application/json', async () => {
    const res = await request(server, 'GET', '/');
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });
});
