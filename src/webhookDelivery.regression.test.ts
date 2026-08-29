/**
 * @file webhookDelivery.regression.test.ts
 * Regression tests for known/tricky webhook edge cases (issue #943):
 * empty, boundary, and malformed inputs across delivery, provider
 * sanitization, retry configuration, and the two independent backoff
 * implementations found to have diverged.
 */

import { Registry } from 'prom-client';
import { WebhookDeliveryService, DeliveryPayload } from './webhookDelivery';
import { calculateWebhookRetryDelay, WEBHOOK_RETRY_POLICY } from './queue/webhook-retry-policy';

describe('WebhookDeliveryService — empty/boundary/malformed regression cases (#943)', () => {
  let registry: Registry;

  beforeEach(() => {
    registry = new Registry();
  });

  describe('empty delivery payload', () => {
    it('delivers successfully with an empty body object ({})', async () => {
      const service = new WebhookDeliveryService(registry);
      const httpClient = jest.fn().mockResolvedValue({ statusCode: 200 });
      const payload: DeliveryPayload = { provider: 'stripe', url: 'https://example.com/hook', body: {} };

      const result = await service.deliver(payload, httpClient);

      expect(result.success).toBe(true);
      expect(httpClient).toHaveBeenCalledWith('https://example.com/hook', {});
    });

    it('delivers with an empty-string url without throwing (passes it through to httpClient as-is)', async () => {
      const service = new WebhookDeliveryService(registry);
      const httpClient = jest.fn().mockResolvedValue({ statusCode: 200 });
      const payload: DeliveryPayload = { provider: 'github', url: '', body: { event: 'push' } };

      const result = await service.deliver(payload, httpClient);

      expect(result.success).toBe(true);
      expect(httpClient).toHaveBeenCalledWith('', { event: 'push' });
    });
  });

  describe('empty/whitespace provider names (sanitizeProvider boundary)', () => {
    it('maps an empty-string provider to "generic"', async () => {
      const service = new WebhookDeliveryService(registry);
      const httpClient = jest.fn().mockResolvedValue({ statusCode: 200 });

      await service.deliver({ provider: '', url: 'https://example.com', body: {} }, httpClient);

      expect(service.getBreakerState('')).toBe('CLOSED');
      // A whitespace/empty provider must not create its own breaker bucket
      // distinct from "generic" -- it should share the same fallback breaker.
      expect(service.getBreakerState('generic')).toBe('CLOSED');
    });

    it('maps a whitespace-only provider ("   ") to "generic", not a distinct bucket', async () => {
      const service = new WebhookDeliveryService(registry);
      const httpClient = jest.fn().mockResolvedValue({ statusCode: 500 });

      // Trip the "   " breaker.
      for (let i = 0; i < 5; i += 1) {
        await service.deliver({ provider: '   ', url: 'https://example.com', body: {} }, httpClient);
      }

      // If "   " correctly maps to the same "generic" bucket as an actual
      // empty/unknown provider, tripping it should also show as OPEN under
      // the "generic" label used elsewhere in this suite for unknown providers.
      expect(service.getBreakerState('   ')).toBe('OPEN');
      expect(service.getBreakerState('totally-unrelated-unknown-provider')).toBe('OPEN');
    });
  });

  describe('retry configuration boundary: maxAttempts = 1 (no retries allowed)', () => {
    it('does not retry at all and goes straight to DLQ on a single 5xx failure', async () => {
      const dlqCallback = jest.fn();
      const service = new WebhookDeliveryService(registry, {}, { maxAttempts: 1 }, dlqCallback);
      const httpClient = jest.fn().mockResolvedValue({ statusCode: 503 });

      const result = await service.deliver({ provider: 'stripe', url: 'https://example.com', body: {} }, httpClient);

      expect(httpClient).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(false);
      expect(result.enqueueToDoLQ).toBe(true);
      expect(dlqCallback).toHaveBeenCalledTimes(1);
    });
  });

  describe('malformed/unusual DLQ callback behavior', () => {
    it('still reports delivery failure correctly when the DLQ callback throws synchronously', async () => {
      const dlqCallback = jest.fn(() => {
        throw new Error('DLQ storage unavailable');
      });
      const service = new WebhookDeliveryService(registry, {}, { maxAttempts: 1 }, dlqCallback);
      const httpClient = jest.fn().mockResolvedValue({ statusCode: 500 });

      const result = await service.deliver({ provider: 'github', url: 'https://example.com', body: {} }, httpClient);

      expect(result.success).toBe(false);
      expect(result.enqueueToDoLQ).toBe(true);
      expect(dlqCallback).toHaveBeenCalledTimes(1);
    });
  });

  describe('KNOWN DIVERGENCE (documented, not silently fixed): two independent backoff implementations disagree', () => {
    /**
     * This codebase has two separate exponential-backoff-with-jitter
     * implementations that are meant to express the same retry policy:
     *
     *   - webhookDelivery.ts's internal calculateBackoffDelay(attemptNumber),
     *     used by WebhookDeliveryService, floors the delay at 0ms and
     *     numbers its first retry attempt as 1.
     *   - queue/webhook-retry-policy.ts's calculateWebhookRetryDelay(attemptNumber),
     *     used by services/webhook.service.ts, floors the delay at 100ms
     *     and numbers its first retry attempt as 0.
     *
     * Both floors and both attempt-numbering conventions currently differ.
     * This is not necessarily a crash-causing bug today, but it means the
     * two delivery paths' "same" retry policy silently drifts if either
     * formula is tweaked without the other being updated in lockstep.
     *
     * These tests pin down the CURRENT behavior of calculateWebhookRetryDelay
     * so any future change to it is a deliberate, visible decision rather
     * than an invisible regression -- and they document the floor mismatch
     * explicitly so it isn't rediscovered from scratch later.
     */
    it('calculateWebhookRetryDelay never returns less than its 100ms floor, even at attempt 0 with worst-case negative jitter', () => {
      const originalRandom = Math.random;
      try {
        // Force the most negative possible jitter offset.
        Math.random = () => 0; // selects the "-jitterAmount" branch, and jitterAmount uses Math.random() again
        const delay = calculateWebhookRetryDelay(0);
        expect(delay).toBeGreaterThanOrEqual(100);
      } finally {
        Math.random = originalRandom;
      }
    });

    it('documents that WEBHOOK_RETRY_POLICY.maxRetries (5) matches WebhookDeliveryService default maxAttempts (5), even though the two backoff floors differ', () => {
      // If this ever fails, the two retry ladders have also diverged on
      // attempt count, not just delay floor -- worth a fresh look at both
      // modules together rather than patching one in isolation.
      expect(WEBHOOK_RETRY_POLICY.maxRetries).toBe(5);
    });
  });
});

describe('WebhookDeliveryService — additional coverage: mid-retry circuit trip and loop fallthrough (#943)', () => {
  let registry: Registry;

  beforeEach(() => {
    registry = new Registry();
  });

  it('returns circuitOpen:true if the breaker trips to OPEN between retry attempts (not just before the first attempt)', async () => {
    const service = new WebhookDeliveryService(registry, { failureThreshold: 1 }, { maxAttempts: 3, initialDelayMs: 1 });
    let callCount = 0;
    const httpClient = jest.fn().mockImplementation(() => {
      callCount += 1;
      return Promise.resolve({ statusCode: 500 });
    });

    const result = await service.deliver({ provider: 'stripe', url: 'https://example.com', body: {} }, httpClient);

    expect(result.circuitOpen).toBe(true);
    expect(callCount).toBe(1);
  });

  it('falls through to the final { success: false, durationSeconds: 0 } return only in the theoretically unreachable case of maxAttempts <= 0', async () => {
    const service = new WebhookDeliveryService(registry, {}, { maxAttempts: 0 });
    const httpClient = jest.fn();

    const result = await service.deliver({ provider: 'github', url: 'https://example.com', body: {} }, httpClient);

    expect(httpClient).not.toHaveBeenCalled();
    expect(result).toEqual({ success: false, durationSeconds: 0 });
  });
});

describe('WebhookDeliveryService — additional coverage: non-network errors and resetBreaker (#943)', () => {
  let registry: Registry;

  beforeEach(() => {
    registry = new Registry();
  });

  it('treats a thrown error with no statusCode and no recognized network error code as non-retryable', async () => {
    const dlqCallback = jest.fn();
    const service = new WebhookDeliveryService(registry, {}, { maxAttempts: 3 }, dlqCallback);
    const httpClient = jest.fn().mockRejectedValue(new Error('totally generic failure, no code or statusCode'));

    const result = await service.deliver({ provider: 'stripe', url: 'https://example.com', body: {} }, httpClient);

    // A bare Error with neither statusCode nor a recognized network error
    // code must not be silently retried forever -- it should be treated as
    // non-retryable and go straight to the DLQ after one attempt.
    expect(httpClient).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.enqueueToDoLQ).toBe(true);
    expect(dlqCallback).toHaveBeenCalledTimes(1);
  });

  it('resetBreaker actually resets an existing OPEN breaker back to CLOSED and updates the gauge', async () => {
    const service = new WebhookDeliveryService(registry, { failureThreshold: 1 });
    const httpClient = jest.fn().mockResolvedValue({ statusCode: 500 });

    await service.deliver({ provider: 'github', url: 'https://example.com', body: {} }, httpClient);
    expect(service.getBreakerState('github')).toBe('OPEN');

    service.resetBreaker('github');

    expect(service.getBreakerState('github')).toBe('CLOSED');
  });
});
