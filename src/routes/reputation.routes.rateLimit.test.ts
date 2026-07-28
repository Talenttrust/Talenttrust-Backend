import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

const TEST_SECRET = 'reputation-rate-limit-secret';

function buildReputationApp() {
  jest.resetModules();
  process.env.JWT_SECRET = TEST_SECRET;
  process.env.RL_REPUTATION_MAX = '2';
  process.env.RL_REPUTATION_WINDOW_MS = '1000';
  process.env.RL_REPUTATION_ABUSE_THRESHOLD = '99';

  jest.doMock('../services/reputation.service', () => ({
    ReputationService: {
      getProfile: (freelancerId: string) => ({
        freelancerId,
        score: 0,
        jobsCompleted: 0,
        totalRatings: 0,
        reviews: [],
        lastUpdated: new Date(0).toISOString(),
        weightedScore: 0,
        scoreAlgorithm: 'test',
      }),
    },
  }));

  const { default: reputationRoutes } = require('./reputation.routes') as typeof import('./reputation.routes');
  const { rateLimitStore } = require('../config/rateLimit') as typeof import('../config/rateLimit');

  const app = express();
  app.use(express.json());
  app.use('/api/v1/reputation', reputationRoutes);

  return { app, store: rateLimitStore };
}

function adminToken() {
  return jwt.sign(
    { sub: 'admin-1', email: 'admin@tt.com', role: 'admin' },
    TEST_SECRET,
    { expiresIn: '1h' },
  );
}

async function getReputation(
  app: express.Application,
  client: { ip?: string; apiKey?: string } = {},
) {
  const req = request(app)
    .get('/api/v1/reputation/freelancer-rate-limit')
    .set('Authorization', `Bearer ${adminToken()}`);

  if (client.ip) {
    req.set('X-Forwarded-For', client.ip);
  }

  if (client.apiKey) {
    req.set('X-API-Key', client.apiKey);
  }

  return req;
}

describe('reputation route rate limiting', () => {
  beforeEach(() => {
    jest.useRealTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    delete process.env.RL_REPUTATION_MAX;
    delete process.env.RL_REPUTATION_WINDOW_MS;
    delete process.env.RL_REPUTATION_ABUSE_THRESHOLD;
  });

  it('allows requests up to the configured cap and rejects the next request with Retry-After', async () => {
    const { app, store } = buildReputationApp();
    try {
      const ip = '203.0.113.70';

      const first = await getReputation(app, { ip });
      const second = await getReputation(app, { ip });
      const third = await getReputation(app, { ip });

      expect(first.status).toBe(200);
      expect(first.headers['x-ratelimit-limit']).toBe('2');
      expect(first.headers['x-ratelimit-remaining']).toBe('1');

      expect(second.status).toBe(200);
      expect(second.headers['x-ratelimit-remaining']).toBe('0');

      expect(third.status).toBe(429);
      expect(third.headers['retry-after']).toBeDefined();
      expect(third.body.error.code).toBe('rate_limited');
    } finally {
      store.destroy();
    }
  });

  it('resets the reputation bucket after the configured window elapses', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(1_700_000_000_000);

    const { app, store } = buildReputationApp();
    try {
      const ip = '203.0.113.71';

      await getReputation(app, { ip });
      await getReputation(app, { ip });
      const blocked = await getReputation(app, { ip });

      expect(blocked.status).toBe(429);

      jest.setSystemTime(1_700_000_001_001);

      const afterReset = await getReputation(app, { ip });
      expect(afterReset.status).toBe(200);
      expect(afterReset.headers['x-ratelimit-remaining']).toBe('1');
    } finally {
      store.destroy();
    }
  });

  it('isolates clients by API key before falling back to IP', async () => {
    const { app, store } = buildReputationApp();
    try {
      const sharedIp = '203.0.113.72';

      await getReputation(app, { ip: sharedIp, apiKey: 'service-key-a' });
      await getReputation(app, { ip: sharedIp, apiKey: 'service-key-a' });
      const keyABlocked = await getReputation(app, { ip: sharedIp, apiKey: 'service-key-a' });

      const keyBOk = await getReputation(app, { ip: sharedIp, apiKey: 'service-key-b' });
      const ipOnlyOk = await getReputation(app, { ip: sharedIp });

      expect(keyABlocked.status).toBe(429);
      expect(keyBOk.status).toBe(200);
      expect(ipOnlyOk.status).toBe(200);
    } finally {
      store.destroy();
    }
  });
});
