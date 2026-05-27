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

import http from 'http';
import { createApp } from '../app';

// ── Helpers ──────────────────────────────────────────────────────────────────

interface SimpleResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function req(
  server: http.Server,
  method: string,
  path: string,
  body?: string,
  headers?: Record<string, string>,
): Promise<SimpleResponse> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const reqHeaders: Record<string, string> = { ...headers };
    if (body) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = String(Buffer.byteLength(body));
    }

    const options: http.RequestOptions = {
      hostname: '127.0.0.1',
      port: addr.port,
      path,
      method,
      headers: reqHeaders,
    };

    const r = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () =>
        resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body: data }),
      );
    });

    r.on('error', reject);
    if (body) r.write(body);
    r.end();
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
  let server: http.Server;

  beforeAll((done) => {
    server = createApp().listen(0, '127.0.0.1', done);
  });

  afterAll((done) => {
    server.close(done);
  });

  // ── 404 responses ────────────────────────────────────────────────────────

  describe('404 — unknown routes', () => {
    it('returns the standardized envelope with not_found code', async () => {
      const res = await req(server, 'GET', '/does-not-exist');
      expect(res.statusCode).toBe(404);
      const json = JSON.parse(res.body);
      expect(json.error.code).toBe('not_found');
      expect(json.error.message).toBe('The requested resource was not found');
      expect(json.error).toHaveProperty('requestId');
    });

    it('does not leak the probed route path', async () => {
      const res = await req(server, 'GET', '/api/v1/secret-internal-path');
      expect(res.body).not.toContain('/api/v1/secret-internal-path');
    });

    it('contains no forbidden content', async () => {
      const res = await req(server, 'GET', '/nope');
      assertNoForbiddenContent(res.body, 'GET /nope');
    });
  });

  // ── Malformed JSON ───────────────────────────────────────────────────────

  describe('400 — malformed JSON', () => {
    it('returns invalid_json code with safe message', async () => {
      const res = await req(server, 'POST', '/api/v1/contracts', '{bad json');
      expect(res.statusCode).toBe(400);
      const json = JSON.parse(res.body);
      expect(json.error.code).toBe('invalid_json');
      expect(json.error.message).toBe('Malformed JSON payload');
    });

    it('contains no forbidden content', async () => {
      const res = await req(server, 'POST', '/api/v1/contracts', '{{{{');
      assertNoForbiddenContent(res.body, 'malformed JSON');
    });
  });

  // ── Error envelope shape ────────────────────────────────────────────────

  describe('envelope shape', () => {
    it('every error response includes requestId', async () => {
      const res = await req(server, 'GET', '/not-a-real-route');
      const json = JSON.parse(res.body);
      expect(typeof json.error.requestId).toBe('string');
      expect(json.error.requestId.length).toBeGreaterThan(0);
    });

    it('error code is always a non-empty string', async () => {
      const res = await req(server, 'GET', '/not-a-real-route');
      const json = JSON.parse(res.body);
      expect(typeof json.error.code).toBe('string');
      expect(json.error.code.length).toBeGreaterThan(0);
    });

    it('error message is always a non-empty string', async () => {
      const res = await req(server, 'GET', '/not-a-real-route');
      const json = JSON.parse(res.body);
      expect(typeof json.error.message).toBe('string');
      expect(json.error.message.length).toBeGreaterThan(0);
    });
  });

  // ── Machine code stability ──────────────────────────────────────────────

  describe('machine code stability', () => {
    it('404 always returns not_found', async () => {
      const res = await req(server, 'GET', '/missing');
      expect(JSON.parse(res.body).error.code).toBe('not_found');
    });

    it('malformed JSON always returns invalid_json', async () => {
      const res = await req(server, 'POST', '/api/v1/contracts', '{');
      expect(JSON.parse(res.body).error.code).toBe('invalid_json');
    });
  });
});
