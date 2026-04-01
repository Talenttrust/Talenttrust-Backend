/**
 * Integration tests for the full Express application.
 *
 * Uses supertest to fire real HTTP requests against the app and verifies:
 *   - X-Request-Id is present on every response
 *   - X-Correlation-Id is echoed back when supplied
 *   - Existing routes still return correct payloads
 *   - Invalid header values are rejected / replaced
 */

import request from 'supertest';
import { app } from './index';
import { validateExternalId } from './middleware/requestId';

describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', service: 'talenttrust-backend' });
  });

  it('response includes X-Request-Id header', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-request-id']).toBeDefined();
    expect(typeof res.headers['x-request-id']).toBe('string');
  });

  it('echoes back a valid X-Request-Id supplied by the client', async () => {
    const clientId = 'my-client-trace-id';
    const res = await request(app)
      .get('/health')
      .set('x-request-id', clientId);
    expect(res.headers['x-request-id']).toBe(clientId);
  });

  it('replaces an invalid X-Request-Id with a server-generated UUID', async () => {
    const res = await request(app)
      .get('/health')
      .set('x-request-id', 'bad value!');
    const id = res.headers['x-request-id'] as string;
    expect(id).not.toBe('bad value!');
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('echoes back a valid X-Correlation-Id', async () => {
    const corrId = 'corr-integration-test';
    const res = await request(app)
      .get('/health')
      .set('x-correlation-id', corrId);
    expect(res.headers['x-correlation-id']).toBe(corrId);
  });

  it('does not set X-Correlation-Id when not supplied', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-correlation-id']).toBeUndefined();
  });

  it('each request gets a unique X-Request-Id', async () => {
    const ids = await Promise.all(
      Array.from({ length: 10 }, () =>
        request(app).get('/health').then((r) => r.headers['x-request-id'] as string),
      ),
    );
    expect(new Set(ids).size).toBe(10);
  });
});

describe('GET /api/v1/contracts', () => {
  it('returns 200 with empty contracts array', async () => {
    const res = await request(app).get('/api/v1/contracts');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ contracts: [] });
  });

  it('response includes X-Request-Id header', async () => {
    const res = await request(app).get('/api/v1/contracts');
    expect(res.headers['x-request-id']).toBeDefined();
  });
});

describe('correlation ID propagation', () => {
  it('both IDs are present when both headers are supplied', async () => {
    const res = await request(app)
      .get('/health')
      .set('x-request-id', 'req-123')
      .set('x-correlation-id', 'corr-456');
    expect(res.headers['x-request-id']).toBe('req-123');
    expect(res.headers['x-correlation-id']).toBe('corr-456');
  });

  it('rejects header injection attempt – Node HTTP layer blocks CRLF', () => {
    // Node's built-in HTTP client throws on CRLF in header values,
    // which is the correct security boundary (RFC 7230 §3.2.6).
    // Our validateExternalId also rejects such values server-side.
    const malicious = 'id\r\nX-Injected: evil';
    expect(validateExternalId(malicious)).toBeUndefined();
  });
});
