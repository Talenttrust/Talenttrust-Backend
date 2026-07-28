/**
 * Integration tests that enforce the safe error message policy across
 * all error-handling paths reachable through the Express application.
 *
 * Policy under test:
 *  - No stack traces in any error response.
 *  - No file paths, SQL fragments, or credential references.
 *  - Consistent envelope shape: { error: { code, message, requestId } }.
 *  - Machine codes are stable strings clients can rely on.
 */

import type { Application } from 'express';
import http from 'http';
import { Duplex } from 'stream';
import { z } from 'zod';
import { attachTerminalHandlers, createApp } from '../app';
import { AppError } from './appError';
import { validateSchema } from '../middleware/validate.middleware';

// ── Helpers ──────────────────────────────────────────────────────────────────

interface InjectedResponse {
  status: number;
  body: any;
  text: string;
}

class MockSocket extends Duplex {
  _read(): void {
    // ServerResponse writes are intercepted in inject(); no socket reads needed.
  }

  _write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    callback();
  }
}

function inject(
  app: Application,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<InjectedResponse> {
  return new Promise((resolve, reject) => {
    const socket = new MockSocket();
    const req = new http.IncomingMessage(socket as any);
    req.method = method;
    req.url = path;
    req.headers = { ...headers };

    if (body !== undefined) {
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      req.headers['content-type'] = req.headers['content-type'] ?? 'application/json';
      req.headers['content-length'] = String(Buffer.byteLength(payload));
      req.push(payload);
    }
    req.push(null);

    const res = new http.ServerResponse(req);
    res.assignSocket(socket as any);

    const chunks: Buffer[] = [];
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);

    res.write = ((chunk: any, encoding?: any, cb?: any) => {
      if (chunk !== undefined) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      }
      return originalWrite(chunk, encoding, cb);
    }) as typeof res.write;

    res.end = ((chunk?: any, encoding?: any, cb?: any) => {
      if (chunk !== undefined) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      }
      const text = Buffer.concat(chunks).toString('utf8');
      let parsed: any = {};
      try {
        parsed = text.length > 0 ? JSON.parse(text) : {};
      } catch {
        parsed = text;
      }

      resolve({
        status: res.statusCode,
        body: parsed,
        text,
      });

      return originalEnd(chunk, encoding, cb);
    }) as typeof res.end;

    (app as any).handle(req as any, res as any, reject);
  });
}

/**
 * Patterns that must never appear in any error response body.
 */
const FORBIDDEN_PATTERNS: ReadonlyArray<RegExp> = [
  /at\s+\S+\s+\(.*:\d+:\d+\)/,          // V8 stack frame
  /at\s+Object\.\<anonymous\>/,            // anonymous stack frame
  /\/[a-zA-Z_][\w\-]*\/.*\.\w{1,5}:/,    // absolute file paths
  /node_modules\//,                        // dependency paths
  /ECONNREFUSED|ENOTFOUND|ETIMEDOUT/,     // raw syscall errors
  /SELECT\s|INSERT\s|UPDATE\s|DELETE\s/i,  // SQL fragments
];

function assertNoForbiddenContent(body: string, context: string): void {
  for (const pattern of FORBIDDEN_PATTERNS) {
    expect({ context, match: pattern.source, leaked: pattern.test(body) }).toEqual({
      context,
      match: pattern.source,
      leaked: false,
    });
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Error message policy — integration', () => {
  let app: Application;

  beforeAll(() => {
    app = createApp({ includeTerminalHandlers: false });

    app.get('/__policy/unknown-error', (_req, _res, next) => {
      next(new Error('SELECT token FROM users at /srv/app/src/private.ts:12:1'));
    });

    app.get('/__policy/app-error', (_req, _res, next) => {
      next(new AppError(
        503,
        'dependency_unavailable',
        'connect ECONNREFUSED 10.0.0.5:6379 for token=abc',
      ));
    });

    app.post(
      '/__policy/validation-error',
      validateSchema(
        z.object({
          body: z.object({
            contractId: z.string().uuid(),
          }),
        }),
      ),
      (_req, res) => res.status(204).end(),
    );

    attachTerminalHandlers(app);
  });

  // ── 404 responses ────────────────────────────────────────────────────────

  describe('404 — unknown routes', () => {
    it('returns the standardized envelope with not_found code', async () => {
      const res = await inject(app, 'GET', '/does-not-exist');
      expect(res.status).toBe(404);
      const json = res.body;
      expect(json.error.code).toBe('not_found');
      expect(json.error.message).toBe('The requested resource was not found');
      expect(json.error).toHaveProperty('requestId');
    });

    it('does not leak the probed route path', async () => {
      const res = await inject(app, 'GET', '/api/v1/secret-internal-path');
      expect(JSON.stringify(res.body)).not.toContain('/api/v1/secret-internal-path');
    });

    it('contains no forbidden content', async () => {
      const res = await inject(app, 'GET', '/nope');
      assertNoForbiddenContent(JSON.stringify(res.body), 'GET /nope');
    });
  });

  // ── Malformed JSON ───────────────────────────────────────────────────────

  describe('400 — malformed JSON', () => {
    it('returns invalid_json code with safe message', async () => {
      const res = await inject(app, 'POST', '/api/v1/contracts', '{bad json', {
        'content-type': 'application/json',
      });
      expect(res.status).toBe(400);
      const json = res.body;
      expect(json.error.code).toBe('invalid_json');
      expect(json.error.message).toBe('Malformed JSON payload');
    });

    it('contains no forbidden content', async () => {
      const res = await inject(app, 'POST', '/api/v1/contracts', '{{{{', {
        'content-type': 'application/json',
      });
      assertNoForbiddenContent(JSON.stringify(res.body), 'malformed JSON');
    });
  });

  // ── Central handler mapping ──────────────────────────────────────────────

  describe('central policy mapping', () => {
    it('maps unknown errors to a safe 500 response', async () => {
      const res = await inject(app, 'GET', '/__policy/unknown-error');
      expect(res.status).toBe(500);
      const json = res.body;
      expect(json.error).toEqual(
        expect.objectContaining({
          code: 'internal_error',
          message: 'An unexpected error occurred',
          requestId: expect.any(String),
        }),
      );
      expect(JSON.stringify(res.body)).not.toContain('SELECT token');
      expect(JSON.stringify(res.body)).not.toContain('/srv/app/src/private.ts');
      assertNoForbiddenContent(JSON.stringify(res.body), 'unknown error');
    });

    it('maps AppError instances through the safe message policy', async () => {
      const res = await inject(app, 'GET', '/__policy/app-error');
      expect(res.status).toBe(503);
      const json = res.body;
      expect(json.error).toEqual(
        expect.objectContaining({
          code: 'dependency_unavailable',
          message: 'A required service is temporarily unavailable',
          requestId: expect.any(String),
        }),
      );
      assertNoForbiddenContent(JSON.stringify(res.body), 'app error');
    });

    it('returns validation errors with a safe body and 400 status', async () => {
      const res = await inject(app, 'POST', '/__policy/validation-error', {
        contractId: 'not-a-uuid',
      });
      expect(res.status).toBe(400);
      const json = res.body;
      expect(json.error).toEqual(
        expect.objectContaining({
          code: 'validation_error',
          message: 'Request validation failed',
          requestId: expect.any(String),
          details: expect.any(Array),
        }),
      );
      assertNoForbiddenContent(JSON.stringify(res.body), 'validation error');
    });
  });

  // ── Error envelope shape ────────────────────────────────────────────────

  describe('envelope shape', () => {
    it('every error response includes requestId', async () => {
      const res = await inject(app, 'GET', '/not-a-real-route');
      const json = res.body;
      expect(typeof json.error.requestId).toBe('string');
      expect(json.error.requestId.length).toBeGreaterThan(0);
    });

    it('error code is always a non-empty string', async () => {
      const res = await inject(app, 'GET', '/not-a-real-route');
      const json = res.body;
      expect(typeof json.error.code).toBe('string');
      expect(json.error.code.length).toBeGreaterThan(0);
    });

    it('error message is always a non-empty string', async () => {
      const res = await inject(app, 'GET', '/not-a-real-route');
      const json = res.body;
      expect(typeof json.error.message).toBe('string');
      expect(json.error.message.length).toBeGreaterThan(0);
    });
  });

  // ── Machine code stability ──────────────────────────────────────────────

  describe('machine code stability', () => {
    it('404 always returns not_found', async () => {
      const res = await inject(app, 'GET', '/missing');
      expect(res.body.error.code).toBe('not_found');
    });

    it('malformed JSON always returns invalid_json', async () => {
      const res = await inject(app, 'POST', '/api/v1/contracts', '{', {
        'content-type': 'application/json',
      });
      expect(res.body.error.code).toBe('invalid_json');
    });
  });
});
