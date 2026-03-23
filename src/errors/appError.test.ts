import { AppError, mapErrorToPayload } from './appError';

describe('mapErrorToPayload', () => {
  it('maps AppError to explicit status and payload code', () => {
    const mapped = mapErrorToPayload(
      new AppError(404, 'not_found', 'Resource not found'),
      'req_test_1',
    );

    expect(mapped).toEqual({
      statusCode: 404,
      payload: {
        error: {
          code: 'not_found',
          message: 'Resource not found',
          requestId: 'req_test_1',
        },
      },
    });
  });

  it('maps unknown errors to generic internal error payload', () => {
    const mapped = mapErrorToPayload(new Error('secret detail'), 'req_test_2');

    expect(mapped).toEqual({
      statusCode: 500,
      payload: {
        error: {
          code: 'internal_error',
          message: 'An unexpected error occurred',
          requestId: 'req_test_2',
        },
      },
    });
  });
});
