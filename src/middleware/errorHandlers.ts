import { NextFunction, Request, Response } from 'express';
import { AppError, mapErrorToPayload } from '../errors/appError';

/**
 * Handles unknown routes with a structured 404 response.
 */
export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new AppError(404, 'not_found', 'The requested resource was not found'));
}

/**
 * Maps all errors to a consistent API envelope and status code.
 */
export function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const requestId = typeof res.locals.requestId === 'string' ? res.locals.requestId : 'unknown';

  if (error instanceof SyntaxError && 'status' in error) {
    const mapped = mapErrorToPayload(new AppError(400, 'invalid_json', 'Malformed JSON payload'), requestId);
    res.status(mapped.statusCode).json(mapped.payload);
    return;
  }

  const mapped = mapErrorToPayload(error, requestId);
  res.status(mapped.statusCode).json(mapped.payload);
}
