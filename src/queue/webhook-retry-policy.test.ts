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
    });    it('should apply jitter to prevent thundering herd', () => {
      const delays = new Set<number>();
      
      for (let i = 0; i < 100; i++) {
        delays.add(calculateWebhookRetryDelay(0));
      }
      
      expect(delays.size).toBeGreaterThan(1);
    });
  });
});

describe('WebhookRetryPolicy — env configurability (#1193)', () => {
  const ENV_KEYS = [
    'WEBHOOK_RETRY_MAX_ATTEMPTS',
    'WEBHOOK_RETRY_INITIAL_DELAY_MS',
    'WEBHOOK_RETRY_MAX_DELAY_MS',
    'WEBHOOK_RETRY_MULTIPLIER',
    'WEBHOOK_RETRY_JITTER_FACTOR',
  ];
  const originalValues = ENV_KEYS.map((k) => process.env[k]);

  afterEach(() => {
    ENV_KEYS.forEach((k, i) => {
      if (originalValues[i] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = originalValues[i] as string;
      }
    });
    jest.resetModules();
  });

  function reloadPolicy() {
    const loaded: Partial<typeof import('../queue/webhook-retry-policy')> = {};
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('../queue/webhook-retry-policy');
      Object.assign(loaded, mod);
    });
    return loaded as typeof import('../queue/webhook-retry-policy');
  }

  it('loads maxAttempts and backoff values from env vars', () => {
    process.env.WEBHOOK_RETRY_MAX_ATTEMPTS = '10';
    process.env.WEBHOOK_RETRY_INITIAL_DELAY_MS = '2000';
    process.env.WEBHOOK_RETRY_MAX_DELAY_MS = '50000';
    process.env.WEBHOOK_RETRY_MULTIPLIER = '3';
    process.env.WEBHOOK_RETRY_JITTER_FACTOR = '0.5';
    const mod = reloadPolicy();
    expect(mod.WEBHOOK_RETRY_POLICY.maxAttempts).toBe(10);
    expect(mod.WEBHOOK_RETRY_POLICY.maxRetries).toBe(9);
    expect(mod.WEBHOOK_RETRY_POLICY.initialDelayMs).toBe(2000);
    expect(mod.WEBHOOK_RETRY_POLICY.maxDelayMs).toBe(50000);
    expect(mod.WEBHOOK_RETRY_POLICY.multiplier).toBe(3);
    expect(mod.WEBHOOK_RETRY_POLICY.jitter).toBe(0.5);
  });

  it('clamps out-of-range values to safe bounds', () => {
    process.env.WEBHOOK_RETRY_MAX_ATTEMPTS = '0'; // below min → clamp to 1
    process.env.WEBHOOK_RETRY_INITIAL_DELAY_MS = '-5'; // below min → clamp to 100
    process.env.WEBHOOK_RETRY_MAX_DELAY_MS = '1'; // below min → clamp to 1000
    process.env.WEBHOOK_RETRY_MULTIPLIER = '0'; // below min → clamp to 1
    process.env.WEBHOOK_RETRY_JITTER_FACTOR = '500'; // above max → clamp to 1
    const mod = reloadPolicy();
    expect(mod.WEBHOOK_RETRY_POLICY.maxAttempts).toBe(1);
    expect(mod.WEBHOOK_RETRY_POLICY.maxRetries).toBe(0);
    expect(mod.WEBHOOK_RETRY_POLICY.initialDelayMs).toBe(100);
    expect(mod.WEBHOOK_RETRY_POLICY.maxDelayMs).toBe(1000);
    expect(mod.WEBHOOK_RETRY_POLICY.multiplier).toBe(1);
    expect(mod.WEBHOOK_RETRY_POLICY.jitter).toBe(1);
  });
});
