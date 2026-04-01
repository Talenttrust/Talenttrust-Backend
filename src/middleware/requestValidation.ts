import { NextFunction, Request, Response } from 'express';
import { ObjectSchema, validateSegment } from '../validation/requestSchema';

/**
 * Validation schema container for request segments.
 */
export interface RequestValidationSchema {
    params?: ObjectSchema;
    query?: ObjectSchema;
    body?: ObjectSchema;
}

/**
 * Middleware factory for strict request validation.
 */
export function createRequestValidationMiddleware(schema: RequestValidationSchema) {
    return (req: Request, res: Response, next: NextFunction): void => {
        const paramsValidation = schema.params
            ? validateSegment(req.params, schema.params, 'params')
            : { value: req.params as Record<string, unknown>, errors: [] as string[] };

        const queryValidation = schema.query
            ? validateSegment(req.query, schema.query, 'query')
            : { value: req.query as Record<string, unknown>, errors: [] as string[] };

        const bodyValidation = schema.body
            ? validateSegment(req.body, schema.body, 'body')
            : { value: req.body as Record<string, unknown>, errors: [] as string[] };

        const errors = [
            ...paramsValidation.errors,
            ...queryValidation.errors,
            ...bodyValidation.errors,
        ];

        if (errors.length > 0) {
            res.status(400).json({
                error: 'Validation failed',
                details: errors,
            });
            return;
        }

        req.params = paramsValidation.value as Request['params'];
        req.query = queryValidation.value as Request['query'];
        req.body = bodyValidation.value;

        next();
    };
}
