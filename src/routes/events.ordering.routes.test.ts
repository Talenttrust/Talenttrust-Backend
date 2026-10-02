/**
 * @file events.ordering.routes.test.ts
 * @description Integration tests for per-contract ordering (#1205): events
 * for the same contract are applied in ledger order through the HTTP
 * ingestion endpoint even when delivered out of order.
 */

import express from 'express';
import request from 'supertest';
import { createEventsRouter } from './events.routes';
import { EventAuditService, InMemoryEventAuditRepository } from '../repository/eventAuditRepository';
import { PerContractEventOrdering } from '../events/ordering';

function makeApp(overrides: { holdTimeoutMs?: number } = {}) {
  const ordering = new PerContractEventOrdering({
    holdTimeoutMs: overrides.holdTimeoutMs ?? 30_000,
    maxPendingPerContract: 10,
    maxTotalPending: 50,
  });
  const service = new EventAuditService(new InMemoryEventAuditRepository(), console, undefined, ordering);
  const app = express();
  app.use(express.json());
  app.use('/api/v1', createEventsRouter(service));
  return { app, service, ordering };
}

function milestoneEvent(contractId: string, sequence: number, eventId: string) {
  return {
    contractId,
    eventId,
    sequence,
    timestamp: new Date().toISOString(),
    type: 'MILESTONE_RELEASED',
    payload: { milestoneId: `m-${sequence}`, amount: 100 },
    network: 'soroban',
    ledger: 100 + sequence,
  };
}

describe('POST /api/v1/events — per-contract ordering', () => {
  it('accepts in-order milestone events immediately', async () => {
    const { app } = makeApp();
    const first = await request(app).post('/api/v1/events').send(milestoneEvent('c-1', 1, 'e1'));
    expect(first.status).toBe(202);
    expect(first.body.data.status).toBe('accepted');

    const second = await request(app).post('/api/v1/events').send(milestoneEvent('c-1', 2, 'e2'));
    expect(second.status).toBe(202);
    expect(second.body.data.status).toBe('accepted');
  });

  it('holds an out-of-order event, then applies both once the gap fills', async () => {
    const { app } = makeApp();
    const first = await request(app).post('/api/v1/events').send(milestoneEvent('c-2', 1, 'e1'));
    expect(first.body.data.status).toBe('accepted');

    // Sequence 3 arrives before sequence 2 — held, not applied.
    const ahead = await request(app).post('/api/v1/events').send(milestoneEvent('c-2', 3, 'e3'));
    expect(ahead.status).toBe(202);
    expect(ahead.body.data.status).toBe('held');

    // Filler arrives — applied, and the held event drains behind it.
    const filler = await request(app).post('/api/v1/events').send(milestoneEvent('c-2', 2, 'e2'));
    expect(filler.status).toBe(202);
    expect(filler.body.data.status).toBe('accepted');

    const history = await request(app).get('/api/v1/contracts/c-2/history');
    const eventIds = history.body.data.map((e: { eventId: string }) => e.eventId);
    // The held event e3 was drained and applied once the gap filled; the
    // history endpoint's own ordering (createdAt desc) is incidental.
    expect([...eventIds].sort()).toEqual(['e1', 'e2', 'e3']);
  });

  it('rejects a held event whose predecessor never arrives (gap timeout)', async () => {
    const { app, service } = makeApp({ holdTimeoutMs: 1_000 });
    await request(app).post('/api/v1/events').send(milestoneEvent('c-3', 1, 'e1'));
    const held = await request(app).post('/api/v1/events').send(milestoneEvent('c-3', 3, 'e3'));
    expect(held.body.data.status).toBe('held');

    // Simulate the passage of time beyond the hold timeout.
    service.expireHeldOrderingEvents(Date.now() + 2_000);

    const ordering = await request(app).get('/api/v1/events/ordering');
    expect(ordering.body.data.enabled).not.toBe(false);
    expect(ordering.body.data.rejections[0]).toMatchObject({
      contractId: 'c-3',
      eventId: 'e3',
      code: 'ordering_gap_timeout',
    });
    expect(ordering.body.data.pending['c-3']).toBeUndefined();
  });

  it('returns duplicate for a replayed sequence', async () => {
    const { app } = makeApp();
    await request(app).post('/api/v1/events').send(milestoneEvent('c-4', 1, 'e1'));
    await request(app).post('/api/v1/events').send(milestoneEvent('c-4', 2, 'e2'));

    const replay = await request(app).post('/api/v1/events').send(milestoneEvent('c-4', 1, 'e1'));
    expect(replay.status).toBe(200);
    expect(replay.body.data.status).toBe('duplicate');
  });

  it('keeps two contracts independent under interleaved delivery', async () => {
    const { app } = makeApp();
    await request(app).post('/api/v1/events').send(milestoneEvent('c-a', 1, 'a1'));
    await request(app).post('/api/v1/events').send(milestoneEvent('c-b', 1, 'b1'));

    // Both streams run ahead of their next sequence — both held.
    const aheadA = await request(app).post('/api/v1/events').send(milestoneEvent('c-a', 3, 'a3'));
    const aheadB = await request(app).post('/api/v1/events').send(milestoneEvent('c-b', 3, 'b3'));
    expect(aheadA.body.data.status).toBe('held');
    expect(aheadB.body.data.status).toBe('held');

    // Filling A's gap must not touch B.
    await request(app).post('/api/v1/events').send(milestoneEvent('c-a', 2, 'a2'));
    const historyA = await request(app).get('/api/v1/contracts/c-a/history');
    expect(historyA.body.data.map((e: { eventId: string }) => e.eventId).sort()).toEqual(['a1', 'a2', 'a3']);
    // Filling A's gap must NOT have applied B's held event.
    const historyB = await request(app).get('/api/v1/contracts/c-b/history');
    expect(historyB.body.data.map((e: { eventId: string }) => e.eventId)).toEqual(['b1']);

    await request(app).post('/api/v1/events').send(milestoneEvent('c-b', 2, 'b2'));
    const historyB2 = await request(app).get('/api/v1/contracts/c-b/history');
    expect(historyB2.body.data.map((e: { eventId: string }) => e.eventId).sort()).toEqual(['b1', 'b2', 'b3']);
  });

  it('rejects an impossible sequence jump with 400 and a structured code', async () => {
    const { app } = makeApp();
    await request(app).post('/api/v1/events').send(milestoneEvent('c-5', 1, 'e1'));
    // maxPendingPerContract is 10; sequence 20 is an impossible jump from 2.
    const jump = await request(app).post('/api/v1/events').send(milestoneEvent('c-5', 20, 'e20'));
    expect(jump.status).toBe(400);
    expect(jump.body.error.code).toBe('ordering_gap_too_large');
  });

  it('reports an empty ordering snapshot when no events were ingested', async () => {
    const { app } = makeApp();
    const ordering = await request(app).get('/api/v1/events/ordering');
    expect(ordering.status).toBe(200);
    expect(ordering.body.data).toMatchObject({ totalPending: 0, pending: {}, highWater: {} });
  });
});
