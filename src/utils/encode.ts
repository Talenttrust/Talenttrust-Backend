/**
 * Safely encodes a string for use in HTML contexts.
 * This is a defense-in-depth measure. While the backend primarily serves JSON,
 * explicit HTML encoding utilities are useful if raw strings are ever embedded or logged.
 * 
 * @param input The untrusted input string
 * @returns The HTML-encoded, safe string
 * 
 * @dev Security Assumptions:
 * - Replaces `&`, `<`, `>`, `"`, and `'` with their corresponding HTML entities.
 * - Does not protect against all XSS contexts (e.g., inside an unquoted attribute or JavaScript block),
 *   but is sufficient for standard HTML body contexts or quoted attributes.
 */
export const encodeHtml = (input: string | null | undefined): string => {
  if (!input) return '';
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
};
