import express from 'express';
import request from 'supertest';
import { healthRouter } from './health';
import { dbProbe, redisProbe, stellarRpcProbe } from './health/probes';

jest.mock('./health/probes', () => ({
  dbProbe: jest.fn(),
  redisProbe: jest.fn(),
  stellarRpcProbe: jest.fn(),
}));

const mockDbProbe = jest.mocked(dbProbe);
const mockRedisProbe = jest.mocked(redisProbe);
const mockStellarRpcProbe = jest.mocked(stellarRpcProbe);

function buildApp() {
  const app = express();
  app.use('/health', healthRouter);
  return app.listen(0);
}

describe('health readiness probes', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...originalEnv };
    process.env.NODE_ENV = 'test';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('returns 200 when all dependencies are reachable', async () => {
    mockDbProbe.mockResolvedValue({ name: 'db', ok: true, latencyMs: 1 });
    mockStellarRpcProbe.mockResolvedValue({ name: 'stellar-rpc', ok: true, latencyMs: 2 });
    mockRedisProbe.mockResolvedValue({ name: 'queue', ok: true, latencyMs: 3 });

    const server = buildApp();
    const res = await request(server).get('/health/ready');
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
    expect(res.body.probe).toBe('ready');
    expect(res.body.checks).toHaveLength(3);
  });

  it('returns 503 when SQLite is unavailable', async () => {
    mockDbProbe.mockResolvedValue({ name: 'db', ok: false, detail: 'SQLITE_CANTOPEN', latencyMs: 1 });
    mockStellarRpcProbe.mockResolvedValue({ name: 'stellar-rpc', ok: true, latencyMs: 2 });
    mockRedisProbe.mockResolvedValue({ name: 'queue', ok: true, latencyMs: 3 });

    const server = buildApp();
    const res = await request(server).get('/health/ready');
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not-ready');
    expect(res.body.checks[0].detail).toContain('SQLITE_CANTOPEN');
  });

  it('returns 503 when the Soroban RPC dependency is unreachable', async () => {
    mockDbProbe.mockResolvedValue({ name: 'db', ok: true, latencyMs: 1 });
    mockStellarRpcProbe.mockResolvedValue({ name: 'stellar-rpc', ok: false, detail: 'ECONNREFUSED', latencyMs: 2 });
    mockRedisProbe.mockResolvedValue({ name: 'queue', ok: true, latencyMs: 3 });

    const server = buildApp();
    const res = await request(server).get('/health/ready');
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not-ready');
    expect(res.body.checks[1].detail).toContain('ECONNREFUSED');
  });
});
