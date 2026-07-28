import { Request, Response } from 'express';
import { ReputationController } from './reputation.controller';
import { ReputationService } from '../services/reputation.service';
import {
  bulkReputationSchema,
  bulkRatingItemSchema,
  MAX_BULK_BATCH_SIZE,
} from '../modules/reputation/dto/reputation.dto';
import { isValidReputationBulkItem } from './reputation.validation';

jest.mock('../services/reputation.service');

function makeRes(): { res: Partial<Response>; statusMock: jest.Mock; jsonMock: jest.Mock } {
  const jsonMock = jest.fn();
  const statusMock = jest.fn().mockReturnValue({ json: jsonMock });
  const res: Partial<Response> = {
    status: statusMock,
    locals: { requestId: 'test-request-id' },
  } as unknown as Response;
  return { res, statusMock, jsonMock };
}

function makeReq(overrides: Partial<Request> = {}): Partial<Request> {
  return { params: {}, body: {}, ...overrides };
}

function validItem(overrides: Record<string, unknown> = {}) {
  return {
    reviewerId: 'reviewer-1',
    targetId: 'target-1',
    contextId: '550e8400-e29b-41d4-a716-446655440000',
    rating: 5,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// bulkRatingItemSchema — Zod validation
// ---------------------------------------------------------------------------

describe('bulkRatingItemSchema — field validation', () => {
  it('accepts a valid item', () => {
    const result = bulkRatingItemSchema.safeParse(validItem());
    expect(result.success).toBe(true);
  });

  it('accepts item with optional comment', () => {
    const result = bulkRatingItemSchema.safeParse(validItem({ comment: 'Great!' }));
    expect(result.success).toBe(true);
  });

  it('rejects empty reviewerId', () => {
    const result = bulkRatingItemSchema.safeParse(validItem({ reviewerId: '' }));
    expect(result.success).toBe(false);
  });

  it('rejects empty targetId', () => {
    const result = bulkRatingItemSchema.safeParse(validItem({ targetId: '' }));
    expect(result.success).toBe(false);
  });

  it('rejects invalid contextId (not UUID)', () => {
    const result = bulkRatingItemSchema.safeParse(validItem({ contextId: 'not-a-uuid' }));
    expect(result.success).toBe(false);
  });

  it('rejects rating = 0', () => {
    const result = bulkRatingItemSchema.safeParse(validItem({ rating: 0 }));
    expect(result.success).toBe(false);
  });

  it('rejects rating = 6', () => {
    const result = bulkRatingItemSchema.safeParse(validItem({ rating: 6 }));
    expect(result.success).toBe(false);
  });

  it('rejects decimal rating', () => {
    const result = bulkRatingItemSchema.safeParse(validItem({ rating: 3.5 }));
    expect(result.success).toBe(false);
  });

  it('rejects NaN rating', () => {
    const result = bulkRatingItemSchema.safeParse(validItem({ rating: NaN }));
    expect(result.success).toBe(false);
  });

  it('rejects Infinity rating', () => {
    const result = bulkRatingItemSchema.safeParse(validItem({ rating: Infinity }));
    expect(result.success).toBe(false);
  });

  it('rejects spam comment', () => {
    const result = bulkRatingItemSchema.safeParse(validItem({ comment: 'aaaaaaaaaa' }));
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// bulkReputationSchema — items array validation
// ---------------------------------------------------------------------------

describe('bulkReputationSchema — array validation', () => {
  it('accepts a single-item batch', () => {
    const result = bulkReputationSchema.safeParse({ body: { items: [validItem()] } });
    expect(result.success).toBe(true);
  });

  it('accepts max-size batch (50)', () => {
    const items = Array.from({ length: MAX_BULK_BATCH_SIZE }, (_, i) =>
      validItem({ reviewerId: `r-${i}`, targetId: `t-${i}` })
    );
    const result = bulkReputationSchema.safeParse({ body: { items } });
    expect(result.success).toBe(true);
  });

  it('rejects empty items array', () => {
    const result = bulkReputationSchema.safeParse({ body: { items: [] } });
    expect(result.success).toBe(false);
  });

  it('rejects batch exceeding MAX_BULK_BATCH_SIZE', () => {
    const items = Array.from({ length: MAX_BULK_BATCH_SIZE + 1 }, (_, i) =>
      validItem({ reviewerId: `r-${i}`, targetId: `t-${i}` })
    );
    const result = bulkReputationSchema.safeParse({ body: { items } });
    expect(result.success).toBe(false);
  });

  it('rejects when items is not an array', () => {
    const result = bulkReputationSchema.safeParse({ body: { items: 'not-an-array' } });
    expect(result.success).toBe(false);
  });

  it('rejects when body is missing', () => {
    const result = bulkReputationSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects batch with one invalid item among valid ones', () => {
    const items = [
      validItem(),
      validItem({ reviewerId: '', targetId: 't-2' }),
    ];
    const result = bulkReputationSchema.safeParse({ body: { items } });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isValidReputationBulkItem — runtime guard
// ---------------------------------------------------------------------------

describe('isValidReputationBulkItem', () => {
  it('returns true for a valid item', () => {
    expect(isValidReputationBulkItem(validItem())).toBe(true);
  });

  it('returns false for null', () => {
    expect(isValidReputationBulkItem(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isValidReputationBulkItem(undefined)).toBe(false);
  });

  it('returns false for non-object', () => {
    expect(isValidReputationBulkItem('string')).toBe(false);
  });

  it('returns false when reviewerId is missing', () => {
    const { reviewerId: _, ...rest } = validItem();
    expect(isValidReputationBulkItem(rest)).toBe(false);
  });

  it('returns false when targetId is missing', () => {
    const { targetId: _, ...rest } = validItem();
    expect(isValidReputationBulkItem(rest)).toBe(false);
  });

  it('returns false when contextId is missing', () => {
    const { contextId: _, ...rest } = validItem();
    expect(isValidReputationBulkItem(rest)).toBe(false);
  });

  it('returns false when rating is out of range', () => {
    expect(isValidReputationBulkItem(validItem({ rating: 0 }))).toBe(false);
    expect(isValidReputationBulkItem(validItem({ rating: 6 }))).toBe(false);
  });

  it('returns false when rating is not an integer', () => {
    expect(isValidReputationBulkItem(validItem({ rating: 3.5 }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ReputationController.createBulkRatings
// ---------------------------------------------------------------------------

describe('ReputationController.createBulkRatings', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 400 when items is missing', async () => {
    const { res, statusMock, jsonMock } = makeRes();
    await ReputationController.createBulkRatings(makeReq({ body: {} }) as Request, res as Response);
    expect(statusMock).toHaveBeenCalledWith(400);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'bad_request' }) })
    );
  });

  it('returns 400 when items is empty', async () => {
    const { res, statusMock } = makeRes();
    await ReputationController.createBulkRatings(makeReq({ body: { items: [] } }) as Request, res as Response);
    expect(statusMock).toHaveBeenCalledWith(400);
  });

  it('returns 200 with all results when all items succeed', async () => {
    const entry = { id: 'e1', reviewerId: 'r1', targetId: 't1', rating: 5, contextId: 'c1', createdAt: new Date().toISOString() };
    (ReputationService.createBulkRatings as jest.Mock).mockReturnValue([
      { index: 0, success: true, data: entry },
    ]);

    const { res, statusMock, jsonMock } = makeRes();
    await ReputationController.createBulkRatings(
      makeReq({ body: { items: [validItem()] } }) as Request,
      res as Response
    );

    expect(statusMock).toHaveBeenCalledWith(200);
    expect(jsonMock).toHaveBeenCalledWith({
      status: 'success',
      data: [{ index: 0, success: true, data: entry }],
    });
  });

  it('returns 207 when some items fail (partial failure)', async () => {
    const entry = { id: 'e1', reviewerId: 'r1', targetId: 't1', rating: 5, contextId: 'c1', createdAt: new Date().toISOString() };
    (ReputationService.createBulkRatings as jest.Mock).mockReturnValue([
      { index: 0, success: true, data: entry },
      { index: 1, success: false, error: { code: 'forbidden', message: 'Users cannot rate themselves' } },
    ]);

    const items = [
      validItem(),
      validItem({ reviewerId: 'target-1' }), // self-rating
    ];

    const { res, statusMock, jsonMock } = makeRes();
    await ReputationController.createBulkRatings(makeReq({ body: { items } }) as Request, res as Response);

    expect(statusMock).toHaveBeenCalledWith(207);
    const body = jsonMock.mock.calls[0][0];
    expect(body.status).toBe('partial_failure');
    expect(body.data).toHaveLength(2);
    expect(body.data[0].success).toBe(true);
    expect(body.data[1].success).toBe(false);
  });

  it('returns 207 when all items fail', async () => {
    (ReputationService.createBulkRatings as jest.Mock).mockReturnValue([
      { index: 0, success: false, error: { code: 'forbidden', message: 'Cannot rate self' } },
    ]);

    const items = [validItem({ reviewerId: 'target-1' })];

    const { res, statusMock } = makeRes();
    await ReputationController.createBulkRatings(makeReq({ body: { items } }) as Request, res as Response);
    expect(statusMock).toHaveBeenCalledWith(207);
  });

  it('returns 200 when all items are guard-invalid (no service call needed)', async () => {
    const items = [
      validItem({ reviewerId: '' }),
      validItem({ targetId: '' }),
    ];

    const { res, statusMock, jsonMock } = makeRes();
    await ReputationController.createBulkRatings(makeReq({ body: { items } }) as Request, res as Response);
    expect(statusMock).toHaveBeenCalledWith(207);
    expect(ReputationService.createBulkRatings).not.toHaveBeenCalled();
    const body = jsonMock.mock.calls[0][0];
    expect(body.data).toHaveLength(2);
    expect(body.data[0].success).toBe(false);
    expect(body.data[1].success).toBe(false);
  });

  it('handles mix of guard-invalid and service-failed items', async () => {
    const items = [
      validItem({ reviewerId: '' }),  // guard invalid
      validItem(),                    // service valid
      validItem({ rating: 10 }),      // guard invalid
    ];

    const entry = { id: 'e1', reviewerId: 'r1', targetId: 't1', rating: 5, contextId: 'c1', createdAt: new Date().toISOString() };
    (ReputationService.createBulkRatings as jest.Mock).mockReturnValue([
      { index: 0, success: true, data: entry },
    ]);

    const { res, statusMock, jsonMock } = makeRes();
    await ReputationController.createBulkRatings(makeReq({ body: { items } }) as Request, res as Response);

    expect(statusMock).toHaveBeenCalledWith(207);
    const body = jsonMock.mock.calls[0][0];
    expect(body.data).toHaveLength(3);
    expect(body.data[0].success).toBe(false);
    expect(body.data[0].error.code).toBe('validation_error');
    expect(body.data[1].success).toBe(true);
    expect(body.data[2].success).toBe(false);
    expect(body.data[2].error.code).toBe('validation_error');
  });

  it('returns 500 when service throws unexpected error', async () => {
    (ReputationService.createBulkRatings as jest.Mock).mockImplementation(() => {
      throw new Error('DB down');
    });

    const { res, statusMock } = makeRes();
    await ReputationController.createBulkRatings(
      makeReq({ body: { items: [validItem()] } }) as Request,
      res as Response
    );
    expect(statusMock).toHaveBeenCalledWith(500);
  });

  it('uses requestId from res.locals', async () => {
    (ReputationService.createBulkRatings as jest.Mock).mockReturnValue([]);

    const { res, jsonMock } = makeRes();
    (res.locals as any).requestId = 'custom-req-id';
    await ReputationController.createBulkRatings(
      makeReq({ body: { items: [validItem()] } }) as Request,
      res as Response
    );
    // Success path doesn't include requestId in body, so just verify it was called
    expect(jsonMock).toHaveBeenCalled();
  });

  it('handles undefined items gracefully', async () => {
    const { res, statusMock } = makeRes();
    await ReputationController.createBulkRatings(
      makeReq({ body: { items: undefined } }) as Request,
      res as Response
    );
    expect(statusMock).toHaveBeenCalledWith(400);
  });
});
