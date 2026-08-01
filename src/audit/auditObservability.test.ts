import express from 'express';
import request from 'supertest';
import { Registry } from 'prom-client';
import { createAuditRouter } from './router';
import { MetricsService } from '../observability/metrics-service';
import { auditStore } from './store';

describe('Audit Router Observability Integration', () => {
  let register: Registry;
  let metricsService: MetricsService;
  let app: express.Application;

  beforeEach(() => {
    auditStore._reset();
    register = new Registry();
    metricsService = new MetricsService('test', register);

    app = express();
    app.use(express.json());
    app.use(
      '/api/v1/audit',
      createAuditRouter({
        metricsService,
      }),
    );
  });

  it('records metrics for GET /api/v1/audit (success)', async () => {
    const res = await request(app).get('/api/v1/audit');
    expect(res.status).toBe(200);

    const metricsOutput = await metricsService.getMetrics();
    expect(metricsOutput).toContain('audit_requests_total{method="GET",route="/api/v1/audit",status="success",status_code="200",error_cause="none"} 1');
    expect(metricsOutput).toContain('audit_request_duration_seconds_bucket');
  });

  it('records metrics for POST /api/v1/audit (success 201)', async () => {
    const payload = {
      action: 'USER_LOGIN',
      severity: 'INFO',
      actor: 'user-123',
      resource: 'auth',
      resourceId: 'session-456',
    };

    const res = await request(app).post('/api/v1/audit').send(payload);
    expect(res.status).toBe(201);

    const metricsOutput = await metricsService.getMetrics();
    expect(metricsOutput).toContain('audit_requests_total{method="POST",route="/api/v1/audit",status="success",status_code="201",error_cause="none"} 1');
  });

  it('records metrics for invalid audit entry POST /api/v1/audit (client_error 400)', async () => {
    const res = await request(app).post('/api/v1/audit').send({});
    expect(res.status).toBe(400);

    const metricsOutput = await metricsService.getMetrics();
    expect(metricsOutput).toContain('audit_requests_total{method="POST",route="/api/v1/audit",status="client_error",status_code="400",error_cause="bad_request"} 1');
  });

  it('records metrics for POST /api/v1/audit/bulk', async () => {
    const payload = {
      entries: [
        {
          action: 'USER_LOGIN',
          severity: 'INFO',
          actor: 'user-123',
          resource: 'auth',
          resourceId: 'session-1',
        },
      ],
    };

    const res = await request(app).post('/api/v1/audit/bulk').send(payload);
    expect(res.status).toBe(201);

    const metricsOutput = await metricsService.getMetrics();
    expect(metricsOutput).toContain('audit_requests_total{method="POST",route="/api/v1/audit/bulk",status="success",status_code="201",error_cause="none"} 1');
  });

  it('records metrics for GET /api/v1/audit/integrity', async () => {
    const res = await request(app).get('/api/v1/audit/integrity');
    expect(res.status).toBe(200);

    const metricsOutput = await metricsService.getMetrics();
    expect(metricsOutput).toContain('audit_requests_total{method="GET",route="/api/v1/audit/integrity",status="success",status_code="200",error_cause="none"} 1');
  });

  it('records metrics for GET /api/v1/audit/:id (client_error 404)', async () => {
    const res = await request(app).get('/api/v1/audit/non-existent-id');
    expect(res.status).toBe(404);

    const metricsOutput = await metricsService.getMetrics();
    expect(metricsOutput).toContain('audit_requests_total{method="GET",route="/api/v1/audit/:id",status="client_error",status_code="404",error_cause="not_found"} 1');
  });
});
