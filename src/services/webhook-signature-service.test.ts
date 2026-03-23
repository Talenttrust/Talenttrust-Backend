import { ApiError } from '../errors/ApiError';
import type { WebhookConfig } from '../config/webhook-config';
import {
  WebhookSignatureService,
  constantTimeHexEquals,
  normalizeSignature,
  parseWebhookTimestamp,
  signPayload,
} from './webhook-signature-service';

describe('WebhookSignatureService', () => {
  const config: WebhookConfig = {
    secret: 'top-secret',
    signatureHeader: 'x-webhook-signature',
    timestampHeader: 'x-webhook-timestamp',
    eventIdHeader: 'x-webhook-id',
    maxAgeSeconds: 300,
    rawBodyLimit: '64kb',
  };

  it('accepts a valid signature within the replay window', () => {
    const rawBody = Buffer.from('{"id":"evt-1"}');
    const timestamp = '1700000000';
    const service = new WebhookSignatureService(config, () => 1_700_000_100_000);

    expect(() =>
      service.verify(rawBody, {
        signature: `sha256=${signPayload(config.secret, timestamp, rawBody)}`,
        timestamp,
      }),
    ).not.toThrow();
  });

  it('rejects missing secrets and invalid signature inputs', () => {
    const rawBody = Buffer.from('{}');
    const unconfigured = new WebhookSignatureService({ ...config, secret: '' });

    expect(() =>
      unconfigured.verify(rawBody, { signature: 'sha256=abc', timestamp: '1700000000' }),
    ).toThrow(new ApiError(503, 'Webhook endpoint is not configured.'));

    const service = new WebhookSignatureService(config, () => 1_700_000_100_000);

    expect(() => service.verify(rawBody, { timestamp: '1700000000' })).toThrow(
      new ApiError(401, 'Invalid webhook signature.'),
    );
    expect(() =>
      service.verify(rawBody, { signature: 'bad-format', timestamp: '1700000000' }),
    ).toThrow(new ApiError(401, 'Invalid webhook signature.'));
  });

  it('rejects stale or tampered deliveries', () => {
    const rawBody = Buffer.from('{"id":"evt-1"}');
    const timestamp = '1700000000';
    const service = new WebhookSignatureService(config, () => 1_700_001_000_000);

    expect(() =>
      service.verify(rawBody, {
        signature: signPayload(config.secret, timestamp, rawBody),
        timestamp,
      }),
    ).toThrow(new ApiError(401, 'Invalid webhook signature.'));

    const freshService = new WebhookSignatureService(config, () => 1_700_000_100_000);

    expect(() =>
      freshService.verify(rawBody, {
        signature: signPayload(config.secret, timestamp, Buffer.from('{"id":"evt-2"}')),
        timestamp,
      }),
    ).toThrow(new ApiError(401, 'Invalid webhook signature.'));
  });

  it('normalizes and validates signatures and timestamps', () => {
    const digest = 'a'.repeat(64);

    expect(normalizeSignature(`sha256=${digest}`)).toBe(digest);
    expect(normalizeSignature(digest.toUpperCase())).toBe(digest);
    expect(() => normalizeSignature('sha256=xyz')).toThrow(
      new ApiError(401, 'Invalid webhook signature.'),
    );

    expect(parseWebhookTimestamp('1700000000')).toBe(1_700_000_000);
    expect(() => parseWebhookTimestamp('not-a-number')).toThrow(
      new ApiError(401, 'Invalid webhook signature.'),
    );

    expect(constantTimeHexEquals(digest, digest)).toBe(true);
    expect(constantTimeHexEquals(digest, 'b'.repeat(64))).toBe(false);
    expect(constantTimeHexEquals(digest, 'short')).toBe(false);
  });
});
