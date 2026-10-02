/**
 * rateLimit.ts — outbound webhook delivery pacing via a token-bucket limiter.
 *
 * Provides single-node (in-process Map) or multi-replica (Redis-backed) pacing for outbound webhooks.
 */

import { recordQueueOverflow, recordThrottled } from './webhookMetrics';
import Redis from 'ioredis';
import { RateLimitStore } from './lib/rateLimitStore';
import type { TokenBucketEntry } from './lib/rateLimitStore';
import { loadWebhookTokenBucketConfig } from './config/rateLimit';

/**
 * Thrown by {@link TokenBucketLimiter.acquireToken} when the per-provider
 * waiter queue has reached its configured maximum depth. Callers should
 * catch this error and route the delivery to the DLQ rather than retrying.
 */
export class RateLimitQueueFullError extends Error {
  public readonly code: string;
  constructor(public readonly providerId: string, maxQueueDepth: number) {
    super(
      `Rate-limit queue full for provider "${providerId}": ` +
        `max depth ${maxQueueDepth} reached. Route to DLQ.`,
    );
    this.name = 'RateLimitQueueFullError';
    this.code = 'RATE_LIMIT_QUEUE_FULL';
  }
}

/** Parsed token-bucket configuration for the outbound webhook limiter. */
export interface RateLimiterConfig {
  /** Maximum burst capacity; the bucket never holds more than this many tokens. */
  capacity: number;
  /** Steady-state token replenishment rate, in tokens per second. */
  refillRatePerSec: number;
  /**
   * Hard cap on the number of pending waiters queued per provider.
   * When the queue reaches this depth, new acquisitions throw
   * {@link RateLimitQueueFullError} so the caller can route the
   * delivery to the DLQ instead of accumulating unbounded memory.
   */
  maxQueueDepth: number;
}

/**
 * Derives a safe, hashed identifier for provider IDs to avoid storing sensitive
 * provider secrets or hostnames in store keys or log entries.
 */
export function redactId(providerId: string): string {
  return RateLimitStore.hashKey(providerId);
}

/**
 * BucketStore — Abstract storage contract for token-bucket rate limiters.
 *
 * Allows token replenishment and consumption to be backed by in-process memory
 * or a distributed Redis store for cluster-wide enforcement.
 */
export interface BucketStore {
  /**
   * Retrieve current available token count for a provider.
   * @param providerId - Raw or hashed provider identifier
   * @returns Remaining token count or undefined if bucket does not exist
   */
  getTokenCount(providerId: string): Promise<number | undefined> | number | undefined;

  /**
   * Atomically refill and consume 1 token for `providerId` if available.
   *
   * Refills accrued tokens up to `capacity` based on elapsed time since last refill,
   * then decrements 1 token if `tokens >= 1`.
   *
   * @param providerId - Raw or hashed provider identifier
   * @param capacity - Maximum capacity of the token bucket
   * @param refillRatePerSec - Replenishment rate in tokens per second
   * @returns `true` if a token was consumed; `false` if insufficient tokens exist.
   */
  consumeToken(
    providerId: string,
    capacity: number,
    refillRatePerSec: number,
  ): Promise<boolean> | boolean;

  /**
   * Total number of active token buckets tracked by this store.
   */
  getSize(): Promise<number> | number;

  /**
   * Clean up resources and close connections on shutdown.
   */
  destroy(): Promise<void> | void;
}

/**
 * In-process Map-backed token-bucket store.
 * Default store engine when Redis is not configured.
 */
export class InMemoryBucketStore implements BucketStore {
  private readonly rateLimitStore: RateLimitStore;

  constructor(rateLimitStore?: RateLimitStore) {
    this.rateLimitStore = rateLimitStore ?? new RateLimitStore({ sweepIntervalMs: 0 });
  }

  get underlyingStore(): RateLimitStore {
    return this.rateLimitStore;
  }

  getTokenCount(providerId: string): number | undefined {
    const bucket = this.rateLimitStore.getTokenBucket(providerId);
    if (!bucket) return undefined;
    return bucket.tokens;
  }

  consumeToken(providerId: string, capacity: number, refillRatePerSec: number): boolean {
    let bucket = this.rateLimitStore.getTokenBucket(providerId);
    const now = Date.now();
    if (!bucket) {
      bucket = { tokens: capacity, lastRefillMs: now, queue: [] };
    } else {
      const elapsedMs = now - bucket.lastRefillMs;
      if (elapsedMs > 0) {
        const refilled = (elapsedMs / 1000) * refillRatePerSec;
        bucket.tokens = Math.min(capacity, bucket.tokens + refilled);
        bucket.lastRefillMs = now;
      }
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      this.rateLimitStore.setTokenBucket(providerId, bucket);
      return true;
    }

    this.rateLimitStore.setTokenBucket(providerId, bucket);
    return false;
  }

  getSize(): number {
    return this.rateLimitStore.tokenBucketSize;
  }

  destroy(): void {
    this.rateLimitStore.destroy();
  }
}

/** Lua script for atomic token refill and consumption in Redis */
const CONSUME_LUA_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refillRate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local requested = tonumber(ARGV[4])

local bucket = redis.call('HMGET', key, 'tokens', 'last_refill')
local tokens = tonumber(bucket[1])
local lastRefill = tonumber(bucket[2])

if not tokens or not lastRefill then
  tokens = capacity
  lastRefill = now
else
  local elapsedMs = now - lastRefill
  if elapsedMs > 0 then
    local refilled = (elapsedMs / 1000.0) * refillRate
    tokens = math.min(capacity, tokens + refilled)
    lastRefill = now
  end
end

local consumed = 0
if tokens >= requested then
  tokens = tokens - requested
  consumed = 1
end

redis.call('HMSET', key, 'tokens', tokens, 'last_refill', lastRefill)
local ttl = math.max(60, math.ceil((capacity / refillRate) * 2))
redis.call('EXPIRE', key, ttl)

return { consumed, tokens }
`;

/** Options for configuring a RedisBucketStore */
export interface RedisBucketStoreOptions {
  redisUrl?: string;
  redisClient?: any;
  keyPrefix?: string;
}

/**
 * Distributed Redis-backed token bucket store.
 * Performs atomic token consumption via Lua scripting across multi-replica nodes.
 * Gracefully falls back to an in-process memory store if Redis is unavailable or fails.
 */
export class RedisBucketStore implements BucketStore {
  private readonly redis: any;
  private readonly keyPrefix: string;
  private readonly fallbackStore: InMemoryBucketStore;
  private isConnected = true;

  constructor(options: RedisBucketStoreOptions = {}) {
    this.keyPrefix = options.keyPrefix ?? 'rate_limit:bucket:';
    this.fallbackStore = new InMemoryBucketStore();

    if (options.redisClient) {
      this.redis = options.redisClient;
    } else if (options.redisUrl) {
      this.redis = new Redis(options.redisUrl);
    } else {
      this.redis = new Redis();
    }

    if (typeof this.redis.on === 'function') {
      this.redis.on('error', (err: Error) => {
        console.warn(`[rateLimit] Redis store error, using in-memory fallback: ${err.message}`);
        this.isConnected = false;
      });
      this.redis.on('connect', () => {
        this.isConnected = true;
      });
    }
  }

  private getKey(providerId: string): string {
    return `${this.keyPrefix}${redactId(providerId)}`;
  }

  async getTokenCount(providerId: string): Promise<number | undefined> {
    if (!this.isConnected) {
      return this.fallbackStore.getTokenCount(providerId);
    }
    try {
      const key = this.getKey(providerId);
      const res = await this.redis.hmget(key, 'tokens', 'last_refill');
      if (!res || !res[0]) return undefined;
      return parseFloat(res[0]);
    } catch (err: any) {
      console.warn(`[rateLimit] Redis getTokenCount failed, falling back to memory: ${err.message}`);
      return this.fallbackStore.getTokenCount(providerId);
    }
  }

  async consumeToken(
    providerId: string,
    capacity: number,
    refillRatePerSec: number,
  ): Promise<boolean> {
    if (!this.isConnected) {
      return this.fallbackStore.consumeToken(providerId, capacity, refillRatePerSec);
    }
    try {
      const key = this.getKey(providerId);
      const now = Date.now();

      let result: any;
      if (typeof this.redis.eval === 'function') {
        result = await this.redis.eval(
          CONSUME_LUA_SCRIPT,
          1,
          key,
          capacity.toString(),
          refillRatePerSec.toString(),
          now.toString(),
          '1',
        );
      } else {
        return this.fallbackStore.consumeToken(providerId, capacity, refillRatePerSec);
      }

      const consumed = Array.isArray(result) ? Number(result[0]) : Number(result);
      return consumed === 1;
    } catch (err: any) {
      console.warn(`[rateLimit] Redis consumeToken failed, falling back to memory: ${err.message}`);
      return this.fallbackStore.consumeToken(providerId, capacity, refillRatePerSec);
    }
  }

  async getSize(): Promise<number> {
    if (!this.isConnected) {
      return this.fallbackStore.getSize();
    }
    try {
      const keys = await this.redis.keys(`${this.keyPrefix}*`);
      return keys.length;
    } catch {
      return this.fallbackStore.getSize();
    }
  }

  async destroy(): Promise<void> {
    this.fallbackStore.destroy();
    if (this.redis && typeof this.redis.quit === 'function') {
      try {
        await this.redis.quit();
      } catch {
        // Ignore disconnect errors
      }
    }
  }
}

/**
 * Creates a BucketStore based on application configuration.
 * Selected via `RATE_LIMIT_STORE_TYPE` ('memory' | 'redis') in process.env.
 */
export function createBucketStore(
  env: NodeJS.ProcessEnv = process.env,
  customRedisClient?: any,
): BucketStore {
  const storeType = env.RATE_LIMIT_STORE_TYPE ?? (env.REDIS_URL ? 'redis' : 'memory');

  if (storeType === 'redis' || customRedisClient) {
    return new RedisBucketStore({
      redisUrl: env.REDIS_URL,
      redisClient: customRedisClient,
      keyPrefix: env.REDIS_KEY_PREFIX,
    });
  }

  return new InMemoryBucketStore();
}

/**
 * Reads token-bucket defaults from the centralized rate-limit configuration.
 */
export function loadRateLimiterConfig(env: NodeJS.ProcessEnv = process.env): RateLimiterConfig {
  const { capacity, refillRatePerSec, maxQueueDepth } = loadWebhookTokenBucketConfig(env);
  return { capacity, refillRatePerSec, maxQueueDepth };
}

/**
 * Per-provider token-bucket limiter backed by a {@link BucketStore}.
 */
export class TokenBucketLimiter {
  private readonly capacity: number;
  private readonly refillRatePerSec: number;
  private readonly maxQueueDepth: number;
  private readonly store: BucketStore;
  private readonly rateLimitStore?: RateLimitStore;
  private readonly queues = new Map<string, Array<() => void>>();
  /** Active drain timers keyed by provider id. */
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(config: RateLimiterConfig, store?: BucketStore | RateLimitStore) {
    this.capacity = config.capacity;
    this.refillRatePerSec = config.refillRatePerSec;
    this.maxQueueDepth = config.maxQueueDepth;
    if (store instanceof RateLimitStore) {
      this.rateLimitStore = store;
      this.store = new InMemoryBucketStore(store);
    } else {
      const bucketStore = store ?? new InMemoryBucketStore();
      this.store = bucketStore;
      this.rateLimitStore =
        bucketStore instanceof InMemoryBucketStore
          ? bucketStore.underlyingStore
          : undefined;
    }
  }

  /**
   * Acquire a single token for `providerId`, resolving immediately when one is
   * available or once one refills. Enqueued waiters resolve in FIFO order.
   */
  acquireToken(providerId: string): Promise<void> {
    const queue = this.getOrCreateQueue(providerId);

    if (queue.length === 0) {
      const consumedResult = this.store.consumeToken(
        providerId,
        this.capacity,
        this.refillRatePerSec,
      );

      if (consumedResult === true) {
        this.syncLegacyStoreQueue(providerId, queue);
        return Promise.resolve();
      }

      if (consumedResult instanceof Promise) {
        let resolveWaiter!: () => void;
        const waiterPromise = new Promise<void>((res) => {
          resolveWaiter = res;
        });

        queue.push(resolveWaiter);
        this.syncLegacyStoreQueue(providerId, queue);

        consumedResult
          .then((consumed) => {
            if (consumed) {
              const idx = queue.indexOf(resolveWaiter);
              if (idx !== -1) queue.splice(idx, 1);
              this.syncLegacyStoreQueue(providerId, queue);
              resolveWaiter();
            } else {
              recordThrottled(providerId);
              this.scheduleDrain(providerId);
            }
          })
          .catch(() => {
            recordThrottled(providerId);
            this.scheduleDrain(providerId);
          });

        return waiterPromise;
      }
    }

    if (queue.length >= this.maxQueueDepth) {
      recordQueueOverflow();
      return Promise.reject(
        new RateLimitQueueFullError(providerId, this.maxQueueDepth),
      );
    }

    return new Promise<void>((resolve) => {
      queue.push(resolve);
      this.syncLegacyStoreQueue(providerId, queue);
      recordThrottled(providerId);
      this.scheduleDrain(providerId);
    });
  }

  /** Number of callers currently queued in this process for `providerId`. */
  getQueueDepth(providerId: string): number {
    return this.queues.get(providerId)?.length ?? 0;
  }

  /** Retrieve remaining token count for `providerId`. */
  async getTokenCount(providerId: string): Promise<number | undefined> {
    return this.store.getTokenCount(providerId);
  }

  private getOrCreateQueue(providerId: string): Array<() => void> {
    let queue = this.queues.get(providerId);
    if (!queue) {
      queue = [];
      this.queues.set(providerId, queue);
    }
    return queue;
  }

  private syncLegacyStoreQueue(providerId: string, queue: Array<() => void>): void {
    if (!this.rateLimitStore) return;
    let bucket = this.rateLimitStore.getTokenBucket(providerId);
    if (!bucket) {
      const tokens = this.store.getTokenCount(providerId) ?? this.capacity;
      const count = typeof tokens === 'number' ? tokens : this.capacity;
      bucket = { tokens: count, lastRefillMs: Date.now(), queue };
    } else {
      bucket.queue = queue;
    }
    this.rateLimitStore.setTokenBucket(providerId, bucket);
  }

  private scheduleDrain(providerId: string): void {
    if (this.timers.has(providerId)) return;
    const delayMs = Math.max(1, Math.ceil(1000 / this.refillRatePerSec));
    const timer = setTimeout(() => {
      this.timers.delete(providerId);
      this.drain(providerId);
    }, delayMs);
    if (typeof timer.unref === 'function') timer.unref();
    this.timers.set(providerId, timer);
  }

  private drain(providerId: string): void {
    const queue = this.queues.get(providerId);
    if (!queue || queue.length === 0) return;

    while (queue.length > 0) {
      const consumed = this.store.consumeToken(
        providerId,
        this.capacity,
        this.refillRatePerSec,
      );
      if (consumed instanceof Promise) {
        void consumed
          .then((didConsume) => {
            if (didConsume) {
              const resolve = queue.shift();
              this.syncLegacyStoreQueue(providerId, queue);
              resolve?.();
            }
            if (queue.length > 0) this.scheduleDrain(providerId);
          })
          .catch(() => {
            if (queue.length > 0) this.scheduleDrain(providerId);
          });
        return;
      }
      if (!consumed) break;

      const resolve = queue.shift();
      this.syncLegacyStoreQueue(providerId, queue);
      resolve?.();
    }

    if (queue.length > 0) {
      this.scheduleDrain(providerId);
    }
  }
}
