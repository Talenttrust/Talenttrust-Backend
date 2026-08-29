import type { WebhookSubscription } from '../../../types/webhook.types';
import {
  fromWebhookSubscriptionResponseDto,
  toCreateWebhookSubscriptionDto,
  toUpdateWebhookSubscriptionDto,
  toWebhookSubscriptionResponseDto,
} from './webhook-subscription.dto';

describe('webhook subscription boundary DTO mappings', () => {
  it('round-trips a subscription response DTO without changing its fields', () => {
    const subscription: WebhookSubscription = {
      id: 'sub-1',
      consumerId: 'consumer-1',
      url: 'https://example.com/hook',
      eventType: 'contract.created',
      secret: 'super-secret',
      active: true,
      createdAt: '2026-07-25T10:00:00.000Z',
      updatedAt: '2026-07-25T10:05:00.000Z',
    };

    expect(fromWebhookSubscriptionResponseDto(toWebhookSubscriptionResponseDto(subscription))).toEqual({
      ...subscription,
      secret: undefined,
    });
  });

  it('maps a create request while omitting missing optional fields', () => {
    const request = {
      url: 'https://example.com/hook',
      eventType: 'contract.updated',
    };

    expect(toCreateWebhookSubscriptionDto(request)).toEqual(request);
  });

  it('maps an update request and preserves explicit false values', () => {
    const request = {
      url: 'https://example.com/updated',
      active: false,
    };

    expect(toUpdateWebhookSubscriptionDto(request)).toEqual(request);
  });

  it('omits missing optional fields when shaping a response', () => {
    const subscription: WebhookSubscription = {
      id: 'sub-2',
      url: 'https://example.com/hook',
      eventType: 'contract.created',
      active: false,
      createdAt: '2026-07-25T10:00:00.000Z',
      updatedAt: '2026-07-25T10:00:00.000Z',
    };

    expect(toWebhookSubscriptionResponseDto(subscription)).toEqual({
      id: 'sub-2',
      url: 'https://example.com/hook',
      eventType: 'contract.created',
      active: false,
      createdAt: '2026-07-25T10:00:00.000Z',
      updatedAt: '2026-07-25T10:00:00.000Z',
    });
  });
});
