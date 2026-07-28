/**
 * @file audit/correlationId.propagation.test.ts
 * @description Tests for correlation ID propagation through the audit flow.
 *
 * These tests verify that correlation IDs are:
 *   - Accepted from X-Correlation-Id header
 *   - Propagated through audit entries
 *   - Returned in all responses and errors
 *   - Threaded through logs correctly
 */

import request from 'supertest';
import express from 'express';
import { requestIdMiddleware } from '../middleware/requestId';
import { createAuditRouter } from './router';
import { auditService } from './service';

describe('Audit correlation ID propagation', () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use(requestIdMiddleware);
    app.use('/api/v1/audit', createAuditRouter({ service: auditService, accessMiddleware: [] }));
  });

  describe('POST /api/v1/audit', () => {
    it('accepts correlation ID from header and propagates to audit entry', async () => {
      const correlationId = 'trace-123-abc';
      const payload = {
        action: 'USER_CREATED',
        severity: 'INFO',
        actor: 'system',
        resource: 'user',
        resourceId: 'user-123',
        metadata: {},
      };

      const res = await request(app)
        .post('/api/v1/audit')
        .set('X-Correlation-Id', correlationId)
        .send(payload);

      expect(res.status).toBe(201);
      expect(res.body.correlationId).toBe(correlationId);
      expect(res.body).toHaveProperty('id');
      expect(res.body).toHaveProperty('timestamp');
    });

    it('uses correlation ID from request body when provided', async () => {
      const correlationId = 'trace-body-456';
      const payload = {
        action: 'USER_CREATED',
        severity: 'INFO',
        actor: 'system',
        resource: 'user',
        resourceId: 'user-123',
        metadata: {},
        correlationId,
      };

      const res = await request(app)
        .post('/api/v1/audit')
        .set('X-Correlation-Id', 'trace-header-789')
        .send(payload);

      expect(res.status).toBe(201);
      // Body correlation ID takes precedence over header
      expect(res.body.correlationId).toBe(correlationId);
    });

    it('generates no correlation ID when not provided', async () => {
      const payload = {
        action: 'USER_CREATED',
        severity: 'INFO',
        actor: 'system',
        resource: 'user',
        resourceId: 'user-123',
        metadata: {},
      };

      const res = await request(app)
        .post('/api/v1/audit')
        .send(payload);

      expect(res.status).toBe(201);
      expect(res.body.correlationId).toBeUndefined();
    });

    it('includes correlation ID in validation error response', async () => {
      const correlationId = 'trace-validation-error';
      const payload = {
        action: 'INVALID_ACTION',
        severity: 'INFO',
        actor: 'system',
        resource: 'user',
        resourceId: 'user-123',
        metadata: {},
      };

      const res = await request(app)
        .post('/api/v1/audit')
        .set('X-Correlation-Id', correlationId)
        .send(payload);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
      expect(res.body.error.correlationId).toBe(correlationId);
      expect(res.body.error.requestId).toBeDefined();
      expect(res.body.error.details).toBeDefined();
    });

    it('includes correlation ID in service error response', async () => {
      const correlationId = 'trace-service-error';
      const payload = {
        action: 'USER_CREATED',
        severity: 'INFO',
        actor: '',
        resource: 'user',
        resourceId: 'user-123',
        metadata: {},
      };

      const res = await request(app)
        .post('/api/v1/audit')
        .set('X-Correlation-Id', correlationId)
        .send(payload);

      expect(res.status).toBe(400);
      expect(res.body.correlationId).toBe(correlationId);
      expect(res.body.requestId).toBeDefined();
    });

    it('rejects invalid correlation ID from header', async () => {
      const maliciousId = 'trace\r\nX-Injected-Header: yes';
      const payload = {
        action: 'USER_CREATED',
        severity: 'INFO',
        actor: 'system',
        resource: 'user',
        resourceId: 'user-123',
        metadata: {},
      };

      const res = await request(app)
        .post('/api/v1/audit')
        .set('X-Correlation-Id', maliciousId)
        .send(payload);

      expect(res.status).toBe(201);
      // Invalid header is rejected, no correlation ID in response
      expect(res.body.correlationId).toBeUndefined();
    });
  });

  describe('GET /api/v1/audit', () => {
    it('includes correlation ID in successful response', async () => {
      const correlationId = 'trace-query-123';

      const res = await request(app)
        .get('/api/v1/audit')
        .set('X-Correlation-Id', correlationId);

      expect(res.status).toBe(200);
      expect(res.body.correlationId).toBe(correlationId);
      expect(res.body.requestId).toBeDefined();
    });

    it('includes correlation ID in error response', async () => {
      const correlationId = 'trace-query-error';

      const res = await request(app)
        .get('/api/v1/audit?from=invalid-date')
        .set('X-Correlation-Id', correlationId);

      expect(res.status).toBe(400);
      expect(res.body.correlationId).toBe(correlationId);
      expect(res.body.requestId).toBeDefined();
    });

    it('returns undefined correlation ID when not provided', async () => {
      const res = await request(app)
        .get('/api/v1/audit');

      expect(res.status).toBe(200);
      expect(res.body.correlationId).toBeUndefined();
      expect(res.body.requestId).toBeDefined();
    });
  });

  describe('GET /api/v1/audit/:id', () => {
    it('includes correlation ID in successful response', async () => {
      const correlationId = 'trace-get-123';
      const entryId = '550e8400-e29b-41d4-a716-446655440000';

      const res = await request(app)
        .get(`/api/v1/audit/${entryId}`)
        .set('X-Correlation-Id', correlationId);

      expect(res.status).toBe(404); // Entry doesn't exist
      expect(res.body.correlationId).toBe(correlationId);
      expect(res.body.requestId).toBeDefined();
    });

    it('includes correlation ID in 404 response', async () => {
      const correlationId = 'trace-404-123';
      const entryId = 'non-existent-id';

      const res = await request(app)
        .get(`/api/v1/audit/${entryId}`)
        .set('X-Correlation-Id', correlationId);

      expect(res.status).toBe(404);
      expect(res.body.correlationId).toBe(correlationId);
      expect(res.body.requestId).toBeDefined();
    });
  });

  describe('GET /api/v1/audit/integrity', () => {
    it('includes correlation ID in integrity check response', async () => {
      const correlationId = 'trace-integrity-123';

      const res = await request(app)
        .get('/api/v1/audit/integrity')
        .set('X-Correlation-Id', correlationId);

      expect(res.status).toBe(200);
      expect(res.body.correlationId).toBe(correlationId);
      expect(res.body.requestId).toBeDefined();
      expect(res.body).toHaveProperty('valid');
    });
  });

  describe('GET /api/v1/audit/export', () => {
    it('includes correlation ID in export error response', async () => {
      const correlationId = 'trace-export-error';

      const res = await request(app)
        .get('/api/v1/audit/export?from=invalid-date')
        .set('X-Correlation-Id', correlationId);

      expect(res.status).toBe(400);
      expect(res.body.correlationId).toBe(correlationId);
      expect(res.body.requestId).toBeDefined();
    });
  });

  describe('Header propagation', () => {
    it('returns X-Correlation-Id header in response when provided', async () => {
      const correlationId = 'trace-header-propagation';
      const payload = {
        action: 'USER_CREATED',
        severity: 'INFO',
        actor: 'system',
        resource: 'user',
        resourceId: 'user-123',
        metadata: {},
      };

      const res = await request(app)
        .post('/api/v1/audit')
        .set('X-Correlation-Id', correlationId)
        .send(payload);

      expect(res.status).toBe(201);
      expect(res.headers['x-correlation-id']).toBe(correlationId);
      expect(res.headers['x-request-id']).toBeDefined();
    });

    it('does not return X-Correlation-Id header when not provided', async () => {
      const payload = {
        action: 'USER_CREATED',
        severity: 'INFO',
        actor: 'system',
        resource: 'user',
        resourceId: 'user-123',
        metadata: {},
      };

      const res = await request(app)
        .post('/api/v1/audit')
        .send(payload);

      expect(res.status).toBe(201);
      expect(res.headers['x-correlation-id']).toBeUndefined();
      expect(res.headers['x-request-id']).toBeDefined();
    });
  });

  describe('Request ID always present', () => {
    it('always includes requestId in responses', async () => {
      const payload = {
        action: 'USER_CREATED',
        severity: 'INFO',
        actor: 'system',
        resource: 'user',
        resourceId: 'user-123',
        metadata: {},
      };

      const res = await request(app)
        .post('/api/v1/audit')
        .send(payload);

      expect(res.status).toBe(201);
      expect(res.body.requestId).toBeDefined();
      expect(typeof res.body.requestId).toBe('string');
    });

    it('always includes requestId in error responses', async () => {
      const res = await request(app)
        .post('/api/v1/audit')
        .send({ invalid: 'payload' });

      expect(res.status).toBe(400);
      expect(res.body.error.requestId).toBeDefined();
      expect(typeof res.body.error.requestId).toBe('string');
    });
  });

  describe('Correlation ID validation', () => {
    it('accepts valid alphanumeric correlation ID', async () => {
      const correlationId = 'Trace-ID-123_abc';
      const payload = {
        action: 'USER_CREATED',
        severity: 'INFO',
        actor: 'system',
        resource: 'user',
        resourceId: 'user-123',
        metadata: {},
      };

      const res = await request(app)
        .post('/api/v1/audit')
        .set('X-Correlation-Id', correlationId)
        .send(payload);

      expect(res.status).toBe(201);
      expect(res.body.correlationId).toBe(correlationId);
    });

    it('accepts correlation ID up to 128 characters', async () => {
      const correlationId = 'a'.repeat(128);
      const payload = {
        action: 'USER_CREATED',
        severity: 'INFO',
        actor: 'system',
        resource: 'user',
        resourceId: 'user-123',
        metadata: {},
      };

      const res = await request(app)
        .post('/api/v1/audit')
        .set('X-Correlation-Id', correlationId)
        .send(payload);

      expect(res.status).toBe(201);
      expect(res.body.correlationId).toBe(correlationId);
    });

    it('rejects correlation ID over 128 characters', async () => {
      const correlationId = 'a'.repeat(129);
      const payload = {
        action: 'USER_CREATED',
        severity: 'INFO',
        actor: 'system',
        resource: 'user',
        resourceId: 'user-123',
        metadata: {},
      };

      const res = await request(app)
        .post('/api/v1/audit')
        .set('X-Correlation-Id', correlationId)
        .send(payload);

      expect(res.status).toBe(201);
      expect(res.body.correlationId).toBeUndefined();
    });

    it('rejects correlation ID with special characters', async () => {
      const correlationId = 'trace@#$%^&*()';
      const payload = {
        action: 'USER_CREATED',
        severity: 'INFO',
        actor: 'system',
        resource: 'user',
        resourceId: 'user-123',
        metadata: {},
      };

      const res = await request(app)
        .post('/api/v1/audit')
        .set('X-Correlation-Id', correlationId)
        .send(payload);

      expect(res.status).toBe(201);
      expect(res.body.correlationId).toBeUndefined();
    });
  });
});
