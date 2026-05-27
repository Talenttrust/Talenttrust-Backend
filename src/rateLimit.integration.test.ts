/**
 * @file rateLimit.integration.test.ts
 * @description Integration tests for rate limiting on sensitive endpoints.
 *
 * Verifies:
 *   - Rate limits are enforced on /api/v1/contracts endpoints
 *   - POST /api/v1/contracts has additional strict rate limiting
 *   - Health endpoint is NOT rate-limited
 *   - Rate-limit headers are present on API responses
 *   - Abuse guard hard-blocks after repeated violations
 */

import { AddressInfo } from 'net';
import type { Server } from 'http';
import { createApp } from './app';
import { RateLimitStore } from './lib/rateLimitStore';

const SHARED_STORE = new RateLimitStore({ sweepIntervalMs: 9_999_999 });

function buildApp() {
  return { app: createApp(), store: SHARED_STORE };
}

afterAll(() => {
  SHARED_STORE.destroy();
});

describe('Rate limiting on sensitive endpoints', () => {
  describe('GET /api/v1/contracts', () => {
    it('allows requests within the rate limit', async () => {
      const { app } = buildApp();
      const server = app.listen(0);
      const { port } = server.address() as AddressInfo;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/v1/contracts`, {
          headers: { 'X-Forwarded-For': '10.1.1.1' },
        });
        expect(res.status).toBe(200);
      } finally {
        await closeServer(server);
      }
    });

    it('returns rate-limit headers on API responses', async () => {
      const { app } = buildApp();
      const server = app.listen(0);
      const { port } = server.address() as AddressInfo;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/v1/contracts`, {
          headers: { 'X-Forwarded-For': '10.2.2.2' },
        });
        expect(res.headers.get('x-ratelimit-limit')).toBeTruthy();
        expect(res.headers.get('x-ratelimit-remaining')).toBeTruthy();
        expect(res.headers.get('x-ratelimit-reset')).toBeTruthy();
      } finally {
        await closeServer(server);
      }
    });
  });

  describe('POST /api/v1/contracts (strict tier)', () => {
    it('returns 429 after exceeding strict tier rate limit', async () => {
      const { app } = buildApp();
      const server = app.listen(0);
      const { port } = server.address() as AddressInfo;
      const ip = '20.1.1.1';
      try {
        let blocked = false;
        for (let i = 0; i < 200; i++) {
          const res = await fetch(`http://127.0.0.1:${port}/api/v1/contracts`, {
            method: 'POST',
            headers: {
              'X-Forwarded-For': ip,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({}),
          });
          if (res.status === 429) {
            blocked = true;
            break;
          }
        }
        expect(blocked).toBe(true);
      } finally {
        await closeServer(server);
      }
    });

    it('includes Retry-After in 429 response', async () => {
      const { app } = buildApp();
      const server = app.listen(0);
      const { port } = server.address() as AddressInfo;
      const ip = '20.2.2.2';
      try {
        let found429 = false;
        for (let i = 0; i < 200; i++) {
          const res = await fetch(`http://127.0.0.1:${port}/api/v1/contracts`, {
            method: 'POST',
            headers: {
              'X-Forwarded-For': ip,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({}),
          });
          if (res.status === 429) {
            expect(res.headers.get('retry-after')).toBeTruthy();
            found429 = true;
            break;
          }
        }
        expect(found429).toBe(true);
      } finally {
        await closeServer(server);
      }
    });
  });

  describe('Health endpoint', () => {
    it('does not apply rate limiting to /health', async () => {
      const { app } = buildApp();
      const server = app.listen(0);
      const { port } = server.address() as AddressInfo;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        expect(res.status).toBe(200);
        expect(res.headers.get('x-ratelimit-limit')).toBeNull();
      } finally {
        await closeServer(server);
      }
    });
  });

  describe('Abuse guard (hard-block)', () => {
    it('hard-blocks IP after repeated rate-limit violations', async () => {
      const testStore = new RateLimitStore({ sweepIntervalMs: 9_999_999 });
      const { createRateLimiter } = await import('./middleware/rateLimiter');
      const testLimiter = createRateLimiter({
        maxRequests: 1,
        windowMs: 60_000,
        abuseThreshold: 3,
        blockDurationMs: 60_000,
        store: testStore,
      });

      const express = await import('express');
      const app = express.default();
      app.use(express.default.json());
      app.post('/test', testLimiter, (_req, res) => res.json({ ok: true }));

      const server = app.listen(0);
      const { port } = server.address() as AddressInfo;
      const ip = '30.1.1.1';

      try {
        let blocked = false;
        for (let i = 0; i < 100; i++) {
          const res = await fetch(`http://127.0.0.1:${port}/test`, {
            method: 'POST',
            headers: {
              'X-Forwarded-For': ip,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({}),
          });
          if (res.headers.get('x-ratelimit-blocked') === 'true') {
            expect(res.status).toBe(429);
            expect(res.headers.get('retry-after')).toBeTruthy();
            blocked = true;
            break;
          }
        }
        expect(blocked).toBe(true);
      } finally {
        await closeServer(server);
        testStore.destroy();
      }
    });
  });
});

async function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((err?: Error) => (err ? reject(err) : resolve()));
  });
}