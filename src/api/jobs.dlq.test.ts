import express from 'express';
import request from 'supertest';
import { app } from '../index';
import { QueueManager, JobType } from '../queue';
import { auditService } from '../audit/service';
import { auditStore } from '../audit/store';
import { Registry } from 'prom-client';
import { jobsRouter, initializeJobs } from './jobs';
import { WebhookDeliveryService } from '../webhookDelivery';
import { IdempotencyLayer } from '../events/idempotency';
import {
  WebhookDLQStorage,
  clearWebhookDLQInstance,
  initializeDLQMetrics,
  resetDLQMetrics,
} from '../queue/webhook-dlq';

// Mock upstream handling layers to isolate endpoint integration
jest.mock('../services/WebhookDeliveryService');
jest.mock('../events/idempotency');

describe('Jobs DLQ API', () => {
  let queueManager: QueueManager;

  async function waitForFailedJob(jobId: string): Promise<void> {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const status = await queueManager.getJobStatus(JobType.EMAIL_NOTIFICATION, jobId);
      if (status?.state === 'failed') {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    throw new Error(`Expected job ${jobId} to be failed`);
  }

  beforeAll(async () => {
    queueManager = QueueManager.getInstance();
    for (const jobType of Object.values(JobType)) {
      await queueManager.initializeQueue(jobType);
    }
  });

  afterEach(async () => {
    auditStore._reset();
    await queueManager.shutdown();
    for (const jobType of Object.values(JobType)) {
      await queueManager.initializeQueue(jobType);
    }
  });

  afterAll(async () => {
    auditStore._reset();
    await queueManager.shutdown();
  });

  it('rejects DLQ viewer without authentication', async () => {
    const res = await request(app).get('/api/v1/jobs/dlq');
    expect(res.status).toBe(401);
  });

  it('rejects DLQ viewer for non-admin users', async () => {
    const res = await request(app)
      .get('/api/v1/jobs/dlq')
      .set('Authorization', 'Bearer demo-user-token');

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Admin role required');
  });

  it('allows admin to view failed jobs and writes audit entry', async () => {
    const { jobId: failedJobId } = await queueManager.addJob(
      JobType.EMAIL_NOTIFICATION,
      {
        to: 'broken-email-address',
        subject: 'DLQ',
        body: 'fail me',
      },
      { attempts: 1 }
    );

    await waitForFailedJob(failedJobId);

    const res = await request(app)
      .get('/api/v1/jobs/dlq?type=email-notification&limit=10')
      .set('Authorization', 'Bearer demo-admin-token');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.entries)).toBe(true);
    expect(res.body.entries.some((entry: { jobId: string }) => entry.jobId === failedJobId)).toBe(true);

    const adminAuditEvents = auditService.query({ action: 'ADMIN_ACTION', resource: 'jobs-dlq' });
    expect(adminAuditEvents.some((entry) => entry.metadata['operation'] === 'view')).toBe(true);
  });

  it('reprocesses a failed job with dedupe and audit logging', async () => {
    const { jobId: failedJobId } = await queueManager.addJob(
      JobType.EMAIL_NOTIFICATION,
      {
        to: 'broken-email-address',
        subject: 'Replay',
        body: 'fail me',
      },
      { attempts: 1 }
    );

    await waitForFailedJob(failedJobId);

    const first = await request(app)
      .post('/api/v1/jobs/dlq/reprocess')
      .set('Authorization', 'Bearer demo-admin-token')
      .send({
        type: JobType.EMAIL_NOTIFICATION,
        jobId: failedJobId,
        reason: 'Retry after upstream fix',
      });

    expect(first.status).toBe(202);
    expect(first.body.deduplicated).toBe(false);

    const second = await request(app)
      .post('/api/v1/jobs/dlq/reprocess')
      .set('Authorization', 'Bearer demo-admin-token')
      .send({
        type: JobType.EMAIL_NOTIFICATION,
        jobId: failedJobId,
        reason: 'Retry after upstream fix',
      });

    expect(second.status).toBe(200);
    expect(second.body.deduplicated).toBe(true);
    expect(second.body.replayJobId).toBe(first.body.replayJobId);

    const adminAuditEvents = auditService.query({ action: 'ADMIN_ACTION', resource: 'jobs-dlq' });
    expect(
      adminAuditEvents.filter((entry) => entry.metadata['operation'] === 'reprocess').length
    ).toBe(2);
  });
});

describe('DLQ Capacity and Overflow', () => {
  let storage: WebhookDLQStorage;
  let registry: Registry;

  beforeEach(() => {
    clearWebhookDLQInstance();
    resetDLQMetrics();
    registry = new Registry();
    
    // Initialize DLQ metrics with test registry
    initializeDLQMetrics(registry);
    
    // Create storage with small capacity for testing
    storage = new WebhookDLQStorage(':memory:', { maxCapacity: 3, maxReplayAttempts: 3 });
  });

  afterEach(() => {
    clearWebhookDLQInstance();
    resetDLQMetrics();
  });

  it('evicts oldest entry when DLQ is at capacity (oldest-evict policy)', async () => {
    // Add 3 entries to reach capacity
    const id1 = await storage.addEntry('webhook-1', 'https://a.com', { seq: 1 }, 1, 'Error 1');
    const id2 = await storage.addEntry('webhook-2', 'https://b.com', { seq: 2 }, 1, 'Error 2');
    const _id3 = await storage.addEntry('webhook-3', 'https://c.com', { seq: 3 }, 1, 'Error 3');

    // Verify all 3 entries exist
    const statsBefore = await storage.getStats();
    expect(statsBefore.pending).toBe(3);

    // Add a 4th entry - should trigger eviction of oldest (id1)
    const _id4 = await storage.addEntry('webhook-4', 'https://d.com', { seq: 4 }, 1, 'Error 4');

    // Verify oldest entry was evicted
    expect(storage.getEntry(id1)).toBeNull();
    expect(storage.getEntry(id2)).not.toBeNull();
    expect(storage.getEntry(_id3)).not.toBeNull();
    expect(storage.getEntry(_id4)).not.toBeNull();

    // Verify count is still 3
    const statsAfter = await storage.getStats();
    expect(statsAfter.pending).toBe(3);
  });

  it('continues to evict oldest entries when adding beyond capacity', async () => {
    // Fill to capacity
    const id1 = await storage.addEntry('webhook-1', 'https://a.com', { seq: 1 }, 1, 'Error 1');
    const id2 = await storage.addEntry('webhook-2', 'https://b.com', { seq: 2 }, 1, 'Error 2');
    const _id3 = await storage.addEntry('webhook-3', 'https://c.com', { seq: 3 }, 1, 'Error 3');

    // Add multiple more entries
    await storage.addEntry('webhook-4', 'https://d.com', { seq: 4 }, 1, 'Error 4');
    await storage.addEntry('webhook-5', 'https://e.com', { seq: 5 }, 1, 'Error 5');

    // Only the last 3 entries should remain
    expect(storage.getEntry(id1)).toBeNull();
    expect(storage.getEntry(id2)).toBeNull();
    
    const stats = await storage.getStats();
    expect(stats.pending).toBe(3);
  });

  it('increments drop_overflow metric when eviction occurs', async () => {
    // Fill to capacity
    await storage.addEntry('webhook-1', 'https://a.com', { seq: 1 }, 1, 'Error 1');
    await storage.addEntry('webhook-2', 'https://b.com', { seq: 2 }, 1, 'Error 2');
    await storage.addEntry('webhook-3', 'https://c.com', { seq: 3 }, 1, 'Error 3');

    // Add one more to trigger eviction
    await storage.addEntry('webhook-4', 'https://d.com', { seq: 4 }, 1, 'Error 4');

    // Check metrics were incremented
    const metrics = await registry.getSingleMetricAsString('webhook_dlq_operations_total');
    expect(metrics).toContain('drop_overflow');
    expect(metrics).toContain('enqueue');
  });

  it('does not evict replayed entries, only pending ones', async () => {
    // Fill to capacity
    const id1 = await storage.addEntry('webhook-1', 'https://a.com', { seq: 1 }, 1, 'Error 1');
    const id2 = await storage.addEntry('webhook-2', 'https://b.com', { seq: 2 }, 1, 'Error 2');
    const _id3 = await storage.addEntry('webhook-3', 'https://c.com', { seq: 3 }, 1, 'Error 3');

    // Mark the oldest as replayed
    storage.markReplayed(id1);

    // Add another entry - should evict id2 (oldest pending), not id1 (replayed)
    const _id4 = await storage.addEntry('webhook-4', 'https://d.com', { seq: 4 }, 1, 'Error 4');

    // id1 should still exist (replayed, not pending)
    expect(storage.getEntry(id1)).not.toBeNull();
    expect(storage.getEntry(id1)?.replayedAt).toBeDefined();
    
    // id2 should be evicted (oldest pending)
    expect(storage.getEntry(id2)).toBeNull();
  });
});

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

    // First replay attempt
    const result1 = storage.incrementReplayAttempts(id);
    expect(result1.success).toBe(true);
    expect(result1.attempts).toBe(1);
    expect(result1.maxExceeded).toBe(false);

    // Second replay attempt
    const result2 = storage.incrementReplayAttempts(id);
    expect(result2.attempts).toBe(2);
    expect(result2.maxExceeded).toBe(false);
  });

  it('permanently drops message after max replay attempts exceeded', async () => {
    const id = await storage.addEntry('webhook-1', 'https://a.com', { seq: 1 }, 1, 'Error');

    // Simulate 3 failed replay attempts (maxReplayAttempts = 3)
    storage.incrementReplayAttempts(id); // attempt 1
    storage.incrementReplayAttempts(id); // attempt 2
    const result3 = storage.incrementReplayAttempts(id); // attempt 3 - should drop

    expect(result3.success).toBe(true);
    expect(result3.attempts).toBe(3);
    expect(result3.maxExceeded).toBe(true);

    // Entry should be permanently deleted
    expect(storage.getEntry(id)).toBeNull();
  });

  it('does not retry infinitely - stops after max attempts', async () => {
    const id = await storage.addEntry('webhook-1', 'https://a.com', { seq: 1 }, 1, 'Error');

    // Simulate exactly max attempts
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

    // Verify no additional attempts can be made (entry is gone)
    const resultAfter = storage.incrementReplayAttempts(id);
    expect(resultAfter.success).toBe(false);
  });

  it('increments drop_poison metric when poison message is dropped', async () => {
    const id = await storage.addEntry('webhook-1', 'https://a.com', { seq: 1 }, 1, 'Error');

    // Reach max attempts
    storage.incrementReplayAttempts(id);
    storage.incrementReplayAttempts(id);
    storage.incrementReplayAttempts(id);

    // Check metrics
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
    // Fill capacity
    await storage.addEntry('webhook-1', 'https://a.com', { seq: 1 }, 1, 'Error 1');
    await storage.addEntry('webhook-2', 'https://b.com', { seq: 2 }, 1, 'Error 2');
    
    // Trigger eviction
    await storage.addEntry('webhook-3', 'https://c.com', { seq: 3 }, 1, 'Error 3');

    const metrics = await registry.getSingleMetricAsString('webhook_dlq_operations_total');
    expect(metrics).toContain('enqueue');
    expect(metrics).toContain('drop_overflow');
  });

  it('increments both enqueue and drop_poison for poison message scenario', async () => {
    const id = await storage.addEntry('webhook-1', 'https://a.com', { seq: 1 }, 1, 'Error');
    
    // Reach poison threshold
    storage.incrementReplayAttempts(id);
    storage.incrementReplayAttempts(id);

    const metrics = await registry.getSingleMetricAsString('webhook_dlq_operations_total');
    expect(metrics).toContain('enqueue');
    expect(metrics).toContain('drop_poison');
  });
});

describe('Issue #256: Idempotent DLQ Replay REST Endpoints', () => {
  let storage: any;    let testApp: ReturnType<typeof express>;
  const mockId = 'dlq_item_uuid_101';
  const mockEvtId = 'evt_sig_alpha_09';

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Create an express app mounting the jobsRouter directly
    testApp = express();
    testApp.use(express.json());
    testApp.use(jobsRouter);

    // Provide the dynamic mocked storage shape satisfying your customized store adapter
    storage = {
      getEntryById: jest.fn(),
      removeEntry: jest.fn(),
      incrementReplayAttempts: jest.fn(),
    };
    
    initializeJobs(storage);
  });

  it('should successfully replay an authentic DLQ message and redact secrets', async () => {
    storage.getEntryById.mockResolvedValue({
      id: mockId,
      eventId: mockEvtId,
      targetUrl: 'https://endpoint.talenttrust.io/webhook',
      payload: { data: 'clean_payload', webhookSecret: 'sk_live_9901' },
    });
    
    (IdempotencyLayer.isEventProcessed as jest.Mock).mockResolvedValue(false);
    (WebhookDeliveryService as any).deliverRaw = jest.fn().mockResolvedValue(true);

    const res = await request(testApp)
      .post(`/jobs/dlq/${mockId}/replay`)
      .set('Authorization', 'Bearer demo-admin-token')
      .send({ reason: 'Operator manual recovery verification' })
      .expect(200);

    expect(res.body.status).toBe('success');
    expect((WebhookDeliveryService as any).deliverRaw).toHaveBeenCalledWith(
      'https://endpoint.talenttrust.io/webhook',
      mockEvtId,
      expect.objectContaining({ webhookSecret: '[REDACTED]' })
    );
    expect(storage.removeEntry).toHaveBeenCalledWith(mockId);
    expect(IdempotencyLayer.markEventProcessed).toHaveBeenCalledWith(mockEvtId);
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
    expect((WebhookDeliveryService as any).deliverRaw).not.toHaveBeenCalled();
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

    // First event unique, second event is a duplicate no-op
    (IdempotencyLayer.isEventProcessed as jest.Mock)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    (WebhookDeliveryService as any).deliverRaw = jest.fn().mockResolvedValue(true);

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
  });
});