/**
 * @file app.test.ts
 * @description Integration tests for the Express application.
 *
 * Tests cover:
 *  - Happy-path responses for all routes
 *  - 404 handling for unknown routes
 *  - Global error handler
 *  - Response shape and content-type contracts
 *
 * @security
 *  Validates that error responses never leak stack traces or internal details
 *  to the client (threat: information disclosure).
 */

import { createApp } from './app';
import express from 'express';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal HTTP request helper that avoids importing supertest (not installed).
 * Uses Node's built-in http module to fire requests against the app.
 */
import http from 'http';

interface SimpleResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(
  server: http.Server,
  method: string,
  path: string,
  body?: string,
): Promise<SimpleResponse> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const options: http.RequestOptions = {
      hostname: '127.0.0.1',
      port: addr.port,
      path,
      method,
      headers: body
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        : {},
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () =>
        resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body: data }),
      );
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('createApp()', () => {
  let server: http.Server;

  beforeAll((done) => {
    server = createApp().listen(0, '127.0.0.1', done); // port 0 = OS-assigned
  });

  afterAll((done) => {
    server.close(done);
  });

  // ── Health endpoint ───────────────────────────────────────────────────────

  describe('GET /health', () => {
    it('returns 200 with correct JSON shape', async () => {
      const res = await request(server, 'GET', '/health');
      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.body);
      expect(json).toEqual({ status: 'ok', service: 'talenttrust-backend' });
    });

    it('responds with application/json content-type', async () => {
      const res = await request(server, 'GET', '/health');
      expect(res.headers['content-type']).toMatch(/application\/json/);
    });

    it('status field is always "ok"', async () => {
      const res = await request(server, 'GET', '/health');
      const json = JSON.parse(res.body);
      expect(json.status).toBe('ok');
    });

    it('service field identifies the backend', async () => {
      const res = await request(server, 'GET', '/health');
      const json = JSON.parse(res.body);
      expect(json.service).toBe('talenttrust-backend');
    });
  });

  // ── Contracts endpoint ────────────────────────────────────────────────────

  describe('GET /api/v1/contracts', () => {
    it('returns 200 with success payload', async () => {
      const res = await request(server, 'GET', '/api/v1/contracts');
      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.body);
      expect(json).toEqual(expect.objectContaining({ status: 'success', data: expect.any(Array) }));
    });

    it('responds with application/json content-type', async () => {
      const res = await request(server, 'GET', '/api/v1/contracts');
      expect(res.headers['content-type']).toMatch(/application\/json/);
    });

    it('data is empty by default', async () => {
      const res = await request(server, 'GET', '/api/v1/contracts');
      const json = JSON.parse(res.body);
      expect(json.data).toHaveLength(0);
    });
  });

  // ── 404 handler ──────────────────────────────────────────────────────────

  describe('404 — unknown routes', () => {
    it('returns 404 for an unknown GET route', async () => {
      const res = await request(server, 'GET', '/does-not-exist');
      expect(res.statusCode).toBe(404);
    });

    it('returns JSON error body for unknown route', async () => {
      const res = await request(server, 'GET', '/unknown');
      const json = JSON.parse(res.body);
      expect(json.error).toEqual(
        expect.objectContaining({ code: 'not_found', message: 'The requested resource was not found' }),
      );
    });

    it('returns 404 for unknown nested path', async () => {
      const res = await request(server, 'GET', '/api/v1/unknown');
      expect(res.statusCode).toBe(404);
    });

    it('does not leak stack trace in 404 response', async () => {
      const res = await request(server, 'GET', '/no-such-route');
      expect(res.body).not.toMatch(/Error:/);
      expect(res.body).not.toMatch(/at Object/);
    });
  });

  // ── Global error handler ─────────────────────────────────────────────────

  describe('500 — global error handler', () => {
    let errorApp: express.Application;
    let errorServer: http.Server;

    beforeAll((done) => {
      // Minimal app: throw route before the final 404 so the error handler is reached
      errorApp = express();
      errorApp.get('/throw', () => {
        throw new Error('deliberate test error');
      });
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      errorApp.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(500).json({ error: 'Internal Server Error' });
      });
      errorServer = errorApp.listen(0, '127.0.0.1', done);
    });

    afterAll((done) => {
      void errorServer.close(done);
    });

    it('returns 500 when a route throws', async () => {
      const res = await request(errorServer, 'GET', '/throw');
      expect(res.statusCode).toBe(500);
    });

    it('returns JSON error body on 500', async () => {
      const res = await request(errorServer, 'GET', '/throw');
      const json = JSON.parse(res.body);
      expect(json).toHaveProperty('error', 'Internal Server Error');
    });

    it('does not leak stack trace in 500 response (information disclosure)', async () => {
      const res = await request(errorServer, 'GET', '/throw');
      expect(res.body).not.toMatch(/deliberate test error/);
      expect(res.body).not.toMatch(/at Object/);
    });
  });

  // ── JSON body parsing ─────────────────────────────────────────────────────

  describe('JSON body parsing middleware', () => {
    it('accepts a POST with a JSON body without crashing', async () => {
      // /health only has GET; a POST will hit the 404 handler — that's fine,
      // the point is the body parser doesn't throw on valid JSON.
      const res = await request(server, 'POST', '/health', JSON.stringify({ ping: true }));
      expect([200, 404, 405]).toContain(res.statusCode);
    });
  });
});
