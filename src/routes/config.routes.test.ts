/**
 * @file routes/config.routes.test.ts
 * @description Integration tests for the GET /api/config route.
 *
 * Mounts only the configRouter on a minimal Express app so failures here are
 * unambiguously scoped to the config route logic.
 */

import express from 'express';
import http from 'http';
import configRouter from './config.routes';

// ── Mock appConfiguration so tests are deterministic ─────────────────────────
const mockLoadConfig = jest.fn();
jest.mock('../appConfiguration', () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
}));

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

describe('GET /api/config', () => {
  let server: http.Server;

  beforeAll((done) => {
    const app = express();
    app.use('/', configRouter);
    server = app.listen(0, '127.0.0.1', done);
  });

  afterAll((done) => {
    server.close(done);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('returns 200 with allowedAssets array', async () => {
    mockLoadConfig.mockReturnValue({ allowedAssets: ['USDC', 'XLM', 'BTC', 'ETH'] });

    const res = await request(server, 'GET', '/');

    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body);
    expect(json).toEqual({ allowedAssets: ['USDC', 'XLM', 'BTC', 'ETH'] });
  });

  it('responds with application/json content-type', async () => {
    mockLoadConfig.mockReturnValue({ allowedAssets: ['USDC'] });

    const res = await request(server, 'GET', '/');

    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('includes USDC in the default asset list', async () => {
    mockLoadConfig.mockReturnValue({ allowedAssets: ['USDC', 'XLM', 'BTC', 'ETH'] });

    const res = await request(server, 'GET', '/');
    const json = JSON.parse(res.body);

    expect(json.allowedAssets).toContain('USDC');
  });

  it('returns an array even for a single-asset config', async () => {
    mockLoadConfig.mockReturnValue({ allowedAssets: ['USDC'] });

    const res = await request(server, 'GET', '/');
    const json = JSON.parse(res.body);

    expect(Array.isArray(json.allowedAssets)).toBe(true);
    expect(json.allowedAssets).toEqual(['USDC']);
  });

  it('returns 500 with error envelope when config loading fails', async () => {
    mockLoadConfig.mockImplementation(() => {
      throw new Error('env read failure');
    });

    const res = await request(server, 'GET', '/');

    expect(res.statusCode).toBe(500);
    const json = JSON.parse(res.body);
    expect(json).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'internal_error' }),
      }),
    );
  });
});
