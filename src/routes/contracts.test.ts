/**
 * @file routes/contracts.test.ts
 * @description Unit tests for the contracts router in isolation.
 */

import express from 'express';
import http from 'http';
import { contractsRouter } from './contracts';

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

describe('contractsRouter', () => {
  let server: http.Server;

  beforeAll((done) => {
    const app = express();
    app.use('/', contractsRouter);
    server = app.listen(0, '127.0.0.1', done);
  });

  afterAll((done) => server.close(done));

  it('GET / → 200', async () => {
    const res = await request(server, 'GET', '/');
    expect(res.statusCode).toBe(200);
  });

  it('returns { contracts: [] }', async () => {
    const res = await request(server, 'GET', '/');
    expect(JSON.parse(res.body)).toEqual({ contracts: [] });
  });

  it('contracts is an array', async () => {
    const res = await request(server, 'GET', '/');
    expect(Array.isArray(JSON.parse(res.body).contracts)).toBe(true);
  });

  it('content-type is application/json', async () => {
    const res = await request(server, 'GET', '/');
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });
});
