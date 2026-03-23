import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';

/**
 * Adds and returns a request correlation ID for observability and error tracing.
 */
export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const headerRequestId = req.header('x-request-id');
  const requestId = headerRequestId && headerRequestId.trim() ? headerRequestId : randomUUID();

  res.locals.requestId = requestId;
  res.setHeader('x-request-id', requestId);
  next();
}
