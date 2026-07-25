/**
 * @file webhook-subscription.validation.test.ts
 * @description Unit tests for the shared webhook subscription validation helpers.
 */

import { Response } from 'express';
import { validateWebhookUrl, findSubscriptionOrFail } from './webhook-subscription.validation';
import { isSafeUrl } from '../utils/ssrf';

jest.mock('../utils/ssrf', () => ({
  isSafeUrl: jest.fn(),
}));

function mockRes(overrides: Partial<Response> = {}): Partial<Response> {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
    locals: { requestId: 'req-123' },
    ...overrides,
  } as Partial<Response>;
}

describe('validateWebhookUrl', () => {
  let res: Partial<Response>;

  beforeEach(() => {
    res = mockRes();
    jest.clearAllMocks();
  });

  it('returns true when isSafeUrl returns true', () => {
    (isSafeUrl as jest.Mock).mockReturnValue(true);
    const result = validateWebhookUrl('https://example.com/hook', res as Response);
    expect(result).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('sends 400 invalid_url when isSafeUrl returns false', () => {
    (isSafeUrl as jest.Mock).mockReturnValue(false);
    const result = validateWebhookUrl('http://127.0.0.1/hook', res as Response);
    expect(result).toBe(false);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: 'invalid_url',
        message: 'Provided URL is invalid or resolved to a private/reserved address.',
        requestId: 'req-123',
      },
    });
  });

  it('falls back to "unknown" requestId when res.locals is missing', () => {
    (isSafeUrl as jest.Mock).mockReturnValue(false);
    const resNoLocals = mockRes({ locals: undefined as any });
    validateWebhookUrl('http://127.0.0.1/hook', resNoLocals as Response);
    expect(resNoLocals.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ requestId: 'unknown' }),
      }),
    );
  });

  it('falls back to "unknown" requestId when res.locals.requestId is undefined', () => {
    (isSafeUrl as jest.Mock).mockReturnValue(false);
    const resNoRequestId = mockRes({ locals: {} as any });
    validateWebhookUrl('http://127.0.0.1/hook', resNoRequestId as Response);
    expect(resNoRequestId.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ requestId: 'unknown' }),
      }),
    );
  });
});

describe('findSubscriptionOrFail', () => {
  let res: Partial<Response>;
  let repo: { findById: jest.Mock };

  beforeEach(() => {
    res = mockRes({ locals: { requestId: 'req-456' } as any });
    repo = { findById: jest.fn() };
  });

  it('returns the subscription when found', async () => {
    const subscription = { id: 'sub-1', url: 'https://example.com/hook', eventType: 'contract.created' };
    repo.findById.mockResolvedValue(subscription);

    const result = await findSubscriptionOrFail('sub-1', repo as any, res as Response);
    expect(result).toEqual(subscription);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('sends 404 not_found when the subscription does not exist', async () => {
    repo.findById.mockResolvedValue(null);

    const result = await findSubscriptionOrFail('sub-missing', repo as any, res as Response);
    expect(result).toBeNull();
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: 'not_found',
        message: 'Webhook subscription not found.',
        requestId: 'req-456',
      },
    });
  });

  it('falls back to "unknown" requestId when res.locals is missing', async () => {
    repo.findById.mockResolvedValue(null);
    const resNoLocals = mockRes({ locals: undefined as any });

    await findSubscriptionOrFail('sub-missing', repo as any, resNoLocals as Response);
    expect(resNoLocals.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ requestId: 'unknown' }),
      }),
    );
  });
});
