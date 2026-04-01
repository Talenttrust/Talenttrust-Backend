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
 * Recursively sanitize an object or string using xss filtering.
 * 
 * @param obj The input object, array, or string to sanitize
 * @returns The sanitized object, array, or string
 * 
 * @dev Security Assumptions:
 * - This function assumes the input is a POJO (Plain Old JavaScript Object), array, or primitive.
 * - Complex objects (like Dates, Buffers) are returned as is to prevent corruption, 
 *   as they are not typical vectors for XSS in their raw form until serialized.
 * - All string values are passed through the strict XSS filter.
 */
const sanitizeObject = (obj: any): any => {
  if (typeof obj === 'string') {
    return customXss.process(obj.trim());
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeObject(item));
  }

  if (obj !== null && typeof obj === 'object') {
    // Avoid sanitizing special objects like Date or Buffer
    if (obj instanceof Date || Buffer.isBuffer(obj)) {
      return obj;
    }

    const sanitizedObj: { [key: string]: any } = {};
    for (const [key, value] of Object.entries(obj)) {
      sanitizedObj[key] = sanitizeObject(value);
    }
    return sanitizedObj;
  }

  return obj;
};

/**
 * Express middleware to sanitize incoming request data.
 * It sanitizes `req.body`, `req.query`, and `req.params`.
 * 
 * @param req Express request object
 * @param res Express response object
 * @param next Express next function
 */
export const sanitize = (req: Request, res: Response, next: NextFunction): void => {
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
