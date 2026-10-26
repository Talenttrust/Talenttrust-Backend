import type { Request, Response, NextFunction } from 'express';

export type Clock = () => number;

export interface RateLimitBucket {
  tokens: number;
  lastRefill: number;
  lastSeen: number;
}

export interface RateLimitStore {
  get(key: string): RateLimitBucket | undefined;
  set(key: string, bucket: RateLimitBucket): void;
  delete(key: string): void;
  size(): number;
  forEach(fn: (key: string, bucket: RateLimitBucket) => void): void;
}

export class InMemoryRateLimitStore implements RateLimitStore {
  private buckets = new Map<string, RateLimitBucket>();
  private readonly maxKeys: number;

  constructor(maxKeys = 50000) {
    this.maxKeys = maxKeys;
  }

  get(key: string): RateLimitBucket | undefined {
    return this.buckets.get(key);
  }

  set(key: string, bucket: RateLimitBucket): void {
    if (!this.buckets.has(key) && this.buckets.size >= this.maxKeys) {
      // Evict oldest by lastSeen
      let oldestKey: string | undefined;
      let oldestSeen = Infinity;
      for (const [k, b] of this.buckets.entries()) {
        if (b.lastSeen < oldestSeen) {
          oldestSeen = b.lastSeen;
          oldestKey = k;
          if (oldestSeen === Infinity) break;
        }
      }
      if (oldestKey !== undefined) {
        this.buckets.delete(oldestKey);
      } else {
        // Fallback: delete first
        const first = this.buckets.keys().next().value;
        if (first !== undefined) this.buckets.delete(first);
      }
    }
    this.buckets.set(key, bucket);
  }

  delete(key: string): void {
    this.buckets.delete(key);
  }

  size(): number {
    return this.buckets.size;
  }

  forEach(fn: (key: string, bucket: RateLimitBucket) => void): void {
    for (const [key, bucket] of this.buckets.entries()) {
      fn(key, bucket);
    }
  }

  // For testing/eviction
  evictIdle(idleMs: number, now: number): number {
    let evicted = 0;
    for (const [key, bucket] of this.buckets.entries()) {
      if (now - bucket.lastSeen >= idleMs) {
        this.buckets.delete(key);
        evicted++;
      }
    }
    return evicted;
  }
}

export interface TokenBucketOptions {
  maxTokens: number;
  refillRate: number; // tokens per second
  store?: RateLimitStore;
  clock?: Clock;
  maxKeys?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetSeconds: number;
  retryAfterSeconds?: number;
}

export class TokenBucketLimiter {
  private store: RateLimitStore;
  private clock: Clock;
  private maxTokens: number;
  private refillRate: number;

  constructor(options: TokenBucketOptions) {
    this.maxTokens = options.maxTokens;
    this.refillRate = options.refillRate; // tokens per second
    this.store = options.store ?? new InMemoryRateLimitStore(options.maxKeys ?? 50000);
    this.clock = options.clock ?? (() => Date.now());
  }

  tryConsume(key: string, tokens = 1): RateLimitResult {
    const now = this.clock();
    let bucket = this.store.get(key);
    if (!bucket) {
      bucket = {
        tokens: this.maxTokens - tokens,
        lastRefill: now,
        lastSeen: now,
      };
      if (bucket.tokens < 0) {
        const deficit = -bucket.tokens;
        const resetSeconds = Math.max(1, Math.ceil(deficit / this.refillRate));
        return {
          allowed: false,
          limit: this.maxTokens,
          remaining: 0,
          resetSeconds,
          retryAfterSeconds: resetSeconds,
        };
      }
      this.store.set(key, bucket);
      return {
        allowed: true,
        limit: this.maxTokens,
        remaining: Math.max(0, bucket.tokens),
        resetSeconds: this.getResetSeconds(bucket, now),
      };
    }

    // Refill
    const elapsedMs = now - bucket.lastRefill;
    if (elapsedMs > 0) {
      const tokensToAdd = (elapsedMs / 1000) * this.refillRate;
      bucket.tokens = Math.min(this.maxTokens, bucket.tokens + tokensToAdd);
      bucket.lastRefill = now;
    }
    bucket.lastSeen = now;

    if (bucket.tokens < tokens) {
      const deficit = tokens - bucket.tokens;
      const resetSeconds = Math.max(1, Math.ceil(deficit / this.refillRate));
      this.store.set(key, bucket);
      return {
        allowed: false,
        limit: this.maxTokens,
        remaining: 0,
        resetSeconds,
        retryAfterSeconds: resetSeconds,
      };
    }

    bucket.tokens -= tokens;
    this.store.set(key, bucket);
    return {
      allowed: true,
      limit: this.maxTokens,
      remaining: Math.floor(bucket.tokens),
      resetSeconds: this.getResetSeconds(bucket, now),
    };
  }

  private getResetSeconds(bucket: RateLimitBucket, now: number): number {
    // Time until full refill
    if (bucket.tokens >= this.maxTokens) return 0;
    const deficit = this.maxTokens - bucket.tokens;
    return Math.max(1, Math.ceil(deficit / this.refillRate));
  }
}

export interface RateLimitPolicy {
  read?: { perMinute: number; burst: number };
  write?: { perMinute: number; burst: number };
  exemptPaths?: string[];
}

export const DEFAULT_RATE_LIMIT_POLICY: RateLimitPolicy = {
  read: { perMinute: 120, burst: 60 },
  write: { perMinute: 20, burst: 10 },
  exemptPaths: ['/health', '/docs', '/openapi.json'],
};
