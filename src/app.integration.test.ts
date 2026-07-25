process.env.JWT_SECRET = process.env.JWT_SECRET || 'app-integration-secret';

import { AddressInfo } from 'net';
import jwt from 'jsonwebtoken';
import { createApp } from './app';
import { CORRELATION_ID_HEADER, REQUEST_ID_HEADER } from './middleware/requestId';

// The contracts list route enforces the deny-by-default authorization matrix,
// so these live-app requests authenticate as an admin. CORS/preflight checks
// run ahead of auth, so the header is harmless for those cases.
const ADMIN_TOKEN = jwt.sign(
  { sub: 'admin-1', email: 'admin@test.com', role: 'admin' },
  process.env.JWT_SECRET as string,
  { expiresIn: '1h' },
);
const authHeaders = (extra: Record<string, string> = {}): Record<string, string> => ({
  Authorization: `Bearer ${ADMIN_TOKEN}`,
  ...extra,
});

/**
 * Exercises the live Express app wiring for the contracts list endpoint
 * (matches ContractsController + ContractsService behavior).
 */
describe('Contracts API integration (live app factory)', () => {
  it('GET /api/v1/contracts returns success envelope', async () => {
    const app = createApp();
    const server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/contracts`, { headers: authHeaders() });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual(
        expect.objectContaining({ status: 'success', data: expect.anything() }),
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err?: Error) => (err ? reject(err) : resolve()));
      });
    }
  });
});

/**
 * @module app.integration.test
 * @description Integration tests for correlation ID propagation across request lifecycle.
 *
 * Verifies that:
 * 1. Correlation IDs are accepted and echoed back in response headers
 * 2. Correlation IDs are included in request-scoped logs
 * 3. Request IDs are always generated and included in response headers
 */
describe('Correlation ID propagation integration', () => {
  /**
   * Tests that X-Correlation-Id header is accepted from the client,
   * validated for security, and echoed back in the response.
   */
  it('should accept X-Correlation-Id header from client and echo back', async () => {
    const app = createApp();
    const server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    const testCorrelationId = 'test-correlation-id-12345';

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/contracts`, {
        headers: authHeaders({
          [CORRELATION_ID_HEADER]: testCorrelationId,
        }),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get(CORRELATION_ID_HEADER)).toBe(testCorrelationId);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err?: Error) => (err ? reject(err) : resolve()));
      });
    }
  });

  /**
   * Tests that X-Correlation-Id is not echoed back when not provided by client.
   */
  it('should not echo X-Correlation-Id when not provided by client', async () => {
    const app = createApp();
    const server = app.listen(0);
    const { port } = server.address() as AddressInfo;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/contracts`, { headers: authHeaders() });

      expect(response.status).toBe(200);
      expect(response.headers.get(CORRELATION_ID_HEADER)).toBeNull();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err?: Error) => (err ? reject(err) : resolve()));
      });
    }
  });

  /**
   * Tests that X-Request-Id header is always generated and echoed back.
   */
  it('should always generate and echo back X-Request-Id header', async () => {
    const app = createApp();
    const server = app.listen(0);
    const { port } = server.address() as AddressInfo;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/contracts`, { headers: authHeaders() });

      expect(response.status).toBe(200);
      const requestId = response.headers.get(REQUEST_ID_HEADER);
      expect(requestId).toBeTruthy();
      // Basic UUID v4 format validation
      expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err?: Error) => (err ? reject(err) : resolve()));
      });
    }
  });

  /**
   * Tests that client-supplied X-Request-Id is reused if valid.
   */
  it('should reuse client-supplied X-Request-Id if valid', async () => {
    const app = createApp();
    const server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    const clientRequestId = 'abc123-def456-ghi789';

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/contracts`, {
        headers: authHeaders({
          [REQUEST_ID_HEADER]: clientRequestId,
        }),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get(REQUEST_ID_HEADER)).toBe(clientRequestId);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err?: Error) => (err ? reject(err) : resolve()));
      });
    }
  });

  /**
   * Tests that both X-Correlation-Id and X-Request-Id are propagated together.
   */
  it('should propagate both X-Correlation-Id and X-Request-Id in response', async () => {
    const app = createApp();
    const server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    const testCorrelationId = 'trace-correlation-id-789';

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/contracts`, {
        headers: authHeaders({
          [CORRELATION_ID_HEADER]: testCorrelationId,
        }),
      });

      expect(response.status).toBe(200);
      const requestId = response.headers.get(REQUEST_ID_HEADER);
      const correlationId = response.headers.get(CORRELATION_ID_HEADER);

      expect(requestId).toBeTruthy();
      expect(correlationId).toBe(testCorrelationId);
      expect(requestId).not.toBe(correlationId);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err?: Error) => (err ? reject(err) : resolve()));
      });
    }
  });

  /**
   * Tests that invalid correlation IDs are rejected (header injection protection).
   * Only alphanumeric, hyphens, and underscores are allowed (max 128 chars).
   */
  it('should reject invalid correlation IDs with special characters', async () => {
    const app = createApp();
    const server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    const invalidCorrelationId = 'test<script>alert(1)</script>';

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/contracts`, {
        headers: authHeaders({
          [CORRELATION_ID_HEADER]: invalidCorrelationId,
        }),
      });

      expect(response.status).toBe(200);
      // Invalid correlation ID should not be echoed back
      expect(response.headers.get(CORRELATION_ID_HEADER)).toBeNull();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err?: Error) => (err ? reject(err) : resolve()));
      });
    }
  });

  /**
   * Tests that correlation IDs exceeding 128 characters are rejected.
   */
  it('should reject correlation IDs exceeding 128 characters', async () => {
    const app = createApp();
    const server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    const longCorrelationId = 'a'.repeat(129);

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/contracts`, {
        headers: authHeaders({
          [CORRELATION_ID_HEADER]: longCorrelationId,
        }),
      });

      expect(response.status).toBe(200);
      // Too-long correlation ID should not be echoed back
      expect(response.headers.get(CORRELATION_ID_HEADER)).toBeNull();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err?: Error) => (err ? reject(err) : resolve()));
      });
    }
  });
});

/**
 * @module app.integration.test
 * @description Integration tests for CORS allowlist enforcement.
 *
 * Verifies that:
 * 1. Allowlisted origins succeed with matching ACAO header.
 * 2. Disallowed origins get 403 without origin reflection.
 * 3. Missing Origin header behaves normally.
 * 4. OPTIONS preflight respects the allowlist.
 */
describe('CORS Policy', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, NODE_ENV: 'test' };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  async function withApp(
    origins: string,
    testFn: (port: number) => Promise<void>,
  ): Promise<void> {
    process.env.CORS_ALLOWED_ORIGINS = origins;
    const app = createApp();
    const server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    try {
      await testFn(port);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err?: Error) => (err ? reject(err) : resolve()));
      });
    }
  }

  it('should allow requests from allowlisted origin and echo it in ACAO', async () => {
    await withApp('http://localhost:3000', async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/contracts`, {
        headers: authHeaders({ Origin: 'http://localhost:3000' }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    });
  });

  it('should reject requests from disallowed origin without reflection', async () => {
    await withApp('https://allowed.example.com', async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/contracts`, {
        headers: authHeaders({ Origin: 'https://evil.example.com' }),
      });
      expect(response.status).toBe(403);
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
    });
  });

  it('should allow requests with no Origin header', async () => {
    await withApp('http://localhost:3000', async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/contracts`, { headers: authHeaders() });
      expect(response.status).toBe(200);
    });
  });

  it('should allow OPTIONS preflight from allowlisted origin', async () => {
    await withApp('http://localhost:3000', async (port) => {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/v1/contracts`,
        {
          method: 'OPTIONS',
          headers: authHeaders({
            Origin: 'http://localhost:3000',
            'Access-Control-Request-Method': 'GET',
          }),
        },
      );
      expect(response.status).toBe(204);
      expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    });
  });

  it('should reject OPTIONS preflight from disallowed origin', async () => {
    await withApp('https://allowed.example.com', async (port) => {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/v1/contracts`,
        {
          method: 'OPTIONS',
          headers: authHeaders({
            Origin: 'https://evil.example.com',
            'Access-Control-Request-Method': 'GET',
          }),
        },
      );
      expect(response.status).toBe(403);
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
    });
  });
});
