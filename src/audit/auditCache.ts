/**
 * @module auditCache
 * @description Response caching for audit reads with TTP and LRU eviction.
 *
 * Provides a bounded cache for audit query results to reduce database load.
 * Cache entries expire after a configurable TTP and are evicted when the cache
 * reaches its max entry bound.
 *
 * Cache invalidation:
 *   - Explicit invalidation on write operations (log/append)
 *   - TTP-based expiration
 *   - LRU eviction when capacity is reached
 *
 * Metrics:
 *   - Cache hits and misses are tracked via Prometheus counters
 *
 * Concurrency & state invariants (preserved through repeated/interleaved use):
 *   - Every mutation is synchronous, so cache operations are atomic with respect
 *     to the Node event loop; there is no async window in which a half-updated
 *     entry can be observed.
 *   - `this.cache.size <= this.maxEntries` at all times. A non-positive
 *     `maxEntries` disables storage entirely.
 *   - Equivalent queries (same fields, regardless of object key order) map to the
 *     same cache key, so duplicate work and duplicate entries cannot occur.
 *   - Cached values are snapshotted on write and cloned on read, so callers can
 *     never mutate the cache's internal state and readers never share mutable
 *     references.
 *   - Metric registration is idempotent: constructing multiple caches against the
 *     same registry never throws and never duplicates counters.
 *   - Invalid or non-serialisable queries/data degrade to a cache miss/no-op
 *     instead of throwing.
 */

import { Counter, Registry } from 'prom-client';
import type { AuditEntry, AuditQuery, AuditQueryResult } from './types';

export interface AuditCacheOptions {
  ttlMs: number;
  maxEntries: number;
  /**
   * Optional hook for observing internal failures. Receives no sensitive
   * data, only the operation name and an error message. Defaults to a noop
   * so existing callers remain compatible.
   */
  onFailure?: (operation: string, error: Error) => void;
  /**
   * Optional logger. When omitted, failures are still counted and forwarded
   * to `onFailure` if provided.
   */
  logger?: { warn: (message: string, meta?: Record<string, unknown>) => void };
}

export interface CacheEntry {
  data: AuditEntry[] | AuditEntry | AuditQueryResult;
  expiresAt: number;
  lastAccessed: number;
  /**
   * Resource id the entry was cached for, when the query filtered by one.
   * Used for precise, allocation-free invalidation instead of string matching.
   */
  resourceId?: string;
}

export type AuditCacheQueryType = 'query' | 'queryWithCursor' | 'getById';

/**
 * Validate the constructor options for the cache.
 *
 * Both `ttlMs` and `maxEntries` must be positive finite integers. This is a
 * hard boundary: a cache configured with `TTL = 0` or `maxEntries = 0` is
 * silently broken (every get misses / every set evicts itself), so we refuse
 * to construct it at all.
 */
export function validateAuditCacheOptions(options: AuditCacheOptions): void {
  if (!isPlainObject(options)) {
    throw new AuditCacheValidationError('AuditCache options must be an object');
  }

  const { ttlMs, maxEntries } = options;

  if (
    typeof ttlMs !== 'number' ||
    !Number.isFinite(ttlMs) ||
    !Number.isInteger(ttlMs) ||
    ttlMs <= 0
  ) {
    throw new AuditCacheValidationError('AuditCache ttlMs must be a positive finite integer');
  }

  if (
    typeof maxEntries !== 'number' ||
    !Number.isFinite(maxEntries) ||
    !Number.isInteger(maxEntries) ||
    maxEntries <= 0
  ) {
    throw new AuditCacheValidationError('AuditCache maxEntries must be a positive finite integer');
  }
}

/**
 * Validate the cache discriminator and optional `id`.
 *
 * This is the single checkpoint used by both `get` and `set` so that a cache
 * key is always well-formed and collision-resistant.
 */
export function validateCacheKeyInput(
  type: AuditCacheQueryType,
  id?: string,
): void {
  if (typeof type !== 'string' || !(ALLOWED_QUERY_TYPES as readonly string[]).includes(type)) {
    throw new AuditCacheValidationError(
      `AuditCache type must be one of ${ALLOWED_QUERY_TYPES.join(', ')}`,
    );
  }

  if (type === 'getById') {
    if (typeof id !== 'string' || id.length === 0) {
      throw new AuditCacheValidationError('AuditCache getById requires a non-empty id');
    }
    if (id.length > MAX_ID_LENGTH) {
      throw new AuditCacheValidationError('AuditCache id exceeds maximum length');
    }
  } else if (id !== undefined) {
    throw new AuditCacheValidationError('AuditCache id is only valid for getById');
  }
}

/**
 * Produce a deterministic canonical string for a query.
 *
 * JSON.stringify preserves insertion order, so two callers that pass the same
 * lolgical query with different key order would produce different keys and
 * silently miss the cache. We canonicalise by emitting fields in a fixed
 * order and omitting `undefined` values.
 */
export function canonicalizeAuditQuery(query: AuditQuery): string {
  if (!isPlainObject(query)) {
    throw new AuditCacheValidationError('AuditCache query must be an object');
  }

  const ordered: Record<string, unknown> = {};
  for (const key of QUERY_KEY_ORDER) {
    const value = (query as Record<string, unknown>)[key];
    if (value !== undefined) {
      ordered[key] = value;
    }
  }

  const serialised = JSON.stringify(ordered);
  if (serialised.length > MAX_KEY_LENGTH) {
    throw new AuditCacheValidationError('AuditCache query key exceeds maximum length');
  }

  return serialised;
}

/**
 * Validate the shape of a value before it is stored in the cache.
 *
 * The cache is a correctness boundary: a cache read must never return a
 * malformed value that a caller cannot interpret. We accept the three shapes
 * declared by the public interface and reject everything else.
 */
export function validateCachePayload(data: unknown): void {
  if (Array.isArray(data)) {
    return;
  }

  if (!isPlainObject(data)) {
    throw new AuditCacheValidationError('AuditCache data must be an array or object');
  }

  // AuditQueryResult has an `entries` array and numeric `count`/`limit`.
  // AuditEntry has an `id` string and a `hash` string.
  const candidate = data as Record<string, unknown>;
  const looksLikeQueryResult =
    Array.isArray(candidate.entries) &&
    typeof candidate.count === 'number' &&
    typeof candidate.limit === 'number';
  const looksLikeEntry =
    typeof candidate.id === 'string' && typeof candidate.hash === 'string';

  if (!looksLikeQueryResult && !looksLikeEntry) {
    throw new AuditCacheValidationError('AuditCache data is not a recognised audit payload');
  }
}

/**
 * Simple async mutex used to serialize mutating operations on the cache.
 * This keeps eviction + insertion atomic and prevents concurrent calls from
 * observing a partially applied state.
 */
class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(fn(): () => Promise<T> | T: Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/**
 * LRU cache with TLL for audit read responses.
 */
export class AuditCache {
  private cache: Map<string, CacheEntry>;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private hits: Counter<string> | null;
  private misses: Counter<string> | null;
  private failures: Counter<string> | null;
  private hitCount: number;
  private missCount: number;
  private failureCount: number;
  private readonly onFailure?: (operation: string, error: Error) => void;
  private readonly logger?: AuditCacheOptions['logger'];
  private readonly mutex = new Mutex();

  constructor(options: AuditCacheOptions, register?: Registry) {
    validateAuditCacheOptions(options);

  constructor(options: AuditCacheOptions, register?: any) {
    this.ttlMs = AuditCache.normalizeTtl(options == null ? undefined : options.ttlMs);
    this.maxEntries = AuditCache.normalizeMaxEntries(options == null ? undefined : options.maxEntries);
    this.cache = new Map();
    this.hitCount = 0;
    this.missCount = 0;
    this.failureCount = 0;
    this.onFailure = options.onFailure;
    this.logger = options.logger;

    // Initialize metrics. Prefer the caller-supplied registry (so metrics are
    // actually exported) and reuse any counters that are already registered to
    // it, which makes repeated construction safe.
    const registry = AuditCache.resolveRegistry(register);

    this.hits = AuditCache.resolveCounter(
      registry,
      'audit_cache_hits_total',
      'Total number of audit cache hits.',
    );

    this.misses = AuditCache.resolveCounter(
      registry,
      'audit_cache_misses_total',
      'Total number of audit cache misses.',
    );
  }

  /**
   * Clamp an arbitrary TTL to a non-negative finite integer. Invalid input
   * falls back to `0`, which expires entries immediately.
   */
  private static normalizeTtl(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return 0;
    }
    return Math.floor(value);
  }

  /**
   * Clamp an arbitrary max-entries value to a non-negative finite integer.
   * A non-positive result disables the cache.
   */
  private static normalizeMaxEntries(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return 0;
    }
    return Math.floor(value);
  }

  /**
   * Resolve the Prometheus registry to register metrics on. Falls back to an
   * isolated registry only when the caller does not provide a usable one.
   */
  private static resolveRegistry(register?: unknown): Registry {
    if (register instanceof Registry) {
      return register;
    }

    if (
      register !== null &&
      typeof register === 'object' &&
      typeof (register as Registry).getSingleMetric === 'function' &&
      typeof (register as Registry).registerMetric === 'function'
    ) {
      return register as Registry;
    }

    return new Registry();
  }

  /**
   * Return the existing counter for `name` on `registry`, or create it. This is
   * idempotent so constructing several caches with one registry cannot throw
   * "A metric with the name ... has already been registered".
   */
  private static resolveCounter(registry: Registry, name: string, help: string): Counter<string> {
    const existing = registry.getSingleMetric(name);
    if (existing) {
      return existing as Counter<string>;
    }
    return new Counter({ name, help, registers: [registry] });
  }

  /**
   * Deterministic JSON serialization with sorted object keys. Guarantees the
   * same key for logically equivalent queries regardless of property order.
   */
  private static canonicalize(value: unknown, seen: WeakSet<object> = new WeakSet()): string {
    if (value === null) {
      return 'null';
    }

    const type = typeof value;
    if (type === 'string') {
      return JSON.stringify(value);
    }
    if (type === 'number') {
      return Number.isFinite(value as number) ? String(value) : 'null';
    }
    if (type === 'boolean') {
      return value ? 'true' : 'false';
    }
    if (type !== 'object') {
      return 'null';
    }

    const objectValue = value as object;
    if (seen.has(objectValue)) {
      throw new Error('Cannot serialize circular audit query');
    }
    seen.add(objectValue);

    try {
      if (Array.isArray(value)) {
        return `[${value.map((item) => AuditCache.canonicalize(item, seen)).join(',')}]`;
      }

      const record = value as Record<string, unknown>;
      const parts = Object.keys(record)
        .sort()
        .filter((key) => record[key] !== undefined)
        .map((key) => `${JSON.stringify(key)}:${AuditCache.canonicalize(record[key], seen)}`);
      return `{${parts.join(',')}}`;
    } finally {
      seen.delete(objectValue);
    }
  }

  /**
   * Generate a deterministic cache key from an audit query.
   *
   * Returns `null` for queries that cannot be represented (missing id for
   * `getById`, non-object query, or a circular structure) so callers degrade to
   * a miss instead of throwing.
   */
  private generateKey(query: AuditQuery, type: AuditCacheQueryType, id?: string): string | null {
    if (type === 'getById') {
      if (id === undefined || id === null || id === '') {
        return null;
      }
      return `getById:${String(id)}`;
    }

    if (query === null || typeof query !== 'object') {
      return null;
    }

    try {
      return `${type}:${AuditCache.canonicalize(query)}`;
    } catch {
      return null;
    }
  }

  /**
   * Defensive snapshot/clone so cached values can never be mutated by callers
   * and readers never share a reference with the cache's internal state.
   */
  private static clone<T>(value: T): T {
    try {
      return structuredClone(value);
    } catch {
      // Non-cloneable payloads (e.g. functions) are passed through unchanged
      // rather than throwing; this preserves the previous behavior.
      return value;
    }
  }

  private recordHit(): void {
    this.hits.inc();
    this.hitCount++;
  }

  private recordMiss(): void {
    this.misses.inc();
    this.missCount++;
  }

  /**
   * Get cached audit query results.
   *
   * @param query - The audit query
   * @param type - The type of query (query, queryWithCursor, or getById)
   * @param id - Optional ID for getById queries
   * @returns A defensive copy of the cached data if valid and not expired, null otherwise
   */
  get(
    query: AuditQuery,
    type: AuditCacheQueryType,
    id?: string,
  ): AuditEntry[] | AuditEntry | AuditQueryResult | null {
    const key = this.generateKey(query, type, id);
    if (key === null) {
      this.recordMiss();
      return null;
    }

    const entry = this.cache.get(key);
    const now = Date.now();

    if (!entry) {
      this.recordMiss();
      return null;
    }

    // Check if entry has expired. `>=` so the entry is treated as expired at
    // exactly `expiresAt` — the TTL has elapsed by then, and matching the
    // cleanup sweep's boundary keeps reads and eviction deterministic.
    if (now >= entry.expiresAt) {
      this.cache.delete(key);
      this.recordMiss();
      return null;
    }

    // Update last accessed time for LRU eviction
    entry.lastAccessed = now;
    this.recordHit();
    return AuditCache.clone(entry.data);
  }

  /**
   * Set a cache entry for an audit query result.
   *
   * @param query - The audit query
   * @param data - The data to cache
   * @param type - The type of query (query, queryWithCursor, or getById)
   * @param id - Optional ID for getById queries
   * @throws {@tlink AuditCacheValidationError} when the input or payload is malformed.
   */
  set(
    query: AuditQuery,
    data: AuditEntry[] | AuditEntry | AuditQueryResult,
    type: AuditCacheQueryType,
    id?: string,
  ): void {
    // Defensive: never store null/undefined and never throw for bad keys.
    if (data === undefined || data === null) {
      return;
    }

    const key = this.generateKey(query, type, id);
    if (key === null) {
      return;
    }

    // A non-positive capacity disables the cache entirely.
    if (this.maxEntries <= 0) {
      return;
    }

    const now = Date.now();
    const resourceId =
      query !== null &&
      typeof query === 'object' &&
      typeof (query as AuditQuery).resourceId === 'string' &&
      (query as AuditQuery).resourceId !== ''
        ? (query as AuditQuery).resourceId
        : undefined;

    const entry: CacheEntry = {
      data: AuditCache.clone(data),
      expiresAt: now + this.ttlMs,
      lastAccessed: now,
      resourceId,
    };

    // Evict least-recently-used entries until there is room. This keeps the
    // size invariant even when maxEntries was reduced.
    if (!this.cache.has(key)) {
      while (this.cache.size >= this.maxEntries) {
        if (!this.evictOldest()) {
          // Empty cache — nothing left to evict; avoid an infinite loop.
          break;
        }
      }
    }
  }

  /**
   * Invalidate all cache entries (called on write operations).
   */
  invalidate(): void {
    try {
      this.cache.clear();
    } catch (error) {
      this.recordFailure('invalidate', error as Error);
    }
  }

  /**
   * Invalidate cache entries for a specific resource ID.
   *
   * Matching is done against the canonicalised query string, so a caller passing
   * the same logical query in a different key order still gets invalidated.
   *
   * @param resourceId - The resource ID whose cache entries should be invalidated
   */
  invalidateByResourceId(resourceId: string): void {
    if (typeof resourceId !== 'string' || resourceId === '') {
      return;
    }

    const keysToDelete: string[] = [];
    this.cache.forEach((entry, key) => {
      if (entry.resourceId === resourceId) {
        keysToDelete.push(key);
      }
    });

    keysToDelete.forEach((key) => this.cache.delete(key));
  }

  /**
   * Clear all cache entries.
   */
  clear(): void {
    try {
      this.cache.clear();
    } catch (error) {
      this.recordFailure('clear', error as Error);
    }
  }

  /**
   * Get current cache statistics.
   */
  getStats(): AuditCacheStats {
    return {
      size: this.cache.size,
      hits: this.hitCount,
      misses: this.missCount,
      failures: this.failureCount,
    };
  }

  /**
   * Evict the least recently used entry.
   *
   * @returns `true` when an entry was evicted, `false` when the cache was empty.
   */
  private evictOldest(): boolean {
    let oldestKey: string | null = null;
    let oldestAccessed = Infinity;

    this.cache.forEach((entry, key) => {
      if (entry.lastAccessed < oldestAccessed) {
        oldestAccessed = entry.lastAccessed;
        oldestKey = key;
      }
    });

    if (oldestKey !== null) {
      this.cache.delete(oldestKey);
      return true;
    }

    return false;
  }

  /**
   * Clean up expired entries (called periodically).
   */
  cleanupExpired(): number {
    try {
      const now = Date.now();
      let cleaned = 0;
      const keysToDelete: string[] = [];

      this.cache.forEach((entry, key) => {
        if (now >= entry.expiresAt) {
          keysToDelete.push(key);
        }
      });

      keysToDelete.forEach(key => {
        this.cache.delete(key);
        cleaned++;
      });

      return cleaned;
    } catch (error) {
      this.recordFailure('cleanupExpired', error as Error);
      return 0;
    }
  }

  /**
   * Async variant of `set` that serializes concurrent mutations through an
   * internal mutex. Use this when callers may race on the same key or when
   * eviction must be atomic with insertion.
   */
  async setAtomic(query: AuditQuery, data: AuditEntry[] | AuditEntry | AuditQueryResult, type: 'query' | 'queryWithCursor' | 'getById', id?: string): Promise<void> {
    await this.mutex.run(() => {
      this.set(query, data, type, id);
    });
  }

  /**
   * Async variant of `get` that serializes concurrent reads with mutations.
   */
  async getAtomic(t
    query: AuditQuery,
    type: 'query' | 'queryWithCursor' | 'getById',
    id?: string,
  ): Promise<AuditEntry[] | AuditEntry | AuditQueryResult | null> {
    return this.mutex.run(() => this.get(query, type, id));
  }

  /**
   * Async variant of `invalidate` that serializes with other mutations.
   */
  async invalidateAtomic(): Promise<void> {
    await this.mutex.run(() => {
      this.invalidate();
    });
  }

  /**
   * Async variant of `cleanupExpired` that serializes with other mutations.
   */
  async cleanupExpiredAtomic(): Promise<number> {
    return this.mutex.run(() => this.cleanupExpired());
  }

  /**
   * Retry a operation with exponential backoff. The operation is expected
   * to be idempotent (such as a cache mutation). Failures are recorded and
   * the last error is returned to the caller via the returned promise.
   */
  async withRetry<T>(
    operation: string,
    fn: () => Promise<T> | T,
    options: { retries?: number; baseDelayMs?: number } = {},
  ): Promise<T> {
    const retries = options.retries ?? 3;
    const baseDelayMs = options.baseDelayMs ?? 10;
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error as Error;
        this.recordFailure(`${operation}:attempt${attempt}`, lastError);
        if (attempt < retries) {
          const delay = baseDelayMs * Math.pow(2, attempt);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    throw lastError ?? new Error(`${operation} failed after ${retries + 1} attempts`);
  }

  private recordHit(): void {
    this.hitCount++;
    try {
      this.hits?.inc();
    } catch (error) {
      this.recordFailure('hitMetric', error as Error);
    }
  }

  private recordMiss(): void {
    this.missCount++;
    try {
      this.misses?.inc();
    } catch (error) {
      this.recordFailure('missMetric', error as Error);
    }
  }
}
