import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AppError } from '../errors/appError';

export const validateRequest = (schema: z.ZodSchema) => {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      schema.parse(req.body);
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        const requestId = typeof res.locals.requestId === 'string' ? res.locals.requestId : 'unknown';
        return res.status(400).json({
          error: {
            code: 'validation_error',
            message: 'Request validation failed',
            requestId,
            details: error.issues.map((err: any) => ({
              field: err.path.join('.'),
              message: err.message
            }))
          }
        });
      }
      next(error);
    }
  };
};

export const validateParams = (schema: z.ZodSchema) => {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      schema.parse(req.params);
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        const requestId = typeof res.locals.requestId === 'string' ? res.locals.requestId : 'unknown';
        return res.status(400).json({
          error: {
            code: 'validation_error',
            message: 'Parameter validation failed',
            requestId,
            details: error.issues.map((err: any) => ({
              field: err.path.join('.'),
              message: err.message
            }))
          }
        });
      }
      next(error);
    }
  };
};

export const validateQuery = (schema: z.ZodSchema) => {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      schema.parse(req.query);
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        const requestId = typeof res.locals.requestId === 'string' ? res.locals.requestId : 'unknown';
        return res.status(400).json({
          error: {
            code: 'validation_error',
            message: 'Query parameter validation failed',
            requestId,
            details: error.issues.map((err: any) => ({
              field: err.path.join('.'),
              message: err.message
            }))
          }
        });
      }
      next(error);
    }
  };
};
