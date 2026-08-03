/**
 * Snapshot tests for disputes error-response bodies (RFC 7807 / structured shape).
 *
 * These tests lock the shape of error payloads so that unintended drift
 * is caught during code review. Update the snapshots intentionally when
 * the API contract changes.
 */

import { describe, it, expect } from '@jest/globals';
import {
  NotFoundError,
  ConflictError,
  mapErrorToPayload,
} from '../../errors/appError';
import { ZodError } from 'zod';

describe('disputes error-response snapshots', () => {
  it('400 validation error shape', () => {
    const zodError = new ZodError([
      {
        code: 'invalid_type',
        expected: 'string',
        received: 'number',
        path: ['disputes', 0, 'reason'],
        message: 'Expected string, received number',
      },
    ]);
    const { payload } = mapErrorToPayload(zodError, 'req-d-001');
    expect(payload).toMatchSnapshot();
  });

  it('404 not-found error shape', () => {
    const err = new NotFoundError('Dispute not found');
    const { payload } = mapErrorToPayload(err, 'req-d-002');
    expect(payload).toMatchSnapshot();
  });

  it('409 conflict error shape', () => {
    const err = new ConflictError('Dispute is already deleted and cannot be restored');
    const { payload } = mapErrorToPayload(err, 'req-d-003');
    expect(payload).toMatchSnapshot();
  });

  it('500 internal-server-error shape', () => {
    const err = new Error('Unexpected dispute service failure');
    const { payload } = mapErrorToPayload(err, 'req-d-004');
    expect(payload).toMatchSnapshot();
  });
});
