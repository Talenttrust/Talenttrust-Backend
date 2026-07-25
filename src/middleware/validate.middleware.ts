import { Request, Response, NextFunction } from 'express';
import { ZodTypeAny, ZodError, z } from 'zod';

export interface ValidationErrorDetail {
  path: string[];
  message: string;
  code: string;
}

export interface ValidationErrorResponse {
  error: {
    code: string;
    message: string;
    requestId: string;
    details: ValidationErrorDetail[];
  };
}

const mapZodErrorToDetails = (error: ZodError): ValidationErrorDetail[] => {
  return error.issues.map((issue) => ({
    path: issue.path.map((p) => String(p)),
    message: issue.message,
    code: issue.code,
  }));
};

/**
 * Canonical request validation middleware.
 *
 * Parses `{ body, query, params }` together through the provided schema,
 * then mutates the matching `req` properties with validated data.
 * Rejects invalid input with a 400 response using a standard error shape
 * aligned with {@link AppError}.
 */
export const validateSchema = (schema: ZodTypeAny) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const validData = await schema.parseAsync({
        body: req.body,
        query: req.query,
        params: req.params,
      });
      req.body = validData.body;
      req.query = validData.query;
      req.params = validData.params;
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const requestId = typeof res.locals.requestId === 'string' ? res.locals.requestId : 'unknown';
        const response: ValidationErrorResponse = {
          error: {
            code: 'validation_error',
            message: 'Request validation failed',
            requestId,
            details: mapZodErrorToDetails(error),
          },
        };
        return res.status(400).json(response);
      }
      next(error);
    }
  };
};

/**
 * Validates only `req.body` against the given schema.
 * Thin convenience wrapper around {@link validateSchema}.
 */
export const validateRequest = (schema: ZodTypeAny) =>
  validateSchema(z.object({ body: schema }));

/**
 * Validates only `req.params` against the given schema.
 * Thin convenience wrapper around {@link validateSchema}.
 */
export const validateParams = (schema: ZodTypeAny) =>
  validateSchema(z.object({ params: schema }));

/**
 * Validates only `req.query` against the given schema.
 * Thin convenience wrapper around {@link validateSchema}.
 */
export const validateQuery = (schema: ZodTypeAny) =>
  validateSchema(z.object({ query: schema }));
