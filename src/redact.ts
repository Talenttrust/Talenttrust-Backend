/**
 * Redaction utilities — nothing sensitive ever reaches the log transport.
 */

// Headers that must never appear in logs
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-api-secret',
  'x-auth-token',
  'proxy-authorization',
]);

// Query-parameter keys whose values must be masked
const SENSITIVE_PARAMS = new Set([
  'token',
  'access_token',
  'refresh_token',
  'api_key',
  'apikey',
  'secret',
  'password',
  'passwd',
  'email',
  'phone',
  'ssn',
  'credit_card',
]);

const MASK = '[REDACTED]';

/**
 * Returns a copy of the headers object with all sensitive keys removed.
 * Keys are compared case-insensitively.
 */
export function redactHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | string[] | undefined> {
  const safe: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!SENSITIVE_HEADERS.has(key.toLowerCase())) {
      safe[key] = value;
    }
  }
  return safe;
}

/**
 * Masks sensitive query-parameter values in a URL string.
 * The path is preserved; only param values are replaced with [REDACTED].
 */
export function redactUrl(rawUrl: string): string {
  let url: URL;
  try {
    // Use a dummy base so relative paths parse correctly
    url = new URL(rawUrl, 'http://localhost');
  } catch {
    return MASK;
  }

  // Rebuild the query string manually so the MASK literal is never percent-encoded
  const parts: string[] = [];
  for (const [key, value] of url.searchParams.entries()) {
    const maskedValue = SENSITIVE_PARAMS.has(key.toLowerCase()) ? MASK : value;
    parts.push(`${encodeURIComponent(key)}=${maskedValue === MASK ? MASK : encodeURIComponent(value)}`);
  }
  const search = parts.length > 0 ? `?${parts.join('&')}` : '';

  const isAbsolute = rawUrl.startsWith('http://') || rawUrl.startsWith('https://');
  return isAbsolute
    ? `${url.origin}${url.pathname}${search}`
    : `${url.pathname}${search}`;
}

/**
 * Normalises a URL path to a cardinality-safe pattern.
 * e.g. /users/123/orders/abc-456  →  /users/:id/orders/:id
 */
export function normalizeUrlPath(rawUrl: string): string {
  let pathname: string;
  try {
    pathname = new URL(rawUrl, 'http://localhost').pathname;
  } catch {
    return MASK;
  }

  return pathname
    // UUIDs
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
    // Pure numeric segments
    .replace(/\/\d+(?=\/|$)/g, '/:id')
    // Alphanumeric slugs that look like IDs (≥8 chars, mixed alpha+digit)
    .replace(/\/[a-z0-9]*\d[a-z0-9]{6,}(?=\/|$)/gi, '/:id');
}
