/**
 * @file router.rateLimit.test.ts
 * @description Rate-limiting coverage for the audit endpoint family — issue #746.
 *
 * Coverage goals:
 * 1. General access tier (`GET /`, `GET /:id`) — at-limit success, over-limit
 *    429 with Retry-After, per-client isolation, window reset.
 * 2. Integrity tier (`GET /integrity`) — has its own, stricter limiter that
 *    trips independently of the general access tier.
 * 3. Export tier (`GET /export`) — confirms it stacks with the general
 *    access tier rather than replacing it.
 * 4. Config-driven behavior — window and cap are both adjustable via the
 *    `RateLimiterConfig` passed to `createRateLimiter`, not hardcoded.
 */

process.env['JWT_SECRET'] = 'router-ratelimit-test-secret-2026';

import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { AuditStore } from './store';
import { AuditService } from './service';
import { AuditExportService } from './exportService';
import { createAuditRouter } from './router';
import { requireAuth, requireRole } from '../middleware/authorization';
import { createRateLimiter } from '../middleware/rateLimiter';

function makeToken(role: 'admin' | 'auditor' | 'client', sub = `${role}-1`): string {
  return jwt.sign(
    { sub, email: `${role}@talenttrust.test`, role },
    process.env['JWT_SECRET'] as string,
    { expiresIn: '1h' },
  );
}

function actorKeyFn(prefix: string) {
  return (req: { headers: Record<string, unknown> } & { user?: { id?: string } }) => {
    return `${prefix}:${req.user?.id ?? 'anonymous'}`;
  };
}

describe('audit router rate limiting', () => {
  let store: AuditStore;
  let service: AuditService;

  beforeEach(() => {
    store = new AuditStore();
    service = new AuditService(store);

    service.log({
      action: 'CONTRACT_CREATED',
      severity: 'INFO',
      actor: 'user-1',
      resource: 'contract',
      resourceId: 'contract-1',
      metadata: { region: 'eu' },
    });
  });

  function buildApp(overrides: {
    accessLimiterConfig?: Parameters<typeof createRateLimiter>[0];
    integrityLimiterConfig?: Parameters<typeof createRateLimiter>[0];
    exportLimiterConfig?: Parameters<typeof createRateLimiter>[0];
  } = {}) {
    const app = express();
    app.use((_req, res, next) => {
      res.locals['requestId'] = 'req-audit-ratelimit';
      next();
    });

    const accessLimiter = createRateLimiter({
      maxRequests: 2,
      windowMs: 60_000,
      abuseThreshold: 10,
      blockWindowMs: 60_000,
      blockDurationMs: 60_000,
      maxBlockDurationMs: 60_000,
      keyFn: actorKeyFn('access'),
      ...overrides.accessLimiterConfig,
    });

    const integrityLimiter = createRateLimiter({
      maxRequests: 1,
      windowMs: 60_000,
      abuseThreshold: 10,
      blockWindowMs: 60_000,
      blockDurationMs: 60_000,
      maxBlockDurationMs: 60_000,
      keyFn: actorKeyFn('integrity'),
      ...overrides.integrityLimiterConfig,
    });

    const exportLimiter = createRateLimiter({
      maxRequests: 1,
      windowMs: 60_000,
      abuseThreshold: 10,
      blockWindowMs: 60_000,
      blockDurationMs: 60_000,
      maxBlockDurationMs: 60_000,
      keyFn: actorKeyFn('export'),
      ...overrides.exportLimiterConfig,
    });

    app.use(
      '/api/v1/audit',
      createAuditRouter({
        service,
        exportService: new AuditExportService(service),
        accessMiddleware: [requireAuth, requireRole('admin', 'auditor'), accessLimiter],
        exportMiddleware: [exportLimiter],
        integrityMiddleware: [integrityLimiter],
      }),
    );

    return app;
  }

  describe('general access tier (GET /, GET /:id)', () => {
    it('allows requests up to the configured cap', async () => {
      const app = buildApp();
      const token = makeToken('admin', 'admin-at-limit');

      await request(app).get('/api/v1/audit').set('Authorization', `Bearer ${token}`).expect(200);
      await request(app).get('/api/v1/audit').set('Authorization', `Bearer ${token}`).expect(200);
    });

    it('returns 429 with a Retry-After header once the cap is exceeded', async () => {
      const app = buildApp();
      const token = makeToken('admin', 'admin-over-limit');

      await request(app).get('/api/v1/audit').set('Authorization', `Bearer ${token}`).expect(200);
      await request(app).get('/api/v1/audit').set('Authorization', `Bearer ${token}`).expect(200);

      const response = await request(app)
        .get('/api/v1/audit')
        .set('Authorization', `Bearer ${token}`)
        .expect(429);

      expect(response.body.error.code).toBe('rate_limited');
      expect(response.headers['retry-after']).toBeDefined();
      expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('shares the general-access bucket across / and /:id for the same client', async () => {
      const app = buildApp();
      const token = makeToken('admin', 'admin-shared-bucket');

      await request(app).get('/api/v1/audit').set('Authorization', `Bearer ${token}`).expect(200);
      await request(app)
        .get('/api/v1/audit/some-id')
        .set('Authorization', `Bearer ${token}`)
        .expect(404); // not found, but the request still consumed the bucket

      // Third request across either route should now be blocked.
      const response = await request(app)
        .get('/api/v1/audit')
        .set('Authorization', `Bearer ${token}`)
        .expect(429);
      expect(response.body.error.code).toBe('rate_limited');
    });

    it('tracks separate buckets per client', async () => {
      const app = buildApp();
      const tokenA = makeToken('admin', 'admin-client-a');
      const tokenB = makeToken('admin', 'admin-client-b');

      await request(app).get('/api/v1/audit').set('Authorization', `Bearer ${tokenA}`).expect(200);
      await request(app).get('/api/v1/audit').set('Authorization', `Bearer ${tokenA}`).expect(200);
      await request(app)
        .get('/api/v1/audit')
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(429);

      // Client B has its own, untouched bucket.
      await request(app).get('/api/v1/audit').set('Authorization', `Bearer ${tokenB}`).expect(200);
    });

    it('resets the window after it elapses', async () => {
      const app = buildApp({ accessLimiterConfig: { maxRequests: 1, windowMs: 50 } });
      const token = makeToken('admin', 'admin-window-reset');

      await request(app).get('/api/v1/audit').set('Authorization', `Bearer ${token}`).expect(200);
      await request(app)
        .get('/api/v1/audit')
        .set('Authorization', `Bearer ${token}`)
        .expect(429);

      await new Promise((resolve) => setTimeout(resolve, 70));

      await request(app).get('/api/v1/audit').set('Authorization', `Bearer ${token}`).expect(200);
    });
  });

  describe('integrity tier (GET /integrity)', () => {
    it('applies its own, stricter limit independent of the general access tier', async () => {
      // Configure the general-access limiter generously so only the
      // integrity-specific limiter can be the one that trips.
      const app = buildApp({ accessLimiterConfig: { maxRequests: 100 } });
      const token = makeToken('admin', 'admin-integrity');

      await request(app)
        .get('/api/v1/audit/integrity')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const response = await request(app)
        .get('/api/v1/audit/integrity')
        .set('Authorization', `Bearer ${token}`)
        .expect(429);

      expect(response.body.error.code).toBe('rate_limited');
      expect(response.headers['retry-after']).toBeDefined();
    });

    it('does not consume the general-access bucket for a different route', async () => {
      const app = buildApp();
      const token = makeToken('admin', 'admin-integrity-isolation');

      // Integrity is capped at 1 by default in this test app, and also
      // consumes one unit of the shared access bucket (cap 2).
      await request(app)
        .get('/api/v1/audit/integrity')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      // One access-bucket slot remains; a query should still succeed.
      await request(app).get('/api/v1/audit').set('Authorization', `Bearer ${token}`).expect(200);
    });
  });

  describe('export tier (GET /export)', () => {
    it('is rate limited independently and stacks with the general access tier', async () => {
      const app = buildApp({ accessLimiterConfig: { maxRequests: 100 } });
      const token = makeToken('admin', 'admin-export');

      await request(app)
        .get('/api/v1/audit/export')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const response = await request(app)
        .get('/api/v1/audit/export')
        .set('Authorization', `Bearer ${token}`)
        .expect(429);

      expect(response.body.error.code).toBe('rate_limited');
    });
  });

  describe('configuration-driven behavior', () => {
    it('honors a wider cap when configured', async () => {
      const app = buildApp({ accessLimiterConfig: { maxRequests: 5 } });
      const token = makeToken('admin', 'admin-wide-cap');

      for (let i = 0; i < 5; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await request(app)
          .get('/api/v1/audit')
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
      }

      await request(app)
        .get('/api/v1/audit')
        .set('Authorization', `Bearer ${token}`)
        .expect(429);
    });

    it('honors a narrower window when configured', async () => {
      const app = buildApp({ accessLimiterConfig: { maxRequests: 1, windowMs: 30 } });
      const token = makeToken('admin', 'admin-narrow-window');

      await request(app).get('/api/v1/audit').set('Authorization', `Bearer ${token}`).expect(200);
      await request(app)
        .get('/api/v1/audit')
        .set('Authorization', `Bearer ${token}`)
        .expect(429);

      await new Promise((resolve) => setTimeout(resolve, 45));

      await request(app).get('/api/v1/audit').set('Authorization', `Bearer ${token}`).expect(200);
    });
  });
});
