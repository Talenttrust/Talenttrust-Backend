
import { Response } from 'express';
import { ok, fail } from './apiResponse';

function makeMockRes(requestId?: string) {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const locals: Record<string, unknown> = {};
  if (requestId !== undefined) locals.requestId = requestId;
  return { status, json, locals } as unknown as Response;
}

describe('apiResponse helpers', () => {
  describe('ok()', () => {
    it('sends 200 with success envelope', () => {
      const res = makeMockRes('req-123');
      ok(res, { id: 1, name: 'test' });
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.status(200).json).toHaveBeenCalledWith({
        status: 'success',
        data: { id: 1, name: 'test' },
        requestId: 'req-123',
      });
    });

    it('includes meta when provided', () => {
      const res = makeMockRes('req-456');
      const meta = { page: 1, limit: 10, total: 100 };
      ok(res, [1, 2, 3], meta);
      expect(res.status(200).json).toHaveBeenCalledWith({
        status: 'success',
        data: [1, 2, 3],
        meta,
        requestId: 'req-456',
      });
    });

    it('uses custom status code', () => {
      const res = makeMockRes('req-789');
      ok(res, { created: true }, undefined, 201);
      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('falls back to unknown when requestId is missing', () => {
      const res = makeMockRes();
      ok(res, { data: true });
      expect(res.status(200).json).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: 'unknown' }),
      );
    });

    it('does not include meta key when meta is undefined', () => {
      const res = makeMockRes('req-123');
      ok(res, { data: true });
      const call = (res.status(200).json as jest.Mock).mock.calls[0][0];
      expect(call).not.toHaveProperty('meta');
    });
  });

  describe('fail()', () => {
    it('sends 400 with error envelope', () => {
      const res = makeMockRes('req-abc');
      fail(res, 'bad_request', 'Invalid input');
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.status(400).json).toHaveBeenCalledWith({
        status: 'error',
        error: {
          code: 'bad_request',
          message: 'Invalid input',
          requestId: 'req-abc',
        },
      });
    });

    it('uses custom status code', () => {
      const res = makeMockRes('req-xyz');
      fail(res, 'not_found', 'Resource not found', 404);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('includes requestId in error envelope', () => {
      const res = makeMockRes('trace-999');
      fail(res, 'server_error', 'Something went wrong', 500);
      expect(res.status(500).json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ requestId: 'trace-999' }),
        }),
      );
    });

    it('falls back to unknown when requestId is missing', () => {
      const res = makeMockRes();
      fail(res, 'bad_request', 'Missing field');
      expect(res.status(400).json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ requestId: 'unknown' }),
        }),
      );
    });
  });
});


