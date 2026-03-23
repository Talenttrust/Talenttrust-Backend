import request from 'supertest';

import { createApp } from './app';
import type { WebhookConfig } from './config/webhook-config';
import { signPayload } from './services/webhook-signature-service';
import type { WebhookEventProcessor } from './types/webhook';

function buildWebhookConfig(overrides?: Partial<WebhookConfig>): WebhookConfig {
  return {
    secret: 'integration-secret',
    signatureHeader: 'x-webhook-signature',
    timestampHeader: 'x-webhook-timestamp',
    eventIdHeader: 'x-webhook-id',
    maxAgeSeconds: 300,
    rawBodyLimit: '1kb',
    ...overrides,
  };
}

function buildSignedRequest(
  app: ReturnType<typeof createApp>,
  body: string,
  config: WebhookConfig,
  options?: {
    timestamp?: string;
    eventId?: string;
    signatureBody?: string;
  },
) {
  const timestamp = options?.timestamp ?? `${Math.floor(Date.now() / 1000)}`;
  const signatureBody = options?.signatureBody ?? body;
  const signature = signPayload(config.secret, timestamp, Buffer.from(signatureBody));

  return request(app)
    .post('/webhooks/blockchain')
    .set('Content-Type', 'application/json')
    .set(config.timestampHeader, timestamp)
    .set(config.signatureHeader, `sha256=${signature}`)
    .set(config.eventIdHeader, options?.eventId ?? 'evt-123')
    .send(body);
}

describe('blockchain webhook integration', () => {
  const validBody = JSON.stringify({
    type: 'contract.metadata.updated',
    occurredAt: '2026-03-01T10:00:00.000Z',
    network: 'stellar-testnet',
    data: {
      contractId: 'ctr-123',
      transactionHash: '0xabc12345',
      blockNumber: 101,
      metadataUri: 'ipfs://metadata',
    },
  });

  it('accepts a valid signed webhook and calls the processor', async () => {
    const processor: WebhookEventProcessor = { process: jest.fn() };
    const config = buildWebhookConfig();
    const app = createApp({
      webhookConfig: config,
      webhookEventProcessor: processor,
    });

    const response = await buildSignedRequest(app, validBody, config);

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ status: 'acknowledged' });
    expect(processor.process).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'evt-123',
        eventType: 'contract.metadata.updated',
        contractId: 'ctr-123',
      }),
    );
  });

  it('rejects missing, malformed, invalid, and stale signatures', async () => {
    const config = buildWebhookConfig();
    const app = createApp({ webhookConfig: config });

    const missing = await request(app)
      .post('/webhooks/blockchain')
      .set('Content-Type', 'application/json')
      .send(validBody);
    expect(missing.status).toBe(401);
    expect(missing.body).toEqual({ error: 'Invalid webhook signature.' });

    const malformed = await request(app)
      .post('/webhooks/blockchain')
      .set('Content-Type', 'application/json')
      .set(config.timestampHeader, '1700000000')
      .set(config.signatureHeader, 'sha256=bad')
      .send(validBody);
    expect(malformed.status).toBe(401);
    expect(malformed.body).toEqual({ error: 'Invalid webhook signature.' });

    const invalid = await buildSignedRequest(app, validBody, config, {
      signatureBody: '{"type":"contract.payment.released"}',
    });
    expect(invalid.status).toBe(401);
    expect(invalid.body).toEqual({ error: 'Invalid webhook signature.' });

    const stale = await buildSignedRequest(app, validBody, config, {
      timestamp: `${Math.floor(Date.now() / 1000) - 1_000}`,
    });
    expect(stale.status).toBe(401);
    expect(stale.body).toEqual({ error: 'Invalid webhook signature.' });
  });

  it('verifies against the exact raw body rather than reserialized JSON', async () => {
    const config = buildWebhookConfig();
    const app = createApp({ webhookConfig: config });
    const compactBody = '{"type":"contract.metadata.updated","occurredAt":"2026-03-01T10:00:00.000Z","network":"stellar-testnet","data":{"contractId":"ctr-123","transactionHash":"0xabc12345","blockNumber":101,"metadataUri":"ipfs://metadata"}}';
    const prettyBody = JSON.stringify(JSON.parse(compactBody), null, 2);

    const response = await buildSignedRequest(app, prettyBody, config, {
      signatureBody: compactBody,
    });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'Invalid webhook signature.' });
  });

  it('handles duplicates idempotently and avoids duplicate processing', async () => {
    const processor: WebhookEventProcessor = { process: jest.fn() };
    const config = buildWebhookConfig();
    const app = createApp({
      webhookConfig: config,
      webhookEventProcessor: processor,
    });

    const first = await buildSignedRequest(app, validBody, config, { eventId: 'evt-dup' });
    const second = await buildSignedRequest(app, validBody, config, { eventId: 'evt-dup' });

    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ status: 'already_processed' });
    expect(processor.process).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed payloads and unsupported event types after verification', async () => {
    const config = buildWebhookConfig();
    const app = createApp({ webhookConfig: config });

    const invalidJson = '{"type":';
    const invalidJsonResponse = await buildSignedRequest(app, invalidJson, config, {
      eventId: 'evt-bad-json',
    });
    expect(invalidJsonResponse.status).toBe(400);
    expect(invalidJsonResponse.body).toEqual({ error: 'Webhook payload must be valid JSON.' });

    const unsupportedBody = JSON.stringify({
      type: 'contract.unknown',
      occurredAt: '2026-03-01T10:00:00.000Z',
      network: 'stellar-testnet',
      data: { contractId: 'ctr-123' },
    });
    const unsupported = await buildSignedRequest(app, unsupportedBody, config, {
      eventId: 'evt-unsupported',
    });
    expect(unsupported.status).toBe(400);
    expect(unsupported.body).toEqual({ error: 'Webhook event type is not supported.' });
  });

  it('keeps failures sanitized and allows retries after processor errors', async () => {
    const processor: WebhookEventProcessor = {
      process: jest
        .fn()
        .mockImplementationOnce(() => {
          throw new Error('secret downstream failure');
        })
        .mockImplementationOnce(() => undefined),
    };
    const config = buildWebhookConfig();
    const app = createApp({
      webhookConfig: config,
      webhookEventProcessor: processor,
    });

    const first = await buildSignedRequest(app, validBody, config, { eventId: 'evt-retry' });
    const retry = await buildSignedRequest(app, validBody, config, { eventId: 'evt-retry' });

    expect(first.status).toBe(500);
    expect(first.body).toEqual({ error: 'Internal server error.' });
    expect(retry.status).toBe(202);
    expect(processor.process).toHaveBeenCalledTimes(2);
  });

  it('rejects empty bodies, oversized bodies, and missing configuration safely', async () => {
    const configuredApp = createApp({ webhookConfig: buildWebhookConfig() });

    const emptyResponse = await request(configuredApp)
      .post('/webhooks/blockchain')
      .set('Content-Type', 'application/json')
      .set('x-webhook-timestamp', '1700000000')
      .set(
        'x-webhook-signature',
        `sha256=${signPayload('integration-secret', '1700000000', Buffer.from(''))}`,
      )
      .send('');
    expect(emptyResponse.status).toBe(400);
    expect(emptyResponse.body).toEqual({ error: 'Webhook body is required.' });

    const oversizedBody = JSON.stringify({
      type: 'contract.metadata.updated',
      occurredAt: '2026-03-01T10:00:00.000Z',
      network: 'stellar-testnet',
      data: {
        contractId: 'ctr-123',
        metadataUri: `ipfs://${'x'.repeat(2_000)}`,
      },
    });
    const oversized = await buildSignedRequest(configuredApp, oversizedBody, buildWebhookConfig());
    expect(oversized.status).toBe(413);
    expect(oversized.body).toEqual({ error: 'Request body is too large.' });

    const unconfiguredApp = createApp({
      webhookConfig: buildWebhookConfig({ secret: '' }),
    });
    const unconfigured = await request(unconfiguredApp)
      .post('/webhooks/blockchain')
      .set('Content-Type', 'application/json')
      .send(validBody);
    expect(unconfigured.status).toBe(503);
    expect(unconfigured.body).toEqual({ error: 'Webhook endpoint is not configured.' });
  });
});
