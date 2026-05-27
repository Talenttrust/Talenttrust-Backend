/**
 * Unit tests for QueueManager deduplication logic.
 * BullMQ Queue is mocked — no Redis required; runs in local and CI environments.
 */

import { JobType } from './types';

// Mock BullMQ before importing QueueManager
const mockGetJob = jest.fn();
const mockAdd = jest.fn();
const mockWorkerClose = jest.fn().mockResolvedValue(undefined);
const mockQueueClose = jest.fn().mockResolvedValue(undefined);
const mockQueueEventsClose = jest.fn().mockResolvedValue(undefined);
const mockWorkerOn = jest.fn();
const mockQueueEventsOn = jest.fn();

jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: mockAdd,
    getJob: mockGetJob,
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
}));

// Import after mocking
import { QueueManager } from './queue-manager';

const EMAIL_PAYLOAD = { to: 'test@example.com', subject: 'Test', body: 'body' };

function makeJob(id: string, state: string) {
  return { id, getState: jest.fn().mockResolvedValue(state) };
}

describe('QueueManager — deduplication (unit, no Redis)', () => {
  let qm: QueueManager;

  beforeEach(async () => {
    jest.clearAllMocks();
    // Reset singleton for test isolation
    (QueueManager as unknown as { instance: undefined }).instance = undefined;
    qm = QueueManager.getInstance();
    mockAdd.mockResolvedValue({ id: 'auto-id' });
    mockGetJob.mockResolvedValue(null);
    await qm.initializeQueue(JobType.EMAIL_NOTIFICATION);
  });

  afterEach(async () => {
    await qm.shutdown();
  });

  describe('without dedupeKey', () => {
    it('returns jobId and deduplicated=false', async () => {
      mockAdd.mockResolvedValue({ id: '123' });

      const result = await qm.addJob(JobType.EMAIL_NOTIFICATION, EMAIL_PAYLOAD);

      expect(result).toEqual({ jobId: '123', deduplicated: false });
      expect(mockGetJob).not.toHaveBeenCalled();
      expect(mockAdd).toHaveBeenCalledWith(
        JobType.EMAIL_NOTIFICATION,
        EMAIL_PAYLOAD,
        expect.not.objectContaining({ jobId: expect.anything() }),
      );
    });

    it('passes priority and delay to queue.add', async () => {
      mockAdd.mockResolvedValue({ id: '456' });

      await qm.addJob(JobType.EMAIL_NOTIFICATION, EMAIL_PAYLOAD, { priority: 2, delay: 1000 });

      expect(mockAdd).toHaveBeenCalledWith(
        JobType.EMAIL_NOTIFICATION,
        EMAIL_PAYLOAD,
        expect.objectContaining({ priority: 2, delay: 1000 }),
      );
    });
  });

  describe('with dedupeKey — no existing job', () => {
    it('returns deduplicated=false and uses dedupeKey as jobId', async () => {
      mockGetJob.mockResolvedValue(null);
      mockAdd.mockResolvedValue({ id: 'my-key' });

      const result = await qm.addJob(
        JobType.EMAIL_NOTIFICATION,
        EMAIL_PAYLOAD,
        { dedupeKey: 'my-key' },
      );

      expect(result).toEqual({ jobId: 'my-key', deduplicated: false });
      expect(mockGetJob).toHaveBeenCalledWith('my-key');
      expect(mockAdd).toHaveBeenCalledWith(
        JobType.EMAIL_NOTIFICATION,
        EMAIL_PAYLOAD,
        expect.objectContaining({
          jobId: 'my-key',
          deduplication: expect.objectContaining({ id: 'my-key' }),
        }),
      );
    });

    it('includes dedupeTtl when provided', async () => {
      mockGetJob.mockResolvedValue(null);
      mockAdd.mockResolvedValue({ id: 'ttl-key' });

      await qm.addJob(
        JobType.EMAIL_NOTIFICATION,
        EMAIL_PAYLOAD,
        { dedupeKey: 'ttl-key', dedupeTtl: 30000 },
      );

      expect(mockAdd).toHaveBeenCalledWith(
        JobType.EMAIL_NOTIFICATION,
        EMAIL_PAYLOAD,
        expect.objectContaining({
          deduplication: { id: 'ttl-key', ttl: 30000 },
        }),
      );
    });

    it('omits ttl from deduplication when dedupeTtl not provided', async () => {
      mockGetJob.mockResolvedValue(null);
      mockAdd.mockResolvedValue({ id: 'no-ttl-key' });

      await qm.addJob(
        JobType.EMAIL_NOTIFICATION,
        EMAIL_PAYLOAD,
        { dedupeKey: 'no-ttl-key' },
      );

      const callArgs = mockAdd.mock.calls[0][2];
      expect(callArgs.deduplication).toEqual({ id: 'no-ttl-key' });
      expect(callArgs.deduplication.ttl).toBeUndefined();
    });
  });

  describe('with dedupeKey — existing live job', () => {
    it('returns deduplicated=true when existing job is waiting', async () => {
      mockGetJob.mockResolvedValue(makeJob('my-key', 'waiting'));
      mockAdd.mockResolvedValue({ id: 'my-key' });

      const result = await qm.addJob(
        JobType.EMAIL_NOTIFICATION,
        EMAIL_PAYLOAD,
        { dedupeKey: 'my-key', delay: 5000 },
      );

      expect(result.deduplicated).toBe(true);
    });

    it('returns deduplicated=true when existing job is active', async () => {
      mockGetJob.mockResolvedValue(makeJob('my-key', 'active'));
      mockAdd.mockResolvedValue({ id: 'my-key' });

      const result = await qm.addJob(
        JobType.EMAIL_NOTIFICATION,
        EMAIL_PAYLOAD,
        { dedupeKey: 'my-key' },
      );

      expect(result.deduplicated).toBe(true);
    });

    it('returns deduplicated=true when existing job is delayed', async () => {
      mockGetJob.mockResolvedValue(makeJob('my-key', 'delayed'));
      mockAdd.mockResolvedValue({ id: 'my-key' });

      const result = await qm.addJob(
        JobType.EMAIL_NOTIFICATION,
        EMAIL_PAYLOAD,
        { dedupeKey: 'my-key' },
      );

      expect(result.deduplicated).toBe(true);
    });
  });

  describe('with dedupeKey — existing terminal job', () => {
    it('returns deduplicated=false when existing job is completed', async () => {
      mockGetJob.mockResolvedValue(makeJob('my-key', 'completed'));
      mockAdd.mockResolvedValue({ id: 'my-key' });

      const result = await qm.addJob(
        JobType.EMAIL_NOTIFICATION,
        EMAIL_PAYLOAD,
        { dedupeKey: 'my-key' },
      );

      expect(result.deduplicated).toBe(false);
    });

    it('returns deduplicated=false when existing job is failed', async () => {
      mockGetJob.mockResolvedValue(makeJob('my-key', 'failed'));
      mockAdd.mockResolvedValue({ id: 'my-key' });

      const result = await qm.addJob(
        JobType.EMAIL_NOTIFICATION,
        EMAIL_PAYLOAD,
        { dedupeKey: 'my-key' },
      );

      expect(result.deduplicated).toBe(false);
    });
  });

  describe('error handling', () => {
    it('throws when queue not initialized', async () => {
      await expect(
        qm.addJob(JobType.CONTRACT_PROCESSING, { contractId: 'x', action: 'create' }),
      ).rejects.toThrow('Queue for contract-processing not initialized');
    });

    it('propagates queue.add errors', async () => {
      mockGetJob.mockResolvedValue(null);
      mockAdd.mockRejectedValue(new Error('Redis connection lost'));

      await expect(
        qm.addJob(JobType.EMAIL_NOTIFICATION, EMAIL_PAYLOAD),
      ).rejects.toThrow('Redis connection lost');
    });
  });
});
