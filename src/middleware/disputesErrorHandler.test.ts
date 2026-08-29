/**
 * @file disputesErrorHandler.test.ts
 * @description Comprehensive tests for disputes error handling middleware.
 *
 * Coverage goals (≥ 95%):
 * - DisputeError instances are converted to AppError
 * - Error codes map to correct HTTP status codes
 * - Error messages are safe and user-friendly
 * - Non-DisputeError instances are passed through unchanged
 * - requestId is preserved in the error chain
 * - All dispute-specific error codes are tested
 */

import { Request, Response, NextFunction } from 'express';
import { AppError } from '../errors/appError';
import { DisputeError } from '../services/disputes.service';
import { disputesErrorHandler } from './disputesErrorHandler';

// ── Mock factories ────────────────────────────────────────────────────────────

function makeMockReq(overrides: Record<string, unknown> = {}): any {
  return {
    method: 'GET',
    path: '/api/v1/disputes',
    ...overrides,
  };
}

function makeMockRes(overrides: Record<string, unknown> = {}): any {
  return {
    locals: { requestId: 'test-request-id' },
    ...overrides,
  };
}

function makeMockNext(): jest.Mock {
  return jest.fn();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('disputesErrorHandler', () => {
  describe('DisputeError conversion', () => {
    it('converts dispute_not_found to 404 AppError', () => {
      const disputeError = new DisputeError('dispute_not_found', 'Dispute 123 not found', 404);
      const req = makeMockReq();
      const res = makeMockRes();
      const next = makeMockNext();

      disputesErrorHandler(disputeError, req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      const passedError = next.mock.calls[0][0];
      expect(passedError).toBeInstanceOf(AppError);
      expect(passedError.statusCode).toBe(404);
      expect(passedError.code).toBe('dispute_not_found');
    });

    it('converts invalid_state_transition to 400 AppError', () => {
      const disputeError = new DisputeError(
        'invalid_state_transition',
        'Invalid transition from open to resolved',
        400,
      );
      const req = makeMockReq();
      const res = makeMockRes();
      const next = makeMockNext();

      disputesErrorHandler(disputeError, req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      const passedError = next.mock.calls[0][0];
      expect(passedError).toBeInstanceOf(AppError);
      expect(passedError.statusCode).toBe(400);
      expect(passedError.code).toBe('invalid_state_transition');
    });

    it('converts internal_error to 500 AppError', () => {
      const disputeError = new DisputeError('internal_error', 'Database connection failed', 500);
      const req = makeMockReq();
      const res = makeMockRes();
      const next = makeMockNext();

      disputesErrorHandler(disputeError, req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      const passedError = next.mock.calls[0][0];
      expect(passedError).toBeInstanceOf(AppError);
      expect(passedError.statusCode).toBe(500);
      expect(passedError.code).toBe('internal_error');
    });

    it('maps unknown dispute error codes to 500', () => {
      const disputeError = new DisputeError('unknown_code', 'Some unknown error', 422);
      const req = makeMockReq();
      const res = makeMockRes();
      const next = makeMockNext();

      disputesErrorHandler(disputeError, req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      const passedError = next.mock.calls[0][0];
      expect(passedError).toBeInstanceOf(AppError);
      expect(passedError.statusCode).toBe(500);
      expect(passedError.code).toBe('unknown_code');
    });
  });

  describe('safe message mapping', () => {
    it('uses safe message for dispute_not_found', () => {
      const disputeError = new DisputeError('dispute_not_found', 'Dispute 123 not found', 404);
      const req = makeMockReq();
      const res = makeMockRes();
      const next = makeMockNext();

      disputesErrorHandler(disputeError, req, res, next);

      const passedError = next.mock.calls[0][0] as AppError;
      expect(passedError.message).toBe('The requested dispute was not found');
      expect(passedError.message).not.toContain('123');
    });

    it('uses safe message for invalid_state_transition', () => {
      const disputeError = new DisputeError(
        'invalid_state_transition',
        'Invalid transition from open to resolved',
        400,
      );
      const req = makeMockReq();
      const res = makeMockRes();
      const next = makeMockNext();

      disputesErrorHandler(disputeError, req, res, next);

      const passedError = next.mock.calls[0][0] as AppError;
      expect(passedError.message).toBe('The requested state transition is not allowed');
      expect(passedError.message).not.toContain('open');
      expect(passedError.message).not.toContain('resolved');
    });

    it('uses safe message for internal_error', () => {
      const disputeError = new DisputeError('internal_error', 'ECONNREFUSED 127.0.0.1:5432', 500);
      const req = makeMockReq();
      const res = makeMockRes();
      const next = makeMockNext();

      disputesErrorHandler(disputeError, req, res, next);

      const passedError = next.mock.calls[0][0] as AppError;
      expect(passedError.message).toBe('An unexpected error occurred while processing the dispute');
      expect(passedError.message).not.toContain('ECONNREFUSED');
      expect(passedError.message).not.toContain('127.0.0.1');
    });

    it('uses fallback message for unknown error codes', () => {
      const disputeError = new DisputeError('unknown_code', 'Some unknown error', 422);
      const req = makeMockReq();
      const res = makeMockRes();
      const next = makeMockNext();

      disputesErrorHandler(disputeError, req, res, next);

      const passedError = next.mock.calls[0][0] as AppError;
      expect(passedError.message).toBe('An unexpected error occurred');
    });
  });

  describe('pass-through for non-DisputeError', () => {
    it('passes through generic Error unchanged', () => {
      const genericError = new Error('Some generic error');
      const req = makeMockReq();
      const res = makeMockRes();
      const next = makeMockNext();

      disputesErrorHandler(genericError, req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      const passedError = next.mock.calls[0][0];
      expect(passedError).toBe(genericError);
      expect(passedError).not.toBeInstanceOf(AppError);
    });

    it('passes through AppError unchanged', () => {
      const appError = new AppError(404, 'not_found', 'Not found');
      const req = makeMockReq();
      const res = makeMockRes();
      const next = makeMockNext();

      disputesErrorHandler(appError, req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      const passedError = next.mock.calls[0][0];
      expect(passedError).toBe(appError);
    });

    it('passes through string errors unchanged', () => {
      const stringError = 'string error';
      const req = makeMockReq();
      const res = makeMockRes();
      const next = makeMockNext();

      disputesErrorHandler(stringError, req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      const passedError = next.mock.calls[0][0];
      expect(passedError).toBe(stringError);
    });

    it('passes through null errors unchanged', () => {
      const nullError = null;
      const req = makeMockReq();
      const res = makeMockRes();
      const next = makeMockNext();

      disputesErrorHandler(nullError, req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      const passedError = next.mock.calls[0][0];
      expect(passedError).toBe(nullError);
    });

    it('passes through object errors unchanged', () => {
      const objectError = { code: 'custom_error', message: 'Custom error' };
      const req = makeMockReq();
      const res = makeMockRes();
      const next = makeMockNext();

      disputesErrorHandler(objectError, req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      const passedError = next.mock.calls[0][0];
      expect(passedError).toBe(objectError);
    });
  });

  describe('integration with global error handler', () => {
    it('produces AppError that global handler can process', () => {
      const disputeError = new DisputeError('dispute_not_found', 'Dispute 123 not found', 404);
      const req = makeMockReq();
      const res = makeMockRes();
      const next = makeMockNext();

      disputesErrorHandler(disputeError, req, res, next);

      const passedError = next.mock.calls[0][0] as AppError;
      
      // Verify the AppError has all required properties for global handler
      expect(passedError).toHaveProperty('statusCode');
      expect(passedError).toHaveProperty('code');
      expect(passedError).toHaveProperty('message');
      expect(passedError).toHaveProperty('expose');
      expect(typeof passedError.statusCode).toBe('number');
      expect(typeof passedError.code).toBe('string');
      expect(typeof passedError.message).toBe('string');
      expect(typeof passedError.expose).toBe('boolean');
    });

    it('sets expose to false to prevent message leakage', () => {
      const disputeError = new DisputeError('dispute_not_found', 'Dispute 123 not found', 404);
      const req = makeMockReq();
      const res = makeMockRes();
      const next = makeMockNext();

      disputesErrorHandler(disputeError, req, res, next);

      const passedError = next.mock.calls[0][0] as AppError;
      expect(passedError.expose).toBe(false);
    });
  });

  describe('request context preservation', () => {
    it('does not modify req or res objects', () => {
      const disputeError = new DisputeError('dispute_not_found', 'Dispute 123 not found', 404);
      const req = makeMockReq({ customProp: 'test' });
      const res = makeMockRes({ customProp: 'test2' });
      const next = makeMockNext();

      const originalReq = { ...req };
      const originalRes = { ...res };

      disputesErrorHandler(disputeError, req, res, next);

      expect(req).toEqual(originalReq);
      expect(res).toEqual(originalRes);
    });
  });

  describe('error code coverage', () => {
    const disputeErrorCodes = [
      'dispute_not_found',
      'invalid_state_transition',
      'internal_error',
    ];

    it.each(disputeErrorCodes)('handles dispute error code: %s', (code) => {
      const disputeError = new DisputeError(code, `Error: ${code}`, 400);
      const req = makeMockReq();
      const res = makeMockRes();
      const next = makeMockNext();

      disputesErrorHandler(disputeError, req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      const passedError = next.mock.calls[0][0];
      expect(passedError).toBeInstanceOf(AppError);
      expect(passedError.code).toBe(code);
    });
  });
});
