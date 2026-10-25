import { Request, Response, NextFunction, RequestHandler } from 'express';
import { ZodError, ZodTypeAny } from 'zod';
import { HttpError } from '../store';

export interface ValidationDetail {
  path: string;
  message: string;
}

type Location = 'params' | 'query' | 'body';

function formatZodError(error: ZodError, prefix: Location): ValidationDetail[] {
  return error.issues.map((issue) => {
    const path = issue.path.map(String).join('.');
    return { path: path ? `${prefix}.${path}` : prefix, message: issue.message };
  });
}

/**
 * True when an issue is about a token amount (`amount`, or a bare milestone
 * amount at `milestones.<n>`). Amount-only failures keep the established
 * `invalid_amount` error code so existing clients are unaffected.
 */
function isAmountIssue(path: readonly PropertyKey[]): boolean {
  const last = path[path.length - 1];
  if (last === 'amount') return true;
  return path.length >= 2 && path[path.length - 2] === 'milestones' && typeof last === 'number';
}

/**
 * Validate params, query and body against strict Zod schemas. On failure the
 * request is rejected with 400 `validation_failed` and a `details` array that
 * lists every problem across all three locations. Errors go through the app
 * error handler so the response still carries `requestId`.
 */
export function validate(schemas: { params?: ZodTypeAny; query?: ZodTypeAny; body?: ZodTypeAny }): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const details: ValidationDetail[] = [];
    let amountOnly = true;
    let idOnly = true;
    const parsed: Partial<Record<Location, unknown>> = {};
    for (const loc of ['params', 'query', 'body'] as const) {
      const schema = schemas[loc];
      if (!schema) continue;
      const input = loc === 'body' ? (req.body ?? {}) : req[loc];
      const result = schema.safeParse(input);
      if (result.success) {
        parsed[loc] = result.data;
      } else {
        details.push(...formatZodError(result.error, loc));
        if (loc !== 'body' || !result.error.issues.every((i) => isAmountIssue(i.path))) amountOnly = false;
        if (loc !== 'params' || !result.error.issues.every((i) => i.path.length === 1 && i.path[0] === 'id')) idOnly = false;
      }
    }
    if (details.length > 0) {
      const message = details.map((d) => `${d.path}: ${d.message}`).join('; ');
      // Keep the established codes when the only problem is the amount or the path id.
      const code = amountOnly ? 'invalid_amount' : idOnly ? 'invalid_id' : 'validation_failed';
      next(new HttpError(400, code, message, { details }));
      return;
    }
    if (parsed.params) req.params = parsed.params as Record<string, string>;
    if (parsed.query) req.query = parsed.query as Request['query'];
    if (parsed.body !== undefined) req.body = parsed.body;
    next();
  };
}
