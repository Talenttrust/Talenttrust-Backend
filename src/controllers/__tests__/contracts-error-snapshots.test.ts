import { describe, it, expect } from '@jest/globals';
import {
  NotFoundError,
  ValidationError,
  ConflictError,
  mapErrorToPayload,
} from '../../errors/appError';
import { ZodError } from 'zod';

/**
 * Snapshot tests for contracts error-response bodies (RFC 7807 / structured shape).
 *
 * These tests lock the shape of error payloads so that unintended drift
 * is caught during code review.  Update the snapshots intentionally when
 * the API contract changes.
 */
describe('contracts error-response snapshots', () => {
  it('400 validation error shape', () => {
    const zodError = new ZodError([
      {
        code: 'invalid_type',
        expected: 'number',
        received: 'string',
        path: ['contracts', 0, 'amount'],
        message: 'Expected number, received string',
      },
    ]);
    const { payload } = mapErrorToPayload(zodError, 'req-c-001');
    expect(payload).toMatchSnapshot();
  });

  it('404 not-found error shape', () => {
    const err = new NotFoundError('Contract not found');
    const { payload } = mapErrorToPayload(err, 'req-c-002');
    expect(payload).toMatchSnapshot();
  });

  it('409 conflict error shape', () => {
    const err = new ConflictError('Contract already exists and cannot be created again');
    const { payload } = mapErrorToPayload(err, 'req-c-003');
    expect(payload).toMatchSnapshot();
  });

  it('500 internal-server-error shape', () => {
    const err = new Error('Unexpected database failure');
    const { payload } = mapErrorToPayload(err, 'req-c-004');
    expect(payload).toMatchSnapshot();
  });
});
