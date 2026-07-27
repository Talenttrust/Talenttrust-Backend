import { Transform, TransformFnParams } from 'class-transformer';
import { FilterXSS } from 'xss';

// Re-use strict XSS options from existing sanitize middleware if possible, or define them locally
const xssOptions = {
  whiteList: {},           // Empty means no HTML tags allowed
  stripIgnoreTag: true,    // Filter out all tags not in whiteList
  stripIgnoreTagBody: ['script', 'style'], // Remove the tag AND its body
};

const xssFilter = new FilterXSS(xssOptions);

/**
 * Sanitizes a single string against XSS and basic SQL injection patterns.
 * Also trims leading/trailing spaces and normalizes to Unicode NFC.
 */
export function sanitizeString(value: string): string {
  // 1. Trim and Normalize Unicode to NFC
  let sanitized = value.trim().normalize('NFC');

  // 2. XSS HTML/JS Sanitization
  sanitized = xssFilter.process(sanitized);

  // 3. Basic SQLi prevention
  // - Escape single quotes to prevent breaking SQL syntax (standard SQL escape is '')
  // - Strip standard SQL comments: '--', '/*', '*/'
  sanitized = sanitized
    .replace(/'/g, "''")
    .replace(/--/g, '')
    .replace(/\/\*/g, '')
    .replace(/\*\//g, '');

  return sanitized;
}

/**
 * Decorator to sanitize string fields or arrays of strings using class-transformer.
 *
 * Applies trimming, Unicode NFC normalization, XSS stripping, and SQLi mitigation.
 * If the value is an array of strings, it applies the sanitization recursively to each element.
 */
export function IsSanitized() {
  return Transform((params: TransformFnParams) => {
    const { value } = params;
    if (typeof value === 'string') {
      return sanitizeString(value);
    }
    if (Array.isArray(value)) {
      return value.map((item) => (typeof item === 'string' ? sanitizeString(item) : item));
    }
    return value;
  });
}
