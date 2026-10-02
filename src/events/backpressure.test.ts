/**
 * @file backpressure.test.ts
 * @description Unit tests for the event-ingestion backpressure monitor
 * (`src/events/backpressure.ts`). Covers the edge cases from issue #1207:
 * empty queue, burst traffic, queue full, metrics backend unavailable, and
 * worker restart.
 */

import { Registry } from 'prom-client';
import {
  EventIngestionBackpressure,
  initializeEventIngestionBackpressureMetrics,
  resetEventIngestionBackpressureMetrics,
} from './backpressure';
import { ContractEvent } from './types';

function makeEvent(overrides: Partial<ContractEvent> = {}): ContractEvent {
  return {
    contractId: 'contract-1',
    eventId: 'event-1',
    sequence: 1,
    timestamp: new Date().toISOString(),
    type: 'MILESTONE_RELEASED',
    payload: {},
    ...overrides,
  };
}

function makeClock(start = 10_000) {
  let now = start;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe('EventIngestionBackpressure', () => {
  afterEach(() => {
    resetEventIngestionBackpressureMetrics();
  });

  it('reports a healthy, empty queue with admission open (empty queue)', () => {
    const bp = new EventIngestionBackpressure({ maxPendingEvents: 5 });
    const health = bp.getHealth();
    expect(health.healthy).toBe(true);
    expect(health.admission).toBe('open');
    expect(health.queueDepth).toBe(0);
    expect(health.oldestEventAgeMs).toBe(0);
    expect(health.rejectedTotal).toBe(0);
    expect(health.latencyMs).toBeUndefined();
  });

  it('tracks queue depth and oldest event age under burst traffic', () => {
    const clock = makeClock();
    const bp = new EventIngestionBackpressure({ maxPendingEvents: 5, clock });

    const a = bp.tryAdmit(makeEvent({ eventId: 'a' }));
    const b = bp.tryAdmit(makeEvent({ eventId: 'b' }));
    const c = bp.tryAdmit(makeEvent({ eventId: 'c' }));
    expect(a.admitted).toBe(true);

    clock.advance(1_000);
    const health = bp.getHealth();
    expect(health.queueDepth).toBe(3);
    // Oldest admitted at t=0; now t=1000.
    expect(health.oldestEventAgeMs).toBe(1_000);
    expect(health.admission).toBe('open');

    // Two more fill the buffer to capacity.
    const d = bp.tryAdmit(makeEvent({ eventId: 'd' }));
    const e = bp.tryAdmit(makeEvent({ eventId: 'e' }));
    expect(bp.getHealth().queueDepth).toBe(5);
    expect(bp.getHealth().admission).toBe('closed');

    // Completing oldest-first frees slots and shrinks the depth.
    bp.complete(a.token!, 'accepted');
    bp.complete(b.token!, 'accepted');
    bp.complete(c.token!, 'accepted');
    bp.complete(d.token!, 'duplicate');
    bp.complete(e.token!, 'accepted');
    expect(bp.getHealth().queueDepth).toBe(0);
  });

  it('rejects admission once the queue is full (queue full)', () => {
    const bp = new EventIngestionBackpressure({ maxPendingEvents: 2 });
    bp.tryAdmit(makeEvent({ eventId: 'a' }));
    bp.tryAdmit(makeEvent({ eventId: 'b' }));

    const denied = bp.tryAdmit(makeEvent({ eventId: 'c' }));
    expect(denied.admitted).toBe(false);
    expect(denied.reason).toBe('ingestion_backpressure');

    const health = bp.getHealth();
    expect(health.healthy).toBe(false);
    expect(health.admission).toBe('closed');
    expect(health.rejectedTotal).toBe(1);
    expect(health.recentRejections[0]).toMatchObject({ eventId: 'c', reason: 'ingestion_backpressure' });
  });

  it('frees a slot after complete() so the queue recovers', () => {
    const bp = new EventIngestionBackpressure({ maxPendingEvents: 1 });
    const first = bp.tryAdmit(makeEvent({ eventId: 'a' }));
    expect(bp.tryAdmit(makeEvent({ eventId: 'b' })).admitted).toBe(false);

    bp.complete(first.token!, 'accepted');
    // Capacity is free again: a new event is admitted (depth 1 of 1).
    const second = bp.tryAdmit(makeEvent({ eventId: 'b' }));
    expect(second.admitted).toBe(true);
    expect(bp.getHealth().queueDepth).toBe(1);
  });

  it('records processing latency across completed events', () => {
    const clock = makeClock();
    const bp = new EventIngestionBackpressure({ maxPendingEvents: 5, clock });

    const a = bp.tryAdmit(makeEvent({ eventId: 'a' }));
    clock.advance(20);
    bp.complete(a.token!, 'accepted');

    const b = bp.tryAdmit(makeEvent({ eventId: 'b' }));
    clock.advance(40);
    bp.complete(b.token!, 'duplicate');

    const health = bp.getHealth();
    expect(health.latencyMs).toMatchObject({ count: 2, sum: 60 });
    expect(health.latencyMs!.p95).toBeGreaterThanOrEqual(40);
  });

  it('works without a metrics registry (metrics backend unavailable)', () => {
    // Deliberately do NOT call initializeEventIngestionBackpressureMetrics.
    const bp = new EventIngestionBackpressure({ maxPendingEvents: 2 });
    bp.tryAdmit(makeEvent({ eventId: 'a' }));
    bp.tryAdmit(makeEvent({ eventId: 'b' }));
    bp.tryAdmit(makeEvent({ eventId: 'c' })); // rejected — recorders no-op
    expect(() => bp.getHealth()).not.toThrow();
    expect(bp.getHealth().rejectedTotal).toBe(1);
  });

  it('exposes metrics when a registry is attached', async () => {
    const registry = new Registry();
    initializeEventIngestionBackpressureMetrics(registry);

    const bp = new EventIngestionBackpressure({ maxPendingEvents: 2 });
    bp.tryAdmit(makeEvent({ eventId: 'a' }));
    bp.tryAdmit(makeEvent({ eventId: 'b' }));
    bp.tryAdmit(makeEvent({ eventId: 'c' }));

    const metrics = await registry.metrics();
    expect(metrics).toContain('event_ingestion_queue_depth');
    expect(metrics).toContain('event_ingestion_oldest_event_age_ms');
    expect(metrics).toContain('event_ingestion_rejected_total');
    expect(metrics).toContain('event_ingestion_processing_latency_ms');
  });

  it('starts clean after a worker restart (fresh instance semantics)', () => {
    const first = new EventIngestionBackpressure({ maxPendingEvents: 1 });
    first.tryAdmit(makeEvent({ eventId: 'a' }));
    expect(first.getHealth().queueDepth).toBe(1);

    // Restart: a new instance carries no phantom backpressure.
    const second = new EventIngestionBackpressure({ maxPendingEvents: 1 });
    expect(second.getHealth()).toMatchObject({ queueDepth: 0, rejectedTotal: 0, healthy: true });

    // clear() gives the same clean slate without reallocation.
    first.clear();
    expect(first.getHealth().queueDepth).toBe(0);
  });

  it('complete() is idempotent for an already-completed token', () => {
    const bp = new EventIngestionBackpressure({ maxPendingEvents: 2 });
    const a = bp.tryAdmit(makeEvent({ eventId: 'a' }));
    bp.complete(a.token!, 'accepted');
    bp.complete(a.token!, 'accepted'); // no-op
    expect(bp.getHealth().queueDepth).toBe(0);
    expect(bp.getHealth().latencyMs?.count).toBe(1);
  });

  it('rejects invalid configuration', () => {
    expect(() => new EventIngestionBackpressure({ maxPendingEvents: 0 })).toThrow();
    expect(() => new EventIngestionBackpressure({ maxPendingEvents: NaN })).toThrow();
  });
});
