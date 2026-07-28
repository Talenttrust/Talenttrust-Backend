/**
 * Reputation Recompute Processor Tests
 *
 * Covers:
 * - Empty store → zero work, no error
 * - Single page (ids fit in one batch)
 * - Multi-page (ids span several batches → pagination is exercised)
 * - Per-subject error isolation (one failing subject does not abort the batch)
 * - Checkpoint writes (createCheckpoint, updateProgress, markCompleted are called)
 * - forceRecompute vs. skip-if-recent logic
 */

import { processReputationRecompute } from './reputation-recompute-processor';
import { reputationCheckpointStore } from '../../models/reputation-checkpoint.store';
import { reputationStore } from '../../models/reputation.store';
import { ReputationRepository } from '../../repositories/reputationRepository';
import { ReputationService } from '../../services/reputation.service';

// ── logger mock ──────────────────────────────────────────────────────────────
jest.mock('../../logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

// ── ReputationService mock ───────────────────────────────────────────────────
jest.mock('../../services/reputation.service', () => ({
  ReputationService: {
    getProfile: jest.fn(),
  },
}));

const mockGetProfile = ReputationService.getProfile as jest.Mock;

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal mock ReputationRepository whose getDistinctTargetIdPage
 * returns pages drawn from `ids` using the supplied limit/offset.
 */
function makeRepo(ids: string[]): jest.Mocked<Pick<ReputationRepository, 'getDistinctTargetIdPage'>> {
  return {
    getDistinctTargetIdPage: jest.fn((limit: number, offset: number) =>
      ids.slice(offset, offset + limit)
    ),
  } as unknown as jest.Mocked<Pick<ReputationRepository, 'getDistinctTargetIdPage'>>;
}

/** Returns a fresh profile stamped "48 hours ago" (stale → eligible for recompute). */
function staleProfile(id: string) {
  return {
    freelancerId: id,
    score: 4.0,
    jobsCompleted: 0,
    totalRatings: 1,
    reviews: [{ reviewerId: 'r1', rating: 4, createdAt: '2023-01-01T00:00:00.000Z' }],
    lastUpdated: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    weightedScore: 4.0,
    scoreAlgorithm: 'exp-decay-v1',
  };
}

/** Returns a fresh profile stamped "just now" (recent → skipped unless force). */
function freshProfile(id: string) {
  return {
    ...staleProfile(id),
    lastUpdated: new Date().toISOString(),
  };
}

// ── setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  reputationCheckpointStore.clear();
  reputationStore.clear();
  jest.clearAllMocks();
});

// ── empty store ──────────────────────────────────────────────────────────────

describe('empty store', () => {
  it('returns success with zero counts and writes no checkpoint progress', async () => {
    const updateSpy = jest.spyOn(reputationCheckpointStore, 'updateProgress');
    const repo = makeRepo([]);

    const result = await processReputationRecompute(
      { batchSize: 10, forceRecompute: false, resumeFromCheckpoint: false },
      repo as unknown as ReputationRepository
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ totalProcessed: 0, totalFreelancers: 0 });
    expect(updateSpy).not.toHaveBeenCalled();
  });
});

// ── single-page scenario ─────────────────────────────────────────────────────

describe('single page', () => {
  it('processes all IDs when they fit in one batch', async () => {
    const ids = ['u1', 'u2', 'u3'];
    const repo = makeRepo(ids);
    mockGetProfile.mockImplementation(staleProfile);

    const result = await processReputationRecompute(
      { batchSize: 10, forceRecompute: true, resumeFromCheckpoint: false },
      repo as unknown as ReputationRepository
    );

    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>).totalProcessed).toBe(3);
    // 3 ids < pageSize=10 → generator exits after the first partial page (no extra sentinel call)
    expect(repo.getDistinctTargetIdPage).toHaveBeenCalledTimes(1);
  });

  it('calls getDistinctTargetIdPage with correct limit and offset', async () => {
    const repo = makeRepo(['a', 'b']);
    mockGetProfile.mockImplementation(staleProfile);

    await processReputationRecompute(
      { batchSize: 50, forceRecompute: true, resumeFromCheckpoint: false },
      repo as unknown as ReputationRepository
    );

    // 2 ids < pageSize=50 → single call, no continuation needed
    expect(repo.getDistinctTargetIdPage).toHaveBeenCalledTimes(1);
    expect(repo.getDistinctTargetIdPage).toHaveBeenNthCalledWith(1, 50, 0);
  });
});

// ── multi-page scenario ──────────────────────────────────────────────────────

describe('multi-page pagination', () => {
  it('iterates all pages and processes every subject exactly once', async () => {
    const ids = Array.from({ length: 7 }, (_, i) => `subject-${i}`);
    const repo = makeRepo(ids);
    mockGetProfile.mockImplementation(staleProfile);

    const result = await processReputationRecompute(
      { batchSize: 3, forceRecompute: true, resumeFromCheckpoint: false },
      repo as unknown as ReputationRepository
    );

    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>).totalProcessed).toBe(7);

    // pages: [0-2]=full, [3-5]=full, [6]=partial → 3 calls (partial page exits loop)
    expect(repo.getDistinctTargetIdPage).toHaveBeenCalledTimes(3);
    expect(repo.getDistinctTargetIdPage).toHaveBeenNthCalledWith(1, 3, 0);
    expect(repo.getDistinctTargetIdPage).toHaveBeenNthCalledWith(2, 3, 3);
    expect(repo.getDistinctTargetIdPage).toHaveBeenNthCalledWith(3, 3, 6);
  });
});

// ── per-subject error isolation ──────────────────────────────────────────────

describe('per-subject error isolation', () => {
  it('continues processing remaining subjects when one throws', async () => {
    const ids = ['good-1', 'bad', 'good-2'];
    const repo = makeRepo(ids);

    mockGetProfile.mockImplementation((id: string) => {
      if (id === 'bad') throw new Error('db error');
      return staleProfile(id);
    });

    const result = await processReputationRecompute(
      { batchSize: 10, forceRecompute: true, resumeFromCheckpoint: false },
      repo as unknown as ReputationRepository
    );

    // job succeeds overall; two subjects processed, one skipped
    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>).totalProcessed).toBe(2);
  });

  it('processes zero subjects gracefully when all throw', async () => {
    const repo = makeRepo(['x', 'y']);
    mockGetProfile.mockImplementation(() => { throw new Error('boom'); });

    const result = await processReputationRecompute(
      { batchSize: 10, forceRecompute: true, resumeFromCheckpoint: false },
      repo as unknown as ReputationRepository
    );

    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>).totalProcessed).toBe(0);
  });
});

// ── checkpoint writes ────────────────────────────────────────────────────────

describe('checkpoint writes', () => {
  it('creates a checkpoint, updates progress per subject, and marks completed', async () => {
    const ids = ['s1', 's2'];
    const repo = makeRepo(ids);
    mockGetProfile.mockImplementation(staleProfile);

    const createSpy = jest.spyOn(reputationCheckpointStore, 'createCheckpoint');
    const updateSpy = jest.spyOn(reputationCheckpointStore, 'updateProgress');
    const completeSpy = jest.spyOn(reputationCheckpointStore, 'markCompleted');

    const result = await processReputationRecompute(
      { batchSize: 10, forceRecompute: true, resumeFromCheckpoint: false },
      repo as unknown as ReputationRepository
    );

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenCalledTimes(2); // once per subject
    expect(completeSpy).toHaveBeenCalledTimes(1);
    expect(result.data).toHaveProperty('checkpointId');
  });

  it('reuses the active checkpoint when resumeFromCheckpoint is true', async () => {
    const existingCp = reputationCheckpointStore.createCheckpoint('existing-job', 100);
    // leave it in 'running' state

    const createSpy = jest.spyOn(reputationCheckpointStore, 'createCheckpoint');
    const repo = makeRepo(['id1']);
    mockGetProfile.mockImplementation(staleProfile);

    await processReputationRecompute(
      { batchSize: 10, forceRecompute: true, resumeFromCheckpoint: true },
      repo as unknown as ReputationRepository
    );

    // Should not have called createCheckpoint again (existing active checkpoint reused)
    expect(createSpy).toHaveBeenCalledTimes(1); // the one we set up above
    const resultCp = reputationCheckpointStore.getCheckpoint(existingCp.jobId);
    expect(resultCp?.status).toBe('completed');
  });

  it('creates a fresh checkpoint when resumeFromCheckpoint is false even if active one exists', async () => {
    reputationCheckpointStore.createCheckpoint('old-job', 50);

    const createSpy = jest.spyOn(reputationCheckpointStore, 'createCheckpoint');
    const repo = makeRepo(['id1']);
    mockGetProfile.mockImplementation(staleProfile);

    await processReputationRecompute(
      { batchSize: 10, forceRecompute: true, resumeFromCheckpoint: false },
      repo as unknown as ReputationRepository
    );

    expect(createSpy).toHaveBeenCalledTimes(2); // old + new
  });
});

// ── skip-if-recent logic ─────────────────────────────────────────────────────

describe('forceRecompute flag', () => {
  it('skips recently updated profiles when forceRecompute is false', async () => {
    const ids = ['recent-1', 'recent-2'];
    const repo = makeRepo(ids);
    mockGetProfile.mockImplementation(freshProfile); // last updated = now

    const result = await processReputationRecompute(
      { batchSize: 10, forceRecompute: false, resumeFromCheckpoint: false },
      repo as unknown as ReputationRepository
    );

    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>).totalProcessed).toBe(0);
  });

  it('processes all profiles when forceRecompute is true regardless of recency', async () => {
    const ids = ['recent-1', 'recent-2'];
    const repo = makeRepo(ids);
    mockGetProfile.mockImplementation(freshProfile);

    const result = await processReputationRecompute(
      { batchSize: 10, forceRecompute: true, resumeFromCheckpoint: false },
      repo as unknown as ReputationRepository
    );

    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>).totalProcessed).toBe(2);
  });
});

// ── persists profile to store ─────────────────────────────────────────────────

describe('store persistence', () => {
  it('writes the profile returned by ReputationService.getProfile into the reputation store', async () => {
    const ids = ['target-x'];
    const repo = makeRepo(ids);
    const profile = staleProfile('target-x');
    mockGetProfile.mockReturnValue(profile);

    await processReputationRecompute(
      { batchSize: 10, forceRecompute: true, resumeFromCheckpoint: false },
      repo as unknown as ReputationRepository
    );

    expect(reputationStore.get('target-x')).toEqual(profile);
  });
});
