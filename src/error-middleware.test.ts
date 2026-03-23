import { ApiError } from './errors/ApiError';
import {
  errorMiddleware,
  isBodyParserError,
  notFoundMiddleware,
} from './middleware/error-middleware';

describe('error middleware', () => {
  it('identifies body parser errors', () => {
    expect(isBodyParserError({ type: 'entity.parse.failed', status: 400 })).toBe(true);
    expect(isBodyParserError({ type: 'other', status: 400 })).toBe(false);
  });

  it('passes ApiError details through the error middleware', () => {
    const status = jest.fn().mockReturnThis();
    const json = jest.fn();

    errorMiddleware(new ApiError(403, 'Forbidden'), {} as never, { status, json } as never, jest.fn());

    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({ error: 'Forbidden' });
  });

  it('sanitizes unknown errors in the error middleware', () => {
    const status = jest.fn().mockReturnThis();
    const json = jest.fn();

    errorMiddleware(new Error('secret details'), {} as never, { status, json } as never, jest.fn());

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ error: 'Internal server error.' });
  });

  it('creates a not found error via the terminal middleware', () => {
    const next = jest.fn();

    notFoundMiddleware({} as never, {} as never, next);

    expect(next).toHaveBeenCalledWith(expect.any(ApiError));
  });
});
