import { NextFunction, Request, Response } from 'express';
import { ReputationController } from './reputation.controller';
import { ReputationService } from '../services/reputation.service';
import {
  ForbiddenError,
  ConflictError,
  ValidationError,
  AppError,
} from '../errors/appError';
import { updateReputationSchema } from '../modules/reputation/dto/reputation.dto';
import { encodeCursor } from '../contracts/cursor.repository';
import type { ReputationProfile } from '../types/reputation';
import { reputationCache } from '../utils/reputationCache';

jest.mock('../services/reputation.service');

const completeProfile = (overrides: Partial<ReputationProfile> = {}): ReputationProfile => ({
  freelancerId: 'user-1',
  score: 4.5,
  jobsCompleted: 5,
  totalRatings: 10,
  reviews: [
    { reviewerId: 'reviewer-1', rating: 5, comment: 'Great', createdAt: '2024-01-01T00:00:00.000Z' },
  ],
  lastUpdated: '2024-02-01T00:00:00.000Z',
  weightedScore: 4.3,
  scoreAlgorithm: 'exp-decay-v1',
  ...overrides,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRes(): { res: Partial<Response>; statusMock: jest.Mock; jsonMock: jest.Mock; nextMock: jest.Mock } {
  const jsonMock = jest.fn();
  const statusMock = jest.fn().mockReturnValue({ json: jsonMock });
  const nextMock = jest.fn();
  const res: Partial<Response> = {
    status: statusMock,
    locals: { requestId: 'test-request-id' },
  } as unknown as Response;
  return { res, statusMock, jsonMock, nextMock };
}

function makeReq(overrides: Partial<Request> = {}): Partial<Request> {
  return { params: { id: 'user-1' }, query: {}, body: {}, ...overrides };
}

// ---------------------------------------------------------------------------
// DTO Schema unit tests — validate boundary enforcement before the controller
// ---------------------------------------------------------------------------

describe('updateReputationSchema — rating field validation', () => {
  const validBase = {
    reviewerId: 'reviewer-1',
    contextId: '550e8400-e29b-41d4-a716-446655440000',
  };

  describe('valid ratings', () => {
    it.each([1, 2, 3, 4, 5])('accepts rating = %i (boundary inclusive)', (rating) => {
      const result = updateReputationSchema.safeParse({ ...validBase, rating });
      expect(result.success).toBe(true);
    });
  });

  describe('below minimum', () => {
    it('rejects rating = 0 (min - 1)', () => {
      const result = updateReputationSchema.safeParse({ ...validBase, rating: 0 });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toMatch(/at least 1/i);
      }
    });

    it('rejects rating = -1', () => {
      const result = updateReputationSchema.safeParse({ ...validBase, rating: -1 });
      expect(result.success).toBe(false);
    });
  });

  describe('above maximum', () => {
    it('rejects rating = 6 (max + 1)', () => {
      const result = updateReputationSchema.safeParse({ ...validBase, rating: 6 });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toMatch(/at most 5/i);
      }
    });

    it('rejects rating = 100', () => {
      const result = updateReputationSchema.safeParse({ ...validBase, rating: 100 });
      expect(result.success).toBe(false);
    });
  });

  describe('non-integer values', () => {
    it('rejects decimal rating = 1.5', () => {
      const result = updateReputationSchema.safeParse({ ...validBase, rating: 1.5 });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toMatch(/integer/i);
      }
    });

    it('rejects decimal rating = 4.9', () => {
      const result = updateReputationSchema.safeParse({ ...validBase, rating: 4.9 });
      expect(result.success).toBe(false);
    });

    it('rejects decimal rating = 3.0001', () => {
      const result = updateReputationSchema.safeParse({ ...validBase, rating: 3.0001 });
      expect(result.success).toBe(false);
    });
  });

  describe('NaN and Infinity', () => {
    it('rejects NaN', () => {
      const result = updateReputationSchema.safeParse({ ...validBase, rating: NaN });
      expect(result.success).toBe(false);
    });

    it('rejects Infinity', () => {
      const result = updateReputationSchema.safeParse({ ...validBase, rating: Infinity });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toMatch(/finite/i);
      }
    });

    it('rejects -Infinity', () => {
      const result = updateReputationSchema.safeParse({ ...validBase, rating: -Infinity });
      expect(result.success).toBe(false);
    });
  });

  describe('wrong type', () => {
    it('rejects string rating', () => {
      const result = updateReputationSchema.safeParse({ ...validBase, rating: '3' });
      expect(result.success).toBe(false);
    });

    it('rejects null rating', () => {
      const result = updateReputationSchema.safeParse({ ...validBase, rating: null });
      expect(result.success).toBe(false);
    });

    it('rejects missing rating', () => {
      const result = updateReputationSchema.safeParse({ ...validBase });
      expect(result.success).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// ReputationController — thin adapter delegating to ReputationService
// ---------------------------------------------------------------------------

describe('ReputationController.getProfile', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    reputationCache.clear();
  });

  it('returns 200 with profile data on success', async () => {
    const mockProfile = completeProfile();
    (ReputationService.getProfile as jest.Mock).mockReturnValue(mockProfile);

    const { res, statusMock, jsonMock, nextMock } = makeRes();
    await ReputationController.getProfile(makeReq() as Request, res as Response, nextMock as NextFunction);

    expect(statusMock).toHaveBeenCalledWith(200);
    expect(jsonMock).toHaveBeenCalledWith({ status: 'success', data: expect.objectContaining({
      freelancerId: 'user-1',
      score: 4.5,
      totalRatings: 10,
    }) });
  });

  it('returns 400 with structured error when service throws AppError(400, bad_request)', async () => {
    (ReputationService.getProfile as jest.Mock).mockImplementation(() => {
      throw new AppError(400, 'bad_request', 'Freelancer ID is required');
    });

    const { res, nextMock } = makeRes();
    await ReputationController.getProfile(makeReq() as Request, res as Response, nextMock as NextFunction);

    expect(nextMock).toHaveBeenCalledTimes(1);
    const error = nextMock.mock.calls[0][0];
    expect(error).toBeInstanceOf(AppError);
    expect(error.statusCode).toBe(400);
    expect(error.code).toBe('bad_request');
    expect(error.message).toBe('Freelancer ID is required');
  });

  it('forwards unknown errors to next unchanged', async () => {
    (ReputationService.getProfile as jest.Mock).mockImplementation(() => {
      throw new Error('Database down');
    });

    const { res, nextMock } = makeRes();
    await ReputationController.getProfile(makeReq() as Request, res as Response, nextMock as NextFunction);

    expect(nextMock).toHaveBeenCalledTimes(1);
    const error = nextMock.mock.calls[0][0];
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Database down');
  });
});

// ---------------------------------------------------------------------------
// ReputationController.createRating — thin adapter, no inline validation
// ---------------------------------------------------------------------------

describe('ReputationController.createRating', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    reputationCache.clear();
  });

  const validBody = {
    reviewerId: 'reviewer-1',
    contextId: '550e8400-e29b-41d4-a716-446655440000',
    rating: 4,
  };

  it('returns 200 with updated profile when service succeeds', async () => {
    const mockProfile = completeProfile();
    (ReputationService.updateProfile as jest.Mock).mockReturnValue(mockProfile);

    const { res, statusMock, jsonMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: validBody }) as Request,
      res as Response
    );

    expect(statusMock).toHaveBeenCalledWith(200);
    expect(jsonMock).toHaveBeenCalledWith({ status: 'success', data: mockProfile });
    expect(ReputationService.updateProfile).toHaveBeenCalledWith('user-1', expect.objectContaining({ reviewerId: 'reviewer-1', rating: 4 }), undefined);
  });

  // --- 400: missing/invalid payload — service throws AppError(400, bad_request) ---

  it('returns 400 when reviewerId is missing', async () => {
    (ReputationService.updateProfile as jest.Mock).mockImplementation(() => {
      throw new AppError(400, 'bad_request', 'Invalid payload: reviewerId and a valid integer rating (1\u20135) are required');
    });
    const { res, statusMock, jsonMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: { rating: 3 } }) as Request,
      res as Response
    );
    expect(statusMock).toHaveBeenCalledWith(400);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'bad_request' }) })
    );
  });

  it('returns 400 when rating is missing', async () => {
    (ReputationService.updateProfile as jest.Mock).mockImplementation(() => {
      throw new AppError(400, 'bad_request', 'Invalid payload: reviewerId and a valid integer rating (1\u20135) are required');
    });
    const { res, statusMock, nextMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: { reviewerId: 'reviewer-1' } }) as Request,
      res as Response,
      nextMock as NextFunction
    );
    expect(nextMock).toHaveBeenCalledTimes(1);
    const error = nextMock.mock.calls[0][0];
    expect(error).toBeInstanceOf(AppError);
    expect(error.statusCode).toBe(400);
  });

  it('returns 400 when rating = 0 (min - 1)', async () => {
    (ReputationService.updateProfile as jest.Mock).mockImplementation(() => {
      throw new AppError(400, 'bad_request', 'Invalid payload: reviewerId and a valid integer rating (1\u20135) are required');
    });
    const { res, statusMock, jsonMock, nextMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: { ...validBody, rating: 0 } }) as Request,
      res as Response,
      nextMock as NextFunction
    );
    expect(nextMock).toHaveBeenCalledTimes(1);
    const error = nextMock.mock.calls[0][0];
    expect(error).toBeInstanceOf(AppError);
    expect(error.statusCode).toBe(400);
    expect(error.code).toBe('bad_request');
  });

  it('returns 400 when rating = 6 (max + 1)', async () => {
    (ReputationService.updateProfile as jest.Mock).mockImplementation(() => {
      throw new AppError(400, 'bad_request', 'Invalid payload: reviewerId and a valid integer rating (1\u20135) are required');
    });
    const { res, statusMock, nextMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: { ...validBody, rating: 6 } }) as Request,
      res as Response,
      nextMock as NextFunction
    );
    expect(nextMock).toHaveBeenCalledTimes(1);
    const error = nextMock.mock.calls[0][0];
    expect(error).toBeInstanceOf(AppError);
    expect(error.statusCode).toBe(400);
  });

  it('returns 400 when rating = -1', async () => {
    (ReputationService.updateProfile as jest.Mock).mockImplementation(() => {
      throw new AppError(400, 'bad_request', 'Invalid payload: reviewerId and a valid integer rating (1\u20135) are required');
    });
    const { res, statusMock, nextMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: { ...validBody, rating: -1 } }) as Request,
      res as Response,
      nextMock as NextFunction
    );
    expect(nextMock).toHaveBeenCalledTimes(1);
    const error = nextMock.mock.calls[0][0];
    expect(error).toBeInstanceOf(AppError);
    expect(error.statusCode).toBe(400);
  });

  it('returns 400 when rating = 1.5 (decimal)', async () => {
    (ReputationService.updateProfile as jest.Mock).mockImplementation(() => {
      throw new AppError(400, 'bad_request', 'Invalid payload: reviewerId and a valid integer rating (1\u20135) are required');
    });
    const { res, statusMock, nextMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: { ...validBody, rating: 1.5 } }) as Request,
      res as Response,
      nextMock as NextFunction
    );
    expect(nextMock).toHaveBeenCalledTimes(1);
    const error = nextMock.mock.calls[0][0];
    expect(error).toBeInstanceOf(AppError);
    expect(error.statusCode).toBe(400);
  });

  it('returns 400 when rating = NaN', async () => {
    (ReputationService.updateProfile as jest.Mock).mockImplementation(() => {
      throw new AppError(400, 'bad_request', 'Invalid payload: reviewerId and a valid integer rating (1\u20135) are required');
    });
    const { res, statusMock, nextMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: { ...validBody, rating: NaN } }) as Request,
      res as Response,
      nextMock as NextFunction
    );
    expect(nextMock).toHaveBeenCalledTimes(1);
    const error = nextMock.mock.calls[0][0];
    expect(error).toBeInstanceOf(AppError);
    expect(error.statusCode).toBe(400);
  });

  it('returns 400 when rating = Infinity', async () => {
    (ReputationService.updateProfile as jest.Mock).mockImplementation(() => {
      throw new AppError(400, 'bad_request', 'Invalid payload: reviewerId and a valid integer rating (1\u20135) are required');
    });
    const { res, statusMock, nextMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: { ...validBody, rating: Infinity } }) as Request,
      res as Response,
      nextMock as NextFunction
    );
    expect(nextMock).toHaveBeenCalledTimes(1);
    const error = nextMock.mock.calls[0][0];
    expect(error).toBeInstanceOf(AppError);
    expect(error.statusCode).toBe(400);
  });

  // --- 403 / 409 / 422: AppError subclasses from createRating guards ---

  it('returns 403 with structured error when service throws ForbiddenError', async () => {
    (ReputationService.updateProfile as jest.Mock).mockImplementation(() => {
      throw new ForbiddenError('Users cannot rate themselves');
    });
    const { res, statusMock, jsonMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: validBody }) as Request,
      res as Response
    );
    expect(statusMock).toHaveBeenCalledWith(403);
    expect(jsonMock).toHaveBeenCalledWith({
      error: {
        code: 'forbidden',
        message: 'Users cannot rate themselves',
        requestId: 'test-request-id',
      },
    });
  });

  it('returns 409 with structured error when service throws ConflictError', async () => {
    (ReputationService.updateProfile as jest.Mock).mockImplementation(() => {
      throw new ConflictError('A rating already exists for this contract context');
    });
    const { res, statusMock, jsonMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: validBody }) as Request,
      res as Response
    );
    expect(statusMock).toHaveBeenCalledWith(409);
    expect(jsonMock).toHaveBeenCalledWith({
      error: {
        code: 'conflict',
        message: 'A rating already exists for this contract context',
        requestId: 'test-request-id',
      },
    });
  });

  it('returns 422 with structured error when service throws ValidationError', async () => {
    (ReputationService.updateProfile as jest.Mock).mockImplementation(() => {
      throw new ValidationError('Comment contains spam');
    });
    const { res, statusMock, jsonMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: validBody }) as Request,
      res as Response
    );
    expect(statusMock).toHaveBeenCalledWith(422);
    expect(jsonMock).toHaveBeenCalledWith({
      error: {
        code: 'validation_error',
        message: 'Comment contains spam',
        requestId: 'test-request-id',
      },
    });
  });

  it('returns 500 with structured error for unknown service errors', async () => {
    (ReputationService.updateProfile as jest.Mock).mockImplementation(() => {
      throw new Error('Unexpected failure');
    });
    const { res, statusMock, jsonMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: validBody }) as Request,
      res as Response
    );
    expect(statusMock).toHaveBeenCalledWith(500);
    expect(jsonMock).toHaveBeenCalledWith({
      error: {
        code: 'internal_error',
        message: 'An unexpected error occurred',
        requestId: 'test-request-id',
      },
    });
  });
});

// ---------------------------------------------------------------------------
// ReputationController.createRating — defense-in-depth guard
// ---------------------------------------------------------------------------

describe('ReputationController.createRating', () => {
  beforeEach(() => jest.resetAllMocks());

  const validBody = {
    reviewerId: 'reviewer-1',
    contextId: '550e8400-e29b-41d4-a716-446655440000',
    rating: 4,
  };

  it('returns 200 when payload is valid', async () => {
    const mockProfile = completeProfile({ score: 4.0, totalRatings: 1 });
    (ReputationService.getProfile as jest.Mock).mockReturnValue(mockProfile);

    const { res, statusMock, jsonMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: validBody }) as Request,
      res as Response
    );

    expect(statusMock).toHaveBeenCalledWith(200);
    expect(jsonMock).toHaveBeenCalledWith({ status: 'success', data: expect.objectContaining({
      freelancerId: 'user-1',
      score: 4.0,
      totalRatings: 1,
    }) });
  });

  // --- Missing / invalid required fields ---

  it('returns 400 when reviewerId is missing', async () => {
    const { res, statusMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: { rating: 3 } }) as Request,
      res as Response
    );
    expect(statusMock).toHaveBeenCalledWith(400);
  });

  it('returns 400 when rating is missing', async () => {
    const { res, statusMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: { reviewerId: 'reviewer-1' } }) as Request,
      res as Response
    );
    expect(statusMock).toHaveBeenCalledWith(400);
  });

  // --- Out-of-range rating values ---

  it('returns 400 when rating = 0 (min - 1)', async () => {
    const { res, statusMock, jsonMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: { ...validBody, rating: 0 } }) as Request,
      res as Response
    );
    expect(statusMock).toHaveBeenCalledWith(400);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'bad_request' }) })
    );
  });

  it('returns 400 when rating = 6 (max + 1)', async () => {
    const { res, statusMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: { ...validBody, rating: 6 } }) as Request,
      res as Response
    );
    expect(statusMock).toHaveBeenCalledWith(400);
  });

  it('returns 400 when rating = -1', async () => {
    const { res, statusMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: { ...validBody, rating: -1 } }) as Request,
      res as Response
    );
    expect(statusMock).toHaveBeenCalledWith(400);
  });

  it('returns 400 when rating = 100', async () => {
    const { res, statusMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: { ...validBody, rating: 100 } }) as Request,
      res as Response
    );
    expect(statusMock).toHaveBeenCalledWith(400);
  });

  // --- Non-integer ratings ---

  it('returns 400 when rating = 1.5 (decimal)', async () => {
    const { res, statusMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: { ...validBody, rating: 1.5 } }) as Request,
      res as Response
    );
    expect(statusMock).toHaveBeenCalledWith(400);
  });

  it('returns 400 when rating = 4.9 (decimal)', async () => {
    const { res, statusMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: { ...validBody, rating: 4.9 } }) as Request,
      res as Response
    );
    expect(statusMock).toHaveBeenCalledWith(400);
  });

  // --- NaN and Infinity ---

  it('returns 400 when rating = NaN', async () => {
    const { res, statusMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: { ...validBody, rating: NaN } }) as Request,
      res as Response
    );
    expect(statusMock).toHaveBeenCalledWith(400);
  });

  it('returns 400 when rating = Infinity', async () => {
    const { res, statusMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: { ...validBody, rating: Infinity } }) as Request,
      res as Response
    );
    expect(statusMock).toHaveBeenCalledWith(400);
  });

  it('returns 400 when rating = -Infinity', async () => {
    const { res, statusMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: { ...validBody, rating: -Infinity } }) as Request,
      res as Response
    );
    expect(statusMock).toHaveBeenCalledWith(400);
  });

  // --- Boundary: valid edge values ---

  it('accepts rating = 1 (minimum)', async () => {
    const mockProfile = completeProfile({ score: 1.0, totalRatings: 1 });
    (ReputationService.getProfile as jest.Mock).mockReturnValue(mockProfile);

    const { res, statusMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: { ...validBody, rating: 1 } }) as Request,
      res as Response
    );
    expect(statusMock).toHaveBeenCalledWith(200);
  });

  it('accepts rating = 5 (maximum)', async () => {
    const mockProfile = completeProfile({ score: 5.0, totalRatings: 1 });
    (ReputationService.getProfile as jest.Mock).mockReturnValue(mockProfile);

    const { res, statusMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: { ...validBody, rating: 5 } }) as Request,
      res as Response
    );
    expect(statusMock).toHaveBeenCalledWith(200);
  });

  // --- Service-layer errors are surfaced correctly ---

  it('returns 403 when service throws ForbiddenError', async () => {
    (ReputationService.getProfile as jest.Mock).mockImplementation(() => {
      throw new ForbiddenError('Users cannot rate themselves');
    });

    const { res, statusMock, jsonMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: validBody }) as Request,
      res as Response
    );

    expect(statusMock).toHaveBeenCalledWith(403);
    expect(jsonMock).toHaveBeenCalledWith({
      error: {
        code: 'forbidden',
        message: 'Users cannot rate themselves',
        requestId: 'test-request-id',
      },
    });
  });

  it('returns 409 when service throws ConflictError', async () => {
    (ReputationService.getProfile as jest.Mock).mockImplementation(() => {
      throw new ConflictError('Rating already exists');
    });

    const { res, statusMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: validBody }) as Request,
      res as Response
    );

    expect(statusMock).toHaveBeenCalledWith(409);
  });

  it('returns 422 when service throws ValidationError', async () => {
    (ReputationService.getProfile as jest.Mock).mockImplementation(() => {
      throw new ValidationError('Comment contains spam');
    });

    const { res, statusMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: validBody }) as Request,
      res as Response
    );

    expect(statusMock).toHaveBeenCalledWith(422);
  });

  it('returns 500 for unknown service errors', async () => {
    (ReputationService.getProfile as jest.Mock).mockImplementation(() => {
      throw new Error('Unexpected failure');
    });

    const { res, statusMock, jsonMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: validBody }) as Request,
      res as Response
    );

    expect(statusMock).toHaveBeenCalledWith(500);
    expect(jsonMock).toHaveBeenCalledWith({
      error: {
        code: 'internal_error',
        message: 'An unexpected error occurred',
        requestId: 'test-request-id',
      },
    });
  });
});

// ─── Cursor-paginated getProfile ─────────────────────────────────────────

describe('ReputationController.getProfile — cursor pagination', () => {
  const mockProfile = {
    freelancerId: 'user-1',
    score: 4.0,
    totalRatings: 25,
    reviews: [
      { reviewerId: 'r1', rating: 5, createdAt: '2024-01-01T00:00:00.000Z' },
      { reviewerId: 'r2', rating: 4, createdAt: '2024-01-02T00:00:00.000Z' },
    ],
    lastUpdated: '2024-01-02T00:00:00.000Z',
    weightedScore: 4.2,
    scoreAlgorithm: 'exp-decay-v1',
    jobsCompleted: 0,
  };

  const mockPaginatedProfile = {
    ...mockProfile,
    nextCursor: encodeCursor({ createdAt: '2024-01-01T00:00:00.000Z', id: 'entry-1' }),
    hasNextPage: true,
    limit: 2,
  };

  beforeEach(() => jest.resetAllMocks());

  it('calls getProfilePaginated when cursor param is present', async () => {
    (ReputationService.getProfilePaginated as jest.Mock).mockReturnValue(mockPaginatedProfile);

    const { res, statusMock, jsonMock } = makeRes();
    const req = makeReq({
      query: { cursor: mockPaginatedProfile.nextCursor! },
    }) as Request;

    await ReputationController.getProfile(req, res as Response);

    expect(ReputationService.getProfilePaginated).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        cursor: mockPaginatedProfile.nextCursor,
      }),
    );
    expect(statusMock).toHaveBeenCalledWith(200);
    expect(jsonMock).toHaveBeenCalledWith({
      status: 'success',
      data: mockPaginatedProfile,
    });
  });

  it('calls getProfilePaginated when limit param is present', async () => {
    (ReputationService.getProfilePaginated as jest.Mock).mockReturnValue(mockPaginatedProfile);

    const { res, statusMock } = makeRes();
    const req = makeReq({ query: { limit: '5' } }) as Request;

    await ReputationController.getProfile(req, res as Response);

    expect(ReputationService.getProfilePaginated).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ limit: 5 }),
    );
    expect(statusMock).toHaveBeenCalledWith(200);
  });

  it('calls legacy getProfile when neither cursor nor limit is present', async () => {
    (ReputationService.getProfile as jest.Mock).mockReturnValue(mockProfile);

    const { res, statusMock, jsonMock } = makeRes();
    const req = makeReq() as Request;

    await ReputationController.getProfile(req, res as Response);

    expect(ReputationService.getProfile).toHaveBeenCalledWith('user-1');
    expect(ReputationService.getProfilePaginated).not.toHaveBeenCalled();
    expect(statusMock).toHaveBeenCalledWith(200);
    expect(jsonMock).toHaveBeenCalledWith({
      status: 'success',
      data: mockProfile,
    });
  });

  it('returns 400 for invalid cursor string', async () => {
    const { res, statusMock, jsonMock } = makeRes();
    const req = makeReq({ query: { cursor: 'not-valid!!!' } }) as Request;

    await ReputationController.getProfile(req, res as Response);

    expect(statusMock).toHaveBeenCalledWith(400);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'bad_request' }),
      }),
    );
  });

  it('returns 400 for limit exceeding max', async () => {
    const { res, statusMock, jsonMock } = makeRes();
    const req = makeReq({ query: { limit: '999' } }) as Request;

    await ReputationController.getProfile(req, res as Response);

    expect(statusMock).toHaveBeenCalledWith(400);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'bad_request' }),
      }),
    );
  });

  it('returns 400 for limit = 0', async () => {
    const { res, statusMock } = makeRes();
    const req = makeReq({ query: { limit: '0' } }) as Request;

    await ReputationController.getProfile(req, res as Response);

    expect(statusMock).toHaveBeenCalledWith(400);
  });

  it('returns 400 for negative limit', async () => {
    const { res, statusMock } = makeRes();
    const req = makeReq({ query: { limit: '-5' } }) as Request;

    await ReputationController.getProfile(req, res as Response);

    expect(statusMock).toHaveBeenCalledWith(400);
  });

  it('returns 400 for non-numeric limit', async () => {
    const { res, statusMock } = makeRes();
    const req = makeReq({ query: { limit: 'abc' } }) as Request;

    await ReputationController.getProfile(req, res as Response);

    expect(statusMock).toHaveBeenCalledWith(400);
  });

  it('returns paginated profile with nextCursor and hasNextPage', async () => {
    (ReputationService.getProfilePaginated as jest.Mock).mockReturnValue(mockPaginatedProfile);

    const { res, jsonMock } = makeRes();
    const req = makeReq({ query: { limit: '2' } }) as Request;

    await ReputationController.getProfile(req, res as Response);

    expect(jsonMock).toHaveBeenCalledWith({
      status: 'success',
      data: expect.objectContaining({
        nextCursor: expect.any(String),
        hasNextPage: true,
        limit: 2,
      }),
    });
  });
});
