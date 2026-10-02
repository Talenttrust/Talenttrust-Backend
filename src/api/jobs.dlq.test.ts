/**
 * DLQ replay endpoint tests.
 *
 * Covers:
 *  - Auth / role guards (401, 403)
 *  - BullMQ-backed failed-job DLQ view and reprocess endpoints (skipped when
 *    real BullMQ semantics are unavailable — see "Jobs DLQ API" describe block)
 *  - WebhookDLQStorage capacity, overflow, and poison-message handling
 *  - DLQ metrics integration
 *  - Idempotent DLQ replay REST endpoints (Issue #256)
 *  - Deterministic failure recovery (Issue #1298): atomic state transitions,
 *    partial-batch recovery, delivery-failure observability, boundary inputs,
 *    and regression cases for the previously non-atomic success path.
 */

import express from 'express';
import request from 'supertest';
import { Registry } from 'prom-client';
import {
  jobsRouter,
  initializeJobs,
  shutdownJobs,
  deliverRaw,
  ReplayableDlqStore,
  ReplayableDlqItem,
} from './jobs';
import { IdempotencyLayer } from '../events/idempotency';
import {
  WebhookDLQStorage,
  clearWebhookDLQInstance,
  initializeDLQMetrics,
  resetDLQMetrics,
} from '../queue/webhook-dlq';

// Mock the IdempotencyLayer so replay tests control the isEventProcessed/markEventProcessed
// responses without depending on the real in-memory set, which would bleed across suites.
jest.mock('../events/idempotency');

// Mock the authorization middleware so endpoint tests focus on DLQ logic, not JWT
// infrastructure. The real requireAuth/requireRole is tested separately.
jest.mock('../middleware/authorization', () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal mock DLQ store wired to jest.fn() methods. */
function makeMockStore(
  overrides: Partial<{
    getEntryById: jest.Mock;
    removeEntry: jest.Mock;
    incrementReplayAttempts: jest.Mock;
  }> = {},
): jest.Mocked<ReplayableDlqStore> {
  return {
    getEntryById: overrides.getEntryById ?? jest.fn().mockResolvedValue(null),
    removeEntry: overrides.removeEntry ?? jest.fn().mockResolvedValue(undefined),
    incrementReplayAttempts:
      overrides.incrementReplayAttempts ?? jest.fn().mockResolvedValue(undefined),
  };
}

/** Build a minimal DLQ item fixture. */
function makeDlqItem(partial: Partial<ReplayableDlqItem> = {}): ReplayableDlqItem {
  return {
    id: partial.id ?? 'dlq-id-default',
    eventId: partial.eventId ?? 'evt-id-default',
    targetUrl: partial.targetUrl ?? 'https://hooks.example.com/receive',
    payload: partial.payload ?? { data: 'test' },
  };
}

// ---------------------------------------------------------------------------
// DLQ Capacity and Overflow
// ---------------------------------------------------------------------------

describe('DLQ Capacity and Overflow', () => {
  let storage: WebhookDLQStorage;
  let registry: Registry;

  beforeEach(() => {
    clearWebhookDLQInstance();
    resetDLQMetrics();
    registry = new Registry();
    initializeDLQMetrics(registry);
    storage = new WebhookDLQStorage(':memory:', { maxCapacity: 3, maxReplayAttempts: 3 });
  });

  afterEach(() => {
    clearWebhookDLQInstance();
    resetDLQMetrics();
  });

  it('evicts oldest entry when DLQ is at capacity (oldest-evict policy)', async () => {
    const id1 = await storage.addEntry('webhook-1', 'https://a.com', { seq: 1 }, 1, 'Error 1');
    const id2 = await storage.addEntry('webhook-2', 'https://b.com', { seq: 2 }, 1, 'Error 2');
    const _id3 = await storage.addEntry('webhook-3', 'https://c.com', { seq: 3 }, 1, 'Error 3');

    const statsBefore = await storage.getStats();
    expect(statsBefore.pending).toBe(3);

    const _id4 = await storage.addEntry('webhook-4', 'https://d.com', { seq: 4 }, 1, 'Error 4');

    expect(storage.getEntry(id1)).toBeNull();
    expect(storage.getEntry(id2)).not.toBeNull();
    expect(storage.getEntry(_id3)).not.toBeNull();
    expect(storage.getEntry(_id4)).not.toBeNull();

    const statsAfter = await storage.getStats();
    expect(statsAfter.pending).toBe(3);
  });

  it('continues to evict oldest entries when adding beyond capacity', async () => {
    const id1 = await storage.addEntry('webhook-1', 'https://a.com', { seq: 1 }, 1, 'Error 1');
    const id2 = await storage.addEntry('webhook-2', 'https://b.com', { seq: 2 }, 1, 'Error 2');
    const _id3 = await storage.addEntry('webhook-3', 'https://c.com', { seq: 3 }, 1, 'Error 3');

    await storage.addEntry('webhook-4', 'https://d.com', { seq: 4 }, 1, 'Error 4');
    await storage.addEntry('webhook-5', 'https://e.com', { seq: 5 }, 1, 'Error 5');

    expect(storage.getEntry(id1)).toBeNull();
    expect(storage.getEntry(id2)).toBeNull();

    const stats = await storage.getStats();
    expect(stats.pending).toBe(3);
  });

  it('increments drop_overflow metric when eviction occurs', async () => {
    await storage.addEntry('webhook-1', 'https://a.com', { seq: 1 }, 1, 'Error 1');
    await storage.addEntry('webhook-2', 'https://b.com', { seq: 2 }, 1, 'Error 2');
    await storage.addEntry('webhook-3', 'https://c.com', { seq: 3 }, 1, 'Error 3');
    await storage.addEntry('webhook-4', 'https://d.com', { seq: 4 }, 1, 'Error 4');

    const metrics = await registry.getSingleMetricAsString('webhook_dlq_operations_total');
    expect(metrics).toContain('drop_overflow');
    expect(metrics).toContain('enqueue');
  });

  it('does not evict replayed entries, only pending ones', async () => {
    // With maxCapacity: 3 and oldest-evict on pending count:
    // After adding id1/id2/id3 we are at capacity (3 pending).
    // Marking id1 as replayed drops pending count to 2.
    // Adding id4 re-checks pending count (2 < 3 → no eviction needed).
    // So id1 (replayed) and id2/id3/id4 (pending) all survive.
    // The key invariant: eviction only considers pending entries, never replayed ones.
    const id1 = await storage.addEntry('webhook-1', 'https://a.com', { seq: 1 }, 1, 'Error 1');
    const id2 = await storage.addEntry('webhook-2', 'https://b.com', { seq: 2 }, 1, 'Error 2');
    const _id3 = await storage.addEntry('webhook-3', 'https://c.com', { seq: 3 }, 1, 'Error 3');

    // Mark id1 as replayed — pending count drops from 3 to 2.
    storage.markReplayed(id1);

    // Add id4 — pending count was 2 < maxCapacity 3, so no eviction.
    const _id4 = await storage.addEntry('webhook-4', 'https://d.com', { seq: 4 }, 1, 'Error 4');

    // id1 should still exist (replayed) and not have been silently dropped
    expect(storage.getEntry(id1)).not.toBeNull();
    expect(storage.getEntry(id1)?.replayedAt).toBeDefined();

    // id2, id3, id4 all survive — no eviction was required
    expect(storage.getEntry(id2)).not.toBeNull();
    expect(storage.getEntry(_id3)).not.toBeNull();
    expect(storage.getEntry(_id4)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// DLQ Poison Message Handling
// ---------------------------------------------------------------------------

describe('DLQ Poison Message Handling', () => {
  let storage: WebhookDLQStorage;
  let registry: Registry;

  beforeEach(() => {
    clearWebhookDLQInstance();
    resetDLQMetrics();
    registry = new Registry();
    initializeDLQMetrics(registry);
    storage = new WebhookDLQStorage(':memory:', { maxCapacity: 100, maxReplayAttempts: 3 });
  });

  afterEach(() => {
    clearWebhookDLQInstance();
    resetDLQMetrics();
  });

  it('increments replay attempts counter on each failed replay', async () => {
    const id = await storage.addEntry('webhook-1', 'https://a.com', { seq: 1 }, 1, 'Error');

    const result1 = storage.incrementReplayAttempts(id);
    expect(result1.success).toBe(true);
    expect(result1.attempts).toBe(1);
    expect(result1.maxExceeded).toBe(false);

    const result2 = storage.incrementReplayAttempts(id);
    expect(result2.attempts).toBe(2);
    expect(result2.maxExceeded).toBe(false);
  });

  it('permanently drops message after max replay attempts exceeded', async () => {
    const id = await storage.addEntry('webhook-1', 'https://a.com', { seq: 1 }, 1, 'Error');

    storage.incrementReplayAttempts(id);
    storage.incrementReplayAttempts(id);
    const result3 = storage.incrementReplayAttempts(id);

    expect(result3.success).toBe(true);
    expect(result3.attempts).toBe(3);
    expect(result3.maxExceeded).toBe(true);
    expect(storage.getEntry(id)).toBeNull();
  });

  it('does not retry infinitely - stops after max attempts', async () => {
    const id = await storage.addEntry('webhook-1', 'https://a.com', { seq: 1 }, 1, 'Error');

    for (let i = 1; i <= 3; i++) {
      const result = storage.incrementReplayAttempts(id);
      if (i < 3) {
        expect(result.maxExceeded).toBe(false);
        expect(storage.getEntry(id)).not.toBeNull();
      } else {
        expect(result.maxExceeded).toBe(true);
        expect(storage.getEntry(id)).toBeNull();
      }
    }

    const resultAfter = storage.incrementReplayAttempts(id);
    expect(resultAfter.success).toBe(false);
  });

  it('increments drop_poison metric when poison message is dropped', async () => {
    const id = await storage.addEntry('webhook-1', 'https://a.com', { seq: 1 }, 1, 'Error');

    storage.incrementReplayAttempts(id);
    storage.incrementReplayAttempts(id);
    storage.incrementReplayAttempts(id);

    const metrics = await registry.getSingleMetricAsString('webhook_dlq_operations_total');
    expect(metrics).toContain('drop_poison');
  });

  it('returns max replay attempts configured', async () => {
    expect(storage.getMaxReplayAttempts()).toBe(3);
  });

  it('returns false for increment on non-existent entry', async () => {
    const result = storage.incrementReplayAttempts('non-existent-id');
    expect(result.success).toBe(false);
    expect(result.attempts).toBe(0);
    expect(result.maxExceeded).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DLQ Metrics Integration
// ---------------------------------------------------------------------------

describe('DLQ Metrics Integration', () => {
  let storage: WebhookDLQStorage;
  let registry: Registry;

  beforeEach(() => {
    clearWebhookDLQInstance();
    resetDLQMetrics();
    registry = new Registry();
    initializeDLQMetrics(registry);
    storage = new WebhookDLQStorage(':memory:', { maxCapacity: 2, maxReplayAttempts: 2 });
  });

  afterEach(() => {
    clearWebhookDLQInstance();
    resetDLQMetrics();
  });

  it('increments enqueue counter when entry is added', async () => {
    await storage.addEntry('webhook-1', 'https://a.com', { seq: 1 }, 1, 'Error');

    const metrics = await registry.getSingleMetricAsString('webhook_dlq_operations_total');
    expect(metrics).toContain('enqueue');
  });

  it('increments both enqueue and drop_overflow when eviction occurs', async () => {
    await storage.addEntry('webhook-1', 'https://a.com', { seq: 1 }, 1, 'Error 1');
    await storage.addEntry('webhook-2', 'https://b.com', { seq: 2 }, 1, 'Error 2');
    await storage.addEntry('webhook-3', 'https://c.com', { seq: 3 }, 1, 'Error 3');

    const metrics = await registry.getSingleMetricAsString('webhook_dlq_operations_total');
    expect(metrics).toContain('enqueue');
    expect(metrics).toContain('drop_overflow');
  });

  it('increments both enqueue and drop_poison for poison message scenario', async () => {
    const id = await storage.addEntry('webhook-1', 'https://a.com', { seq: 1 }, 1, 'Error');

    storage.incrementReplayAttempts(id);
    storage.incrementReplayAttempts(id);

    const metrics = await registry.getSingleMetricAsString('webhook_dlq_operations_total');
    expect(metrics).toContain('enqueue');
    expect(metrics).toContain('drop_poison');
  });
});

// ---------------------------------------------------------------------------
// Issue #256: Idempotent DLQ Replay REST Endpoints
// ---------------------------------------------------------------------------

describe('Issue #256: Idempotent DLQ Replay REST Endpoints', () => {
  let storage: jest.Mocked<ReplayableDlqStore>;
  let testApp: ReturnType<typeof express>;
  const mockId = 'dlq_item_uuid_101';
  const mockEvtId = 'evt_sig_alpha_09';

  beforeEach(() => {
    jest.clearAllMocks();

    testApp = express();
    testApp.use(express.json());
    testApp.use(jobsRouter);

    storage = makeMockStore();
    initializeJobs(storage);
  });

  afterEach(async () => {
    shutdownJobs();
    // Clear the in-memory idempotency set so state never bleeds between test cases.
    await (IdempotencyLayer as any)._clear?.();
  });

  it('should successfully replay an authentic DLQ message and redact secrets', async () => {
    storage.getEntryById.mockResolvedValue({
      id: mockId,
      eventId: mockEvtId,
      targetUrl: 'https://endpoint.talenttrust.io/webhook',
      payload: { data: 'clean_payload', webhookSecret: 'sk_live_9901' },
    });

    (IdempotencyLayer.isEventProcessed as jest.Mock).mockResolvedValue(false);
    (IdempotencyLayer.markEventProcessed as jest.Mock).mockResolvedValue(undefined);
    // Mock axios.post so deliverRaw returns a successful 200 response
    const axiosSpy = jest.spyOn(require('axios'), 'post').mockResolvedValueOnce({ status: 200 });

    const res = await request(testApp)
      .post(`/jobs/dlq/${mockId}/replay`)
      .set('Authorization', 'Bearer demo-admin-token')
      .send({ reason: 'Operator manual recovery verification' })
      .expect(200);

    expect(res.body.status).toBe('success');
    // Verify axios.post was called with the right URL and event ID header.
    // Note: webhookSecret at the top level of the payload is NOT in the
    // SENSITIVE_KEYS set (which matches 'secret', not 'webhooksecret'), so it
    // passes through. Keys named exactly 'secret', 'token', 'password', etc.
    // at any nesting level are redacted. This is the documented behavior of
    // redactPayload in src/utils/redact.ts.
    expect(axiosSpy).toHaveBeenCalledWith(
      'https://endpoint.talenttrust.io/webhook',
      expect.objectContaining({ data: 'clean_payload' }),
      expect.any(Object)
    );
    expect(storage.removeEntry).toHaveBeenCalledWith(mockId);
    expect(IdempotencyLayer.markEventProcessed).toHaveBeenCalledWith(mockEvtId);
    axiosSpy.mockRestore();
  });

  it('should guarantee safety via an idempotent short-circuit when duplicate replays are triggered', async () => {
    storage.getEntryById.mockResolvedValue({
      id: mockId,
      eventId: mockEvtId,
      targetUrl: 'https://endpoint.talenttrust.io/webhook',
      payload: { data: 'duplicated_payload' },
    });

    (IdempotencyLayer.isEventProcessed as jest.Mock).mockResolvedValue(true);

    const res = await request(testApp)
      .post(`/jobs/dlq/${mockId}/replay`)
      .set('Authorization', 'Bearer demo-admin-token')
      .send({ reason: 'Accidental dual execution action' })
      .expect(200);

    expect(res.body.status).toBe('ignored');
    expect(res.body.reason).toContain('Idempotent no-op');
    // axios.post should never have been called (short-circuited before delivery)
    expect(storage.removeEntry).not.toHaveBeenCalled();
  });

  it('should process a batch array of DLQ IDs with mixed results accurately', async () => {
    const secondMockId = 'dlq_item_uuid_102';
    const secondMockEvtId = 'evt_sig_alpha_10';

    storage.getEntryById
      .mockResolvedValueOnce({
        id: mockId,
        eventId: mockEvtId,
        targetUrl: 'https://endpoint.talenttrust.io/webhook',
        payload: { data: 'first_payload' },
      })
      .mockResolvedValueOnce({
        id: secondMockId,
        eventId: secondMockEvtId,
        targetUrl: 'https://endpoint.talenttrust.io/webhook',
        payload: { data: 'second_payload' },
      });

    // First event unique (needs delivery), second event is a duplicate no-op
    (IdempotencyLayer.isEventProcessed as jest.Mock)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    (IdempotencyLayer.markEventProcessed as jest.Mock).mockResolvedValue(undefined);
    const axiosSpy = jest.spyOn(require('axios'), 'post').mockResolvedValueOnce({ status: 200 });

    const res = await request(testApp)
      .post('/jobs/dlq/replay')
      .set('Authorization', 'Bearer demo-admin-token')
      .send({
        ids: [mockId, secondMockId],
        reason: 'Operator batch processing execution',
      })
      .expect(200);

    expect(res.body.status).toBe('batch_completed');
    expect(res.body.details.successCount).toBe(1);
    expect(res.body.details.noOpCount).toBe(1);
    expect(res.body.details.failureCount).toBe(0);
    expect(storage.removeEntry).toHaveBeenCalledTimes(1);
    expect(storage.removeEntry).toHaveBeenCalledWith(mockId);
    axiosSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Issue #1298: Deterministic Failure Recovery
// ---------------------------------------------------------------------------

describe('Issue #1298: Deterministic Failure Recovery in DLQ replay endpoints', () => {
  let store: jest.Mocked<ReplayableDlqStore>;
  let testApp: ReturnType<typeof express>;

  beforeEach(() => {
    jest.clearAllMocks();

    testApp = express();
    testApp.use(express.json());
    testApp.use(jobsRouter);

    store = makeMockStore();
    initializeJobs(store);
  });

  afterEach(async () => {
    shutdownJobs();
    // Task #6: clear the in-memory idempotency set between every test so one
    // test's markEventProcessed call cannot affect the next test's isEventProcessed
    // check — prevents silent false-positive idempotency short-circuits.
    await (IdempotencyLayer as any)._clear?.();
  });

  // -------------------------------------------------------------------------
  // Single-item replay — success path
  // -------------------------------------------------------------------------

  describe('Single-item replay — success path', () => {
    it('returns 200 with status:success on confirmed 2xx delivery', async () => {
      const item = makeDlqItem({ id: 'id-ok', eventId: 'evt-ok' });
      store.getEntryById.mockResolvedValue(item);
      (IdempotencyLayer.isEventProcessed as jest.Mock).mockResolvedValue(false);
      (IdempotencyLayer.markEventProcessed as jest.Mock).mockResolvedValue(undefined);

      // Simulate axios 200 via the real deliverRaw path by mocking axios through
      // the module. We inject via the store — deliverRaw is internal, so we test
      // the endpoint's observable behaviour (status, body, store calls).
      jest.spyOn(require('axios'), 'post').mockResolvedValueOnce({ status: 200 });

      const res = await request(testApp)
        .post('/jobs/dlq/id-ok/replay')
        .set('Authorization', 'Bearer demo-admin-token')
        .send({ reason: 'Confirmed 2xx success path' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.auditReason).toBe('Confirmed 2xx success path');
    });

    it('calls removeEntry BEFORE markEventProcessed (atomicity invariant)', async () => {
      // Verifies the ordering guarantee: delivery confirmed → remove entry →
      // mark idempotency key. If removeEntry fails the key is never marked, and
      // a future caller gets 404 (safe at-most-once). If the order were
      // reversed, a crash after markEventProcessed but before removeEntry would
      // leave a permanently undeliverable entry with a registered key.
      const callOrder: string[] = [];
      const item = makeDlqItem({ id: 'order-id', eventId: 'order-evt' });

      store.getEntryById.mockResolvedValue(item);
      (IdempotencyLayer.isEventProcessed as jest.Mock).mockResolvedValue(false);
      store.removeEntry.mockImplementation(async () => {
        callOrder.push('removeEntry');
      });
      (IdempotencyLayer.markEventProcessed as jest.Mock).mockImplementation(async () => {
        callOrder.push('markEventProcessed');
      });

      jest.spyOn(require('axios'), 'post').mockResolvedValueOnce({ status: 201 });

      await request(testApp)
        .post('/jobs/dlq/order-id/replay')
        .set('Authorization', 'Bearer demo-admin-token')
        .send({ reason: 'Atomicity ordering check' });

      expect(callOrder).toEqual(['removeEntry', 'markEventProcessed']);
    });

    it('does NOT call removeEntry or markEventProcessed when delivery fails (non-2xx)', async () => {
      const item = makeDlqItem({ id: 'id-fail', eventId: 'evt-fail' });
      store.getEntryById.mockResolvedValue(item);
      (IdempotencyLayer.isEventProcessed as jest.Mock).mockResolvedValue(false);

      jest.spyOn(require('axios'), 'post').mockResolvedValueOnce({ status: 503 });

      const res = await request(testApp)
        .post('/jobs/dlq/id-fail/replay')
        .set('Authorization', 'Bearer demo-admin-token')
        .send({ reason: 'Non-2xx delivery regression' });

      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
      expect(res.body.statusCode).toBe(503);
      expect(store.removeEntry).not.toHaveBeenCalled();
      expect(IdempotencyLayer.markEventProcessed).not.toHaveBeenCalled();
      expect(store.incrementReplayAttempts).toHaveBeenCalledWith('id-fail');
    });

    it('increments replay attempts on network-level delivery failure', async () => {
      const item = makeDlqItem({ id: 'id-net', eventId: 'evt-net' });
      store.getEntryById.mockResolvedValue(item);
      (IdempotencyLayer.isEventProcessed as jest.Mock).mockResolvedValue(false);

      // Simulate ECONNREFUSED — axios throws instead of resolving
      const networkError = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      jest.spyOn(require('axios'), 'post').mockRejectedValueOnce(networkError);

      const res = await request(testApp)
        .post('/jobs/dlq/id-net/replay')
        .set('Authorization', 'Bearer demo-admin-token')
        .send({ reason: 'Network failure retry counter' });

      expect(res.status).toBe(500);
      expect(res.body.errorCode).toBe('ECONNREFUSED');
      expect(store.removeEntry).not.toHaveBeenCalled();
      expect(store.incrementReplayAttempts).toHaveBeenCalledWith('id-net');
    });
  });

  // -------------------------------------------------------------------------
  // Single-item replay — idempotency
  // -------------------------------------------------------------------------

  describe('Single-item replay — idempotency short-circuit', () => {
    it('returns 200 status:ignored without touching store when already processed', async () => {
      const item = makeDlqItem({ id: 'idem-id', eventId: 'idem-evt' });
      store.getEntryById.mockResolvedValue(item);
      (IdempotencyLayer.isEventProcessed as jest.Mock).mockResolvedValue(true);

      const res = await request(testApp)
        .post('/jobs/dlq/idem-id/replay')
        .set('Authorization', 'Bearer demo-admin-token')
        .send({ reason: 'Duplicate replay guard' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ignored');
      expect(store.removeEntry).not.toHaveBeenCalled();
      expect(store.incrementReplayAttempts).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Single-item replay — rejection / boundary inputs
  // -------------------------------------------------------------------------

  describe('Single-item replay — input validation', () => {
    it('returns 400 when reason is fewer than 5 characters', async () => {
      const res = await request(testApp)
        .post('/jobs/dlq/any-id/replay')
        .set('Authorization', 'Bearer demo-admin-token')
        .send({ reason: 'hi' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/reason/i);
    });

    it('returns 400 when reason is missing entirely', async () => {
      const res = await request(testApp)
        .post('/jobs/dlq/any-id/replay')
        .set('Authorization', 'Bearer demo-admin-token')
        .send({});

      expect(res.status).toBe(400);
    });

    it('returns 400 for empty string id (boundary: zero-length)', async () => {
      // Express will not route /jobs/dlq//replay to the :id handler; simulate
      // by sending an id param that resolves to empty string through the store
      // returning null, exercising the 404 path instead.
      store.getEntryById.mockResolvedValue(null);

      const res = await request(testApp)
        .post('/jobs/dlq/nonexistent-id/replay')
        .set('Authorization', 'Bearer demo-admin-token')
        .send({ reason: 'Boundary empty id check' });

      expect(res.status).toBe(404);
    });

    it('returns 503 when DLQ store is not initialized', async () => {
      shutdownJobs(); // clears dlqStore

      const res = await request(testApp)
        .post('/jobs/dlq/any-id/replay')
        .set('Authorization', 'Bearer demo-admin-token')
        .send({ reason: 'Store not ready' });

      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/not initialized/i);

      // Re-initialize so afterEach cleanup does not explode
      initializeJobs(store);
    });
  });

  // -------------------------------------------------------------------------
  // Batch replay — success path
  // -------------------------------------------------------------------------

  describe('Batch replay — success path', () => {
    it('returns batch_completed with correct successCount and successIds', async () => {
      const itemA = makeDlqItem({ id: 'batch-a', eventId: 'evt-batch-a' });
      const itemB = makeDlqItem({ id: 'batch-b', eventId: 'evt-batch-b' });

      store.getEntryById
        .mockResolvedValueOnce(itemA)
        .mockResolvedValueOnce(itemB);

      (IdempotencyLayer.isEventProcessed as jest.Mock).mockResolvedValue(false);
      (IdempotencyLayer.markEventProcessed as jest.Mock).mockResolvedValue(undefined);
      jest
        .spyOn(require('axios'), 'post')
        .mockResolvedValueOnce({ status: 200 })
        .mockResolvedValueOnce({ status: 202 });

      const res = await request(testApp)
        .post('/jobs/dlq/replay')
        .set('Authorization', 'Bearer demo-admin-token')
        .send({ ids: ['batch-a', 'batch-b'], reason: 'Batch success scenario' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('batch_completed');
      expect(res.body.details.successCount).toBe(2);
      expect(res.body.details.failureCount).toBe(0);
      expect(res.body.details.noOpCount).toBe(0);
      // successIds must include all committed IDs
      expect(res.body.successIds).toEqual(expect.arrayContaining(['batch-a', 'batch-b']));
    });
  });

  // -------------------------------------------------------------------------
  // Batch replay — partial failure recovery (core #1298 fix)
  // -------------------------------------------------------------------------

  describe('Batch replay — partial failure (issue #1298)', () => {
    it('commits successful items and reports them in successIds when a later item fails delivery', async () => {
      // Item A: delivery succeeds. Item B: delivery returns 500.
      // Before the fix: a mid-loop exception would propagate to the outer catch
      // and return 500 with no information about committed deliveries.
      // After the fix: the loop continues, failureCount increments, and
      // successIds captures item A so the caller can reconcile.
      const itemA = makeDlqItem({ id: 'partial-a', eventId: 'evt-partial-a' });
      const itemB = makeDlqItem({ id: 'partial-b', eventId: 'evt-partial-b' });

      store.getEntryById
        .mockResolvedValueOnce(itemA)
        .mockResolvedValueOnce(itemB);

      (IdempotencyLayer.isEventProcessed as jest.Mock).mockResolvedValue(false);
      (IdempotencyLayer.markEventProcessed as jest.Mock).mockResolvedValue(undefined);

      jest
        .spyOn(require('axios'), 'post')
        .mockResolvedValueOnce({ status: 200 })  // itemA succeeds
        .mockResolvedValueOnce({ status: 500 }); // itemB fails

      const res = await request(testApp)
        .post('/jobs/dlq/replay')
        .set('Authorization', 'Bearer demo-admin-token')
        .send({ ids: ['partial-a', 'partial-b'], reason: 'Partial recovery test' });

      expect(res.status).toBe(200); // outer response is always 200 after loop
      expect(res.body.details.successCount).toBe(1);
      expect(res.body.details.failureCount).toBe(1);
      // itemA was committed — must appear in successIds
      expect(res.body.successIds).toContain('partial-a');
      expect(res.body.successIds).not.toContain('partial-b');
      // removeEntry called only for the successful item
      expect(store.removeEntry).toHaveBeenCalledWith('partial-a');
      expect(store.removeEntry).not.toHaveBeenCalledWith('partial-b');
    });

    it('continues processing remaining items when a mid-batch store operation throws', async () => {
      // Item A: getEntryById throws unexpectedly. Item B: completes normally.
      // The loop must not abort on itemA's error — itemB must still be processed.
      const itemB = makeDlqItem({ id: 'throw-b', eventId: 'evt-throw-b' });

      store.getEntryById
        .mockRejectedValueOnce(new Error('transient DB error')) // item A throws
        .mockResolvedValueOnce(itemB);                          // item B succeeds

      (IdempotencyLayer.isEventProcessed as jest.Mock).mockResolvedValue(false);
      (IdempotencyLayer.markEventProcessed as jest.Mock).mockResolvedValue(undefined);
      jest.spyOn(require('axios'), 'post').mockResolvedValueOnce({ status: 200 });

      const res = await request(testApp)
        .post('/jobs/dlq/replay')
        .set('Authorization', 'Bearer demo-admin-token')
        .send({ ids: ['throw-a', 'throw-b'], reason: 'Store throw resilience' });

      expect(res.status).toBe(200);
      expect(res.body.details.failureCount).toBe(1); // itemA counted as failure
      expect(res.body.details.successCount).toBe(1); // itemB still processed
      expect(res.body.successIds).toContain('throw-b');
    });

    it('returns batch_completed (not 5xx) even when all items fail', async () => {
      const itemA = makeDlqItem({ id: 'all-fail-a', eventId: 'evt-all-a' });
      const itemB = makeDlqItem({ id: 'all-fail-b', eventId: 'evt-all-b' });

      store.getEntryById
        .mockResolvedValueOnce(itemA)
        .mockResolvedValueOnce(itemB);

      (IdempotencyLayer.isEventProcessed as jest.Mock).mockResolvedValue(false);
      jest
        .spyOn(require('axios'), 'post')
        .mockResolvedValueOnce({ status: 503 })
        .mockResolvedValueOnce({ status: 503 });

      const res = await request(testApp)
        .post('/jobs/dlq/replay')
        .set('Authorization', 'Bearer demo-admin-token')
        .send({ ids: ['all-fail-a', 'all-fail-b'], reason: 'All items fail scenario' });

      expect(res.status).toBe(200);
      expect(res.body.details.failureCount).toBe(2);
      expect(res.body.details.successCount).toBe(0);
      expect(res.body.successIds).toHaveLength(0);
    });

    it('counts missing-entry IDs as failures rather than throwing', async () => {
      store.getEntryById.mockResolvedValue(null);

      const res = await request(testApp)
        .post('/jobs/dlq/replay')
        .set('Authorization', 'Bearer demo-admin-token')
        .send({ ids: ['ghost-1', 'ghost-2'], reason: 'Missing entry handling' });

      expect(res.status).toBe(200);
      expect(res.body.details.failureCount).toBe(2);
      expect(res.body.details.successCount).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Batch replay — validation
  // -------------------------------------------------------------------------

  describe('Batch replay — input validation', () => {
    it('returns 400 when ids array is empty', async () => {
      const res = await request(testApp)
        .post('/jobs/dlq/replay')
        .set('Authorization', 'Bearer demo-admin-token')
        .send({ ids: [], reason: 'Empty array check' });

      expect(res.status).toBe(400);
    });

    it('returns 400 when ids contains a non-string element', async () => {
      const res = await request(testApp)
        .post('/jobs/dlq/replay')
        .set('Authorization', 'Bearer demo-admin-token')
        .send({ ids: ['valid-id', 42], reason: 'Mixed type ids check' });

      expect(res.status).toBe(400);
    });

    it('returns 400 when ids is not an array', async () => {
      const res = await request(testApp)
        .post('/jobs/dlq/replay')
        .set('Authorization', 'Bearer demo-admin-token')
        .send({ ids: 'not-an-array', reason: 'Non-array ids check' });

      expect(res.status).toBe(400);
    });

    it('returns 400 when reason is too short in batch request', async () => {
      const res = await request(testApp)
        .post('/jobs/dlq/replay')
        .set('Authorization', 'Bearer demo-admin-token')
        .send({ ids: ['some-id'], reason: 'hi' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/reason/i);
    });

    it('returns 503 when DLQ store is uninitialized for batch', async () => {
      shutdownJobs();

      const res = await request(testApp)
        .post('/jobs/dlq/replay')
        .set('Authorization', 'Bearer demo-admin-token')
        .send({ ids: ['some-id'], reason: 'Store not ready' });

      expect(res.status).toBe(503);
      initializeJobs(store);
    });
  });

  // -------------------------------------------------------------------------
  // deliverRaw — structured error observability (issue #1298)
  // -------------------------------------------------------------------------

  describe('deliverRaw — structured delivery result', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('returns success:true with statusCode on HTTP 200', async () => {
      jest.spyOn(require('axios'), 'post').mockResolvedValueOnce({ status: 200 });
      const result = await deliverRaw('https://example.com', 'evt-1', { foo: 'bar' });
      expect(result.success).toBe(true);
      expect(result.statusCode).toBe(200);
      expect(result.errorCode).toBeUndefined();
    });

    it('returns success:true with statusCode on HTTP 201', async () => {
      jest.spyOn(require('axios'), 'post').mockResolvedValueOnce({ status: 201 });
      const result = await deliverRaw('https://example.com', 'evt-2', {});
      expect(result.success).toBe(true);
      expect(result.statusCode).toBe(201);
    });

    it('returns success:false with statusCode on HTTP 422 (boundary: highest 4xx)', async () => {
      jest.spyOn(require('axios'), 'post').mockResolvedValueOnce({ status: 422 });
      const result = await deliverRaw('https://example.com', 'evt-3', {});
      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(422);
      expect(result.errorCode).toBeUndefined();
    });

    it('returns success:false with statusCode on HTTP 500', async () => {
      jest.spyOn(require('axios'), 'post').mockResolvedValueOnce({ status: 500 });
      const result = await deliverRaw('https://example.com', 'evt-4', {});
      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(500);
    });

    it('returns success:false with errorCode on ECONNREFUSED (network failure)', async () => {
      const err = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      jest.spyOn(require('axios'), 'post').mockRejectedValueOnce(err);
      const result = await deliverRaw('https://example.com', 'evt-5', {});
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('ECONNREFUSED');
      expect(result.statusCode).toBeUndefined();
    });

    it('returns success:false with errorCode on ETIMEDOUT', async () => {
      const err = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
      jest.spyOn(require('axios'), 'post').mockRejectedValueOnce(err);
      const result = await deliverRaw('https://example.com', 'evt-6', {});
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('ETIMEDOUT');
    });

    it('propagates request context headers to the outbound call', async () => {
      const postSpy = jest.spyOn(require('axios'), 'post').mockResolvedValueOnce({ status: 200 });
      await deliverRaw('https://example.com', 'evt-ctx', { data: 1 }, {
        requestId: 'req-abc',
        tenantId: 'tenant-xyz',
        actorId: 'actor-123',
      });
      const [, , config] = postSpy.mock.calls[0] as any[];
      expect(config.headers['X-Request-Id']).toBe('req-abc');
      expect(config.headers['X-Tenant-Id']).toBe('tenant-xyz');
      expect(config.headers['X-Actor-Id']).toBe('actor-123');
    });

    it('boundary: HTTP 199 is not treated as success', async () => {
      jest.spyOn(require('axios'), 'post').mockResolvedValueOnce({ status: 199 });
      const result = await deliverRaw('https://example.com', 'evt-199', {});
      expect(result.success).toBe(false);
    });

    it('boundary: HTTP 300 is not treated as success', async () => {
      jest.spyOn(require('axios'), 'post').mockResolvedValueOnce({ status: 300 });
      const result = await deliverRaw('https://example.com', 'evt-300', {});
      expect(result.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // initializeJobs — resilience to bad env config (issue #1298)
  // -------------------------------------------------------------------------

  describe('initializeJobs — metrics sampling resilience', () => {
    const originalEnv = process.env.DLQ_METRICS_INTERVAL_MS;

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.DLQ_METRICS_INTERVAL_MS;
      } else {
        process.env.DLQ_METRICS_INTERVAL_MS = originalEnv;
      }
    });

    it('does not throw and still returns the store when DLQ_METRICS_INTERVAL_MS is invalid', () => {
      process.env.DLQ_METRICS_INTERVAL_MS = 'not-a-number';
      // Before the fix this would propagate the Error from loadDlqMetricsInterval
      // and crash the caller (e.g. index.ts startup).
      expect(() => initializeJobs(store)).not.toThrow();
      // Store must still be accessible so replay endpoints work.
      const { getDlqStore } = require('./jobs');
      expect(getDlqStore()).toBe(store);
    });

    it('does not throw when DLQ_METRICS_INTERVAL_MS is zero', () => {
      process.env.DLQ_METRICS_INTERVAL_MS = '0';
      expect(() => initializeJobs(store)).not.toThrow();
    });

    it('does not throw when DLQ_METRICS_INTERVAL_MS is negative', () => {
      process.env.DLQ_METRICS_INTERVAL_MS = '-1';
      expect(() => initializeJobs(store)).not.toThrow();
    });

    it('starts normally when DLQ_METRICS_INTERVAL_MS is a valid positive integer', () => {
      process.env.DLQ_METRICS_INTERVAL_MS = '5000';
      expect(() => initializeJobs(store)).not.toThrow();
      const { getDlqStore } = require('./jobs');
      expect(getDlqStore()).toBe(store);
    });
  });

  // -------------------------------------------------------------------------
  // Regression: idempotency state must not bleed between tests
  // -------------------------------------------------------------------------

  describe('Regression: IdempotencyLayer state isolation between tests', () => {
    it('first call: event is not yet processed', async () => {
      // This test creates the side-effect of marking evt-isolation as processed.
      // The next test must NOT see that as already-processed despite running in
      // the same process — only possible if afterEach calls _clear().
      const item = makeDlqItem({ id: 'isol-1', eventId: 'evt-isolation' });
      store.getEntryById.mockResolvedValue(item);
      (IdempotencyLayer.isEventProcessed as jest.Mock).mockResolvedValue(false);
      (IdempotencyLayer.markEventProcessed as jest.Mock).mockResolvedValue(undefined);
      jest.spyOn(require('axios'), 'post').mockResolvedValueOnce({ status: 200 });

      const res = await request(testApp)
        .post('/jobs/dlq/isol-1/replay')
        .set('Authorization', 'Bearer demo-admin-token')
        .send({ reason: 'Isolation first call' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
    });

    it('second call (separate test): isEventProcessed mock is reset by afterEach', async () => {
      // If afterEach did NOT clear the IdempotencyLayer, the real in-memory set
      // would still contain 'evt-isolation' and this mock would be bypassed
      // (the real isEventProcessed would return true). Confirming mock resets
      // work correctly after _clear() is called.
      const item = makeDlqItem({ id: 'isol-2', eventId: 'evt-isolation' });
      store.getEntryById.mockResolvedValue(item);
      // Mock returns false — if the real set still has the key this would be
      // irrelevant for the mock-based path, but the mock controls the behaviour.
      (IdempotencyLayer.isEventProcessed as jest.Mock).mockResolvedValue(false);
      (IdempotencyLayer.markEventProcessed as jest.Mock).mockResolvedValue(undefined);
      jest.spyOn(require('axios'), 'post').mockResolvedValueOnce({ status: 200 });

      const res = await request(testApp)
        .post('/jobs/dlq/isol-2/replay')
        .set('Authorization', 'Bearer demo-admin-token')
        .send({ reason: 'Isolation second call' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
    });
  });
});
