import { Request, Response, NextFunction, RequestHandler } from 'express';
import { ZodError, ZodIssue, ZodTypeAny } from 'zod';
import { HttpError } from '../store';

export interface ValidationDetail {
  path: string;
  message: string;
}

function formatZodError(error: ZodError, prefix: string): ValidationDetail[] {
  return error.issues.map((issue: ZodIssue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '';
    return {
      path: prefix ? `${prefix}.${path}` : path,
      message: issue.message,
    };
  });
}

export function validate(
  schemas: { params?: ZodTypeAny; query?: ZodTypeAny; body?: ZodTypeAny },
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      if (schemas.params) {
        req.params = schemas.params.parse(req.params) as Record<string, string>;
      }
      if (schemas.query) {
        req.query = schemas.query.parse(req.query) as Record<string, string>;
      }
      if (schemas.body) {
        req.body = schemas.body.parse(req.body ?? {});
      }
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        const details: ValidationDetail[] = [];
        if (schemas.params) {
          try {
            schemas.params.parse(req.params);
          } catch (e) {
            if (e instanceof ZodError) {
              details.push(...formatZodError(e, 'params'));
            }
          }
        }
        if (schemas.query) {
          try {
            schemas.query.parse(req.query);
          } catch (e) {
            if (e instanceof ZodError) {
              details.push(...formatZodError(e, 'query'));
            }
          }
        }
        if (schemas.body) {
          try {
            schemas.body.parse(req.body ?? {});
          } catch (e) {
            if (e instanceof ZodError) {
              details.push(...formatZodError(e, 'body'));
            }
          }
        }
        const message = details.map((d) => `${d.path}: ${d.message}`).join('; ');
        res.status(400).json({
          error: 'validation_failed',
          message,
          details,
        });
        return;
      }
      next(err);
    }
  };
}

export function createValidationError(message: string, details: ValidationDetail[]): HttpError {
  return new HttpError(400, 'validation_failed', message);
}