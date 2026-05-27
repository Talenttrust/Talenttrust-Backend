import { AppError, mapErrorToPayload } from './appError';

describe('appError', () => {
  it('maps AppError to explicit status and payload code', () => {
    const { statusCode, payload } = mapErrorToPayload(
      new AppError(404, 'not_found', 'Resource not found'),
      'req-1',
    );
    expect(statusCode).toBe(404);
    expect(payload.error.code).toBe('not_found');
  });

  it('maps unknown errors to 500', () => {
    const { statusCode, payload } = mapErrorToPayload(new Error('boom'), 'req-2');
    expect(statusCode).toBe(500);
    expect(payload.error.code).toBe('internal_error');
  });
});
