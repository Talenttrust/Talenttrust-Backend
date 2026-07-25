import { createHmac, timingSafeEqual } from 'crypto';
import { safeMessageForCode, sanitizeErrorMessage } from '../errors/safeErrors';

export interface WebhookSignature {
  signature: string;
  timestamp: number;
}

/** Maximum age of a webhook timestamp before rejection (5 minutes). */
export const WEBHOOK_SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;

/** Expected length of a hex-encoded SHA-256 HMAC digest. */
export const WEBHOOK_SIGNATURE_HEX_LENGTH = 64;

/**
 * Machine-readable codes returned by {@link verifyWebhookSignature}.
 * Messages are always resolved through {@link safeMessageForCode}.
 */
export const WEBHOOK_VERIFICATION_CODES = {
  VALID: 'valid',
  TIMESTAMP_EXPIRED: 'unauthorized',
  INVALID_TIMESTAMP: 'bad_request',
  INVALID_SIGNATURE_FORMAT: 'bad_request',
  SIGNATURE_MISMATCH: 'invalid_webhook_signature',
  MISSING_SECRET: 'bad_request',
} as const;

export type WebhookVerificationCode =
  (typeof WEBHOOK_VERIFICATION_CODES)[keyof typeof WEBHOOK_VERIFICATION_CODES];

export interface WebhookVerificationResult {
  /** `true` only when the HMAC matches and the timestamp is within the allowed window. */
  valid: boolean;
  /** Stable machine code; `valid` when {@link valid} is `true`. */
  code: WebhookVerificationCode;
  /** Client-safe message from the safe-errors policy; never contains secrets or stack traces. */
  message: string;
}

/**
 * Generates an HMAC-SHA256 signature for webhook payloads.
 *
 * @param payload - Webhook body object (serialized with `JSON.stringify`).
 * @param secret - Shared signing secret.
 * @param timestamp - Unix timestamp in milliseconds included in the canonical string.
 * @returns Lowercase hex-encoded HMAC digest (64 characters).
 */
export function generateSignature(
  payload: unknown,
  secret: string,
  timestamp: number,
): string {
  const canonicalString = `${timestamp}.${JSON.stringify(payload)}`;
  const hmac = createHmac('sha256', secret);
  hmac.update(canonicalString);
  return hmac.digest('hex');
}

/**
 * Creates webhook signature material for outbound delivery headers.
 *
 * @param payload - Webhook body to sign.
 * @param secret - Shared signing secret.
 */
export function createWebhookSignature(
  payload: unknown,
  secret: string,
): WebhookSignature {
  const timestamp = Date.now();
  const signature = generateSignature(payload, secret, timestamp);
  return { signature, timestamp };
}

/**
 * Strips the optional `sha256=` prefix and validates hex encoding.
 *
 * @returns Normalized lowercase hex digest, or `null` when the header is malformed.
 */
export function normalizeSignatureHeader(signature: unknown): string | null {
  if (typeof signature !== 'string') {
    return null;
  }

  const trimmed = signature.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const hexBody = /^sha256=/i.test(trimmed) ? trimmed.slice('sha256='.length) : trimmed;
  if (hexBody.length === 0 || hexBody.length > 256) {
    return null;
  }

  if (!/^[a-fA-F0-9]+$/.test(hexBody)) {
    return null;
  }

  return hexBody.toLowerCase();
}

/**
 * Constant-time comparison of two hex-encoded digests.
 * Uses `crypto.timingSafeEqual` on decoded buffers; length mismatches still perform
 * a dummy comparison to avoid leaking digest length via timing.
 *
 * @internal Exported for adversarial test coverage only.
 */
export function constantTimeCompareHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');

  if (left.length !== right.length || left.length === 0) {
    timingSafeEqual(left.length > 0 ? left : Buffer.alloc(32), left.length > 0 ? left : Buffer.alloc(32));
    return false;
  }

  return timingSafeEqual(left, right);
}

/**
 * Full webhook signature verification with safe, structured failure reasons.
 *
 * @param payload - Parsed webhook JSON body.
 * @param signature - Value of the `X-Signature` header (may include `sha256=` prefix).
 * @param timestamp - Value of the `X-Timestamp` header (milliseconds).
 * @param secret - Shared signing secret.
 * @param options - Optional overrides (e.g. clock for tests).
 */
export function verifyWebhookSignature(
  payload: unknown,
  signature: unknown,
  timestamp: unknown,
  secret: unknown,
  options?: { now?: number; maxAgeMs?: number },
): WebhookVerificationResult {
  const now = options?.now ?? Date.now();
  const maxAgeMs = options?.maxAgeMs ?? WEBHOOK_SIGNATURE_MAX_AGE_MS;

  if (typeof secret !== 'string' || secret.length === 0) {
    return failure(WEBHOOK_VERIFICATION_CODES.MISSING_SECRET, 'Webhook secret is required');
  }

  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) {
    return failure(WEBHOOK_VERIFICATION_CODES.INVALID_TIMESTAMP, 'Webhook timestamp is invalid');
  }

  if (now - timestamp > maxAgeMs) {
    return failure(WEBHOOK_VERIFICATION_CODES.TIMESTAMP_EXPIRED, 'Webhook timestamp is too old');
  }

  const normalizedSignature = normalizeSignatureHeader(signature);
  if (
    normalizedSignature === null ||
    normalizedSignature.length !== WEBHOOK_SIGNATURE_HEX_LENGTH
  ) {
    return failure(
      WEBHOOK_VERIFICATION_CODES.INVALID_SIGNATURE_FORMAT,
      'Webhook signature format is invalid',
    );
  }

  const expectedSignature = generateSignature(payload, secret, timestamp);
  if (!constantTimeCompareHex(normalizedSignature, expectedSignature)) {
    return failure(
      WEBHOOK_VERIFICATION_CODES.SIGNATURE_MISMATCH,
      'Webhook signature does not match',
    );
  }

  return {
    valid: true,
    code: WEBHOOK_VERIFICATION_CODES.VALID,
    message: 'Webhook signature is valid',
  };
}

/**
 * Boolean convenience wrapper around {@link verifyWebhookSignature}.
 */
export function verifySignature(
  payload: unknown,
  signature: string,
  timestamp: number,
  secret: string,
  options?: { now?: number; maxAgeMs?: number },
): boolean {
  return verifyWebhookSignature(payload, signature, timestamp, secret, options).valid;
}

function failure(code: Exclude<WebhookVerificationCode, 'valid'>, rawMessage: string): WebhookVerificationResult {
  const message = sanitizeErrorMessage(rawMessage, code);
  return { valid: false, code, message };
}
