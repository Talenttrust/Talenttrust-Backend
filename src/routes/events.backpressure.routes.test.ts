/**
 * @file events.backpressure.routes.test.ts
 * @description Integration tests for event-ingestion backpressure (#1207):
 * bounded admission control returns 429 when the ingestion buffer is full,
 * and GET /events/health exposes actionable signals (queue depth, oldest
 * age, rejected work, latency, admission state).
 */

import express from 'express';
import request from 'supertest';
import { createEventsRouter } from './events.routes';
import { EventAuditService, InMemoryEventAuditRepository } from '../repository/eventAuditRepository';
import { EventIngestionBackpressure } from '../events/backpressure';

function validEvent(overrides: Record<string, unknown> = {}) {
  return {
    contractId: 'contract-1',
    eventId: 'event-1',
    sequence: 1,
    timestamp: new Date().toISOString(),
    type: 'CONTRACT_CREATED',
    payload: { title: 'New contract', amount: 100 },
    ...overrides,
  };
}

function makeApp(backpressure: EventIngestionBackpressure) {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1',
    createEventsRouter(new EventAuditService(new InMemoryEventAuditRepository()), { backpressure }),
  );
  return app;
}

describe('POST /api/v1/events — bounded admission control', () => {
  it('accepts events while the queue has capacity', async () => {
    const app = makeApp(new EventIngestionBackpressure({ maxPendingEvents: 10 }));
    const res = await request(app).post('/api/v1/events').send(validEvent());
    expect(res.status).toBe(202);
    expect(res.body.data.status).toBe('accepted');
  });

  it('returns 429 with Retry-After when the ingestion queue is full', async () => {
    const backpressure = new EventIngestionBackpressure({ maxPendingEvents: 1 });
    // Pre-fill the admission buffer (simulating concurrent in-flight work).
    backpressure.tryAdmit(validEvent() as never);

    const app = makeApp(backpressure);
    const res = await request(app).post('/api/v1/events').send(validEvent({ eventId: 'event-2' }));
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('1');
    expect(res.body.error.code).toBe('ingestion_backpressure');
  });

  it('recovers once an in-flight event completes', async () => {
    const backpressure = new EventIngestionBackpressure({ maxPendingEvents: 1 });
    const app = makeApp(backpressure);

    const first = await request(app).post('/api/v1/events').send(validEvent());
    expect(first.status).toBe(202);

    // First request completed synchronously, so capacity is free again.
    const second = await request(app).post('/api/v1/events').send(validEvent({ eventId: 'event-2', sequence: 2 }));
    expect(second.status).toBe(202);
  });

  it('reports queue depth and rejected work after saturation', async () => {
    const backpressure = new EventIngestionBackpressure({ maxPendingEvents: 1 });
    backpressure.tryAdmit(validEvent() as never);
    const app = makeApp(backpressure);

    await request(app).post('/api/v1/events').send(validEvent({ eventId: 'event-2' }));
    await request(app).post('/api/v1/events').send(validEvent({ eventId: 'event-3' }));

    const health = await request(app).get('/api/v1/events/health');
    expect(health.status).toBe(503);
    expect(health.body.data).toMatchObject({
      healthy: false,
      admission: 'closed',
      queueDepth: 1,
      maxPendingEvents: 1,
      rejectedTotal: 2,
    });
    expect(health.body.data.recentRejections).toHaveLength(2);
  });
});

describe('GET /api/v1/events/health — actionable health signals', () => {
  it('is healthy with an empty queue', async () => {
    const app = makeApp(new EventIngestionBackpressure({ maxPendingEvents: 10 }));
    const res = await request(app).get('/api/v1/events/health');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      healthy: true,
      admission: 'open',
      queueDepth: 0,
      oldestEventAgeMs: 0,
      rejectedTotal: 0,
    });
  });

  it('exposes processing latency after completed events', async () => {
    const backpressure = new EventIngestionBackpressure({ maxPendingEvents: 10 });
    const app = makeApp(backpressure);
    await request(app).post('/api/v1/events').send(validEvent());

    const res = await request(app).get('/api/v1/events/health');
    expect(res.status).toBe(200);
    expect(res.body.data.latencyMs).toMatchObject({ count: 1 });
    expect(res.body.data.latencyMs.sum).toBeGreaterThanOrEqual(0);
  });
});
