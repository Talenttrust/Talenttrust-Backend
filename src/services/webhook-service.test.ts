import { ApiError } from '../errors/ApiError';
import type { WebhookEventProcessor } from '../types/webhook';
import { InMemoryWebhookDeliveryStore } from './webhook-delivery-store';
import {
  InMemoryWebhookEventProcessor,
  WebhookService,
  listSupportedWebhookEventTypes,
  normalizeWebhookPayload,
} from './webhook-service';

describe('WebhookService', () => {
  const validPayload = {
    id: 'evt-payload',
    type: 'contract.metadata.updated' as const,
    occurredAt: '2026-03-01T10:00:00.000Z',
    network: 'stellar-testnet',
    data: {
      contractId: 'ctr-123',
      transactionHash: '0xabc12345',
      blockNumber: 101,
      metadataUri: 'ipfs://metadata',
    },
  };

  it('normalizes supported events and prefers the header delivery id', () => {
    expect(normalizeWebhookPayload(validPayload, 'evt-header')).toEqual({
      eventId: 'evt-header',
      eventType: 'contract.metadata.updated',
      occurredAt: '2026-03-01T10:00:00.000Z',
      network: 'stellar-testnet',
      contractId: 'ctr-123',
      transactionHash: '0xabc12345',
      blockNumber: 101,
      metadataUri: 'ipfs://metadata',
      status: undefined,
    });
  });

  it('rejects malformed and unsupported payloads', () => {
    expect(() => normalizeWebhookPayload([] as never)).toThrow(
      new ApiError(400, 'Webhook payload must be a JSON object.'),
    );
    expect(() => normalizeWebhookPayload({})).toThrow(
      new ApiError(400, 'Webhook event id is required.'),
    );
    expect(() =>
      normalizeWebhookPayload({
        ...validPayload,
        occurredAt: 'not-a-date',
      }),
    ).toThrow(new ApiError(400, 'Webhook occurredAt must be a valid ISO-8601 timestamp.'));
    expect(() =>
      normalizeWebhookPayload({
        ...validPayload,
        data: undefined,
      }),
    ).toThrow(new ApiError(400, 'Webhook data must be a JSON object.'));
    expect(() =>
      normalizeWebhookPayload({
        ...validPayload,
        type: 'unsupported.event',
      }),
    ).toThrow(new ApiError(400, 'Webhook event type is not supported.'));
    expect(() =>
      normalizeWebhookPayload({
        ...validPayload,
        data: { contractId: '!' },
      }),
    ).toThrow(new ApiError(400, 'Webhook contractId is invalid.'));
    expect(() =>
      normalizeWebhookPayload({
        ...validPayload,
        data: {
          contractId: 'ctr-123',
          transactionHash: 'invalid',
        },
      }),
    ).toThrow(new ApiError(400, 'Webhook transactionHash is invalid.'));
    expect(() =>
      normalizeWebhookPayload({
        ...validPayload,
        data: {
          contractId: 'ctr-123',
          blockNumber: -1,
        },
      }),
    ).toThrow(new ApiError(400, 'Webhook blockNumber is invalid.'));
  });

  it('processes verified events once and suppresses duplicates', () => {
    const processor = new InMemoryWebhookEventProcessor();
    const service = new WebhookService(new InMemoryWebhookDeliveryStore(60), processor);

    const first = service.handleVerifiedPayload(validPayload, 'evt-1');
    const second = service.handleVerifiedPayload(validPayload, 'evt-1');

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(processor.listProcessedEvents()).toHaveLength(1);
  });

  it('releases reservations if processing fails so retries can succeed', () => {
    const processor: WebhookEventProcessor = {
      process: jest
        .fn()
        .mockImplementationOnce(() => {
          throw new Error('boom');
        })
        .mockImplementationOnce(() => undefined),
    };
    const service = new WebhookService(new InMemoryWebhookDeliveryStore(60), processor);

    expect(() => service.handleVerifiedPayload(validPayload, 'evt-2')).toThrow('boom');

    const retry = service.handleVerifiedPayload(validPayload, 'evt-2');

    expect(retry.duplicate).toBe(false);
    expect(processor.process).toHaveBeenCalledTimes(2);
  });

  it('lists supported event types for documentation and tests', () => {
    expect(listSupportedWebhookEventTypes()).toEqual([
      'contract.metadata.updated',
      'contract.payment.released',
    ]);
  });
});
