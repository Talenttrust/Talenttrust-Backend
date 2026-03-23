import type { NextFunction, Request, Response } from 'express';

import { ApiError } from '../errors/ApiError';

/**
 * @notice Translate unknown routes into a consistent 404 response.
 */
export function notFoundMiddleware(_req: Request, _res: Response, next: NextFunction): void {
  next(new ApiError(404, 'Route not found.'));
}

/**
 * @notice Final error handler that keeps internal details out of API responses.
 */
export function errorMiddleware(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (isBodyParserError(error)) {
    res.status(400).json({ error: 'Malformed JSON request body.' });
    return;
  }

  if (isEntityTooLargeError(error)) {
    res.status(413).json({ error: 'Request body is too large.' });
    return;
  }

  if (error instanceof ApiError) {
    res.status(error.status).json({ error: error.message });
    return;
  }

  res.status(500).json({ error: 'Internal server error.' });
}

/**
 * @notice Detect malformed JSON parsing failures from Express.
 * @param error Thrown framework error value.
 */
export function isBodyParserError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'type' in error &&
      'status' in error &&
      error.type === 'entity.parse.failed' &&
      error.status === 400,
  );
}

/**
 * @notice Detect oversized request payload failures from Express parsers.
 * @param error Thrown framework error value.
 */
export function isEntityTooLargeError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'type' in error &&
      'status' in error &&
      error.type === 'entity.too.large' &&
      error.status === 413,
  );
}
