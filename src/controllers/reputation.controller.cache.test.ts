/**
 * Tests for the cache integration in ReputationController.
 *
 * Covers:
 *  - getProfile: cold cache calls service and populates cache
 *  - getProfile: warm cache returns stored value without calling service
 *  - getProfile: TTL-expired entry calls service again
 *  - createRating: invalidates the cache entry for the rated freelancer
 *  - createRating: invalidation is no-op when nothing was cached
 *  - Metrics accumulate correctly across controller calls
 */

import { Request, Response } from 'express';
import { ReputationController } from './reputation.controller';
import { ReputationService } from '../services/reputation.service';
import { reputationCache, initReputationCache, DEFAULT_REPUTATION_CACHE_TTL_MS, DEFAULT_REPUTATION_CACHE_MAX_ENTRIES } from '../utils/reputationCache';
import { ReputationProfile } from '../types/reputation';
import { ForbiddenError, AppError } from '../errors/appError';

jest.mock('../services/reputation.service');

// ── helpers ──────────────────────────────────────────────────────────────────

function makeRes(): { res: Partial<Response>; statusMock: jest.Mock; jsonMock: jest.Mock; nextMock: jest.Mock } {
  const jsonMock = jest.fn();
  const statusMock = jest.fn().mockReturnValue({ json: jsonMock });
  const nextMock = jest.fn();
  const res = {
    status: statusMock,
    locals: {
      requestId: 'test-req-id',
      correlationId: 'test-corr-id',
    },
  } as unknown as Response;
  return { res, statusMock, jsonMock, nextMock };
}

function makeGetReq(id = 'user-1'): Partial<Request> {
  return { params: { id }, body: {} };
}

function makeWriteReq(id = 'user-1', body = { reviewerId: 'reviewer-1', rating: 4 }): Partial<Request> {
  return { params: { id }, body };
}

function fakeProfile(id = 'user-1', score = 4.5): ReputationProfile {
  return {
    freelancerId: id,
    score,
    jobsCompleted: 0,
    totalRatings: 1,
    reviews: [],
    lastUpdated: new Date().toISOString(),
    weightedScore: score,
    scoreAlgorithm: 'exp-decay-v1',
  };
}

// ── setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  // Reset the singleton to a known small TTL so tests can control expiry
  initReputationCache({ ttlMs: 1_000, maxEntries: 10 });
  reputationCache.clear();
  reputationCache.resetMetrics();
});

afterEach(() => {
  jest.useRealTimers();
  // Restore singleton to default state for other test suites
  initReputationCache({ ttlMs: DEFAULT_REPUTATION_CACHE_TTL_MS, maxEntries: DEFAULT_REPUTATION_CACHE_MAX_ENTRIES });
});

// ── getProfile — cold cache (service called, result cached) ──────────────────

describe('ReputationController.getProfile — cold cache', () => {
  it('calls ReputationService.getProfile on first request', async () => {
    const p = fakeProfile();
    (ReputationService.getProfile as jest.Mock).mockReturnValue(p);

    const { res } = makeRes();
    await ReputationController.getProfile(makeGetReq() as Request, res as Response);

    expect(ReputationService.getProfile).toHaveBeenCalledTimes(1);
    expect(ReputationService.getProfile).toHaveBeenCalledWith('user-1');
  });

  it('returns 200 with profile data on cold cache miss', async () => {
    const p = fakeProfile();
    (ReputationService.getProfile as jest.Mock).mockReturnValue(p);

    const { res, statusMock, jsonMock } = makeRes();
    await ReputationController.getProfile(makeGetReq() as Request, res as Response);

    expect(statusMock).toHaveBeenCalledWith(200);
    expect(jsonMock).toHaveBeenCalledWith({ status: 'success', data: p, correlationId: 'test-corr-id' });
  });

  it('populates the cache after the first miss', async () => {
    const p = fakeProfile();
    (ReputationService.getProfile as jest.Mock).mockReturnValue(p);

    const { res } = makeRes();
    await ReputationController.getProfile(makeGetReq() as Request, res as Response);

    expect(reputationCache.get('user-1')).toEqual(p);
  });

  it('miss metric increments on cold cache hit', async () => {
    (ReputationService.getProfile as jest.Mock).mockReturnValue(fakeProfile());
    const { res } = makeRes();
    await ReputationController.getProfile(makeGetReq() as Request, res as Response);
    // The controller itself does not touch metrics counters directly —
    // the cache records the miss internally before the service is called
    // (get() returns undefined → miss counter++)
    expect(reputationCache.getMetrics().misses).toBe(1);
  });
});

// ── getProfile — warm cache (service NOT called) ─────────────────────────────

describe('ReputationController.getProfile — cache hit', () => {
  it('does NOT call ReputationService.getProfile on second request', async () => {
    const p = fakeProfile();
    (ReputationService.getProfile as jest.Mock).mockReturnValue(p);

    const { res: r1 } = makeRes();
    await ReputationController.getProfile(makeGetReq() as Request, r1 as Response);
    jest.clearAllMocks();

    const { res: r2 } = makeRes();
    await ReputationController.getProfile(makeGetReq() as Request, r2 as Response);

    expect(ReputationService.getProfile).not.toHaveBeenCalled();
  });

  it('returns 200 with the cached profile on second request', async () => {
    const p = fakeProfile('user-1', 4.8);
    (ReputationService.getProfile as jest.Mock).mockReturnValue(p);

    const { res: r1 } = makeRes();
    await ReputationController.getProfile(makeGetReq() as Request, r1 as Response);

    const { res: r2, statusMock, jsonMock } = makeRes();
    await ReputationController.getProfile(makeGetReq() as Request, r2 as Response);

    expect(statusMock).toHaveBeenCalledWith(200);
    expect(jsonMock).toHaveBeenCalledWith({ status: 'success', data: p, correlationId: 'test-corr-id' });
  });

  it('hit metric increments on second request', async () => {
    (ReputationService.getProfile as jest.Mock).mockReturnValue(fakeProfile());
    const { res: r1 } = makeRes();
    await ReputationController.getProfile(makeGetReq() as Request, r1 as Response);

    const { res: r2 } = makeRes();
    await ReputationController.getProfile(makeGetReq() as Request, r2 as Response);

    expect(reputationCache.getMetrics().hits).toBe(1);
  });

  it('different keys are cached independently', async () => {
    const p1 = fakeProfile('user-1', 4.0);
    const p2 = fakeProfile('user-2', 3.0);
    (ReputationService.getProfile as jest.Mock)
      .mockReturnValueOnce(p1)
      .mockReturnValueOnce(p2);

    const { res: r1 } = makeRes();
    await ReputationController.getProfile(makeGetReq('user-1') as Request, r1 as Response);
    const { res: r2 } = makeRes();
    await ReputationController.getProfile(makeGetReq('user-2') as Request, r2 as Response);

    // Service called once per unique key
    expect(ReputationService.getProfile).toHaveBeenCalledTimes(2);

    // Third call for user-1 hits cache
    jest.clearAllMocks();
    const { res: r3, jsonMock } = makeRes();
    await ReputationController.getProfile(makeGetReq('user-1') as Request, r3 as Response);
    expect(ReputationService.getProfile).not.toHaveBeenCalled();
    expect(jsonMock).toHaveBeenCalledWith({ status: 'success', data: p1, correlationId: 'test-corr-id' });
  });
});

// ── getProfile — TTL expiry (cache treated as miss after TTL) ─────────────────

describe('ReputationController.getProfile — TTL expiry', () => {
  it('calls service again after TTL has elapsed', async () => {
    const p = fakeProfile();
    (ReputationService.getProfile as jest.Mock).mockReturnValue(p);

    const { res: r1 } = makeRes();
    await ReputationController.getProfile(makeGetReq() as Request, r1 as Response);
    expect(ReputationService.getProfile).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(1_001); // past 1 s TTL

    jest.clearAllMocks();
    (ReputationService.getProfile as jest.Mock).mockReturnValue(fakeProfile('user-1', 5.0));

    const { res: r2, jsonMock } = makeRes();
    await ReputationController.getProfile(makeGetReq() as Request, r2 as Response);
    expect(ReputationService.getProfile).toHaveBeenCalledTimes(1);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ score: 5.0 }) }),
    );
  });
});

// ── createRating — cache invalidation ────────────────────────────────────────

describe('ReputationController.createRating — cache invalidation', () => {
  it('invalidates the cache for the rated freelancer after a write', async () => {
    // Prime the cache
    const p = fakeProfile();
    (ReputationService.getProfile as jest.Mock).mockReturnValue(p);
    const { res: rGet } = makeRes();
    await ReputationController.getProfile(makeGetReq() as Request, rGet as Response);
    expect(reputationCache.get('user-1')).toBeDefined();

    // Write invalidates it
    const { res: rPut } = makeRes();
    await ReputationController.createRating(makeWriteReq() as Request, rPut as Response);
    expect(reputationCache.get('user-1')).toBeUndefined();
  });

  it('forces the next GET to re-fetch from service after invalidation', async () => {
    const p1 = fakeProfile('user-1', 3.0);
    // createRating internally calls getProfile (as the updateProfile fallback),
    // so we need 3 mock return values: first GET, createRating internal call, second GET.
    const p2 = fakeProfile('user-1', 4.5);
    (ReputationService.getProfile as jest.Mock)
      .mockReturnValueOnce(p1)  // first GET (miss → service)
      .mockReturnValueOnce(p1)  // createRating internal getProfile call
      .mockReturnValueOnce(p2); // second GET (miss after invalidation → service)

    // First GET — populates cache
    const { res: r1 } = makeRes();
    await ReputationController.getProfile(makeGetReq() as Request, r1 as Response);
    expect(reputationCache.get('user-1')).toBeDefined();

    // Write — invalidates cache entry
    const { res: rPut } = makeRes();
    await ReputationController.createRating(makeWriteReq() as Request, rPut as Response);
    expect(reputationCache.get('user-1')).toBeUndefined();

    // Second GET — cache is cold again, must call service
    const { res: r2, jsonMock } = makeRes();
    await ReputationController.getProfile(makeGetReq() as Request, r2 as Response);
    expect(jsonMock).toHaveBeenCalledWith({ status: 'success', data: p2, correlationId: 'test-corr-id' });
  });

  it('invalidation is a no-op when no profile was cached (no error)', async () => {
    (ReputationService.getProfile as jest.Mock).mockReturnValue(fakeProfile());
    const { res, statusMock } = makeRes();
    await expect(
      ReputationController.createRating(makeWriteReq() as Request, res as Response),
    ).resolves.not.toThrow();
    expect(statusMock).toHaveBeenCalledWith(200);
  });

  it('only invalidates the matching key, not other cached profiles', async () => {
    const pA = fakeProfile('user-a');
    const pB = fakeProfile('user-b');
    (ReputationService.getProfile as jest.Mock)
      .mockReturnValueOnce(pA)
      .mockReturnValueOnce(pB);

    const { res: rA } = makeRes();
    await ReputationController.getProfile(makeGetReq('user-a') as Request, rA as Response);
    const { res: rB } = makeRes();
    await ReputationController.getProfile(makeGetReq('user-b') as Request, rB as Response);

    // Invalidate only user-a
    const { res: rPut } = makeRes();
    await ReputationController.createRating(makeWriteReq('user-a') as Request, rPut as Response);

    expect(reputationCache.get('user-a')).toBeUndefined();
    expect(reputationCache.get('user-b')).toEqual(pB);
  });

  it('returns 400 for invalid payload (validation guard still works)', async () => {
    const { res, statusMock } = makeRes();
    await ReputationController.createRating(
      makeWriteReq('user-1', { rating: 99 }) as Request,
      res as Response,
    );
    expect(statusMock).toHaveBeenCalledWith(400);
  });

  it('returns 403 when service throws ForbiddenError', async () => {
    (ReputationService.getProfile as jest.Mock).mockImplementation(() => {
      throw new ForbiddenError('cannot rate');
    });
    const { res, statusMock } = makeRes();
    await ReputationController.createRating(makeWriteReq() as Request, res as Response);
    expect(statusMock).toHaveBeenCalledWith(403);
  });

  it('returns the AppError statusCode when service throws a raw AppError', async () => {
    (ReputationService.getProfile as jest.Mock).mockImplementation(() => {
      throw new AppError(418, 'teapot', "I'm a teapot");
    });
    const { res, statusMock, jsonMock } = makeRes();
    await ReputationController.createRating(makeWriteReq() as Request, res as Response);
    expect(statusMock).toHaveBeenCalledWith(418);
    expect(jsonMock).toHaveBeenCalledWith({
      error: {
        code: 'teapot',
        message: "I'm a teapot",
        requestId: 'test-req-id',
        correlationId: 'test-corr-id',
      },
    });
  });

  it('returns 500 for an unknown error thrown from service', async () => {
    (ReputationService.getProfile as jest.Mock).mockImplementation(() => {
      throw new Error('unexpected boom');
    });
    const { res, statusMock, jsonMock } = makeRes();
    await ReputationController.createRating(makeWriteReq() as Request, res as Response);
    expect(statusMock).toHaveBeenCalledWith(500);
    expect(jsonMock).toHaveBeenCalledWith({
      error: {
        code: 'internal_error',
        message: 'An unexpected error occurred',
        requestId: 'test-req-id',
        correlationId: 'test-corr-id',
      },
    });
  });
});

// ── error paths — cache is not polluted ──────────────────────────────────────

describe('ReputationController.getProfile — error paths do not pollute cache', () => {
  it('does not cache anything when service throws', async () => {
    (ReputationService.getProfile as jest.Mock).mockImplementation(() => {
      throw new Error('DB error');
    });

    const { res } = makeRes();
    await ReputationController.getProfile(makeGetReq() as Request, res as Response);
    expect(reputationCache.get('user-1')).toBeUndefined();
    expect(reputationCache.size).toBe(0);
  });

  it('returns 400 for missing-ID error without caching', async () => {
    (ReputationService.getProfile as jest.Mock).mockImplementation(() => {
      throw new Error('Freelancer ID is required');
    });

    const { res, statusMock } = makeRes();
    await ReputationController.getProfile(makeGetReq() as Request, res as Response);
    expect(statusMock).toHaveBeenCalledWith(400);
    expect(reputationCache.size).toBe(0);
  });
});
