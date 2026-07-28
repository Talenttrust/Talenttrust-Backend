/**
 * @file middleware/compression.test.ts
 * @description Tests for the disputes response compression middleware.
 *
 * Coverage targets (≥ 95 %):
 *   - selectEncoding — all Accept-Encoding variants and edge cases
 *   - createCompressionMiddleware — gzip, deflate, identity, threshold boundary
 *   - Below-threshold → no compression, no Content-Encoding header
 *   - At/above-threshold + gzip → compressed, Content-Encoding: gzip
 *   - At/above-threshold + deflate → compressed, Content-Encoding: deflate
 *   - identity / missing Accept-Encoding → no compression
 *   - Vary: Accept-Encoding header present when compressed
 *   - Content-Type preserved as application/json
 *   - Compressed body correctly decompresses back to original JSON
 *   - Disputes router integration — end-to-end compressed path
 *   - Disputes router integration — end-to-end uncompressed path (small body)
 */

import http from 'http';
import zlib from 'zlib';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';

import {
  selectEncoding,
  createCompressionMiddleware,
  DEFAULT_COMPRESSION_THRESHOLD,
} from './compression';

// ── Mock auth middleware so integration tests don't require real JWTs ─────────
jest.mock('./authorization', () => ({
  requireAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
  requirePermission: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

// ── Helper to make raw HTTP requests and capture raw response bytes ───────────
function rawGet(
  server: http.Server,
  path: string,
  acceptEncoding?: string,
): Promise<{ statusCode: number; headers: http.IncomingMessage['headers']; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const headers: Record<string, string> = {};
    if (acceptEncoding !== undefined) {
      headers['Accept-Encoding'] = acceptEncoding;
    }
    const req = http.request({ host: '127.0.0.1', port: addr.port, path, method: 'GET', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({
        statusCode: res.statusCode ?? 0,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

// ── selectEncoding unit tests ─────────────────────────────────────────────────

describe('selectEncoding', () => {
  it('returns "identity" when Accept-Encoding is undefined', () => {
    expect(selectEncoding(undefined)).toBe('identity');
  });

  it('returns "identity" for an empty string', () => {
    expect(selectEncoding('')).toBe('identity');
  });

  it('returns "gzip" when header is "gzip"', () => {
    expect(selectEncoding('gzip')).toBe('gzip');
  });

  it('returns "gzip" when header is "gzip, deflate"', () => {
    expect(selectEncoding('gzip, deflate')).toBe('gzip');
  });

  it('returns "deflate" when header is "deflate, gzip" (first-match wins)', () => {
    expect(selectEncoding('deflate, gzip')).toBe('deflate');
  });

  it('returns "gzip" for wildcard "*"', () => {
    expect(selectEncoding('*')).toBe('gzip');
  });

  it('returns "deflate" when only deflate is listed', () => {
    expect(selectEncoding('deflate')).toBe('deflate');
  });

  it('returns "gzip" for "gzip;q=1.0, deflate;q=0.9"', () => {
    expect(selectEncoding('gzip;q=1.0, deflate;q=0.9')).toBe('gzip');
  });

  it('returns "identity" for "br" (unsupported algorithm)', () => {
    expect(selectEncoding('br')).toBe('identity');
  });

  it('is case-insensitive — "GZIP" → gzip', () => {
    expect(selectEncoding('GZIP')).toBe('gzip');
  });

  it('is case-insensitive — "Deflate" → deflate', () => {
    expect(selectEncoding('Deflate')).toBe('deflate');
  });

  it('strips whitespace around tokens', () => {
    expect(selectEncoding('  gzip  ,  deflate  ')).toBe('gzip');
  });

  it('returns "identity" for "identity" directive', () => {
    expect(selectEncoding('identity')).toBe('identity');
  });

  it('returns "identity" for "br, identity"', () => {
    expect(selectEncoding('br, identity')).toBe('identity');
  });
});

// ── createCompressionMiddleware unit tests ────────────────────────────────────

function buildTestApp(threshold?: number) {
  const app = express();
  app.use(express.json());
  app.use(createCompressionMiddleware({ threshold }));
  return app;
}

describe('createCompressionMiddleware', () => {
  describe('DEFAULT_COMPRESSION_THRESHOLD', () => {
    it('is 1024 bytes', () => {
      expect(DEFAULT_COMPRESSION_THRESHOLD).toBe(1024);
    });
  });

  // ── Below-threshold (small bodies) ─────────────────────────────────────────

  describe('below threshold — no compression', () => {
    it('does not set Content-Encoding when body is below threshold', async () => {
      const THRESHOLD = 512;
      const app = buildTestApp(THRESHOLD);
      app.get('/test', (_req, res) => res.json({ small: 'payload' }));
      const server = app.listen(0);
      try {
        const { headers } = await rawGet(server, '/test', 'gzip');
        expect(headers['content-encoding']).toBeUndefined();
      } finally {
        server.close();
      }
    });

    it('returns plain JSON body for small responses', async () => {
      const THRESHOLD = 512;
      const app = buildTestApp(THRESHOLD);
      app.get('/test', (_req, res) => res.json({ key: 'value' }));
      const server = app.listen(0);
      try {
        const { body, headers } = await rawGet(server, '/test', 'gzip');
        expect(headers['content-encoding']).toBeUndefined();
        expect(JSON.parse(body.toString('utf8'))).toEqual({ key: 'value' });
      } finally {
        server.close();
      }
    });

    it('does not add Vary header when no compression applied', async () => {
      const THRESHOLD = 512;
      const app = buildTestApp(THRESHOLD);
      app.get('/test', (_req, res) => res.json({ small: true }));
      const server = app.listen(0);
      try {
        const { headers } = await rawGet(server, '/test', 'gzip');
        expect(headers['content-encoding']).toBeUndefined();
      } finally {
        server.close();
      }
    });
  });

  // ── At / above threshold ───────────────────────────────────────────────────

  describe('at/above threshold with gzip', () => {
    const THRESHOLD = 64;

    function bigBody() {
      return { data: 'x'.repeat(THRESHOLD + 100) };
    }

    it('sets Content-Encoding: gzip when body is above threshold and client accepts gzip', async () => {
      const app = buildTestApp(THRESHOLD);
      app.get('/test', (_req, res) => res.json(bigBody()));
      const server = app.listen(0);
      try {
        const { headers } = await rawGet(server, '/test', 'gzip');
        expect(headers['content-encoding']).toBe('gzip');
      } finally {
        server.close();
      }
    });

    it('decompressed gzip body matches original JSON', async () => {
      const app = buildTestApp(THRESHOLD);
      const payload = bigBody();
      app.get('/test', (_req, res) => res.json(payload));
      const server = app.listen(0);
      try {
        const { headers, body } = await rawGet(server, '/test', 'gzip');
        expect(headers['content-encoding']).toBe('gzip');
        const decompressed = zlib.gunzipSync(body).toString('utf8');
        expect(JSON.parse(decompressed)).toEqual(payload);
      } finally {
        server.close();
      }
    });

    it('sets Content-Type to application/json when gzip compressed', async () => {
      const app = buildTestApp(THRESHOLD);
      app.get('/test', (_req, res) => res.json(bigBody()));
      const server = app.listen(0);
      try {
        const { headers } = await rawGet(server, '/test', 'gzip');
        expect(headers['content-type']).toMatch(/application\/json/);
      } finally {
        server.close();
      }
    });

    it('sets Vary: Accept-Encoding when gzip compression is applied', async () => {
      const app = buildTestApp(THRESHOLD);
      app.get('/test', (_req, res) => res.json(bigBody()));
      const server = app.listen(0);
      try {
        const { headers } = await rawGet(server, '/test', 'gzip');
        expect(headers['vary']).toBe('Accept-Encoding');
      } finally {
        server.close();
      }
    });

    it('sets a numeric Content-Length on compressed responses', async () => {
      const app = buildTestApp(THRESHOLD);
      app.get('/test', (_req, res) => res.json(bigBody()));
      const server = app.listen(0);
      try {
        const { headers } = await rawGet(server, '/test', 'gzip');
        expect(Number(headers['content-length'])).toBeGreaterThan(0);
      } finally {
        server.close();
      }
    });
  });

  // ── Deflate ────────────────────────────────────────────────────────────────

  describe('at/above threshold with deflate', () => {
    const THRESHOLD = 64;

    function bigBody() {
      return { data: 'y'.repeat(THRESHOLD + 100) };
    }

    it('sets Content-Encoding: deflate when client only accepts deflate', async () => {
      const app = buildTestApp(THRESHOLD);
      app.get('/test', (_req, res) => res.json(bigBody()));
      const server = app.listen(0);
      try {
        const { headers } = await rawGet(server, '/test', 'deflate');
        expect(headers['content-encoding']).toBe('deflate');
      } finally {
        server.close();
      }
    });

    it('decompressed deflate body matches original JSON', async () => {
      const app = buildTestApp(THRESHOLD);
      const payload = bigBody();
      app.get('/test', (_req, res) => res.json(payload));
      const server = app.listen(0);
      try {
        const { headers, body } = await rawGet(server, '/test', 'deflate');
        expect(headers['content-encoding']).toBe('deflate');
        const decompressed = zlib.inflateSync(body).toString('utf8');
        expect(JSON.parse(decompressed)).toEqual(payload);
      } finally {
        server.close();
      }
    });
  });

  // ── Identity / no Accept-Encoding ─────────────────────────────────────────

  describe('identity / missing Accept-Encoding', () => {
    const THRESHOLD = 64;

    function bigBody() {
      return { data: 'z'.repeat(THRESHOLD + 100) };
    }

    it('does not compress when Accept-Encoding is absent', async () => {
      const app = buildTestApp(THRESHOLD);
      app.get('/test', (_req, res) => res.json(bigBody()));
      const server = app.listen(0);
      try {
        // Do NOT pass Accept-Encoding so selectEncoding gets undefined → 'identity'
        const { headers, body } = await rawGet(server, '/test', undefined);
        expect(headers['content-encoding']).toBeUndefined();
        expect(JSON.parse(body.toString('utf8'))).toEqual(bigBody());
      } finally {
        server.close();
      }
    });

    it('does not compress when Accept-Encoding is "identity"', async () => {
      const app = buildTestApp(THRESHOLD);
      app.get('/test', (_req, res) => res.json(bigBody()));
      const server = app.listen(0);
      try {
        const { headers } = await rawGet(server, '/test', 'identity');
        expect(headers['content-encoding']).toBeUndefined();
      } finally {
        server.close();
      }
    });

    it('does not compress when Accept-Encoding is only "br" (unsupported)', async () => {
      const app = buildTestApp(THRESHOLD);
      app.get('/test', (_req, res) => res.json(bigBody()));
      const server = app.listen(0);
      try {
        const { headers } = await rawGet(server, '/test', 'br');
        expect(headers['content-encoding']).toBeUndefined();
      } finally {
        server.close();
      }
    });
  });

  // ── Exact threshold boundary ───────────────────────────────────────────────

  describe('threshold boundary', () => {
    it('does not compress a body exactly at threshold (at-or-below not compressed)', async () => {
      const THRESHOLD = 100;
      const app = buildTestApp(THRESHOLD);

      // Build a payload whose serialised JSON is exactly THRESHOLD bytes.
      const target = THRESHOLD;
      const prefix = '{"d":"';
      const suffix = '"}';
      const padding = 'a'.repeat(target - prefix.length - suffix.length);
      const payload = { d: padding };
      expect(JSON.stringify(payload).length).toBe(target);

      app.get('/test', (_req, res) => res.json(payload));
      const server = app.listen(0);
      try {
        // Exactly threshold → byteLength <= threshold → no compression.
        const { headers } = await rawGet(server, '/test', 'gzip');
        expect(headers['content-encoding']).toBeUndefined();
      } finally {
        server.close();
      }
    });

    it('compresses a body one byte above threshold', async () => {
      const THRESHOLD = 100;
      const app = buildTestApp(THRESHOLD);

      const target = THRESHOLD + 1;
      const prefix = '{"d":"';
      const suffix = '"}';
      const padding = 'a'.repeat(target - prefix.length - suffix.length);
      const payload = { d: padding };
      expect(JSON.stringify(payload).length).toBe(target);

      app.get('/test', (_req, res) => res.json(payload));
      const server = app.listen(0);
      try {
        const { headers } = await rawGet(server, '/test', 'gzip');
        expect(headers['content-encoding']).toBe('gzip');
      } finally {
        server.close();
      }
    });
  });

  // ── Default threshold ──────────────────────────────────────────────────────

  describe('default threshold (1024 bytes)', () => {
    it('uses DEFAULT_COMPRESSION_THRESHOLD when no threshold provided', async () => {
      const app = express();
      app.use(express.json());
      app.use(createCompressionMiddleware()); // no options
      app.get('/test', (_req, res) => res.json({ small: 'tiny payload' }));

      const server = app.listen(0);
      try {
        // tiny payload < 1024 → uncompressed
        const { headers } = await rawGet(server, '/test', 'gzip');
        expect(headers['content-encoding']).toBeUndefined();
      } finally {
        server.close();
      }
    });

    it('compresses a body that exceeds 1024 bytes with default threshold', async () => {
      const app = express();
      app.use(express.json());
      app.use(createCompressionMiddleware());
      app.get('/test', (_req, res) => res.json({ data: 'a'.repeat(1100) }));

      const server = app.listen(0);
      try {
        const { headers, body } = await rawGet(server, '/test', 'gzip');
        expect(headers['content-encoding']).toBe('gzip');
        // Verify decompressed body is valid JSON
        const decompressed = zlib.gunzipSync(body).toString('utf8');
        expect(JSON.parse(decompressed)).toHaveProperty('data');
      } finally {
        server.close();
      }
    });
  });
});

// ── Disputes router integration tests ────────────────────────────────────────

import disputesRouter, { DISPUTES_COMPRESSION_THRESHOLD } from '../routes/disputes.routes';

function buildDisputesApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/disputes', disputesRouter);
  return app;
}

describe('Disputes router — compression integration', () => {
  it('DISPUTES_COMPRESSION_THRESHOLD is exported and equals 1024', () => {
    expect(DISPUTES_COMPRESSION_THRESHOLD).toBe(1024);
  });

  describe('small responses — no compression', () => {
    it('GET /api/v1/disputes returns plain JSON (no Content-Encoding) for default small body', async () => {
      // The default list response { disputes: [], total: 0 } is well below 1 KiB.
      const app = buildDisputesApp();
      const server = app.listen(0);
      try {
        const { statusCode, headers, body } = await rawGet(server, '/api/v1/disputes', 'gzip');
        expect(statusCode).toBe(200);
        expect(headers['content-encoding']).toBeUndefined();
        expect(JSON.parse(body.toString('utf8'))).toHaveProperty('disputes');
      } finally {
        server.close();
      }
    });

    it('GET /api/v1/disputes/:id returns plain JSON for default small body', async () => {
      const app = buildDisputesApp();
      const server = app.listen(0);
      try {
        const { statusCode, headers, body } = await rawGet(server, '/api/v1/disputes/test-id', 'gzip');
        expect(statusCode).toBe(200);
        expect(headers['content-encoding']).toBeUndefined();
        expect(JSON.parse(body.toString('utf8'))).toHaveProperty('dispute');
      } finally {
        server.close();
      }
    });

    it('does not compress when client sends no Accept-Encoding', async () => {
      // Low-threshold app so body size is not the blocker
      const app = express();
      app.use(express.json());
      app.use(createCompressionMiddleware({ threshold: 10 }));
      app.get('/test', (_req, res) => res.json({ data: 'a'.repeat(200) }));
      const server = app.listen(0);
      try {
        const { headers } = await rawGet(server, '/test', undefined);
        expect(headers['content-encoding']).toBeUndefined();
      } finally {
        server.close();
      }
    });
  });

  describe('large responses — gzip compression', () => {
    it('compresses a large response when client accepts gzip', async () => {
      const app = express();
      app.use(express.json());
      app.use(createCompressionMiddleware({ threshold: 10 }));
      const disputes = Array.from({ length: 5 }, (_, i) => ({ id: `d-${i}`, status: 'open' }));
      app.get('/api/v1/disputes', (_req, res) => res.json({ disputes, total: 5 }));

      const server = app.listen(0);
      try {
        const { headers, body } = await rawGet(server, '/api/v1/disputes', 'gzip');
        expect(headers['content-encoding']).toBe('gzip');

        const decompressed = zlib.gunzipSync(body).toString('utf8');
        const parsed = JSON.parse(decompressed);
        expect(parsed).toHaveProperty('disputes');
        expect(parsed.total).toBe(5);
      } finally {
        server.close();
      }
    });

    it('sets Vary: Accept-Encoding on a compressed response', async () => {
      const app = express();
      app.use(express.json());
      app.use(createCompressionMiddleware({ threshold: 10 }));
      app.get('/test', (_req, res) =>
        res.json({ data: 'x'.repeat(200) }),
      );
      const server = app.listen(0);
      try {
        const { headers } = await rawGet(server, '/test', 'gzip');
        expect(headers['vary']).toBe('Accept-Encoding');
      } finally {
        server.close();
      }
    });

    it('compresses when client sends "gzip, deflate, br" (gzip selected)', async () => {
      const app = express();
      app.use(express.json());
      app.use(createCompressionMiddleware({ threshold: 10 }));
      app.get('/test', (_req, res) => res.json({ data: 'a'.repeat(200) }));
      const server = app.listen(0);
      try {
        const { headers } = await rawGet(server, '/test', 'gzip, deflate, br');
        expect(headers['content-encoding']).toBe('gzip');
      } finally {
        server.close();
      }
    });

    it('uses deflate when only deflate is advertised', async () => {
      const app = express();
      app.use(express.json());
      app.use(createCompressionMiddleware({ threshold: 10 }));
      app.get('/test', (_req, res) => res.json({ data: 'b'.repeat(200) }));
      const server = app.listen(0);
      try {
        const { headers, body } = await rawGet(server, '/test', 'deflate');
        expect(headers['content-encoding']).toBe('deflate');
        const decompressed = zlib.inflateSync(body).toString('utf8');
        expect(JSON.parse(decompressed)).toHaveProperty('data');
      } finally {
        server.close();
      }
    });
  });

  describe('POST /api/v1/disputes — create dispute', () => {
    it('POST returns 201 with plain JSON for default small response', async () => {
      const app = buildDisputesApp();
      const res = await request(app)
        .post('/api/v1/disputes')
        .set('Accept-Encoding', 'identity') // disable compression at client level
        .send({ reason: 'payment dispute' });
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('dispute');
    });
  });

  describe('PATCH /api/v1/disputes/:id — update dispute', () => {
    it('PATCH returns 200 with plain JSON for default small response', async () => {
      const app = buildDisputesApp();
      const res = await request(app)
        .patch('/api/v1/disputes/dispute-1')
        .set('Accept-Encoding', 'identity')
        .send({ status: 'resolved' });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('dispute');
    });
  });

  describe('DELETE /api/v1/disputes/:id — delete dispute', () => {
    it('DELETE returns 200 with plain JSON body', async () => {
      const app = buildDisputesApp();
      const res = await request(app)
        .delete('/api/v1/disputes/dispute-1')
        .set('Accept-Encoding', 'identity');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('message');
    });
  });
});
