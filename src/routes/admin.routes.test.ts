/**
 * @file routes/admin.routes.test.ts
 * @description Integration coverage for the authorization boundary around
 * every route exported by `adminRouter` and mounted by `createApp()` at
 * `/api/v1/admin`.
 *
 * Protected routes exercised here:
 * - GET /api/v1/admin/queue-health
 * - GET /api/v1/admin/circuit-breakers
 * - POST /api/v1/admin/webhooks/dlq/replay-all
 * - POST /api/v1/admin/circuit-breaker/:name/reset
 *
 * Each route is tested with no token, an expired admin token, an authenticated
 * non-admin principal, and a valid admin principal. Requests go through the
 * fully assembled application so a missing or misplaced route guard fails the
 * suite instead of being hidden by an isolated router fixture.
 */

process.env.JWT_SECRET = 'test-secret';

import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createApp } from '../app';
import { circuitBreakerRegistry } from '../circuit-breaker/registry';
import { auditService } from '../audit/service';

jest.mock('../config/env.schema', () => ({
  validateEnv: jest.fn(() => ({})),
}));

jest.mock('../db/database', () => ({
  getDb: jest.fn(() => ({})),
}));

jest.mock('../db/betterSqlite3', () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock('../routes/contracts.routes', () => ({
  __esModule: true,
  default: jest.requireActual<typeof import('express')>('express').Router(),
  createContractsRouter: jest.fn(() => jest.requireActual<typeof import('express')>('express').Router()),
}));

jest.mock('../routes/events.routes', () => ({
  __esModule: true,
  default: jest.requireActual<typeof import('express')>('express').Router(),
}));

jest.mock('../routes/reputation.routes', () => ({
  __esModule: true,
  default: jest.requireActual<typeof import('express')>('express').Router(),
}));

jest.mock('../routes/config.routes', () => ({
  __esModule: true,
  default: jest.requireActual<typeof import('express')>('express').Router(),
}));

jest.mock('../routes/dependency-scan.routes', () => ({
  __esModule: true,
  default: jest.requireActual<typeof import('express')>('express').Router(),
}));

jest.mock('../routes/deploy.routes', () => ({
  deployRouter: jest.requireActual<typeof import('express')>('express').Router(),
}));

jest.mock('../queue', () => ({
  QueueManager: {
    getInstance: jest.fn(() => ({
      getHealth: jest.fn().mockResolvedValue([]),
      getRecentFailures: jest.fn().mockResolvedValue([]),
    })),
  },
}));

jest.mock('../services/webhook.service', () => ({
  WebhookService: jest.fn().mockImplementation(() => ({
    replayAll: jest.fn().mockResolvedValue({
      attempted: 2,
      succeeded: 2,
      failed: 0,
      deduped: 0,
    }),
  })),
}));

const JWT_SECRET = process.env.JWT_SECRET;

type AdminRoute = {
  method: 'get' | 'post';
  path: string;
  nonAdminToken: () => string;
};

function createToken(role: string, expiresIn: string | number = '1h'): string {
  return jwt.sign(
    { sub: 'test-user-id', email: 'test@example.com', role },
    JWT_SECRET,
    { expiresIn: expiresIn as jwt.SignOptions['expiresIn'] },
  );
}

const adminRoutes: AdminRoute[] = [
  {
    method: 'get',
    path: '/api/v1/admin/queue-health',
    nonAdminToken: () => createToken('client'),
  },
  {
    method: 'get',
    path: '/api/v1/admin/circuit-breakers',
    nonAdminToken: () => createToken('client'),
  },
  {
    method: 'post',
    path: '/api/v1/admin/webhooks/dlq/replay-all',
    nonAdminToken: () => createToken('client'),
  },
  {
    method: 'post',
    path: '/api/v1/admin/circuit-breaker/test-reset-dep/reset',
    // adminAuthGuard recognises this test principal as authenticated but
    // deliberately non-admin, allowing the integration assertion to target
    // authorization (403) rather than malformed authentication (401).
    nonAdminToken: () => 'demo-user-token',
  },
];

describe('admin route authorization guard integration', () => {
  const app = createApp();
  const adminToken = createToken('admin');
  const expiredAdminToken = createToken('admin', -1);

  function callRoute(route: AdminRoute, token?: string) {
    const test = route.method === 'get'
      ? request(app).get(route.path)
      : request(app).post(route.path).send({});

    return token ? test.set('Authorization', `Bearer ${token}`) : test;
  }

  beforeEach(() => {
    circuitBreakerRegistry.getOrCreate('test-reset-dep');
  });

  afterEach(() => {
    circuitBreakerRegistry.clear();
  });

  describe.each(adminRoutes)('$method $path', (adminRoute) => {
    it('returns 401 when credentials are missing', async () => {
      const response = await callRoute(adminRoute);

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('unauthorized');
    });

    it('returns 401 when the admin token is expired', async () => {
      const response = await callRoute(adminRoute, expiredAdminToken);

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('unauthorized');
    });

    it('returns 403 for an authenticated non-admin principal', async () => {
      const response = await callRoute(adminRoute, adminRoute.nonAdminToken());

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('forbidden');
    });

    it('allows a valid admin principal through to the handler', async () => {
      const response = await callRoute(adminRoute, adminToken);

      expect(response.status).toBe(200);
    });
  });

  describe('POST /api/v1/admin/circuit-breaker/:name/reset functionality', () => {
    let logSpy: jest.SpiedFunction<typeof auditService.log>;

    beforeEach(() => {
      logSpy = jest.spyOn(auditService, 'log').mockImplementation(() => ({} as any));
    });

    afterEach(() => {
      logSpy.mockRestore();
    });

    it('resets a tripped circuit breaker and emits audit log when called by valid admin', async () => {
      const breaker = circuitBreakerRegistry.getOrCreate('tripped-dep', { failureThreshold: 1 });
      await expect(breaker.execute(async () => { throw new Error('upstream failure'); })).rejects.toThrow();
      expect(breaker.getState()).toBe('OPEN');

      const response = await request(app)
        .post('/api/v1/admin/circuit-breaker/tripped-dep/reset')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        name: 'tripped-dep',
      });
      expect(breaker.getState()).toBe('CLOSED');
      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'ADMIN_ACTION',
          severity: 'INFO',
          actor: 'test-user-id',
          resource: 'circuit_breaker',
          resourceId: 'tripped-dep',
        })
      );
    });

    it('returns 400 with safe error response when breaker is not found', async () => {
      const response = await request(app)
        .post('/api/v1/admin/circuit-breaker/nonexistent-breaker/reset')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('bad_request');
      expect(response.body.error.message).toBe('The request could not be processed');
      expect(response.body.error).toHaveProperty('requestId');
      expect(logSpy).not.toHaveBeenCalled();
    });
  });
});
