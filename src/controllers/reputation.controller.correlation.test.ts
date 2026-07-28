import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../errors/appError';
import { setWriteRecordImpl } from '../logger';
import type { LogRecord } from '../logger';

// ── Service mock setup ────────────────────────────────────────────────────────

const mockGetProfile = jest.fn();
const mockGetProfilePaginated = jest.fn();
const mockUpdateProfile = jest.fn();
const mockCreateBulkRatings = jest.fn();

jest.mock('../services/reputation.service', () => ({
  ReputationService: {
    getProfile: mockGetProfile,
    getProfilePaginated: mockGetProfilePaginated,
    updateProfile: mockUpdateProfile,
    createBulkRatings: mockCreateBulkRatings,
  },
}));

import { ReputationController } from './reputation.controller';

// ── Helpers ───────────────────────────────────────────────────────────────────

const TEST_REQUEST_ID = 'test-request-id-123';
const TEST_CORRELATION_ID = 'test-correlation-id-456';

const fakeProfile = {
  freelancerId: 'user-1',
  score: 4.5,
  jobsCompleted: 5,
  totalRatings: 10,
  reviews: [],
  lastUpdated: '2024-02-01T00:00:00.000Z',
  weightedScore: 4.3,
  scoreAlgorithm: 'exp-decay-v1',
};

function makeResponse(locals: Record<string, unknown> = {}): Partial<Response> {
  const mockLog = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn().mockReturnThis(),
  };

  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
    locals: {
      requestId: TEST_REQUEST_ID,
      log: mockLog,
      ...locals,
    } as Record<string, unknown>,
  };
}

function getLog(res: Partial<Response>) {
  return (res.locals as Record<string, unknown>)['log'] as Record<string, jest.Mock>;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('ReputationController – correlation ID propagation', () => {
  let mockNext: NextFunction;

  beforeEach(() => {
    mockNext = jest.fn();
    mockGetProfile.mockReset();
    mockGetProfilePaginated.mockReset();
    mockUpdateProfile.mockReset();
    mockCreateBulkRatings.mockReset();
  });

  describe('getProfile', () => {
    it('includes correlationId in success response when present in locals', async () => {
      mockGetProfile.mockReturnValue(fakeProfile);
      const res = makeResponse({ correlationId: TEST_CORRELATION_ID });
      const req = { params: { id: 'user-1' }, query: {} } as unknown as Request;

      await ReputationController.getProfile(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(200);
      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.correlationId).toBe(TEST_CORRELATION_ID);
    });

    it('omits correlationId from success response when absent', async () => {
      mockGetProfile.mockReturnValue(fakeProfile);
      const res = makeResponse(); // no correlationId
      const req = { params: { id: 'user-1' }, query: {} } as unknown as Request;

      await ReputationController.getProfile(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(200);
      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body).not.toHaveProperty('correlationId');
    });

    it('logs correlationId on entry when present', async () => {
      mockGetProfile.mockReturnValue(fakeProfile);
      const res = makeResponse({ correlationId: TEST_CORRELATION_ID });
      const log = getLog(res);
      const req = { params: { id: 'user-1' }, query: {} } as unknown as Request;

      await ReputationController.getProfile(req, res as Response, mockNext);

      expect(log.info).toHaveBeenCalledWith(
        'reputation.getProfile: start',
        expect.objectContaining({ correlationId: TEST_CORRELATION_ID }),
      );
    });
  });

  describe('createRating', () => {
    const validBody = {
      reviewerId: 'reviewer-1',
      contextId: '550e8400-e29b-41d4-a716-446655440000',
      rating: 4,
    };

    it('forwards correlationId to service.updateProfile', async () => {
      mockUpdateProfile.mockReturnValue(fakeProfile);
      const res = makeResponse({ correlationId: TEST_CORRELATION_ID });
      const req = { params: { id: 'user-1' }, body: validBody } as unknown as Request;

      await ReputationController.createRating(req, res as Response, mockNext);

      expect(mockUpdateProfile).toHaveBeenCalledWith(
        'user-1',
        expect.anything(),
        TEST_CORRELATION_ID,
      );
    });

    it('includes correlationId in error payload when validation fails', async () => {
      const res = makeResponse({ correlationId: TEST_CORRELATION_ID });
      const req = { params: { id: 'user-1' }, body: { reviewerId: '' } } as unknown as Request;

      await ReputationController.createRating(req, res as Response, mockNext);

      expect(mockNext).toHaveBeenCalledTimes(1);
      const error = (mockNext as jest.Mock).mock.calls[0][0];
      expect(error).toBeInstanceOf(AppError);
      expect(error.statusCode).toBe(400);
      expect(res.locals.correlationId).toBe(TEST_CORRELATION_ID);
    });
  });

  describe('createBulkRatings', () => {
    const validBulkBody = {
      items: [
        {
          reviewerId: 'reviewer-1',
          targetId: 'user-1',
          contextId: '550e8400-e29b-41d4-a716-446655440000',
          rating: 4,
        },
      ],
    };

    it('forwards correlationId to service.createBulkRatings', async () => {
      mockCreateBulkRatings.mockReturnValue([]);
      const res = makeResponse({ correlationId: TEST_CORRELATION_ID });
      const req = { body: validBulkBody } as unknown as Request;

      await ReputationController.createBulkRatings(req, res as Response, mockNext);

      expect(mockCreateBulkRatings).toHaveBeenCalledWith(
        expect.anything(),
        TEST_CORRELATION_ID,
      );
    });

    it('includes correlationId in 200 response when present', async () => {
      mockCreateBulkRatings.mockReturnValue([{ index: 0, success: true }]);
      const res = makeResponse({ correlationId: TEST_CORRELATION_ID });
      const req = { body: validBulkBody } as unknown as Request;

      await ReputationController.createBulkRatings(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(200);
      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.correlationId).toBe(TEST_CORRELATION_ID);
    });
  });
});
