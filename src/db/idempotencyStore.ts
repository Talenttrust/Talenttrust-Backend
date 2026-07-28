export interface IdempotencyRecord<TResult = unknown> {
  key: string;
  payloadHash: string;
  result: TResult;
  createdAt: Date;
  expiresAt?: Date;
}

export interface IdempotencyStore {
  get<TResult = unknown>(key: string): IdempotencyRecord<TResult> | undefined;
  getRaw<TResult = unknown>(key: string): IdempotencyRecord<TResult> | undefined;
  set<TResult>(record: IdempotencyRecord<TResult>): void;
  delete(key: string): void;
  size(): number;
  clear(): void;
  purgeExpired(now?: Date): number;
  destroy(): void;
}

export interface IdempotencyStoreConfig {
  ttlMs?: number;
  clock?: () => Date;
  sweepIntervalMs?: number;
  maxSize?: number;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000;

/**
 * Stores idempotency records for request de-duplication with TTL-based eviction.
 *
 * @remarks
 * Each record carries an `expiresAt` timestamp. Lookups treat expired keys as
 * absent so re-submissions after TTL are processed fresh. The `purgeExpired`
 * sweep removes expired entries to bound memory growth.
 *
 * @security
 * - `purgeExpired` is parameter-bound by `expiresAt` and never touches
 *   unexpired keys.
 */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>();
  private readonly ttlMs: number;
  private readonly clock: () => Date;
  private readonly maxSize: number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: IdempotencyStoreConfig = {}) {
    this.ttlMs = config.ttlMs ?? DEFAULT_TTL_MS;
    this.clock = config.clock ?? (() => new Date());
    this.maxSize = config.maxSize ?? 10000;
    
    const sweepIntervalMs = config.sweepIntervalMs ?? 60_000;
    if (sweepIntervalMs > 0) {
      const timer = setInterval(() => this.purgeExpired(), sweepIntervalMs);
      if (typeof (timer as any).unref === 'function') {
        (timer as any).unref();
      }
      this.sweepTimer = timer;
    }
  }

  get<TResult = unknown>(key: string): IdempotencyRecord<TResult> | undefined {
    const record = this.records.get(key) as IdempotencyRecord<TResult> | undefined;
    if (!record) {
      return undefined;
    }

    if (record.expiresAt! <= this.clock()) {
      this.records.delete(key);
      return undefined;
    }

    return record;
  }

  getRaw<TResult = unknown>(key: string): IdempotencyRecord<TResult> | undefined {
    return this.records.get(key) as IdempotencyRecord<TResult> | undefined;
  }

  delete(key: string): void {
    this.records.delete(key);
  }

  size(): number {
    return this.records.size;
  }

  set<TResult>(record: IdempotencyRecord<TResult>): void {
    if (this.records.size >= this.maxSize && !this.records.has(record.key)) {
      this.purgeExpired();
      if (this.records.size >= this.maxSize) {
        // Fallback: remove oldest entry (first in map iteration)
        const firstKey = this.records.keys().next().value;
        if (firstKey !== undefined) {
          this.records.delete(firstKey);
        }
      }
    }

    const now = this.clock();
    const expiresAt = record.expiresAt ?? new Date(now.getTime() + this.ttlMs);
    this.records.set(record.key, {
      ...record,
      createdAt: record.createdAt ?? now,
      expiresAt,
    });
  }

  clear(): void {
    this.records.clear();
  }

  purgeExpired(now: Date = this.clock()): number {
    let purged = 0;
    for (const [key, record] of this.records) {
      if (record.expiresAt! <= now) {
        this.records.delete(key);
        purged++;
      }
    }
    return purged;
  }

  destroy(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.records.clear();
  }
}

export const defaultIdempotencyStore = new InMemoryIdempotencyStore();
