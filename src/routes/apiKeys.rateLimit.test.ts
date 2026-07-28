import express, { Request } from 'express';
import request from 'supertest';
import { createRateLimiter } from '../middleware/rateLimiter';
import { RateLimitStore } from '../lib/rateLimitStore';
import { apiKeysRateLimitKey } from './apiKeys.routes';

describe('API-key endpoint rate limiting', () => {
  it('allows requests at the cap, then returns 429 with Retry-After', async () => {
    const app = express();
    const store = new RateLimitStore({ sweepIntervalMs: 0 });

    app.get(
      '/api/v1/api-keys',
      createRateLimiter({
        maxRequests: 2,
        windowMs: 60_000,
        abuseThreshold: 5,
        store,
        keyFn: apiKeysRateLimitKey,
      }),
      (_req, res) => res.status(200).json({ ok: true }),
    );

    const first = await request(app)
      .get('/api/v1/api-keys')
      .set('X-API-Key', 'client-a');
    const atLimit = await request(app)
      .get('/api/v1/api-keys')
      .set('X-API-Key', 'client-a');
    const exceeded = await request(app)
      .get('/api/v1/api-keys')
      .set('X-API-Key', 'client-a');

    expect(first.status).toBe(200);
    expect(atLimit.status).toBe(200);
    expect(atLimit.headers['x-ratelimit-remaining']).toBe('0');
    expect(exceeded.status).toBe(429);
    expect(Number(exceeded.headers['retry-after'])).toBeGreaterThan(0);
    expect(exceeded.body.error.code).toBe('rate_limited');

    store.destroy();
  });

  it('keeps API-key clients isolated from one another', async () => {
    const app = express();
    const store = new RateLimitStore({ sweepIntervalMs: 0 });
    const limiter = createRateLimiter({
      maxRequests: 1,
      windowMs: 60_000,
      store,
      keyFn: apiKeysRateLimitKey,
    });

    app.get('/api/v1/api-keys', limiter, (_req, res) => res.sendStatus(200));

    expect(
      (await request(app).get('/api/v1/api-keys').set('X-API-Key', 'client-a')).status,
    ).toBe(200);
    expect(
      (await request(app).get('/api/v1/api-keys').set('X-API-Key', 'client-a')).status,
    ).toBe(429);
    expect(
      (await request(app).get('/api/v1/api-keys').set('X-API-Key', 'client-b')).status,
    ).toBe(200);

    store.destroy();
  });

  it('falls back to an IP-scoped key when no API key is supplied', () => {
    const req = {
      headers: {},
      ip: '203.0.113.10',
      socket: {},
    } as Request;

    expect(apiKeysRateLimitKey(req)).toBe('ip:203.0.113.10');
  });
});
