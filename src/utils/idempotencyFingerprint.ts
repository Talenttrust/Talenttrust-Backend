import { createHash } from 'crypto';

/**
 * Recursively canonicalizes a JSON-serializable value into a deterministic
 * string so semantically-equal bodies produce the same fingerprint regardless
 * of object key insertion order.
 *
 * @remarks
 * This is intentionally self-contained (no Prometheus/axios import side
 * effects) so the idempotency middleware stays dependency-light. Object keys
 * are sorted at every nesting level; arrays preserve order (order is
 * semantically significant for arrays); `undefined` is canonicalized as
 * `null` so a missing body is distinguishable from an empty object.
 */
export function canonicalizeJson(value: unknown): string {
  if (value === undefined) {
    return 'null';
  }

  if (value === null || typeof value !== 'object') {
    // JSON.stringify returns `string | undefined`, but for every JSON-legal
    // primitive here (string/number/boolean/null) it is always a string.
    return JSON.stringify(value) as string;
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJson(item)).join(',')}]`;
  }

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(obj[key])}`)
    .join(',')}}`;
}

export interface IdempotencyFingerprintInput {
  method: string;
  path: string;
  tenantId: string;
  body: unknown;
}

/**
 * Computes the idempotency fingerprint for a request.
 *
 * Includes method, path, tenant scope, and the canonicalized body. No
 * secrets or request headers are included — only the fields that define the
 * logical operation being deduplicated.
 */
export function computeIdempotencyFingerprint(
  input: IdempotencyFingerprintInput,
): string {
  const { method, path, tenantId, body } = input;
  const payload = `${method}\n${path}\n${tenantId}\n${canonicalizeJson(body)}`;
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}
