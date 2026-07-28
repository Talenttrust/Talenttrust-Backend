import express, { type Request, type Response } from 'express';
import request from 'supertest';
import { RateLimitStore } from '../lib/rateLimitStore';
import { createRateLimiter, type RateLimiterConfig } from './rateLimiter';

function buildApp(config: RateLimiterConfig) {
  const app = express();
  app.use('/api', createRateLimiter(config));
  app.get('/api/test', (_req: Request, res: Response) => res.json({ ok: true }));
  return app;
}

describe('createRateLimiter with unified RateLimitStore', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('preserves at-limit and over-limit behavior', async () => {
    const store = new RateLimitStore({ sweepIntervalMs: 0 });
    const app = buildApp({ maxRequests: 2, windowMs: 60_000, abuseThreshold: 99, store });

    const first = await request(app).get('/api/test').set('X-Forwarded-For', '10.0.0.1');
    const second = await request(app).get('/api/test').set('X-Forwarded-For', '10.0.0.1');
    const third = await request(app).get('/api/test').set('X-Forwarded-For', '10.0.0.1');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers['x-ratelimit-remaining']).toBe('0');
    expect(third.status).toBe(429);
    expect(third.headers['retry-after']).toBeDefined();

    store.destroy();
  });

  it('preserves the window reset boundary', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(1_000);

    const store = new RateLimitStore({ sweepIntervalMs: 0 });
    const app = buildApp({ maxRequests: 1, windowMs: 1_000, abuseThreshold: 99, store });

    const first = await request(app).get('/api/test').set('X-Forwarded-For', '10.0.0.2');
    const second = await request(app).get('/api/test').set('X-Forwarded-For', '10.0.0.2');

    jest.setSystemTime(2_000);
    const stillSameWindow = await request(app).get('/api/test').set('X-Forwarded-For', '10.0.0.2');

    jest.setSystemTime(2_001);
    const afterReset = await request(app).get('/api/test').set('X-Forwarded-For', '10.0.0.2');

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(stillSameWindow.status).toBe(429);
    expect(afterReset.status).toBe(200);

    store.destroy();
  });

  it('isolates multiple keys in the same unified store', async () => {
    const store = new RateLimitStore({ sweepIntervalMs: 0 });
    const app = buildApp({ maxRequests: 1, windowMs: 60_000, abuseThreshold: 99, store });

    await request(app).get('/api/test').set('X-Forwarded-For', '10.0.0.3');
    const blocked = await request(app).get('/api/test').set('X-Forwarded-For', '10.0.0.3');
    const otherKey = await request(app).get('/api/test').set('X-Forwarded-For', '10.0.0.4');

    expect(blocked.status).toBe(429);
    expect(otherKey.status).toBe(200);
    expect(store.size).toBe(2);

    store.destroy();
  });

  it('coordinates identical limits across middleware instances sharing the store', async () => {
    const store = new RateLimitStore({ sweepIntervalMs: 0 });
    const config = { maxRequests: 2, windowMs: 60_000, abuseThreshold: 99, store };
    const appA = buildApp(config);
    const appB = buildApp(config);

    await request(appA).get('/api/test').set('X-Forwarded-For', '10.0.0.5');
    await request(appB).get('/api/test').set('X-Forwarded-For', '10.0.0.5');
    const overLimit = await request(appA).get('/api/test').set('X-Forwarded-For', '10.0.0.5');

    expect(overLimit.status).toBe(429);

    store.destroy();
  });
});
