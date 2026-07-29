import { ContractBoundsError } from '../contracts/bounds';
import { SoftDeleteRetentionError } from '../utils/softDelete';
import { AppError } from '../errors/appError';
import { contractsErrorHandler } from './contractsErrorHandler';

function makeMockReq(overrides: Record<string, unknown> = {}): any {
  return { method: 'GET', path: '/api/v1/contracts', ...overrides };
}

function makeMockRes(overrides: Record<string, unknown> = {}): any {
  return {
    locals: { requestId: 'test-request-id' },
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
    ...overrides,
  };
}

function makeMockNext(): jest.Mock {
  return jest.fn();
}

describe('contractsErrorHandler', () => {
  describe('ContractBoundsError conversion', () => {
    it('responds with 422 and contract_bounds_error code', () => {
      const error = new ContractBoundsError('Budget exceeds maximum');
      const req = makeMockReq();
      const res = makeMockRes();
      const next = makeMockNext();

      contractsErrorHandler(error, req, res, next);

      expect(res.status).toHaveBeenCalledWith(422);
      expect(res.json).toHaveBeenCalledWith({
        status: 'error',
        error: {
          code: 'contract_bounds_error',
          message: 'Budget exceeds maximum',
          requestId: 'test-request-id',
        },
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('preserves the original error message', () => {
      const error = new ContractBoundsError('Milestone count 25 exceeds maximum of 20');
      const req = makeMockReq();
      const res = makeMockRes();
      const next = makeMockNext();

      contractsErrorHandler(error, req, res, next);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            message: 'Milestone count 25 exceeds maximum of 20',
          }),
        }),
      );
    });

    it('includes requestId from res.locals', () => {
      const error = new ContractBoundsError('Budget exceeds maximum');
      const req = makeMockReq();
      const res = makeMockRes({ locals: { requestId: 'custom-req-id' } });
      const next = makeMockNext();

      contractsErrorHandler(error, req, res, next);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ requestId: 'custom-req-id' }),
        }),
      );
    });

    it('falls back to "unknown" when requestId is missing', () => {
      const error = new ContractBoundsError('Budget exceeds maximum');
      const req = makeMockReq();
      const res = makeMockRes({ locals: {} });
      const next = makeMockNext();

      contractsErrorHandler(error, req, res, next);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ requestId: 'unknown' }),
        }),
      );
    });

    it('includes correlationId when present in res.locals', () => {
      const error = new ContractBoundsError('Budget exceeds maximum');
      const req = makeMockReq();
      const res = makeMockRes({
        locals: { requestId: 'test-id', correlationId: 'corr-123' },
      });
      const next = makeMockNext();

      contractsErrorHandler(error, req, res, next);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ correlationId: 'corr-123' }),
        }),
      );
    });
  });

  describe('SoftDeleteRetentionError conversion', () => {
    it('responds with 410 and soft_delete_retention_expired code', () => {
      const error = new SoftDeleteRetentionError('Record is past retention window');
      const req = makeMockReq();
      const res = makeMockRes();
      const next = makeMockNext();

      contractsErrorHandler(error, req, res, next);

      expect(res.status).toHaveBeenCalledWith(410);
      expect(res.json).toHaveBeenCalledWith({
        status: 'error',
        error: {
          code: 'soft_delete_retention_expired',
          message: 'Record is past retention window',
          requestId: 'test-request-id',
        },
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('preserves the original error message from SoftDeleteRetentionError', () => {
      const error = new SoftDeleteRetentionError('Custom retention message');
      const req = makeMockReq();
      const res = makeMockRes();
      const next = makeMockNext();

      contractsErrorHandler(error, req, res, next);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ message: 'Custom retention message' }),
        }),
      );
    });
  });

  describe('AppError conversion (bad_request / validation_error)', () => {
    it('responds with 400 and bad_request code', () => {
      const error = new AppError(400, 'bad_request', 'Limit must be between 1 and 100');
      const req = makeMockReq();
      const res = makeMockRes();
      const next = makeMockNext();

      contractsErrorHandler(error, req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        status: 'error',
        error: {
          code: 'bad_request',
          message: 'Limit must be between 1 and 100',
          requestId: 'test-request-id',
        },
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('responds with 400 and validation_error code', () => {
      const error = new AppError(400, 'validation_error', 'Operations array is required');
      const req = makeMockReq();
      const res = makeMockRes();
      const next = makeMockNext();

      contractsErrorHandler(error, req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ code: 'validation_error' }),
        }),
      );
    });

    it('uses AppError statusCode for unknown error codes', () => {
      const error = new AppError(409, 'conflict', 'Resource conflict');
      const req = makeMockReq();
      const res = makeMockRes();
      const next = makeMockNext();

      contractsErrorHandler(error, req, res, next);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ code: 'conflict' }),
        }),
      );
    });
  });

  describe('pass-through for unknown errors', () => {
    it('passes through generic Error to next()', () => {
      const error = new Error('Generic database error');
      const req = makeMockReq();
      const res = makeMockRes();
      const next = makeMockNext();

      contractsErrorHandler(error, req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(next).toHaveBeenCalledWith(error);
      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
    });

    it('passes through NotFoundError (AppError subclass) as AppError', () => {
      const error = new AppError(404, 'not_found', 'Not found');
      const req = makeMockReq();
      const res = makeMockRes();
      const next = makeMockNext();

      contractsErrorHandler(error, req, res, next);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ code: 'not_found' }),
        }),
      );
    });

    it('passes through string errors to next()', () => {
      const error = 'string error';
      const req = makeMockReq();
      const res = makeMockRes();
      const next = makeMockNext();

      contractsErrorHandler(error, req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(next).toHaveBeenCalledWith(error);
    });

    it('passes through null errors to next()', () => {
      const error = null;
      const req = makeMockReq();
      const res = makeMockRes();
      const next = makeMockNext();

      contractsErrorHandler(error, req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(next).toHaveBeenCalledWith(error);
    });

    it('passes through object errors to next()', () => {
      const error = { custom: 'error' };
      const req = makeMockReq();
      const res = makeMockRes();
      const next = makeMockNext();

      contractsErrorHandler(error, req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(next).toHaveBeenCalledWith(error);
    });
  });

  describe('error code coverage - all contract error codes', () => {
    it.each([
      ['contract_bounds_error', 422, new ContractBoundsError('msg')],
      ['soft_delete_retention_expired', 410, new SoftDeleteRetentionError('msg')],
      ['bad_request', 400, new AppError(400, 'bad_request', 'msg')],
      ['validation_error', 400, new AppError(400, 'validation_error', 'msg')],
    ])('maps %s to status %i', (_code, expectedStatus, error) => {
      const req = makeMockReq();
      const res = makeMockRes();
      const next = makeMockNext();

      contractsErrorHandler(error, req, res, next);

      expect(res.status).toHaveBeenCalledWith(expectedStatus);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('envelope shape compliance', () => {
    it('returns a top-level status field set to "error"', () => {
      const error = new ContractBoundsError('test');
      const req = makeMockReq();
      const res = makeMockRes();
      const next = makeMockNext();

      contractsErrorHandler(error, req, res, next);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'error' }),
      );
    });

    it('error object contains code, message, and requestId', () => {
      const error = new ContractBoundsError('test');
      const req = makeMockReq();
      const res = makeMockRes({ locals: { requestId: 'req-1' } });
      const next = makeMockNext();

      contractsErrorHandler(error, req, res, next);

      const callArg = (res.json as jest.Mock).mock.calls[0][0];
      expect(callArg).toHaveProperty('status', 'error');
      expect(callArg.error).toHaveProperty('code');
      expect(callArg.error).toHaveProperty('message');
      expect(callArg.error).toHaveProperty('requestId', 'req-1');
    });

    it('does not include error.details (no Zod or validation details)', () => {
      const error = new ContractBoundsError('test');
      const req = makeMockReq();
      const res = makeMockRes();
      const next = makeMockNext();

      contractsErrorHandler(error, req, res, next);

      const callArg = (res.json as jest.Mock).mock.calls[0][0];
      expect(callArg.error).not.toHaveProperty('details');
    });
  });
});