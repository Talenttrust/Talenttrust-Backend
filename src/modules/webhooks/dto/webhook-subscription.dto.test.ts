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

import {
  bulkCreateItemSchema,
  bulkUpdateItemSchema,
  bulkDeleteItemSchema,
  bulkWebhookItemSchema,
  bulkWebhookSubscriptionSchema,
  MAX_WEBHOOK_BULK_BATCH_SIZE,
} from './webhook-subscription.dto';

// ---------------------------------------------------------------------------
// Bulk schema unit tests
//
// These cover the new bulk schemas added for POST /api/v1/webhook-subscriptions/bulk.
// Integration tests live in webhook-subscription.bulk.test.ts but require a
// working createApp() + DB stack. Schema tests here run without any DB or HTTP
// stack and provide complete coverage of the Zod validation logic.
// ---------------------------------------------------------------------------

describe('MAX_WEBHOOK_BULK_BATCH_SIZE', () => {
  it('is 25', () => {
    expect(MAX_WEBHOOK_BULK_BATCH_SIZE).toBe(25);
  });
});

describe('bulkCreateItemSchema', () => {
  it('accepts a minimal valid create item', () => {
    const result = bulkCreateItemSchema.safeParse({
      operation: 'create',
      url: 'https://example.com/hook',
      eventType: 'contract.created',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a create item with all optional fields', () => {
    const result = bulkCreateItemSchema.safeParse({
      operation: 'create',
      url: 'https://example.com/hook',
      eventType: 'contract.created',
      consumerId: '550e8400-e29b-41d4-a716-446655440000',
      secret: 'shh',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-URL url', () => {
    expect(
      bulkCreateItemSchema.safeParse({ operation: 'create', url: 'not-a-url', eventType: 'x' }).success,
    ).toBe(false);
  });

  it('rejects missing url', () => {
    expect(
      bulkCreateItemSchema.safeParse({ operation: 'create', eventType: 'x' }).success,
    ).toBe(false);
  });

  it('rejects empty eventType', () => {
    expect(
      bulkCreateItemSchema.safeParse({ operation: 'create', url: 'https://example.com', eventType: '' }).success,
    ).toBe(false);
  });

  it('rejects eventType exceeding 100 characters', () => {
    expect(
      bulkCreateItemSchema.safeParse({
        operation: 'create',
        url: 'https://example.com',
        eventType: 'x'.repeat(101),
      }).success,
    ).toBe(false);
  });

  it('rejects non-UUID consumerId', () => {
    expect(
      bulkCreateItemSchema.safeParse({
        operation: 'create',
        url: 'https://example.com',
        eventType: 'x',
        consumerId: 'not-a-uuid',
      }).success,
    ).toBe(false);
  });

  it('rejects secret exceeding 256 characters', () => {
    expect(
      bulkCreateItemSchema.safeParse({
        operation: 'create',
        url: 'https://example.com',
        eventType: 'x',
        secret: 'a'.repeat(257),
      }).success,
    ).toBe(false);
  });

  it('rejects missing operation', () => {
    expect(
      bulkCreateItemSchema.safeParse({ url: 'https://example.com', eventType: 'x' }).success,
    ).toBe(false);
  });
});

describe('bulkUpdateItemSchema', () => {
  const validId = '550e8400-e29b-41d4-a716-446655440000';

  it('accepts a minimal valid update item (id only)', () => {
    expect(
      bulkUpdateItemSchema.safeParse({ operation: 'update', id: validId }).success,
    ).toBe(true);
  });

  it('accepts all optional update fields', () => {
    expect(
      bulkUpdateItemSchema.safeParse({
        operation: 'update',
        id: validId,
        url: 'https://example.com/new',
        eventType: 'payment.completed',
        active: false,
        secret: 'new-secret',
      }).success,
    ).toBe(true);
  });

  it('rejects missing id', () => {
    expect(
      bulkUpdateItemSchema.safeParse({ operation: 'update', active: false }).success,
    ).toBe(false);
  });

  it('rejects non-UUID id', () => {
    expect(
      bulkUpdateItemSchema.safeParse({ operation: 'update', id: 'not-a-uuid' }).success,
    ).toBe(false);
  });

  it('rejects invalid url when url is present', () => {
    expect(
      bulkUpdateItemSchema.safeParse({ operation: 'update', id: validId, url: 'not-a-url' }).success,
    ).toBe(false);
  });

  it('accepts active: false (explicit boolean)', () => {
    expect(
      bulkUpdateItemSchema.safeParse({ operation: 'update', id: validId, active: false }).success,
    ).toBe(true);
  });
});

describe('bulkDeleteItemSchema', () => {
  const validId = '550e8400-e29b-41d4-a716-446655440000';

  it('accepts a valid delete item', () => {
    expect(
      bulkDeleteItemSchema.safeParse({ operation: 'delete', id: validId }).success,
    ).toBe(true);
  });

  it('rejects missing id', () => {
    expect(bulkDeleteItemSchema.safeParse({ operation: 'delete' }).success).toBe(false);
  });

  it('rejects non-UUID id', () => {
    expect(
      bulkDeleteItemSchema.safeParse({ operation: 'delete', id: 'bad-id' }).success,
    ).toBe(false);
  });
});

describe('bulkWebhookItemSchema (discriminated union)', () => {
  const validId = '550e8400-e29b-41d4-a716-446655440000';

  it('routes to create branch on operation=create', () => {
    const result = bulkWebhookItemSchema.safeParse({
      operation: 'create',
      url: 'https://example.com',
      eventType: 'x',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.operation).toBe('create');
  });

  it('routes to update branch on operation=update', () => {
    const result = bulkWebhookItemSchema.safeParse({ operation: 'update', id: validId });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.operation).toBe('update');
  });

  it('routes to delete branch on operation=delete', () => {
    const result = bulkWebhookItemSchema.safeParse({ operation: 'delete', id: validId });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.operation).toBe('delete');
  });

  it('rejects unknown operation value', () => {
    expect(
      bulkWebhookItemSchema.safeParse({ operation: 'upsert', url: 'https://example.com', eventType: 'x' }).success,
    ).toBe(false);
  });

  it('rejects missing operation field', () => {
    expect(
      bulkWebhookItemSchema.safeParse({ url: 'https://example.com', eventType: 'x' }).success,
    ).toBe(false);
  });
});

describe('bulkWebhookSubscriptionSchema', () => {
  const validId = '550e8400-e29b-41d4-a716-446655440000';

  const oneItem = [{ operation: 'delete', id: validId }];
  const atCap = Array.from({ length: MAX_WEBHOOK_BULK_BATCH_SIZE }, (_, i) => ({
    operation: 'delete',
    id: `550e8400-e29b-41d4-a716-${String(i).padStart(12, '0')}`,
  }));
  const overCap = [...atCap, { operation: 'delete', id: validId }];

  it('accepts a single-item batch', () => {
    expect(bulkWebhookSubscriptionSchema.safeParse({ body: { items: oneItem } }).success).toBe(true);
  });

  it(`accepts a batch at exactly cap (${MAX_WEBHOOK_BULK_BATCH_SIZE} items)`, () => {
    expect(bulkWebhookSubscriptionSchema.safeParse({ body: { items: atCap } }).success).toBe(true);
  });

  it('rejects an empty items array', () => {
    expect(bulkWebhookSubscriptionSchema.safeParse({ body: { items: [] } }).success).toBe(false);
  });

  it(`rejects a batch exceeding cap (${MAX_WEBHOOK_BULK_BATCH_SIZE + 1} items)`, () => {
    expect(bulkWebhookSubscriptionSchema.safeParse({ body: { items: overCap } }).success).toBe(false);
  });

  it('rejects missing items field', () => {
    expect(bulkWebhookSubscriptionSchema.safeParse({ body: {} }).success).toBe(false);
  });

  it('rejects missing body', () => {
    expect(bulkWebhookSubscriptionSchema.safeParse({}).success).toBe(false);
  });

  it('accepts items containing non-object elements (envelope validates length only, items validated per-item in handler)', () => {
    // The envelope schema validates only array length; per-item validation
    // happens in the route handler via bulkWebhookItemSchema.safeParse().
    const result = bulkWebhookSubscriptionSchema.safeParse({
      body: { items: ['invalid', null, 42] },
    });
    expect(result.success).toBe(true); // length = 3, within cap
  });
});
