/**
 * QueueManager — job quarantine wiring (unit, no Redis)
 *
 * Mocks BullMQ (same approach as `queue-manager.fair.test.ts`) and verifies
 * that terminal job failures are moved to quarantine instead of being retried
 * to exhaustion, while transient failures keep the existing retry path.
 */

const mockAdd = jest.fn();
const mockGetJob = jest.fn();
const mockGetWaiting = jest.fn();
const mockQueueClose = jest.fn().mockResolvedValue(undefined);
const mockWorkerOn = jest.fn();
const mockWorkerClose = jest.fn().mockResolvedValue(undefined);
const mockQueueEventsOn = jest.fn();
const mockQueueEventsClose = jest.fn().mockResolvedValue(undefined);

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

// Import the quarantine store instance getter so tests can clear state and
// inspect persisted entries using the same in-memory store the manager uses.
import { QueueManager } from './queue-manager';
import { JobResult, JobType } from './types';
import { jobProcessors } from './processors';
import {
  InvalidJobPayloadError,
  TerminalJobError,
  StaleJobReferenceError,
} from './queue-errors';
import {
  getJobQuarantineStorage,
  clearJobQuarantineInstance,
} from './job-quarantine';

type TestableQueueManager = {
  processJob(jobType: JobType, job: Record<string, unknown>): Promise<JobResult>;
};

const TERMINAL_PAYLOAD = { contractId: 'short', action: 'create' };
const TRANSIENT_PAYLOAD = { contractId: 'contract-test-123', action: 'create' };

function makeJob(id: string, data: Record<string, unknown>, attemptsMade = 0) {
  return { id, name: JobType.CONTRACT_PROCESSING, data, attemptsMade };
}

// A processor that always succeeds (default, so swap only when needed).
const okProcessor = jest.fn().mockResolvedValue({ success: true });

describe('QueueManager — job quarantine wiring (unit, no Redis)', () => {
  let qm: QueueManager;
  let originalProcessor: typeof okProcessor;

  beforeEach(async () => {
    jest.clearAllMocks();
    (QueueManager as unknown as { instance: undefined }).instance = undefined;
    qm = QueueManager.getInstance();
    mockAdd.mockResolvedValue({ id: 'auto-id' });
    mockGetJob.mockResolvedValue(null);
    mockGetWaiting.mockResolvedValue([]);

    clearJobQuarantineInstance();
    originalProcessor = jobProcessors[JobType.CONTRACT_PROCESSING] as unknown as typeof okProcessor;
    jobProcessors[JobType.CONTRACT_PROCESSING] = okProcessor as never;

    await qm.initializeQueue(JobType.CONTRACT_PROCESSING);
  });

  afterEach(async () => {
    jobProcessors[JobType.CONTRACT_PROCESSING] = originalProcessor;
    await qm.shutdown();
    clearJobQuarantineInstance();
  });

  describe('processJob failure classification', () => {
    it('quarantines a terminal failure and throws TerminalJobError (no retry storm)', async () => {
      jobProcessors[JobType.CONTRACT_PROCESSING] = jest
        .fn()
        .mockRejectedValue(new InvalidJobPayloadError('Invalid contract ID')) as never;

      await expect(
        (qm as unknown as TestableQueueManager).processJob(
          JobType.CONTRACT_PROCESSING,
          makeJob('job-terminal', TERMINAL_PAYLOAD, 1),
        ),
      ).rejects.toBeInstanceOf(TerminalJobError);

      const entries = getJobQuarantineStorage().listEntries({});
      expect(entries).toHaveLength(1);
      expect(entries[0].jobId).toBe('job-terminal');
      expect(entries[0].kind).toBe('invalid_payload');
      expect(entries[0].attemptsMade).toBe(1);
    });

    it('does NOT quarantine a transient failure and still throws a generic Error', async () => {
      jobProcessors[JobType.CONTRACT_PROCESSING] = jest
        .fn()
        .mockRejectedValue(new Error('upstream 500')) as never;

      await expect(
        (qm as unknown as TestableQueueManager).processJob(
          JobType.CONTRACT_PROCESSING,
          makeJob('job-transient', TRANSIENT_PAYLOAD, 0),
        ),
      ).rejects.toThrow('Job processing failed: upstream 500');

      expect(getJobQuarantineStorage().listEntries({})).toHaveLength(0);
    });

    it('quarantines StaleJobReferenceError subclass with its kind', async () => {
      jobProcessors[JobType.CONTRACT_PROCESSING] = jest
        .fn()
        .mockRejectedValue(new StaleJobReferenceError('contract gone')) as never;

      await expect(
        (qm as unknown as TestableQueueManager).processJob(
          JobType.CONTRACT_PROCESSING,
          makeJob('job-stale', TERMINAL_PAYLOAD, 2),
        ),
      ).rejects.toBeInstanceOf(TerminalJobError);

      const entries = getJobQuarantineStorage().listEntries({});
      expect(entries).toHaveLength(1);
      expect(entries[0].kind).toBe('stale_reference');
    });

    it('handles quarantine storage failure gracefully: job still fails, no crash', async () => {
      // Make the store's addEntry throw; the manager must still fail the job
      // (terminal) without crashing the worker.
      const storage = getJobQuarantineStorage();
      const addSpy = jest
        .spyOn(storage, 'addEntry')
        .mockRejectedValue(new Error('quarantine db unavailable'));

      jobProcessors[JobType.CONTRACT_PROCESSING] = jest
        .fn()
        .mockRejectedValue(new InvalidJobPayloadError('nope')) as never;

      await expect(
        (qm as unknown as TestableQueueManager).processJob(
          JobType.CONTRACT_PROCESSING,
          makeJob('job-storage-fail', TERMINAL_PAYLOAD, 0),
        ),
      ).rejects.toBeInstanceOf(TerminalJobError);

      expect(addSpy).toHaveBeenCalledTimes(1);
      expect(getJobQuarantineStorage().listEntries({})).toHaveLength(0);
    });
  });

  describe('quarantine inspection and replay', () => {
    it('lists persisted quarantined entries via getQuarantinedJobs', async () => {
      jobProcessors[JobType.CONTRACT_PROCESSING] = jest
        .fn()
        .mockRejectedValue(new InvalidJobPayloadError('bad')) as never;

      await (qm as unknown as TestableQueueManager).processJob(
        JobType.CONTRACT_PROCESSING,
        makeJob('job-list', TERMINAL_PAYLOAD, 0),
      ).catch(() => undefined);

      const entries = await qm.getQuarantinedJobs({});
      expect(entries).toHaveLength(1);
      expect(entries[0].jobId).toBe('job-list');
    });

    it('replays a quarantined job by re-enqueuing its payload (deduped on second call)', async () => {
      const storage = getJobQuarantineStorage();
      const entryId = await storage.addEntry({
        jobType: JobType.CONTRACT_PROCESSING,
        jobId: 'orig-123',
        tenantId: 'tenant-9',
        payload: TERMINAL_PAYLOAD as never,
        reason: 'bad payload',
        kind: 'invalid_payload',
        attemptsMade: 3,
      });

      const first = await qm.replayQuarantinedJob(entryId);
      expect(first.deduplicated).toBe(false);
      expect(mockAdd).toHaveBeenCalledWith(
        JobType.CONTRACT_PROCESSING,
        expect.objectContaining({
          contractId: 'short',
          tenantId: 'tenant-9',
          quarantineOriginalJobId: 'orig-123',
        }),
        expect.anything(),
      );

      // Second call is an idempotent no-op because the replay job id exists.
      mockGetJob.mockResolvedValue({ id: first.replayedJobId });
      const second = await qm.replayQuarantinedJob(entryId);
      expect(second.deduplicated).toBe(true);
      expect(second.replayedJobId).toBe(first.replayedJobId);
    });

    it('throws when replaying a non-existent quarantine id', async () => {
      await expect(qm.replayQuarantinedJob('missing')).rejects.toThrow(
        'Quarantined job not found: missing',
      );
    });

    it('throws when the target queue is not initialized', async () => {
      // Initialize only EMAIL_NOTIFICATION (not CONTRACT_PROCESSING is already
      // initialized in beforeEach) — use a fresh manager with no queue.
      jobProcessors[JobType.REPUTATION_UPDATE] = okProcessor as never;
      const storage = getJobQuarantineStorage();
      const entryId = await storage.addEntry({
        jobType: JobType.REPUTATION_UPDATE,
        jobId: 'orig-2',
        payload: { userId: 'user-1', contractId: 'c', rating: 5 } as never,
        reason: 'bad',
        kind: 'invalid_payload',
        attemptsMade: 0,
      });

      await expect(qm.replayQuarantinedJob(entryId)).rejects.toThrow(
        'Queue for reputation-update not initialized',
      );
    });
  });
});