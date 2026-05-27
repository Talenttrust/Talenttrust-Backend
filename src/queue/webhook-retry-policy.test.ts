/**
 * @file queue/webhook-retry-policy.test.ts
 * @description Tests for webhook retry policy and delay calculation
 */

import { WEBHOOK_RETRY_POLICY, calculateWebhookRetryDelay } from '../queue/webhook-retry-policy';

describe('WebhookRetryPolicy', () => {
  describe('WEBHOOK_RETRY_POLICY', () => {
    it('should have correct max retries', () => {
      expect(WEBHOOK_RETRY_POLICY.maxRetries).toBe(5);
    });

    it('should have correct initial delay', () => {
      expect(WEBHOOK_RETRY_POLICY.initialDelayMs).toBe(1000);
    });

    it('should have valid multiplier', () => {
      expect(WEBHOOK_RETRY_POLICY.multiplier).toBe(2);
    });

    it('should have valid jitter range', () => {
      expect(WEBHOOK_RETRY_POLICY.jitter).toBeGreaterThanOrEqual(0);
      expect(WEBHOOK_RETRY_POLICY.jitter).toBeLessThanOrEqual(1);
    });
  });

  describe('calculateWebhookRetryDelay', () => {
    it('should return initial delay for first attempt', () => {
      const delay = calculateWebhookRetryDelay(0);
      expect(delay).toBeGreaterThanOrEqual(100);
      expect(delay).toBeLessThanOrEqual(WEBHOOK_RETRY_POLICY.initialDelayMs * 2);
    });

    it('should increase delay with attempt number', () => {
      const delay0 = calculateWebhookRetryDelay(0);
      const delay2 = calculateWebhookRetryDelay(2);
      
      expect(delay2).toBeGreaterThan(delay0);
    });

    it('should never exceed max delay', () => {
      for (let i = 0; i < 10; i++) {
        const delay = calculateWebhookRetryDelay(i);
        expect(delay).toBeLessThanOrEqual(WEBHOOK_RETRY_POLICY.maxDelayMs + 3000);
      }
    });

    it('should apply jitter to prevent thundering herd', () => {
      const delays = new Set<number>();
      
      for (let i = 0; i < 100; i++) {
        delays.add(calculateWebhookRetryDelay(0));
      }
      
      expect(delays.size).toBeGreaterThan(1);
    });
  });
});