/**
 * @module redact
 * @description Utilities for redacting secrets and signatures from log output.
 *
 * Never log raw HMAC signatures, signing secrets, or nonces.  Pass any
 * string through `redactSecret` before including it in a log record.
 */

const REDACTED = '[REDACTED]';
const SENSITIVE_KEYS = new Set([
  'secret',
  'signature',
  'token',
  'accesstoken',
  'authtoken',
  'apikey',
  'privatekey',
  'key',
  'password',
  'authorization',
  'nonce',
  'cookie',
]);
const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-api-secret',
  'x-auth-token',
  'x-access-token',
  'proxy-authorization',
  'x-forwarded-for',
  'x-real-ip',
]);
const DEFAULT_HEADER_VALUE_MAX_LENGTH = 200;

/**
 * Replaces a secret value with a fixed redaction marker.
 *
 * @param _value - The sensitive value (unused; accepted so call-sites are explicit).
 * @returns The redaction marker string.
 */
export function redactSecret(_value: unknown): string {
  return REDACTED;
}

/**
 * Redacts all values in an object whose keys match known sensitive patterns.
 *
 * @param obj - Plain object to sanitise.
 * @returns A new object with sensitive values replaced by `[REDACTED]`.
 */
export function redactObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (isSensitiveKey(k)) {
      out[k] = REDACTED;
    } else if (v !== null && typeof v === 'object') {
      if (Array.isArray(v)) {
        // Recursively process array elements
        out[k] = v.map(item => {
          if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
            return redactObject(item as Record<string, unknown>);
          }
          return item;
        });
      } else {
        // Recursively process nested objects
        out[k] = redactObject(v as Record<string, unknown>);
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Redacts sensitive HTTP header values while preserving non-sensitive headers.
 * Header matching is case-insensitive and known sensitive headers are always masked.
 * Non-sensitive string values are truncated to a bounded length for log safety.
 *
 * @param headers - Header map from Express request/response objects.
 * @param maxValueLength - Maximum length for non-sensitive string header values.
 * @returns A new object safe to include in structured logs.
 */
export function redactHeaders(
  headers: Record<string, unknown> | undefined,
  maxValueLength = DEFAULT_HEADER_VALUE_MAX_LENGTH,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};

  if (!headers) {
    return sanitized;
  }

  for (const [key, value] of Object.entries(headers)) {
    if (SENSITIVE_HEADER_NAMES.has(key.toLowerCase())) {
      sanitized[key] = REDACTED;
      continue;
    }

    if (typeof value === 'string' && value.length > maxValueLength) {
      sanitized[key] = value.slice(0, maxValueLength) + '...';
      continue;
    }

    sanitized[key] = value;
  }

  return sanitized;
}

/**
 * Top-level payload redaction wrapper added for DLQ replay pipelines.
 * Safely accepts unknown structures and runs recursive redactions on arrays and objects.
 * @param payload - The incoming webhook message payload data structure.
 * @returns Sanitised payload data where all sensitive parameters are scrubbed.
 */
export function redactPayload(payload: unknown): any {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }

  if (Array.isArray(payload)) {
    return payload.map(item => redactPayload(item));
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redactPayload(value);
  }
  return out;
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase().replace(/[-_]/g, ''));
}
