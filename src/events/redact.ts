const REDACTED = '[REDACTED]';
const REDACTED_PAYLOAD = '[REDACTED_PAYLOAD]';
const SENSITIVE_KEY_PATTERN = /(authorization|cookie|password|secret|signature|token|api[-_]?key)/i;

/**
 * Redacts secrets from structured log metadata.
 *
 * @param value - JSON-like metadata that may contain secret-bearing fields.
 * @returns A copy with sensitive field values replaced by a redaction marker.
 */
export function redact<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => redact(item)) as T;
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redact(entry),
      ]),
    ) as T;
  }

  return value;
}

/**
 * Replaces an event payload before logging.
 *
 * @remarks
 * Payload bodies can contain user PII or signed webhook material. Conflict logs
 * should keep only routing and hash metadata, never the submitted body.
 */
export function redactPayloadForLog(_payload: unknown): string {
  return REDACTED_PAYLOAD;
}
