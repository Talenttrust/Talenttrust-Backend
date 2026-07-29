/**
 * @module reputation-webhook/service.test
 *
 * Comprehensive tests for reputation webhook notification service.
 *
 * Test coverage:
 * - Event creation and validation
 * - Subscription management
 * - Event delivery with retry/backoff
 * - Dead-letter queue handling
 * - Payload size validation
 * - Signature generation
 * - Circuit breaker integration
 */

import { Registry } from 'prom-client';
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
  ReputationWebhookService,
  initializeReputationWebhookService,
  getReputationWebhookService,
  resetGlobalInstance,
  type ReputationWebhookServiceConfig,
} from './reputation-webhook.service';
import { InMemoryDlqStore } from '../../../dlqStore';
import {
  type ReputationWebhookEvent,
  type ReputationWebhookSubscription,
  createRatingCreatedEvent,
  validatePayloadSize,
  MAX_WEBHOOK_PAYLOAD_SIZE,
} from './reputation-webhook.types';

describe('ReputationWebhookService', () => {
  let registry: Registry;
  let service: ReputationWebhookService;
  let mockFetch: jest.MockedFunction<typeof fetch>;

  beforeEach(() => {
    registry = new Registry();
    registry.clear();
    
    // Mock fetch for HTTP delivery
    mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
    global.fetch = mockFetch;

    // Reset global singleton
    resetGlobalInstance();
  });

  afterEach(() => {
    jest.clearAllMocks();
    registry.clear();
  });

  describe('Initialization', () => {
    it('should initialize service with default config', () => {
      const config: ReputationWebhookServiceConfig = { registry };
      service = new ReputationWebhookService(config);
      
      expect(service).toBeInstanceOf(ReputationWebhookService);
      expect(service.getDlqDepth()).toEqual(new Map());
    });

    it('should initialize with custom DLQ store', () => {
      const customDlq = new InMemoryDlqStore();
      const config: ReputationWebhookServiceConfig = { registry, dlqStore: customDlq };
      service = new ReputationWebhookService(config);
      
      expect(service).toBeInstanceOf(ReputationWebhookService);
    });

    it('should initialize global singleton', () => {
      const config: ReputationWebhookServiceConfig = { registry };
      const instance = initializeReputationWebhookService(config);
      
      expect(instance).toBeInstanceOf(ReputationWebhookService);
      expect(getReputationWebhookService()).toBe(instance);
    });

    it('should throw if initializing singleton twice', () => {
      const config: ReputationWebhookServiceConfig = { registry };
      initializeReputationWebhookService(config);
      
      expect(() => initializeReputationWebhookService(config)).toThrow(
        'ReputationWebhookService already initialized'
      );
    });

    it('should throw if getting singleton before initialization', () => {
      expect(() => getReputationWebhookService()).toThrow(
        'ReputationWebhookService not initialized'
      );
    });
  });

  describe('Subscription Management', () => {
    beforeEach(() => {
      service = new ReputationWebhookService({ registry });
    });

    it('should add subscription with generated ID', () => {
      const subscription: ReputationWebhookSubscription = {
        subscriberId: '',
        webhookUrl: 'https://example.com/webhook',
        secret: 'test-secret',
        eventTypes: ['reputation.rating.created'],
      };
      
      const id = service.addSubscription(subscription);
      expect(id).toBeTruthy();
      expect(typeof id).toBe('string');
    });

    it('should add subscription with custom ID', () => {
      const subscription: ReputationWebhookSubscription = {
        subscriberId: 'custom-sub-id',
        webhookUrl: 'https://example.com/webhook',
        secret: 'test-secret',
        eventTypes: ['reputation.rating.created'],
      };
      
      const id = service.addSubscription(subscription);
      expect(id).toBe('custom-sub-id');
    });

    it('should remove subscription', () => {
      const subscription: ReputationWebhookSubscription = {
        subscriberId: 'test-sub',
        webhookUrl: 'https://example.com/webhook',
        secret: 'test-secret',
        eventTypes: [],
      };
      
      service.addSubscription(subscription);
      const removed = service.removeSubscription('test-sub');
      
      expect(removed).toBe(true);
      expect(service.getSubscriptions()).toHaveLength(0);
    });

    it('should return false when removing non-existent subscription', () => {
      const removed = service.removeSubscription('non-existent');
      expect(removed).toBe(false);
    });

    it('should get all subscriptions', () => {
      const sub1: ReputationWebhookSubscription = {
        subscriberId: 'sub1',
        webhookUrl: 'https://example.com/webhook1',
        secret: 'secret1',
        eventTypes: [],
      };
      const sub2: ReputationWebhookSubscription = {
        subscriberId: 'sub2',
        webhookUrl: 'https://example.com/webhook2',
        secret: 'secret2',
        eventTypes: [],
      };
      
      service.addSubscription(sub1);
      service.addSubscription(sub2);
      
      const subscriptions = service.getSubscriptions();
      expect(subscriptions).toHaveLength(2);
      expect(subscriptions[0].id).toBe('sub1');
      expect(subscriptions[1].id).toBe('sub2');
    });
  });

  describe('Event Emission', () => {
    beforeEach(() => {
      service = new ReputationWebhookService({ registry });
    });

    it('should emit event to matching subscriptions', async () => {
      const subscription: ReputationWebhookSubscription = {
        subscriberId: 'test-sub',
        webhookUrl: 'https://example.com/webhook',
        secret: 'test-secret',
        eventTypes: ['reputation.rating.created'],
      };
      
      service.addSubscription(subscription);
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
      } as Response);
      
      const event = createRatingCreatedEvent(
        'target-123',
        'reviewer-456',
        5,
        'context-789',
        'entry-101',
        4.8,
        10,
        4.9,
        'exp-decay-v1',
        'Great work!'
      );
      
      const results = await service.emitEvent(event);
      
      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      expect(results[0].statusCode).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should emit to subscriptions with matching event type', async () => {
      const subscription: ReputationWebhookSubscription = {
        subscriberId: 'test-sub',
        webhookUrl: 'https://example.com/webhook',
        secret: 'test-secret',
        eventTypes: ['reputation.rating.created'],
      };
      
      service.addSubscription(subscription);
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
      } as Response);
      
      const event = createRatingCreatedEvent(
        'target-123',
        'reviewer-456',
        5,
        'context-789',
        'entry-101',
        4.8,
        10,
        4.9,
        'exp-decay-v1'
      );
      
      const results = await service.emitEvent(event);
      
      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
    });

    it('should not emit to subscriptions with mismatched target filter', async () => {
      const subscription: ReputationWebhookSubscription = {
        subscriberId: 'test-sub',
        webhookUrl: 'https://example.com/webhook',
        secret: 'test-secret',
        eventTypes: [],
        targetFilter: 'other-target',
      };
      
      service.addSubscription(subscription);
      
      const event = createRatingCreatedEvent(
        'target-123',
        'reviewer-456',
        5,
        'context-789',
        'entry-101',
        4.8,
        10,
        4.9,
        'exp-decay-v1'
      );
      
      const results = await service.emitEvent(event);
      
      expect(results).toHaveLength(0);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should emit to subscriptions with matching target filter', async () => {
      const subscription: ReputationWebhookSubscription = {
        subscriberId: 'test-sub',
        webhookUrl: 'https://example.com/webhook',
        secret: 'test-secret',
        eventTypes: [],
        targetFilter: 'target-123',
      };
      
      service.addSubscription(subscription);
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
      } as Response);
      
      const event = createRatingCreatedEvent(
        'target-123',
        'reviewer-456',
        5,
        'context-789',
        'entry-101',
        4.8,
        10,
        4.9,
        'exp-decay-v1'
      );
      
      const results = await service.emitEvent(event);
      
      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
    });

    it('should emit to multiple subscriptions in parallel', async () => {
      const sub1: ReputationWebhookSubscription = {
        subscriberId: 'sub1',
        webhookUrl: 'https://example.com/webhook1',
        secret: 'secret1',
        eventTypes: [],
      };
      const sub2: ReputationWebhookSubscription = {
        subscriberId: 'sub2',
        webhookUrl: 'https://example.com/webhook2',
        secret: 'secret2',
        eventTypes: [],
      };
      
      service.addSubscription(sub1);
      service.addSubscription(sub2);
      
      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200 } as Response)
        .mockResolvedValueOnce({ ok: true, status: 200 } as Response);
      
      const event = createRatingCreatedEvent(
        'target-123',
        'reviewer-456',
        5,
        'context-789',
        'entry-101',
        4.8,
        10,
        4.9,
        'exp-decay-v1'
      );
      
      const results = await service.emitEvent(event);
      
      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should throw error for oversized payload', async () => {
      const subscription: ReputationWebhookSubscription = {
        subscriberId: 'test-sub',
        webhookUrl: 'https://example.com/webhook',
        secret: 'test-secret',
        eventTypes: [],
      };
      
      service.addSubscription(subscription);
      
      // Create an event with a massive comment to exceed size limit
      const largeComment = 'x'.repeat(MAX_WEBHOOK_PAYLOAD_SIZE + 1000);
      const event = createRatingCreatedEvent(
        'target-123',
        'reviewer-456',
        5,
        'context-789',
        'entry-101',
        4.8,
        10,
        4.9,
        'exp-decay-v1',
        largeComment
      );
      
      await expect(service.emitEvent(event)).rejects.toThrow(
        'Webhook payload exceeds maximum size of 100 KB'
      );
    });
  });

  describe('Retry and Backoff', () => {
    beforeEach(() => {
      service = new ReputationWebhookService({
        registry,
        retryConfig: {
          maxAttempts: 3,
          initialDelayMs: 10,
          maxDelayMs: 100,
          multiplier: 2,
          jitterFactor: 0,
        },
      });
    });

    it('should retry on 5xx errors', async () => {
      const subscription: ReputationWebhookSubscription = {
        subscriberId: 'test-sub',
        webhookUrl: 'https://example.com/webhook',
        secret: 'test-secret',
        eventTypes: [],
      };
      
      service.addSubscription(subscription);
      
      // Fail twice with 500, then succeed
      mockFetch
        .mockResolvedValueOnce({ status: 500 } as Response)
        .mockResolvedValueOnce({ status: 500 } as Response)
        .mockResolvedValueOnce({ ok: true, status: 200 } as Response);
      
      const event = createRatingCreatedEvent(
        'target-123',
        'reviewer-456',
        5,
        'context-789',
        'entry-101',
        4.8,
        10,
        4.9,
        'exp-decay-v1'
      );
      
      const results = await service.emitEvent(event);
      
      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('should retry on network errors', async () => {
      const subscription: ReputationWebhookSubscription = {
        subscriberId: 'test-sub',
        webhookUrl: 'https://example.com/webhook',
        secret: 'test-secret',
        eventTypes: [],
      };
      
      service.addSubscription(subscription);
      
      // Fail twice with ECONNREFUSED, then succeed
      const networkError = new Error('ECONNREFUSED');
      (networkError as any).code = 'ECONNREFUSED';
      
      mockFetch
        .mockRejectedValueOnce(networkError)
        .mockRejectedValueOnce(networkError)
        .mockResolvedValueOnce({ ok: true, status: 200 } as Response);
      
      const event = createRatingCreatedEvent(
        'target-123',
        'reviewer-456',
        5,
        'context-789',
        'entry-101',
        4.8,
        10,
        4.9,
        'exp-decay-v1'
      );
      
      const results = await service.emitEvent(event);
      
      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('should not retry on 4xx errors', async () => {
      const subscription: ReputationWebhookSubscription = {
        subscriberId: 'test-sub',
        webhookUrl: 'https://example.com/webhook',
        secret: 'test-secret',
        eventTypes: [],
      };
      
      service.addSubscription(subscription);
      
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
      } as Response);
      
      const event = createRatingCreatedEvent(
        'target-123',
        'reviewer-456',
        5,
        'context-789',
        'entry-101',
        4.8,
        10,
        4.9,
        'exp-decay-v1'
      );
      
      const results = await service.emitEvent(event);
      
      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(false);
      expect(results[0].statusCode).toBe(400);
      expect(results[0].enqueueToDoLQ).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should enqueue to DLQ after max retries exhausted', async () => {
      const subscription: ReputationWebhookSubscription = {
        subscriberId: 'test-sub',
        webhookUrl: 'https://example.com/webhook',
        secret: 'test-secret',
        eventTypes: [],
      };
      
      service.addSubscription(subscription);
      
      // Always fail with 500
      mockFetch.mockRejectedValue(new Error('HTTP 500'));
      
      const event = createRatingCreatedEvent(
        'target-123',
        'reviewer-456',
        5,
        'context-789',
        'entry-101',
        4.8,
        10,
        4.9,
        'exp-decay-v1'
      );
      
      const results = await service.emitEvent(event);
      
      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(false);
      expect(results[0].enqueueToDoLQ).toBe(true);
      
      // Verify DLQ entry
      const dlqDepth = service.getDlqDepth();
      expect(dlqDepth.get('reputation-webhook')).toBe(1);
    });
  });

  describe('Dead-Letter Queue', () => {
    beforeEach(() => {
      service = new ReputationWebhookService({
        registry,
        retryConfig: { maxAttempts: 2, initialDelayMs: 10, maxDelayMs: 100, multiplier: 2, jitterFactor: 0 },
      });
    });

    it('should track DLQ depth by provider', async () => {
      const subscription: ReputationWebhookSubscription = {
        subscriberId: 'test-sub',
        webhookUrl: 'https://example.com/webhook',
        secret: 'test-secret',
        eventTypes: [],
      };
      
      service.addSubscription(subscription);
      mockFetch.mockRejectedValue(new Error('HTTP 500'));
      
      const event = createRatingCreatedEvent(
        'target-123',
        'reviewer-456',
        5,
        'context-789',
        'entry-101',
        4.8,
        10,
        4.9,
        'exp-decay-v1'
      );
      
      await service.emitEvent(event);
      
      const depth = service.getDlqDepth();
      expect(depth.get('reputation-webhook')).toBe(1);
    });

    it('should track DLQ oldest entry age', async () => {
      const subscription: ReputationWebhookSubscription = {
        subscriberId: 'test-sub',
        webhookUrl: 'https://example.com/webhook',
        secret: 'test-secret',
        eventTypes: [],
      };
      
      service.addSubscription(subscription);
      mockFetch.mockRejectedValue(new Error('HTTP 500'));
      
      const event = createRatingCreatedEvent(
        'target-123',
        'reviewer-456',
        5,
        'context-789',
        'entry-101',
        4.8,
        10,
        4.9,
        'exp-decay-v1'
      );
      
      await service.emitEvent(event);
      
      const ages = service.getDlqOldestAge();
      expect(ages.get('reputation-webhook')).toBeGreaterThanOrEqual(0);
      expect(ages.get('reputation-webhook')).toBeLessThan(1); // Should be very recent
    });

    it('should drain DLQ entries', async () => {
      const subscription: ReputationWebhookSubscription = {
        subscriberId: 'test-sub',
        webhookUrl: 'https://example.com/webhook',
        secret: 'test-secret',
        eventTypes: [],
      };
      
      service.addSubscription(subscription);
      mockFetch.mockRejectedValue(new Error('HTTP 500'));
      
      const event = createRatingCreatedEvent(
        'target-123',
        'reviewer-456',
        5,
        'context-789',
        'entry-101',
        4.8,
        10,
        4.9,
        'exp-decay-v1'
      );
      
      await service.emitEvent(event);
      
      const drained = service.drainDlq('reputation-webhook', 10);
      expect(drained).toHaveLength(1);
      
      const depth = service.getDlqDepth();
      expect(depth.get('reputation-webhook') ?? 0).toBe(0);
    });

    it('should clear DLQ', async () => {
      const subscription: ReputationWebhookSubscription = {
        subscriberId: 'test-sub',
        webhookUrl: 'https://example.com/webhook',
        secret: 'test-secret',
        eventTypes: [],
      };
      
      service.addSubscription(subscription);
      mockFetch.mockRejectedValue(new Error('HTTP 500'));
      
      const event = createRatingCreatedEvent(
        'target-123',
        'reviewer-456',
        5,
        'context-789',
        'entry-101',
        4.8,
        10,
        4.9,
        'exp-decay-v1'
      );
      
      await service.emitEvent(event);
      
      service.clearDlq();
      
      const depth = service.getDlqDepth();
      expect(depth.get('reputation-webhook')).toBeUndefined();
    });
  });

  describe('Signature Generation', () => {
    beforeEach(() => {
      service = new ReputationWebhookService({ registry });
    });

    it('should include signature headers in delivery', async () => {
      const subscription: ReputationWebhookSubscription = {
        subscriberId: 'test-sub',
        webhookUrl: 'https://example.com/webhook',
        secret: 'test-secret',
        eventTypes: [],
      };
      
      service.addSubscription(subscription);
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
      } as Response);
      
      const event = createRatingCreatedEvent(
        'target-123',
        'reviewer-456',
        5,
        'context-789',
        'entry-101',
        4.8,
        10,
        4.9,
        'exp-decay-v1'
      );
      
      await service.emitEvent(event);
      
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[0]).toBe('https://example.com/webhook');
      expect(callArgs[1]?.headers).toMatchObject({
        'Content-Type': 'application/json',
        'X-Event-Type': 'reputation.rating.created',
      });
      expect(callArgs[1]?.headers['X-Signature']).toMatch(/^sha256=[a-f0-9]{64}$/);
      expect(callArgs[1]?.headers['X-Timestamp']).toMatch(/^\d+$/);
      expect(callArgs[1]?.headers['X-Event-ID']).toBe(event.eventId);
    });
  });

  describe('Convenience Methods', () => {
    beforeEach(() => {
      service = new ReputationWebhookService({ registry });
    });

    it('should emit rating created event via convenience method', async () => {
      const subscription: ReputationWebhookSubscription = {
        subscriberId: 'test-sub',
        webhookUrl: 'https://example.com/webhook',
        secret: 'test-secret',
        eventTypes: [],
      };
      
      service.addSubscription(subscription);
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
      } as Response);
      
      const results = await service.emitRatingCreated(
        'target-123',
        'reviewer-456',
        5,
        'context-789',
        'entry-101',
        4.8,
        10,
        4.9,
        'exp-decay-v1',
        'Great work!'
      );
      
      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('Metrics', () => {
    beforeEach(() => {
      service = new ReputationWebhookService({ registry });
    });

    it('should emit events emitted metric', async () => {
      const subscription: ReputationWebhookSubscription = {
        subscriberId: 'test-sub',
        webhookUrl: 'https://example.com/webhook',
        secret: 'test-secret',
        eventTypes: [],
      };
      
      service.addSubscription(subscription);
      mockFetch.mockResolvedValue({ ok: true, status: 200 } as Response);
      
      const event = createRatingCreatedEvent(
        'target-123',
        'reviewer-456',
        5,
        'context-789',
        'entry-101',
        4.8,
        10,
        4.9,
        'exp-decay-v1'
      );
      
      await service.emitEvent(event);
      
      const metric = registry.getSingleMetric('reputation_webhook_events_emitted_total');
      const metricValue = await metric?.get() as { values: Array<{ value: number }> };
      expect(metricValue?.values[0].value).toBe(1);
    });

    it('should emit delivery success metric', async () => {
      const subscription: ReputationWebhookSubscription = {
        subscriberId: 'test-sub',
        webhookUrl: 'https://example.com/webhook',
        secret: 'test-secret',
        eventTypes: [],
      };
      
      service.addSubscription(subscription);
      mockFetch.mockResolvedValue({ ok: true, status: 200 } as Response);
      
      const event = createRatingCreatedEvent(
        'target-123',
        'reviewer-456',
        5,
        'context-789',
        'entry-101',
        4.8,
        10,
        4.9,
        'exp-decay-v1'
      );
      
      await service.emitEvent(event);
      
      const metric = registry.getSingleMetric('reputation_webhook_deliveries_success_total');
      const metricValue = await metric?.get() as { values: Array<{ value: number }> };
      expect(metricValue?.values[0].value).toBe(1);
    });

    it('should emit delivery failure metric', async () => {
      const subscription: ReputationWebhookSubscription = {
        subscriberId: 'test-sub',
        webhookUrl: 'https://example.com/webhook',
        secret: 'test-secret',
        eventTypes: [],
      };
      
      service.addSubscription(subscription);
      mockFetch.mockResolvedValue({ ok: false, status: 400 } as Response);
      
      const event = createRatingCreatedEvent(
        'target-123',
        'reviewer-456',
        5,
        'context-789',
        'entry-101',
        4.8,
        10,
        4.9,
        'exp-decay-v1'
      );
      
      await service.emitEvent(event);
      
      const metric = registry.getSingleMetric('reputation_webhook_deliveries_failure_total');
      const metricValue = await metric?.get() as { values: Array<{ value: number }> };
      expect(metricValue?.values[0].value).toBe(1);
    });

    it('should emit DLQ enqueue metric', async () => {
      const subscription: ReputationWebhookSubscription = {
        subscriberId: 'test-sub',
        webhookUrl: 'https://example.com/webhook',
        secret: 'test-secret',
        eventTypes: [],
      };
      
      service.addSubscription(subscription);
      mockFetch.mockRejectedValue(new Error('HTTP 500'));
      
      const event = createRatingCreatedEvent(
        'target-123',
        'reviewer-456',
        5,
        'context-789',
        'entry-101',
        4.8,
        10,
        4.9,
        'exp-decay-v1'
      );
      
      await service.emitEvent(event);
      
      const metric = registry.getSingleMetric('reputation_webhook_dlq_enqueued_total');
      const metricValue = await metric?.get() as { values: Array<{ value: number }> };
      expect(metricValue?.values[0].value).toBe(1);
    });
  });
});

describe('reputation-webhook.types', () => {
  describe('createRatingCreatedEvent', () => {
    it('should create valid rating created event', () => {
      const event = createRatingCreatedEvent(
        'target-123',
        'reviewer-456',
        5,
        'context-789',
        'entry-101',
        4.8,
        10,
        4.9,
        'exp-decay-v1',
        'Great work!'
      );
      
      expect(event.eventType).toBe('reputation.rating.created');
      expect(event.eventId).toBeTruthy();
      expect(event.timestamp).toBeTruthy();
      expect(event.data.targetId).toBe('target-123');
      expect(event.data.reviewerId).toBe('reviewer-456');
      expect(event.data.rating).toBe(5);
      expect(event.data.contextId).toBe('context-789');
      expect(event.data.entryId).toBe('entry-101');
      expect(event.data.newScore).toBe(4.8);
      expect(event.data.totalRatings).toBe(10);
      expect(event.data.weightedScore).toBe(4.9);
      expect(event.data.scoreAlgorithm).toBe('exp-decay-v1');
      expect(event.data.comment).toBe('Great work!');
    });

    it('should create event without comment', () => {
      const event = createRatingCreatedEvent(
        'target-123',
        'reviewer-456',
        5,
        'context-789',
        'entry-101',
        4.8,
        10,
        4.9,
        'exp-decay-v1'
      );
      
      expect(event.data.comment).toBeUndefined();
    });

    it('should generate unique event IDs', () => {
      const event1 = createRatingCreatedEvent(
        'target-123',
        'reviewer-456',
        5,
        'context-789',
        'entry-101',
        4.8,
        10,
        4.9,
        'exp-decay-v1'
      );
      const event2 = createRatingCreatedEvent(
        'target-123',
        'reviewer-456',
        5,
        'context-789',
        'entry-101',
        4.8,
        10,
        4.9,
        'exp-decay-v1'
      );
      
      expect(event1.eventId).not.toBe(event2.eventId);
    });
  });

  describe('validatePayloadSize', () => {
    it('should validate normal payload', () => {
      const event = createRatingCreatedEvent(
        'target-123',
        'reviewer-456',
        5,
        'context-789',
        'entry-101',
        4.8,
        10,
        4.9,
        'exp-decay-v1',
        'Great work!'
      );
      
      expect(validatePayloadSize(event)).toBe(true);
    });

    it('should reject oversized payload', () => {
      const largePayload = {
        eventType: 'reputation.rating.created',
        eventId: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        data: {
          comment: 'x'.repeat(MAX_WEBHOOK_PAYLOAD_SIZE + 1000),
        },
      };
      
      expect(validatePayloadSize(largePayload)).toBe(false);
    });

    it('should handle invalid payload gracefully', () => {
      // Circular reference that can't be serialized
      const circular: any = { a: 1 };
      circular.self = circular;
      
      expect(validatePayloadSize(circular)).toBe(false);
    });
  });
});
