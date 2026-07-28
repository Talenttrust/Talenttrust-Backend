import express, { Request, Response } from 'express';
import request from 'supertest';
import { createRateLimiter } from '../middleware/rateLimiter';
import { rateLimitConfig } from '../config/rateLimit';
import { RateLimitStore } from '../lib/rateLimitStore';

function buildApp(overrides: Partial<typeof rateLimitConfig.milestones> = {}) {
  const app = express();
  app.use(express.json());
  const limiter = createRateLimiter({
    ...rateLimitConfig.milestones,
    ...overrides,
    keyFn: (req) => {
      const apiKey = req.headers['x-api-key'];
      if (apiKey) {
        const key = Array.isArray(apiKey) ? apiKey[0] : apiKey;
        return `milestones:apikey:${key}`;
      }
      const xff = req.headers['x-forwarded-for'];
      if (xff) {
        const first = Array.isArray(xff) ? xff[0] : (xff as string).split(',')[0];
        return `milestones:ip:${first.trim()}`;
      }
      return `milestones:ip:${req.ip ?? req.socket?.remoteAddress ?? 'unknown'}`;
    },
  });
  app.use('/api/v1/contracts', limiter);
  app.get('/api/v1/contracts/bounds', (_req: Request, res: Response) => res.json({ ok: true }));
  app.post('/api/v1/contracts', (_req: Request, res: Response) => res.json({ ok: true }));
  app.patch('/api/v1/contracts/:id', (_req: Request, res: Response) => res.json({ ok: true }));
  return app;
}

describe('milestones rate limiting', () => {
  describe('within limit', () => {
    it('allows requests up to the configured limit', async () => {
      const app = buildApp({ maxRequests: 5, windowMs: 60_000, abuseThreshold: 99 });
      for (let i = 0; i < 5; i++) {
        const res = await request(app)
          .get('/api/v1/contracts/bounds')
          .set('X-Forwarded-For', '10.0.0.1');
        expect(res.status).toBe(200);
      }
    });

    it('returns X-RateLimit headers on success', async () => {
      const app = buildApp({ maxRequests: 10, windowMs: 60_000, abuseThreshold: 99 });
      const res = await request(app)
        .get('/api/v1/contracts/bounds')
        .set('X-Forwarded-For', '10.0.0.2');
      expect(res.headers['x-ratelimit-limit']).toBe('10');
      expect(Number(res.headers['x-ratelimit-remaining'])).toBe(9);
      expect(Number(res.headers['x-ratelimit-reset'])).toBeGreaterThan(0);
    });
  });

  describe('limit exceeded', () => {
    it('returns 429 when the limit is exceeded', async () => {
      const app = buildApp({ maxRequests: 3, windowMs: 60_000, abuseThreshold: 99 });
      const ip = '10.0.0.3';

      for (let i = 0; i < 3; i++) {
        await request(app).get('/api/v1/contracts/bounds').set('X-Forwarded-For', ip);
      }
      const res = await request(app).get('/api/v1/contracts/bounds').set('X-Forwarded-For', ip);
      expect(res.status).toBe(429);
    });

    it('returns Retry-After header on 429', async () => {
      const app = buildApp({ maxRequests: 2, windowMs: 60_000, abuseThreshold: 99 });
      const ip = '10.0.0.4';

      await request(app).get('/api/v1/contracts/bounds').set('X-Forwarded-For', ip);
      await request(app).get('/api/v1/contracts/bounds').set('X-Forwarded-For', ip);
      const res = await request(app).get('/api/v1/contracts/bounds').set('X-Forwarded-For', ip);
      expect(res.headers['retry-after']).toBeDefined();
    });

    it('returns error JSON with expected shape on 429', async () => {
      const app = buildApp({ maxRequests: 1, windowMs: 60_000, abuseThreshold: 99 });
      const ip = '10.0.0.5';

      await request(app).get('/api/v1/contracts/bounds').set('X-Forwarded-For', ip);
      const res = await request(app).get('/api/v1/contracts/bounds').set('X-Forwarded-For', ip);
      expect(res.body).toMatchObject({
        error: {
          code: 'rate_limited',
          message: expect.any(String),
          requestId: expect.any(String),
        },
      });
    });
  });

  describe('window reset', () => {
    it('allows requests again after the window expires', async () => {
      jest.useFakeTimers();
      const store = new RateLimitStore({ sweepIntervalMs: 9_999_999 });
      const app = buildApp({
        maxRequests: 2,
        windowMs: 1_000,
        abuseThreshold: 99,
        store,
      });
      const ip = '10.0.0.6';

      for (let i = 0; i < 2; i++) {
        await request(app).get('/api/v1/contracts/bounds').set('X-Forwarded-For', ip);
      }
      let res = await request(app).get('/api/v1/contracts/bounds').set('X-Forwarded-For', ip);
      expect(res.status).toBe(429);

      jest.advanceTimersByTime(1_001);

      res = await request(app).get('/api/v1/contracts/bounds').set('X-Forwarded-For', ip);
      expect(res.status).toBe(200);

      store.destroy();
      jest.useRealTimers();
    });
  });

  describe('per-client keying', () => {
    it('uses X-API-Key header when present', async () => {
      const app = buildApp({ maxRequests: 2, windowMs: 60_000, abuseThreshold: 99 });
      const ip = '10.0.0.7';

      await request(app)
        .get('/api/v1/contracts/bounds')
        .set('X-Forwarded-For', ip)
        .set('X-API-Key', 'key-1');
      await request(app)
        .get('/api/v1/contracts/bounds')
        .set('X-Forwarded-For', ip)
        .set('X-API-Key', 'key-1');
      const res = await request(app)
        .get('/api/v1/contracts/bounds')
        .set('X-Forwarded-For', ip)
        .set('X-API-Key', 'key-1');
      expect(res.status).toBe(429);
    });

    it('isolates buckets by API key (different keys from same IP are not blocked)', async () => {
      const app = buildApp({ maxRequests: 2, windowMs: 60_000, abuseThreshold: 99 });
      const ip = '10.0.0.8';

      await request(app)
        .get('/api/v1/contracts/bounds')
        .set('X-Forwarded-For', ip)
        .set('X-API-Key', 'key-a');
      await request(app)
        .get('/api/v1/contracts/bounds')
        .set('X-Forwarded-For', ip)
        .set('X-API-Key', 'key-a');

      const res = await request(app)
        .get('/api/v1/contracts/bounds')
        .set('X-Forwarded-For', ip)
        .set('X-API-Key', 'key-b');
      expect(res.status).toBe(200);
    });
  });

  describe('all milestones HTTP methods', () => {
    it('rate-limits POST /api/v1/contracts', async () => {
      const app = buildApp({ maxRequests: 1, windowMs: 60_000, abuseThreshold: 99 });
      const ip = '10.0.0.9';

      await request(app).post('/api/v1/contracts').set('X-Forwarded-For', ip);
      const res = await request(app).post('/api/v1/contracts').set('X-Forwarded-For', ip);
      expect(res.status).toBe(429);
    });

    it('rate-limits PATCH /api/v1/contracts/:id', async () => {
      const app = buildApp({ maxRequests: 1, windowMs: 60_000, abuseThreshold: 99 });
      const ip = '10.0.0.10';

      await request(app).patch('/api/v1/contracts/123').set('X-Forwarded-For', ip);
      const res = await request(app).patch('/api/v1/contracts/123').set('X-Forwarded-For', ip);
      expect(res.status).toBe(429);
    });
  });
});
