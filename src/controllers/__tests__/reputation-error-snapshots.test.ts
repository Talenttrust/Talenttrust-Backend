import { describe, it, expect } from '@jest/globals';
import {
  NotFoundError,
  ValidationError,
  ConflictError,
  mapErrorToPayload,
} from '../../errors/appError';
import { ZodError } from 'zod';

/**
 * Snapshot tests for reputation error-response bodies (RFC 7807 / structured shape).
 *
 * These tests lock the shape of error payloads so that unintended drift
 * is caught during code review.  Update the snapshots intentionally when
 * the API contract changes.
 */
describe('reputation error-response snapshots', () => {
  it('400 validation error shape', () => {
    const zodError = new ZodError([
      {
        code: 'invalid_type',
        expected: 'number',
        received: 'string',
        path: ['rating'],
        message: 'Expected number, received string',
      },
    ]);
    const { payload } = mapErrorToPayload(zodError, 'req-001');
    expect(payload).toMatchSnapshot();
  });

  it('404 not-found error shape', () => {
    const err = new NotFoundError('Reputation profile not found');
    const { payload } = mapErrorToPayload(err, 'req-002');
    expect(payload).toMatchSnapshot();
  });

  it('409 conflict error shape', () => {
    const err = new ConflictError('Reputation rating already exists for this contract');
    const { payload } = mapErrorToPayload(err, 'req-003');
    expect(payload).toMatchSnapshot();
  });

  it('500 internal-server-error shape', () => {
    const err = new Error('Unexpected database failure');
    const { payload } = mapErrorToPayload(err, 'req-004');
    expect(payload).toMatchSnapshot();
  });
});
