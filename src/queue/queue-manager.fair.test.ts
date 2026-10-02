/**
 * QueueManager — weighted fair scheduling wiring (unit, no Redis)
 *
 * Mocks BullMQ (same approach as `queue-manager.dedupe.test.ts`) and verifies
 * the scheduler integration: payload enrichment, priority-level metrics,
 * rebalance promotion of overdue jobs, worker-restart reconstruction from
 * durable job data, retry tolerance, error isolation, and empty-queue no-ops.
 */

import { Registry } from 'prom-client';

const mockAdd = jest.fn();
const mockGetJob = jest.fn();
const mockGetWaiting = jest.fn();
const mockQueueClose = jest.fn().mockResolvedValue(undefined);
const mockWorkerOn = jest.fn();
const mockWorkerClose = jest.fn().mockResolvedValue(undefined);
const mockQueueEventsOn = jest.fn();
const mockQueueEventsClose = jest.fn().mockResolvedValue(undefined);
const mockChangePriority = jest.fn().mockResolvedValue(undefined);

jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: mockAdd,
    getJob: mockGetJob,
    getWaiting: mockGetWaiting,
    on: jest.fn(),
    close: mockQueueClose,
  })),
  Worker: jest.fn().mockImplementation(() => ({
    on: mockWorkerOn,
    close: mockWorkerClose,
  })),
  QueueEvents: jest.fn().mockImplementation(() => ({
    on: mockQueueEventsOn,
    close: mockQueueEventsClose,
  })),
  Job: jest.fn(),
}));

import { QueueManager } from './queue-manager';
import { JobType } from './types';
import { PriorityLevel } from './fair-scheduler';
import {
  initializeQueueFairMetrics,
  resetQueueFairMetrics,
} from './queue-metrics';

const EMAIL_PAYLOAD = { to: 'test@example.com', subject: 'Test', body: 'body' };

interface WaitingJob {
  id: string;
  data: Record<string, unknown>;
  opts: { priority?: number };
  timestamp: number;
  changePriority: jest.Mock;
}

function makeWaitingJob(
  id: string,
  data: Record<string, unknown>,
  optsPriority: number | undefined,
  timestamp: number,
): WaitingJob {
  return { id, data, opts: { priority: optsPriority }, timestamp, changePriority: mockChangePriority };
}

describe('QueueManager — weighted fair scheduling (unit, no Redis)', () => {
  let qm: QueueManager;
  let registry: Registry;

  beforeEach(async () => {
    jest.clearAllMocks();
    (QueueManager as unknown as { instance: undefined }).instance = undefined;
    qm = QueueManager.getInstance();
    mockAdd.mockResolvedValue({ id: 'auto-id' });
    mockGetJob.mockResolvedValue(null);
    mockGetWaiting.mockResolvedValue([]);

    registry = new Registry();
    resetQueueFairMetrics();
    initializeQueueFairMetrics(registry);
    await qm.initializeQueue(JobType.EMAIL_NOTIFICATION);
  });

  afterEach(async () => {
    await qm.shutdown();
    resetQueueFairMetrics();
  });

  describe('addJob', () => {
    it('enriches the payload with tenantId and priorityLevel when provided', async () => {
      await qm.addJob(JobType.EMAIL_NOTIFICATION, EMAIL_PAYLOAD, {
        tenantId: 'tenant-42',
        priorityLevel: PriorityLevel.HIGH,
      });

      expect(mockAdd).toHaveBeenCalledWith(
        JobType.EMAIL_NOTIFICATION,
        expect.objectContaining({ tenantId: 'tenant-42', priorityLevel: 'high' }),
        expect.anything(),
      );
    });

    it('persists the derived level in the payload when no fair options are passed', async () => {
      await qm.addJob(JobType.EMAIL_NOTIFICATION, EMAIL_PAYLOAD);

      const [, payload] = mockAdd.mock.calls[0];
      // The derived level is always persisted so the rebalance pass never has
      // to rely on the (mutable) job option for new jobs.
      expect(payload).toEqual({ ...EMAIL_PAYLOAD, priorityLevel: 'normal' });
    });

    it('persists an explicit priorityLevel in the payload', async () => {
      await qm.addJob(JobType.EMAIL_NOTIFICATION, EMAIL_PAYLOAD, {
        priorityLevel: PriorityLevel.CRITICAL,
      });

      const [, payload] = mockAdd.mock.calls[0];
      expect(payload).toEqual({ ...EMAIL_PAYLOAD, priorityLevel: 'critical' });
    });

    it('records the normalized priority level metric', async () => {
      await qm.addJob(JobType.EMAIL_NOTIFICATION, EMAIL_PAYLOAD, { priority: 1 });

      const metrics = await registry.getMetricsAsJSON();
      const counter = metrics.find((m) => m.name === 'queue_fair_priority_assigned_total')!;
      const value = (counter.values as { labels: { priority_level: string }; value: number }[]).find(
        (v) => v.labels.priority_level === 'critical',
      );
      expect(value?.value).toBe(1);
    });
  });

  describe('rebalanceWaitingJobs', () => {
    it('is a no-op with zero waiting jobs and reports zero overdue', async () => {
      const changed = await qm.rebalanceWaitingJobs(JobType.EMAIL_NOTIFICATION);
      expect(changed).toBe(0);
      expect(mockChangePriority).not.toHaveBeenCalled();

      const metrics = await registry.getMetricsAsJSON();
      const gauge = metrics.find((m) => m.name === 'queue_fair_overdue_waiting')!;
      expect((gauge.values as { value: number }[])[0].value).toBe(0);
    });

    it('promotes an overdue low-priority job ahead of a fresh critical job', async () => {
      const now = Date.now();
      mockGetWaiting.mockResolvedValue([
        makeWaitingJob('fresh-crit', {}, 1, now - 100),
        makeWaitingJob('stale-low', {}, 4, now - 400_000), // overdue (> 5 min default)
      ]);

      const changed = await qm.rebalanceWaitingJobs(JobType.EMAIL_NOTIFICATION);
      // Only the stale job changes (fresh critical is already at priority 1).
      expect(changed).toBe(1);

      // The stale low job must be moved to the front (priority 0).
      const staleCall = mockChangePriority.mock.calls.find(
        (call) => call[0]?.priority === 0,
      );
      expect(staleCall).toBeDefined();

      const metrics = await registry.getMetricsAsJSON();
      const boosts = metrics.find((m) => m.name === 'queue_fair_aged_boosts_total')!;
      expect((boosts.values as { value: number }[])[0].value).toBe(1);
      const decisions = metrics.find((m) => m.name === 'queue_fair_decisions_total')!;
      const aged = (decisions.values as { labels: { decision: string }; value: number }[]).find(
        (v) => v.labels.decision === 'aged',
      );
      expect(aged?.value).toBe(1);
    });

    it('reconstructs level and tenant from durable job data (worker restart)', async () => {
      // A restarted worker has no in-memory scheduler state — it must derive
      // level/tenant from job.data and opts, exactly like a fresh process.
      const now = Date.now();
      mockGetWaiting.mockResolvedValue([
        makeWaitingJob('job-a', { tenantId: 'tenant-a', priorityLevel: 'high' }, 2, now - 100),
        makeWaitingJob('job-b', { tenantId: 'tenant-b', priorityLevel: 'low' }, 4, now - 50),
      ]);

      await qm.rebalanceWaitingJobs(JobType.EMAIL_NOTIFICATION);

      // Both jobs get re-prioritized; ordering is deterministic (same inputs,
      // same output on any worker).
      expect(mockChangePriority).toHaveBeenCalledTimes(2);
    });

    it('tolerates changePriority failures without aborting the pass', async () => {
      const now = Date.now();
      // job-1 (LOW, opts 4 -> effective 0) runs first; job-2 (NORMAL, opts 3
      // -> effective 1) runs second. Both priorities change.
      mockGetWaiting.mockResolvedValue([
        makeWaitingJob('job-1', {}, 4, now - 100),
        makeWaitingJob('job-2', {}, 3, now - 100),
      ]);
      mockChangePriority
        .mockRejectedValueOnce(new Error('job is no longer waiting'))
        .mockResolvedValue(undefined);

      // The rejected call is caught and logged; the remaining job still gets
      // re-prioritized, so the pass completes with one successful change.
      await expect(qm.rebalanceWaitingJobs(JobType.EMAIL_NOTIFICATION)).resolves.toBe(1);
      expect(mockChangePriority).toHaveBeenCalledTimes(2);
    });

    it('skips changePriority when the effective priority is unchanged', async () => {
      const now = Date.now();
      // Single waiting job; its current priority already matches the computed
      // effective priority (0), so no change is needed.
      mockGetWaiting.mockResolvedValue([
        makeWaitingJob('only-job', {}, 0, now - 100),
      ]);

      await qm.rebalanceWaitingJobs(JobType.EMAIL_NOTIFICATION);
      expect(mockChangePriority).not.toHaveBeenCalled();
    });

    it('does not fail when getWaiting throws', async () => {
      mockGetWaiting.mockRejectedValue(new Error('Redis connection lost'));
      await expect(qm.rebalanceWaitingJobs(JobType.EMAIL_NOTIFICATION)).resolves.toBe(0);
    });

    it('bounds the number of waiting jobs examined per pass', async () => {
      mockGetWaiting.mockResolvedValue([]);
      await qm.rebalanceWaitingJobs(JobType.EMAIL_NOTIFICATION);

      // getWaiting is called with a bounded window (0 .. MAX-1), never unbounded.
      expect(mockGetWaiting).toHaveBeenCalledWith(0, 999);
    });
  });

  describe('retry and failure paths', () => {
    it('treats a retried job (attemptsMade > 0) as a pending job with its original timestamp', async () => {
      // A job that failed and is waiting for retry keeps its original enqueue
      // timestamp. If that timestamp is now overdue, the retry is promoted.
      const now = Date.now();
      const retriedJob = makeWaitingJob('retry-1', { attemptsMade: 2 }, 4, now - 400_000);
      mockGetWaiting.mockResolvedValue([retriedJob]);

      const changed = await qm.rebalanceWaitingJobs(JobType.EMAIL_NOTIFICATION);
      expect(changed).toBe(1);
      const call = mockChangePriority.mock.calls[0][0];
      expect(call.priority).toBe(0); // promoted to the front of the queue
    });
  });
});
