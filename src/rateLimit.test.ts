import { RateLimitStore } from './lib/rateLimitStore';
import {
  TokenBucketLimiter,
  loadRateLimiterConfig,
  RateLimitQueueFullError,
} from './rateLimit';

jest.mock('./webhookMetrics', () => ({
  recordThrottled: jest.fn(),
  recordQueueOverflow: jest.fn(),
}));

describe('loadRateLimiterConfig', () => {
  it('reads token-bucket defaults from centralized rate-limit config', () => {
    const originalCapacity = process.env.WEBHOOK_BUCKET_CAPACITY;
    const originalRefill = process.env.WEBHOOK_REFILL_RATE_PER_SEC;
    const originalDepth = process.env.WEBHOOK_MAX_QUEUE_DEPTH;
    process.env.WEBHOOK_BUCKET_CAPACITY = '7';
    process.env.WEBHOOK_REFILL_RATE_PER_SEC = '3';
    process.env.WEBHOOK_MAX_QUEUE_DEPTH = '500';

    expect(loadRateLimiterConfig()).toEqual({
      capacity: 7,
      refillRatePerSec: 3,
      maxQueueDepth: 500,
    });

    restoreEnv('WEBHOOK_BUCKET_CAPACITY', originalCapacity);
    restoreEnv('WEBHOOK_REFILL_RATE_PER_SEC', originalRefill);
    restoreEnv('WEBHOOK_MAX_QUEUE_DEPTH', originalDepth);
  });

  it('uses default maxQueueDepth of 1000 when env var is not set', () => {
    const originalDepth = process.env.WEBHOOK_MAX_QUEUE_DEPTH;
    delete process.env.WEBHOOK_MAX_QUEUE_DEPTH;

    const config = loadRateLimiterConfig();
    expect(config.maxQueueDepth).toBe(1000);

    restoreEnv('WEBHOOK_MAX_QUEUE_DEPTH', originalDepth);
  });

  it('throws for invalid WEBHOOK_MAX_QUEUE_DEPTH', () => {
    expect(() =>
      loadRateLimiterConfig({ WEBHOOK_MAX_QUEUE_DEPTH: '0' }),
    ).toThrow('Invalid WEBHOOK_MAX_QUEUE_DEPTH');

    expect(() =>
      loadRateLimiterConfig({ WEBHOOK_MAX_QUEUE_DEPTH: '-5' }),
    ).toThrow('Invalid WEBHOOK_MAX_QUEUE_DEPTH');

    expect(() =>
      loadRateLimiterConfig({ WEBHOOK_MAX_QUEUE_DEPTH: '1.5' }),
    ).toThrow('Invalid WEBHOOK_MAX_QUEUE_DEPTH');

    expect(() =>
      loadRateLimiterConfig({ WEBHOOK_MAX_QUEUE_DEPTH: 'NaN' }),
    ).toThrow('Invalid WEBHOOK_MAX_QUEUE_DEPTH');
  });
});

describe('TokenBucketLimiter', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('single fast provider (never queues)', () => {
    it('resolves immediately when a token is available with empty queue', async () => {
      const store = new RateLimitStore({ sweepIntervalMs: 0 });
      const limiter = new TokenBucketLimiter(
        { capacity: 5, refillRatePerSec: 10, maxQueueDepth: 100 },
        store,
      );

      const p = limiter.acquireToken('fast-provider');
      await expect(p).resolves.toBeUndefined();
      expect(limiter.getQueueDepth('fast-provider')).toBe(0);

      store.destroy();
    });

    it('always resolves immediately for a single provider with sufficient capacity', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(1_000);

      const store = new RateLimitStore({ sweepIntervalMs: 0 });
      const limiter = new TokenBucketLimiter(
        { capacity: 3, refillRatePerSec: 5, maxQueueDepth: 100 },
        store,
      );

      for (let i = 0; i < 3; i++) {
        await expect(limiter.acquireToken('fast-provider')).resolves.toBeUndefined();
      }

      // Fourth acquisition should queue (no remaining tokens)
      const queued = limiter.acquireToken('fast-provider');
      expect(limiter.getQueueDepth('fast-provider')).toBe(1);

      // Advance time to refill a token
      jest.setSystemTime(2_000);
      jest.advanceTimersByTime(1_000);
      await expect(queued).resolves.toBeUndefined();

      store.destroy();
    });
  });

  describe('FIFO ordering below cap', () => {
    it('releases queued waiters in FIFO order', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(1_000);
      jest.spyOn(console, 'log').mockImplementation(() => undefined);

      const store = new RateLimitStore({ sweepIntervalMs: 0 });
      const limiter = new TokenBucketLimiter(
        { capacity: 1, refillRatePerSec: 3, maxQueueDepth: 100 },
        store,
      );

      // Consume the only token so subsequent calls queue
      await limiter.acquireToken('fifo-provider');

      const order: number[] = [];
      const p1 = limiter.acquireToken('fifo-provider').then(() => order.push(1));
      const p2 = limiter.acquireToken('fifo-provider').then(() => order.push(2));
      const p3 = limiter.acquireToken('fifo-provider').then(() => order.push(3));

      expect(limiter.getQueueDepth('fifo-provider')).toBe(3);

      // Advance time enough for 3 refills (1 token/sec * 3 sec)
      jest.setSystemTime(4_000);
      jest.advanceTimersByTime(3_000);

      await Promise.all([p1, p2, p3]);
      expect(order).toEqual([1, 2, 3]);
      expect(limiter.getQueueDepth('fifo-provider')).toBe(0);

      store.destroy();
    });

    it('preserves FIFO across multiple drain cycles', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(1_000);

      const store = new RateLimitStore({ sweepIntervalMs: 0 });
      const limiter = new TokenBucketLimiter(
        { capacity: 2, refillRatePerSec: 1, maxQueueDepth: 100 },
        store,
      );

      // Use both tokens immediately
      await limiter.acquireToken('multi-fifo');
      await limiter.acquireToken('multi-fifo');

      const order: number[] = [];
      const p1 = limiter.acquireToken('multi-fifo').then(() => order.push(1));
      const p2 = limiter.acquireToken('multi-fifo').then(() => order.push(2));

      // Advance 1 second — 1 token refills, waiter 1 resolves
      jest.setSystemTime(2_000);
      jest.advanceTimersByTime(1_000);
      await p1;

      // Queue waiter 3 now — should go behind waiter 2
      const p3 = limiter.acquireToken('multi-fifo').then(() => order.push(3));

      // Advance another second — 1 token refills, waiter 2 resolves
      jest.setSystemTime(3_000);
      jest.advanceTimersByTime(1_000);
      await p2;

      // Advance another second — 1 token refills, waiter 3 resolves
      jest.setSystemTime(4_000);
      jest.advanceTimersByTime(1_000);
      await p3;

      expect(order).toEqual([1, 2, 3]);

      store.destroy();
    });
  });

  describe('queue depth cap enforcement', () => {
    it('rejects with RateLimitQueueFullError when queue is at capacity', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(1_000);

      const store = new RateLimitStore({ sweepIntervalMs: 0 });
      const limiter = new TokenBucketLimiter(
        { capacity: 1, refillRatePerSec: 1, maxQueueDepth: 2 },
        store,
      );

      // Consume initial token
      await limiter.acquireToken('capped');

      // Queue 2 waiters (fills to maxQueueDepth = 2)
      const q1 = limiter.acquireToken('capped');
      const q2 = limiter.acquireToken('capped');
      expect(limiter.getQueueDepth('capped')).toBe(2);

      // Next acquisition should be rejected
      const overCap = limiter.acquireToken('capped');
      await expect(overCap).rejects.toThrow(RateLimitQueueFullError);
      await expect(overCap).rejects.toMatchObject({
        code: 'RATE_LIMIT_QUEUE_FULL',
        providerId: 'capped',
      });

      // Resolve existing waiters by advancing time
      jest.setSystemTime(4_000);
      jest.advanceTimersByTime(3_000);
      await expect(q1).resolves.toBeUndefined();
      await expect(q2).resolves.toBeUndefined();

      store.destroy();
    });

    it('rejects exactly when queue.length >= maxQueueDepth (boundary check)', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(1_000);

      const store = new RateLimitStore({ sweepIntervalMs: 0 });
      const limiter = new TokenBucketLimiter(
        { capacity: 1, refillRatePerSec: 1, maxQueueDepth: 1 },
        store,
      );

      // Consume initial token
      await limiter.acquireToken('boundary');

      // Queue 1 waiter (exactly at cap)
      const q1 = limiter.acquireToken('boundary');
      expect(limiter.getQueueDepth('boundary')).toBe(1);

      // One more should be rejected
      const overflow = limiter.acquireToken('boundary');
      await expect(overflow).rejects.toThrow(RateLimitQueueFullError);

      // Advance time to drain the queued waiter
      jest.setSystemTime(2_000);
      jest.advanceTimersByTime(1_000);
      await expect(q1).resolves.toBeUndefined();
      expect(limiter.getQueueDepth('boundary')).toBe(0);

      store.destroy();
    });

    it('rejects one over cap while using small maxQueueDepth', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(1_000);

      const store = new RateLimitStore({ sweepIntervalMs: 0 });
      const limiter = new TokenBucketLimiter(
        { capacity: 1, refillRatePerSec: 1, maxQueueDepth: 0 },
        store,
      );

      // Consume the single token
      await limiter.acquireToken('tiny');

      // With maxQueueDepth=0, every new acquisition should be rejected
      const overflow = limiter.acquireToken('tiny');
      await expect(overflow).rejects.toThrow(RateLimitQueueFullError);

      store.destroy();
    });
  });

  describe('drain-then-refill cycles', () => {
    it('accepts new acquisitions after draining below cap', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(1_000);

      const store = new RateLimitStore({ sweepIntervalMs: 0 });
      const limiter = new TokenBucketLimiter(
        { capacity: 1, refillRatePerSec: 1, maxQueueDepth: 2 },
        store,
      );

      // Consume initial token
      await limiter.acquireToken('drain-test');

      // Fill queue to cap (2 waiters)
      const q1 = limiter.acquireToken('drain-test');
      const q2 = limiter.acquireToken('drain-test');
      expect(limiter.getQueueDepth('drain-test')).toBe(2);

      // Advance 1 second — 1 token refills, q1 resolves, queue drops to 1
      jest.setSystemTime(2_000);
      jest.advanceTimersByTime(1_000);
      await q1;
      expect(limiter.getQueueDepth('drain-test')).toBe(1);

      // Now we can queue again (below cap)
      const q3 = limiter.acquireToken('drain-test');
      expect(limiter.getQueueDepth('drain-test')).toBe(2);

      // Advance 1 second — 1 token refills, q2 resolves
      jest.setSystemTime(3_000);
      jest.advanceTimersByTime(1_000);
      await q2;

      // Advance 1 second — 1 token refills, q3 resolves
      jest.setSystemTime(4_000);
      jest.advanceTimersByTime(1_000);
      await q3;

      expect(limiter.getQueueDepth('drain-test')).toBe(0);

      store.destroy();
    });
  });

  describe('RateLimitQueueFullError', () => {
    it('has the correct error name, code, and message', () => {
      const err = new RateLimitQueueFullError('test-provider', 50);
      expect(err.name).toBe('RateLimitQueueFullError');
      expect(err.code).toBe('RATE_LIMIT_QUEUE_FULL');
      expect(err.message).toContain('test-provider');
      expect(err.message).toContain('50');
      expect(err.providerId).toBe('test-provider');
    });

    it('is an instance of Error and RateLimitQueueFullError', () => {
      const err = new RateLimitQueueFullError('p', 10);
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(RateLimitQueueFullError);
    });
  });
});

function restoreEnv(key: string, original: string | undefined): void {
  if (original === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = original;
  }
}
