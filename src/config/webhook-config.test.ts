import { loadWebhookConfig, parsePositiveInteger } from './webhook-config';

describe('webhook config', () => {
  it('loads defaults when optional env vars are absent', () => {
    expect(loadWebhookConfig({ WEBHOOK_SECRET: 'secret' })).toEqual({
      secret: 'secret',
      signatureHeader: 'x-webhook-signature',
      timestampHeader: 'x-webhook-timestamp',
      eventIdHeader: 'x-webhook-id',
      maxAgeSeconds: 300,
      rawBodyLimit: '64kb',
    });
  });

  it('normalizes custom header names and parses numeric settings', () => {
    expect(
      loadWebhookConfig({
        WEBHOOK_SECRET: 'custom',
        WEBHOOK_SIGNATURE_HEADER: 'X-Signature',
        WEBHOOK_TIMESTAMP_HEADER: 'X-Timestamp',
        WEBHOOK_EVENT_ID_HEADER: 'X-Event-Id',
        WEBHOOK_MAX_AGE_SECONDS: '120',
        WEBHOOK_RAW_BODY_LIMIT: '32kb',
      }),
    ).toEqual({
      secret: 'custom',
      signatureHeader: 'x-signature',
      timestampHeader: 'x-timestamp',
      eventIdHeader: 'x-event-id',
      maxAgeSeconds: 120,
      rawBodyLimit: '32kb',
    });
  });

  it('falls back when positive integer config values are invalid', () => {
    expect(parsePositiveInteger(undefined, 10)).toBe(10);
    expect(parsePositiveInteger('0', 10)).toBe(10);
    expect(parsePositiveInteger('-1', 10)).toBe(10);
    expect(parsePositiveInteger('abc', 10)).toBe(10);
    expect(parsePositiveInteger('30', 10)).toBe(30);
  });
});
