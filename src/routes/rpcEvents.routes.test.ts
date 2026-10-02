/**
 * rpcEvents.routes.test.ts — Integration tests for POST /api/v1/rpc/events.
 *
 * Uses supertest to exercise the full Express middleware stack:
 * requireAuth → body validation → BoundedPaginationService (mocked).
 *
 * Covers:
 * - 401 when no auth token
 * - 400 for missing bound
 * - 400 for invalid range
 * - 400 for over-limit page size (schema cap)
 * - 200 success with events
 * - 200 success with empty events
 * - 200 success with continuation token
 * - 400 for invalid continuation token
 * - 403 for tenant mismatch on continuation
 * - 400 for work cap exceeded
 * - 502 for provider failure
 * - Tenant isolation: tenantId always comes from JWT, never from body
 * - No internal error details leaked in error responses
 */

import request from 'supertest';
import express from 'express';
import { createRpcEventsRouter } from './rpcEvents.routes';
import { BoundedPaginationService } from '../rpc/boundedPaginationService';
import { PAGINATION_ERROR_CODES } from '../rpc/boundedPaginationService';
import { AppError } from '../errors/appError';
import { requestIdMiddleware } from '../middleware/requestId';
import jwt from 'jsonwebtoken';

// ── Helpers ───────────────────────────────────────────────────────────────────

const JWT_SECRET = 'test-secret';

function makeJwt(payload: { sub: string; email: string; role: string } = {
  sub: 'user-abc',
  email: 'test@example.com',
  role: 'client',
}): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
}

function buildApp(service?: BoundedPaginationService): express.Application {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);

  // Set JWT_SECRET for requireAuth
  process.env['JWT_SECRET'] = JWT_SECRET;

  app.use('/api/v1', createRpcEventsRouter(service));
  return app;
}

function makeService(overrides: Partial<BoundedPaginationService> = {}): BoundedPaginationService {
  const svc = {
    fetchPage: jest.fn().mockResolvedValue({
      events: [],
      nextToken: null,
      fetchedSoFar: 0,
      cappedByWorkLimit: false,
    }),
    ...overrides,
  } as unknown as BoundedPaginationService;
  return svc;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('POST /api/v1/rpc/events', () => {
  const VALID_BODY = {
    contractId: 'CABC123',
    ledgerWindow: { fromLedger: 100, toLedger: 200 },
  };

  // ── Auth ─────────────────────────────────────────────────────────────────
  describe('authentication', () => {
    it('returns 401 when Authorization header is missing', async () => {
      const app = buildApp(makeService());
      const res = await request(app)
        .post('/api/v1/rpc/events')
        .send(VALID_BODY);

      expect(res.status).toBe(401);
      // requireAuth sends its own response shape (not the ok/fail envelope)
      expect(res.body).toBeDefined();
    });

    it('returns 401 when token is invalid', async () => {
      const app = buildApp(makeService());
      const res = await request(app)
        .post('/api/v1/rpc/events')
        .set('Authorization', 'Bearer not-a-valid-jwt')
        .send(VALID_BODY);

      expect(res.status).toBe(401);
    });

    it('returns 401 when token is expired', async () => {
      const expiredToken = jwt.sign(
        { sub: 'u1', email: 'e@e.com', role: 'client' },
        JWT_SECRET,
        { expiresIn: '-1s' },
      );
      const app = buildApp(makeService());
      const res = await request(app)
        .post('/api/v1/rpc/events')
        .set('Authorization', `Bearer ${expiredToken}`)
        .send(VALID_BODY);

      expect(res.status).toBe(401);
    });
  });

  // ── Validation ────────────────────────────────────────────────────────────
  describe('request validation', () => {
    it('returns 400 when contractId is missing', async () => {
      const app = buildApp(makeService());
      const res = await request(app)
        .post('/api/v1/rpc/events')
        .set('Authorization', `Bearer ${makeJwt()}`)
        .send({ ledgerWindow: { fromLedger: 100, toLedger: 200 } });

      expect(res.status).toBe(400);
      expect(res.body.status).toBe('error');
      expect(res.body.error.code).toBe('validation_error');
    });

    it('returns 400 when neither ledgerWindow nor timeWindow is provided (missing bound)', async () => {
      const app = buildApp(makeService());
      const res = await request(app)
        .post('/api/v1/rpc/events')
        .set('Authorization', `Bearer ${makeJwt()}`)
        .send({ contractId: 'CABC123' });

      expect(res.status).toBe(400);
      expect(res.body.status).toBe('error');
    });

    it('returns 400 when ledgerWindow.toLedger < fromLedger (invalid range)', async () => {
      const svc = makeService();
      (svc.fetchPage as jest.Mock).mockRejectedValue(
        new AppError(400, PAGINATION_ERROR_CODES.INVALID_RANGE, 'toLedger must be >= fromLedger.'),
      );
      const app = buildApp(svc);
      const res = await request(app)
        .post('/api/v1/rpc/events')
        .set('Authorization', `Bearer ${makeJwt()}`)
        .send({ contractId: 'CABC123', ledgerWindow: { fromLedger: 500, toLedger: 100 } });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(PAGINATION_ERROR_CODES.INVALID_RANGE);
    });

    it('returns 400 when limit exceeds MAX_RPC_PAGE_SIZE in the schema', async () => {
      const app = buildApp(makeService());
      const res = await request(app)
        .post('/api/v1/rpc/events')
        .set('Authorization', `Bearer ${makeJwt()}`)
        .send({
          contractId: 'CABC123',
          ledgerWindow: { fromLedger: 100, toLedger: 200 },
          limit: 99_999, // far above cap
        });

      expect(res.status).toBe(400);
    });

    it('returns 400 when limit is 0', async () => {
      const app = buildApp(makeService());
      const res = await request(app)
        .post('/api/v1/rpc/events')
        .set('Authorization', `Bearer ${makeJwt()}`)
        .send({
          contractId: 'CABC123',
          ledgerWindow: { fromLedger: 100, toLedger: 200 },
          limit: 0,
        });

      expect(res.status).toBe(400);
    });
  });

  // ── Success paths ─────────────────────────────────────────────────────────
  describe('success responses', () => {
    it('returns 200 with empty events when provider returns nothing', async () => {
      const svc = makeService();
      const app = buildApp(svc);

      const res = await request(app)
        .post('/api/v1/rpc/events')
        .set('Authorization', `Bearer ${makeJwt()}`)
        .send(VALID_BODY);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.events).toHaveLength(0);
      expect(res.body.data.nextToken).toBeNull();
      expect(res.body.data.cappedByWorkLimit).toBe(false);
    });

    it('returns 200 with events when service succeeds', async () => {
      const events = [
        { ledger: 150, timestampMs: 900_000, contractId: 'CABC123', type: 'contract_event', value: {}, pagingToken: 'tok-1' },
      ];
      const svc = makeService();
      (svc.fetchPage as jest.Mock).mockResolvedValue({
        events,
        nextToken: null,
        fetchedSoFar: 1,
        cappedByWorkLimit: false,
      });
      const app = buildApp(svc);

      const res = await request(app)
        .post('/api/v1/rpc/events')
        .set('Authorization', `Bearer ${makeJwt()}`)
        .send(VALID_BODY);

      expect(res.status).toBe(200);
      expect(res.body.data.events).toHaveLength(1);
      expect(res.body.data.fetchedSoFar).toBe(1);
    });

    it('returns continuation token in response when more pages exist', async () => {
      const svc = makeService();
      (svc.fetchPage as jest.Mock).mockResolvedValue({
        events: [{ ledger: 100, timestampMs: 0, contractId: 'CABC', type: 't', value: {}, pagingToken: 'p1' }],
        nextToken: 'opaque-next-token',
        fetchedSoFar: 1,
        cappedByWorkLimit: false,
      });
      const app = buildApp(svc);

      const res = await request(app)
        .post('/api/v1/rpc/events')
        .set('Authorization', `Bearer ${makeJwt()}`)
        .send(VALID_BODY);

      expect(res.status).toBe(200);
      expect(res.body.data.nextToken).toBe('opaque-next-token');
    });

    it('includes requestId in the response envelope', async () => {
      const app = buildApp(makeService());
      const res = await request(app)
        .post('/api/v1/rpc/events')
        .set('Authorization', `Bearer ${makeJwt()}`)
        .send(VALID_BODY);

      expect(res.status).toBe(200);
      expect(typeof res.body.requestId).toBe('string');
      expect(res.body.requestId.length).toBeGreaterThan(0);
    });
  });

  // ── Continuation token handling ───────────────────────────────────────────
  describe('continuation token handling', () => {
    it('returns 400 for an invalid continuation token', async () => {
      const svc = makeService();
      (svc.fetchPage as jest.Mock).mockRejectedValue(
        new AppError(400, PAGINATION_ERROR_CODES.INVALID_TOKEN, 'Continuation token is invalid.'),
      );
      const app = buildApp(svc);

      const res = await request(app)
        .post('/api/v1/rpc/events')
        .set('Authorization', `Bearer ${makeJwt()}`)
        .send({
          contractId: 'CABC123',
          ledgerWindow: { fromLedger: 100, toLedger: 200 },
          continuationToken: 'completely-invalid-token',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(PAGINATION_ERROR_CODES.INVALID_TOKEN);
    });

    it('returns 403 when continuation token belongs to a different tenant', async () => {
      const svc = makeService();
      (svc.fetchPage as jest.Mock).mockRejectedValue(
        new AppError(403, PAGINATION_ERROR_CODES.TENANT_MISMATCH, 'Token does not belong to this tenant.'),
      );
      const app = buildApp(svc);

      const res = await request(app)
        .post('/api/v1/rpc/events')
        .set('Authorization', `Bearer ${makeJwt()}`)
        .send({
          contractId: 'CABC123',
          ledgerWindow: { fromLedger: 100, toLedger: 200 },
          continuationToken: 'another-tenants-token',
        });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe(PAGINATION_ERROR_CODES.TENANT_MISMATCH);
    });

    it('returns 400 when total work cap is exceeded via token', async () => {
      const svc = makeService();
      (svc.fetchPage as jest.Mock).mockRejectedValue(
        new AppError(400, PAGINATION_ERROR_CODES.WORK_CAP_EXCEEDED, 'Work cap reached.'),
      );
      const app = buildApp(svc);

      const res = await request(app)
        .post('/api/v1/rpc/events')
        .set('Authorization', `Bearer ${makeJwt()}`)
        .send({
          contractId: 'CABC123',
          ledgerWindow: { fromLedger: 100, toLedger: 200 },
          continuationToken: 'at-cap-token',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(PAGINATION_ERROR_CODES.WORK_CAP_EXCEEDED);
    });
  });

  // ── Tenant isolation ──────────────────────────────────────────────────────
  describe('tenant isolation', () => {
    it('always passes tenantId from the JWT sub, not from the request body', async () => {
      const svc = makeService();
      const app = buildApp(svc);
      const jwtSub = 'jwt-user-id';
      const token = makeJwt({ sub: jwtSub, email: 'u@u.com', role: 'client' });

      await request(app)
        .post('/api/v1/rpc/events')
        .set('Authorization', `Bearer ${token}`)
        .send({
          contractId: 'CABC123',
          ledgerWindow: { fromLedger: 100, toLedger: 200 },
          tenantId: 'attacker-injected-tenant', // should be ignored
        });

      const call = (svc.fetchPage as jest.Mock).mock.calls[0][0];
      expect(call.tenantId).toBe(jwtSub);
      expect(call.tenantId).not.toBe('attacker-injected-tenant');
    });

    it('uses different JWT subs for different users', async () => {
      const svc = makeService();
      const app = buildApp(svc);

      await request(app)
        .post('/api/v1/rpc/events')
        .set('Authorization', `Bearer ${makeJwt({ sub: 'tenant-X', email: 'x@x.com', role: 'client' })}`)
        .send(VALID_BODY);

      const call = (svc.fetchPage as jest.Mock).mock.calls[0][0];
      expect(call.tenantId).toBe('tenant-X');
    });
  });

  // ── Provider failures ─────────────────────────────────────────────────────
  describe('provider failure handling', () => {
    it('returns 502 for SorobanRpc transport errors', async () => {
      const svc = makeService();
      (svc.fetchPage as jest.Mock).mockRejectedValue(
        Object.assign(new Error('transport fail'), { name: 'SorobanRpcTransportError', statusCode: 502 }),
      );
      const app = buildApp(svc);

      const res = await request(app)
        .post('/api/v1/rpc/events')
        .set('Authorization', `Bearer ${makeJwt()}`)
        .send(VALID_BODY);

      expect(res.status).toBe(502);
    });

    it('returns 502 for unexpected provider errors (not AppError)', async () => {
      const svc = makeService();
      (svc.fetchPage as jest.Mock).mockRejectedValue(new Error('unexpected crash'));
      const app = buildApp(svc);

      const res = await request(app)
        .post('/api/v1/rpc/events')
        .set('Authorization', `Bearer ${makeJwt()}`)
        .send(VALID_BODY);

      expect(res.status).toBe(502);
    });

    it('does NOT expose internal error messages in error responses', async () => {
      const svc = makeService();
      (svc.fetchPage as jest.Mock).mockRejectedValue(new Error('SECRET_DB_PATH: internal crash'));
      const app = buildApp(svc);

      const res = await request(app)
        .post('/api/v1/rpc/events')
        .set('Authorization', `Bearer ${makeJwt()}`)
        .send(VALID_BODY);

      expect(res.status).toBe(502);
      expect(JSON.stringify(res.body)).not.toContain('SECRET_DB_PATH');
    });

    it('returns structured error envelope on all failures', async () => {
      const svc = makeService();
      (svc.fetchPage as jest.Mock).mockRejectedValue(new Error('crash'));
      const app = buildApp(svc);

      const res = await request(app)
        .post('/api/v1/rpc/events')
        .set('Authorization', `Bearer ${makeJwt()}`)
        .send(VALID_BODY);

      expect(res.body).toHaveProperty('status', 'error');
      expect(res.body).toHaveProperty('error');
      expect(res.body.error).toHaveProperty('code');
      expect(res.body.error).toHaveProperty('message');
      expect(res.body.error).toHaveProperty('requestId');
    });
  });

  // ── Response shape ─────────────────────────────────────────────────────────
  describe('response shape', () => {
    it('success response has status:success, data, and requestId', async () => {
      const app = buildApp(makeService());
      const res = await request(app)
        .post('/api/v1/rpc/events')
        .set('Authorization', `Bearer ${makeJwt()}`)
        .send(VALID_BODY);

      expect(res.body).toMatchObject({
        status: 'success',
        data: {
          events: expect.any(Array),
          nextToken: null,
          fetchedSoFar: expect.any(Number),
          cappedByWorkLimit: expect.any(Boolean),
        },
        requestId: expect.any(String),
      });
    });

    it('error response never includes stack traces', async () => {
      const err = new Error('boom');
      err.stack = 'Error: boom\n  at secretFile.ts:99';
      const svc = makeService();
      (svc.fetchPage as jest.Mock).mockRejectedValue(err);
      const app = buildApp(svc);

      const res = await request(app)
        .post('/api/v1/rpc/events')
        .set('Authorization', `Bearer ${makeJwt()}`)
        .send(VALID_BODY);

      expect(JSON.stringify(res.body)).not.toContain('secretFile.ts');
    });
  });
});
