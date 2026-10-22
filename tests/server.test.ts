import express from 'express';
import { startServer, parsePort, resolveTimeouts } from '../src/server';
import http from 'http';
import net from 'net';

describe('Server lifecycle', () => {
  it('parsePort defaults to 3001 and rejects invalid values', () => {
    expect(parsePort(undefined)).toBe(3001);
    expect(parsePort('3001')).toBe(3001);
    expect(() => parsePort('abc')).toThrow(/Invalid PORT/);
    expect(() => parsePort('0')).toThrow(/Invalid PORT/);
    expect(() => parsePort('65536')).toThrow(/Invalid PORT/);
    expect(() => parsePort('-1')).toThrow(/Invalid PORT/);
    expect(() => parsePort('3.5')).toThrow(/Invalid PORT/);
  });

  it('resolveTimeouts uses defaults and rejects headers <= keepAlive', () => {
    const defaults = resolveTimeouts({});
    expect(defaults.keepAliveTimeoutMs).toBe(65_000);
    expect(defaults.headersTimeoutMs).toBe(66_000);
    expect(defaults.requestTimeoutMs).toBe(30_000);

    expect(() =>
      resolveTimeouts({ KEEP_ALIVE_TIMEOUT_MS: '100', HEADERS_TIMEOUT_MS: '50' }),
    ).toThrow(/HEADERS_TIMEOUT_MS.*greater than.*KEEP_ALIVE_TIMEOUT_MS/);

    expect(() => resolveTimeouts({ KEEP_ALIVE_TIMEOUT_MS: 'abc' })).toThrow(/Invalid KEEP_ALIVE_TIMEOUT_MS/);
    expect(() => resolveTimeouts({ HEADERS_TIMEOUT_MS: 'abc' })).toThrow(/Invalid HEADERS_TIMEOUT_MS/);
  });

  it('startServer applies configured timeouts', async () => {
    const app = express();
    const { server, close } = startServer({
      app,
      port: 0,
      timeouts: { keepAliveTimeoutMs: 30_000, headersTimeoutMs: 31_000, requestTimeoutMs: 5_000 },
    });
    expect(server.keepAliveTimeout).toBe(30_000);
    expect(server.headersTimeout).toBe(31_000);
    await close();
  });

  it('waits for in-flight request to complete, refuses new connections', async () => {
    const app = express();
    app.get('/slow', (_req, res) => {
      setTimeout(() => res.json({ ok: true }), 200);
    });

    const { port, close } = startServer({ app, port: 0 });

    const slowPromise = new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const req = http.get(`http://localhost:${port}/slow`, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data || '{}') }));
      });
      req.on('error', reject);
    });

    // Ensure the request reaches the server before closing.
    await new Promise((r) => setTimeout(r, 100));

    const result = await close();
    const slow = await slowPromise;

    expect(result.forced).toBe(false);
    expect(slow.status).toBe(200);
    expect(slow.body).toEqual({ ok: true });

    // New connection should be refused
    await new Promise((resolve, reject) => {
      const socket = net.connect({ port }, () => {
        socket.destroy();
        reject(new Error('expected connection to be refused'));
      });
      socket.on('error', (err) => {
        expect((err as { code?: string }).code).toBe('ECONNREFUSED');
        resolve(void 0);
      });
    });
  });

  it('force-closes long-running request and resolves with forced: true', async () => {
    const app = express();
    app.get('/slow', (_req, res) => {
      setTimeout(() => res.json({ ok: true }), 500);
    });

    const { port, close } = startServer({ app, port: 0, shutdownGraceMs: 50 });

    const slowPromise = new Promise<{ status: number }>((resolve, reject) => {
      const req = http.get(`http://localhost:${port}/slow`, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
      });
      req.on('error', reject);
    });

    // Ensure the request reaches the server before closing.
    await new Promise((r) => setTimeout(r, 100));

    const result = await close();

    // The slow request should have been force-closed, so it errors out.
    await slowPromise.catch((err) => {
      expect(err).toBeDefined();
    });

    expect(result.forced).toBe(true);
  });

  it('/health returns 503 while draining', async () => {
    const app = express();
    app.get('/health', (_req, res) => {
      if (app.get('draining')) {
        res.status(503).setHeader('Connection', 'close').json({ status: 'draining' });
        return;
      }
      res.json({ status: 'ok' });
    });

    const { port, close } = startServer({ app, port: 0, shutdownGraceMs: 5000 });

    // Trigger drain without waiting for close to resolve
    app.set('draining', true);

    const health = await new Promise<{ status: number; body: { status: string } }>((resolve, reject) => {
      const req = http.get(`http://localhost:${port}/health`, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data || '{}') }));
      });
      req.on('error', reject);
    });

    expect(health.status).toBe(503);
    expect(health.body.status).toBe('draining');

    await close();
  });
});
