import { createHmac, timingSafeEqual } from 'crypto';

import { ApiError } from '../errors/ApiError';
import type { WebhookConfig } from '../config/webhook-config';

interface VerificationHeaders {
  signature?: string;
  timestamp?: string;
}

/**
 * @notice Verifies signed webhook deliveries against the raw request body.
 */
export class WebhookSignatureService {
  /**
   * @param config Verified runtime webhook configuration.
   * @param now Clock injection for deterministic tests.
   */
  constructor(
    private readonly config: WebhookConfig,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * @notice Reject unsigned, stale, or tampered webhook deliveries.
   * @param rawBody Raw request body captured before JSON parsing.
   * @param headers Signature and timestamp values extracted from the request.
   */
  verify(rawBody: Buffer, headers: VerificationHeaders): void {
    if (!this.config.secret) {
      throw new ApiError(503, 'Webhook endpoint is not configured.');
    }

    const signature = headers.signature?.trim();
    const timestamp = headers.timestamp?.trim();

    if (!signature || !timestamp) {
      throw new ApiError(401, 'Invalid webhook signature.');
    }

    const timestampSeconds = parseWebhookTimestamp(timestamp);
    const ageSeconds = Math.abs(Math.floor(this.now() / 1000) - timestampSeconds);

    if (ageSeconds > this.config.maxAgeSeconds) {
      throw new ApiError(401, 'Invalid webhook signature.');
    }

    const expected = signPayload(this.config.secret, timestamp, rawBody);
    const actual = normalizeSignature(signature);

    if (!constantTimeHexEquals(expected, actual)) {
      throw new ApiError(401, 'Invalid webhook signature.');
    }
  }
}

/**
 * @notice Create the HMAC digest over the provider timestamp and raw body.
 * @param secret Shared webhook secret.
 * @param timestamp Header timestamp used in the signed payload.
 * @param rawBody Exact bytes received from the provider.
 */
export function signPayload(secret: string, timestamp: string, rawBody: Buffer): string {
  return createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest('hex');
}

/**
 * @notice Compare two SHA-256 hex digests using a timing-safe primitive.
 * @param expectedHex Expected lowercase digest.
 * @param actualHex Untrusted lowercase digest supplied by the client.
 */
export function constantTimeHexEquals(expectedHex: string, actualHex: string): boolean {
  if (!isSha256Hex(expectedHex) || !isSha256Hex(actualHex)) {
    return false;
  }

  return timingSafeEqual(Buffer.from(expectedHex, 'hex'), Buffer.from(actualHex, 'hex'));
}

/**
 * @notice Normalize the supported signature header format.
 * @param signatureHeader Raw header value, with or without `sha256=` prefix.
 */
export function normalizeSignature(signatureHeader: string): string {
  const normalized = signatureHeader.startsWith('sha256=')
    ? signatureHeader.slice('sha256='.length)
    : signatureHeader;

  if (!isSha256Hex(normalized)) {
    throw new ApiError(401, 'Invalid webhook signature.');
  }

  return normalized.toLowerCase();
}

/**
 * @notice Validate and parse the signed webhook timestamp header.
 * @param timestamp Raw timestamp header value.
 */
export function parseWebhookTimestamp(timestamp: string): number {
  if (!/^\d{1,16}$/.test(timestamp)) {
    throw new ApiError(401, 'Invalid webhook signature.');
  }

  const parsed = Number.parseInt(timestamp, 10);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ApiError(401, 'Invalid webhook signature.');
  }

  return parsed;
}

/**
 * @notice Ensure the value is a full SHA-256 digest encoded in hex.
 * @param value Candidate signature value.
 */
export function isSha256Hex(value: string): boolean {
  return /^[a-fA-F0-9]{64}$/.test(value);
}
