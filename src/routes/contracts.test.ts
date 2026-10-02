/**
 * @file routes/contracts.test.ts
 * @description Unit tests for the contracts router, including CONTRACTS_ENABLED flag paths.
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

describe('contractsRouter — flag enabled (default)', () => {
  let server: http.Server;

  beforeAll((done: jest.DoneCallback) => {
    delete process.env['CONTRACTS_ENABLED'];
    const a = express();
    a.use('/', contractsRouter);
    const s = a.listen(0, '127.0.0.1', done);
    void (server = s);
  });

  afterAll((done) => {
    void server.close(done);
  });

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

describe('contractsRouter — flag explicitly enabled (CONTRACTS_ENABLED=true)', () => {
  let server: http.Server;

  beforeAll((done: jest.DoneCallback) => {
    process.env['CONTRACTS_ENABLED'] = 'true';
    const a = express();
    a.use('/', contractsRouter);
    const s = a.listen(0, '127.0.0.1', done);
    void (server = s);
  });

  afterAll((done) => {
    delete process.env['CONTRACTS_ENABLED'];
    void server.close(done);
  });

  it('GET / → 200', async () => {
    const res = await request(server, 'GET', '/');
    expect(res.statusCode).toBe(200);
  });

  it('returns { contracts: [] }', async () => {
    const res = await request(server, 'GET', '/');
    expect(JSON.parse(res.body)).toEqual({ contracts: [] });
  });
});

describe('contractsRouter — flag disabled (CONTRACTS_ENABLED=false)', () => {
  let server: http.Server;

  beforeAll((done: jest.DoneCallback) => {
    process.env['CONTRACTS_ENABLED'] = 'false';
    const a = express();
    a.use('/', contractsRouter);
    const s = a.listen(0, '127.0.0.1', done);
    void (server = s);
  });

  afterAll((done) => {
    delete process.env['CONTRACTS_ENABLED'];
    void server.close(done);
  });

  it('GET / → 503', async () => {
    const res = await request(server, 'GET', '/');
    expect(res.statusCode).toBe(503);
  });

  it('returns error message', async () => {
    const res = await request(server, 'GET', '/');
    expect(JSON.parse(res.body)).toEqual({ error: 'Contracts feature is disabled' });
  });

  it('content-type is application/json', async () => {
    const res = await request(server, 'GET', '/');
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });
});
