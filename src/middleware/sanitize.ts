import { Request, Response, NextFunction } from 'express';
import { FilterXSS } from 'xss';

/**
 * Custom xss options to enforce strict sanitization
 * Strip all HTML tags by allowing an empty list of whiteList.
 */
const xssOptions = {
  whiteList: {},           // Empty means no tags are allowed
  stripIgnoreTag: true,    // Filter out all tags not in whiteList
  stripIgnoreTagBody: ['script', 'style'], // Remove the tag AND its body
};

const customXss = new FilterXSS(xssOptions);

/**
 * Keys that must never be copied onto a sanitized object, because assigning them
 * can pollute `Object.prototype` and affect every object in the process.
 */
const PROTOTYPE_POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Recursively sanitize an object, array, or string using strict XSS filtering.
 *
 * The return type mirrors the input type (`T`), so callers - and Express's
 * `query`/`params` typings - keep their expected shapes instead of collapsing to
 * `any`. String values are trimmed and passed through the strict XSS filter;
 * arrays and plain objects are sanitized recursively; everything else is
 * returned unchanged.
 *
 * @typeParam T - The (inferred) type of the value being sanitized.
 * @param obj The input object, array, or string to sanitize.
 * @returns A new sanitized value of the same shape as the input.
 *
 * @remarks Security guarantees:
 * - **Prototype-pollution safe:** keys `__proto__`, `constructor`, and
 *   `prototype` are skipped during recursion, so a crafted payload cannot reach
 *   `Object.prototype`. The result is also created with a `null` prototype.
 * - **Non-mutating:** input objects/arrays are copied rather than mutated.
 * - **Idempotent:** running the function twice yields the same result.
 * - Special objects (`Date`, `Buffer`) are returned as-is to avoid corruption.
 */
const sanitizeObject = <T>(obj: T): T => {
  if (typeof obj === 'string') {
    return customXss.process(obj.trim()) as unknown as T;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeObject(item)) as unknown as T;
  }

  if (obj !== null && typeof obj === 'object') {
    // Avoid sanitizing special objects like Date or Buffer
    if (obj instanceof Date || Buffer.isBuffer(obj)) {
      return obj;
    }

    const sanitizedObj: { [key: string]: unknown } = Object.create(null);
    for (const [key, value] of Object.entries(obj)) {
      // Drop prototype-pollution keys so they never survive sanitization.
      if (PROTOTYPE_POLLUTION_KEYS.has(key)) {
        continue;
      }
      sanitizedObj[key] = sanitizeObject(value);
    }
    return sanitizedObj as unknown as T;
  }

  return obj;
};

/**
 * Express middleware that strips XSS payloads from incoming request data.
 *
 * Sanitizes `req.body`, `req.query`, and `req.params` in place. Because
 * {@link sanitizeObject} preserves the input type, `req.query` and `req.params`
 * keep their declared `ParsedQs` / params shapes instead of degrading to `any`,
 * so downstream handlers continue to see the expected string/array structures.
 *
 * The middleware is idempotent (safe to run more than once) and guards against
 * prototype-pollution keys during sanitization.
 *
 * @param req Express request object
 * @param res Express response object
 * @param next Express next function
 */
export const sanitize = (req: Request, _res: Response, next: NextFunction): void => {
  if (req.body) {
    req.body = sanitizeObject(req.body);
  }
  if (req.query) {
    req.query = sanitizeObject(req.query);
  }
  if (req.params) {
    req.params = sanitizeObject(req.params);
  }
  next();
};

export default sanitize;
