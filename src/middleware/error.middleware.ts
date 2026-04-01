import { Request, Response, NextFunction } from 'express';

/**
 * @dev Global error handling middleware.
 * Ensures that unexpected errors do not leak stack traces or internal
 * logic to the client, especially in production environments.
 * 
 * @param err The error object.
 * @param req The Express Request.
 * @param res The Express Response.
 * @param next The Express NextFunction.
 */
export const errorHandler = (err: any, req: Request, res: Response, next: NextFunction) => {
  const statusCode = err.status || 500;
  const message = err.message || 'Internal Server Error';

  console.error(`[Error] ${statusCode} - ${message}`, err.stack);

  res.status(statusCode).json({
    status: 'error',
    statusCode,
    message: process.env.NODE_ENV === 'production' && statusCode === 500 
      ? 'Internal server error' 
      : message,
  });
};
