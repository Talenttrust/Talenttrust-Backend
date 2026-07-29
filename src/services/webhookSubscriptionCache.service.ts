/**
 * @module services/webhookSubscriptionCache.service
 * @description SWR cache layer for webhook-subscription read endpoints.
 *
 * Wraps `SWRCache` with named methods that match the two read paths exposed
 * by `routes/webhook-subscription.routes.ts`:
 *  - `getById`      → caches individual subscription lookups (GET /:id)
 *  - `getList`      → caches paginated list results (GET /)
 *
 * Invalidation must be called on every mutation:
 *  - POST   /  → `invalidateLists()`
 *  - PATCH  /:id → `invalidateSubscription(id)` + `invalidateLists()`
 *  - DELETE /:id → `invalidateSubscription(id)` + `invalidateLists()`
 *
 * Metrics follow the same prom-client Counter/Gauge pattern established by
 * `ContractCacheService` (src/services/contractCache.service.ts):
 *  - webhook_subscription_cache_hits_total        {operation}
 *  - webhook_subscription_cache_misses_total      {operation}
 *  - webhook_subscription_cache_invalidations_total {reason}
 *  - webhook_subscription_cache_entries           (Gauge)
 *
 * Config is sourced from environment variables with sane defaults (see
 * `loadWebhookCacheConfig` below), following the same `toMs`/`toCount`
 * convention used in `src/config/rateLimit.ts`.
 */

import { Counter, Gauge, Registry } from 'prom-client';
import { SWRCache } from '../utils/swrCache';
import type { WebhookSubscription } from '../types/webhook.types';
import type { CursorPage } from '../contracts/cursor.types';

// ── Default config values ─────────────────────────────────────────────────────

export const DEFAULT_WEBHOOK_CACHE_TTL_MS = 5_000;
export const DEFAULT_WEBHOOK_CACHE_SWR_MS = 30_000;
export const DEFAULT_WEBHOOK_CACHE_MAX_ENTRIES = 500;

// ── Config interface + env-var loader ─────────────────────────────────────────

export interface WebhookCacheConfig {
  ttlMs?: number;
  swrMs?: number;
  maxEntries?: number;
}

/**
 * Reads webhook cache config from environment variables, applying sane
 * defaults when a variable is absent or unparseable. Follows the same
 * `toMs` / `toCount` pattern used in `src/config/rateLimit.ts`.
 *
 * Supported variables:
 *  WEBHOOK_CACHE_TTL_MS       — fresh TTL in ms          (default 5 000)
 *  WEBHOOK_CACHE_SWR_MS       — stale-while-revalidate   (default 30 000)
 *  WEBHOOK_CACHE_MAX_ENTRIES  — LRU entry cap            (default 500)
 */
export function loadWebhookCacheConfig(env: NodeJS.ProcessEnv = process.env): WebhookCacheConfig {
  return {
    ttlMs: toMs(env['WEBHOOK_CACHE_TTL_MS'], DEFAULT_WEBHOOK_CACHE_TTL_MS),
    swrMs: toMs(env['WEBHOOK_CACHE_SWR_MS'], DEFAULT_WEBHOOK_CACHE_SWR_MS),
    maxEntries: toCount(env['WEBHOOK_CACHE_MAX_ENTRIES'], DEFAULT_WEBHOOK_CACHE_MAX_ENTRIES),
  };
}

function toMs(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (Number.isNaN(parsed) || parsed < 0) {
    console.warn(`[webhookCache] Invalid env value "${value}", using fallback ${fallback}`);
    return fallback;
  }
  return parsed;
}

function toCount(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Math.floor(Number(value));
  if (Number.isNaN(parsed) || parsed < 1) {
    console.warn(`[webhookCache] Invalid env value "${value}", using fallback ${fallback}`);
    return fallback;
  }
  return parsed;
}

// ── Cache key helpers ─────────────────────────────────────────────────────────

/** Cache key for a single subscription lookup (GET /:id). */
const CACHE_KEY_SUB = (id: string) => `webhook-sub:${id}`;

/**
 * Cache key for a paginated list result (GET /).
 *
 * Encodes all filter dimensions so distinct queries never share a bucket.
 * Written into `listKeys` on every cache write so `invalidateLists()` can
 * purge every outstanding list key without needing a prefix-scan.
 */
const CACHE_KEY_LIST = (
  consumerId: string | undefined,
  eventType: string | undefined,
  active: boolean | undefined,
  cursor: string | undefined,
  limit: number | undefined,
) =>
  `webhook-subs:list:${consumerId ?? ''}:${eventType ?? ''}:${String(active ?? '')}:${cursor ?? ''}:${limit ?? ''}`;

// ── Operation labels ──────────────────────────────────────────────────────────

export type WebhookCacheOperation = 'getById' | 'getList';

// ── Service class ─────────────────────────────────────────────────────────────

export class WebhookSubscriptionCacheService {
  private readonly cache: SWRCache;
  private readonly ttlMs: number;
  private readonly swrMs: number;

  /**
   * Tracks every list-variant key written to the cache so `invalidateLists()`
   * can purge them all without a prefix-scan (SWRCache has no deleteByPrefix).
   */
  private readonly listKeys = new Set<string>();

  // Prometheus metrics — follow the same naming convention as ContractCacheService
  public readonly cacheHitsTotal: Counter<'operation'>;
  public readonly cacheMissesTotal: Counter<'operation'>;
  public readonly cacheInvalidationsTotal: Counter<'reason'>;
  public readonly cacheEntries: Gauge;

  constructor(config: WebhookCacheConfig = {}, register?: Registry) {
    this.ttlMs = config.ttlMs ?? DEFAULT_WEBHOOK_CACHE_TTL_MS;
    this.swrMs = config.swrMs ?? DEFAULT_WEBHOOK_CACHE_SWR_MS;
    this.cache = new SWRCache({
      maxEntries: config.maxEntries ?? DEFAULT_WEBHOOK_CACHE_MAX_ENTRIES,
    });

    const reg = register ?? new Registry();

    this.cacheHitsTotal = new Counter({
      name: 'webhook_subscription_cache_hits_total',
      help: 'Total number of webhook subscription cache hits by operation',
      labelNames: ['operation'] as const,
      registers: [reg],
    });

    this.cacheMissesTotal = new Counter({
      name: 'webhook_subscription_cache_misses_total',
      help: 'Total number of webhook subscription cache misses by operation',
      labelNames: ['operation'] as const,
      registers: [reg],
    });

    this.cacheInvalidationsTotal = new Counter({
      name: 'webhook_subscription_cache_invalidations_total',
      help: 'Total number of webhook subscription cache invalidations by reason',
      labelNames: ['reason'] as const,
      registers: [reg],
    });

    this.cacheEntries = new Gauge({
      name: 'webhook_subscription_cache_entries',
      help: 'Current number of entries in the webhook subscription cache',
      registers: [reg],
    });
  }

  /** Current number of cached entries. */
  public get size(): number {
    return this.cache.size;
  }

  // ── Read methods ────────────────────────────────────────────────────────────

  /**
   * Cache-aware lookup for a single subscription.
   * Key: `webhook-sub:<id>`
   */
  async getById(
    id: string,
    fetcher: () => Promise<WebhookSubscription | undefined>,
  ): Promise<WebhookSubscription | undefined> {
    const key = CACHE_KEY_SUB(id);
    const result = await this.cache.get<WebhookSubscription | undefined>(key, fetcher, {
      ttlMs: this.ttlMs,
      swrMs: this.swrMs,
    });
    this.updateEntryGauge();
    this.recordResult('getById', result.source);
    return result.data;
  }

  /**
   * Cache-aware paginated list lookup.
   * Key encodes all filter + pagination dimensions so distinct queries never
   * collide. Each key is registered in `listKeys` for bulk invalidation.
   */
  async getList(
    params: {
      consumerId?: string;
      eventType?: string;
      active?: boolean;
      cursor?: string;
      limit?: number;
    },
    fetcher: () => Promise<CursorPage<WebhookSubscription>>,
  ): Promise<CursorPage<WebhookSubscription>> {
    const key = CACHE_KEY_LIST(
      params.consumerId,
      params.eventType,
      params.active,
      params.cursor,
      params.limit,
    );

    // Register this key so invalidateLists() can purge it later.
    this.listKeys.add(key);

    const result = await this.cache.get<CursorPage<WebhookSubscription>>(key, fetcher, {
      ttlMs: this.ttlMs,
      swrMs: this.swrMs,
    });
    this.updateEntryGauge();
    this.recordResult('getList', result.source);
    return result.data;
  }

  // ── Invalidation methods ────────────────────────────────────────────────────

  /**
   * Removes a single subscription key from the cache.
   * Call on PATCH and DELETE for the affected subscription id.
   */
  invalidateSubscription(id: string): void {
    this.cache.delete(CACHE_KEY_SUB(id));
    this.cacheInvalidationsTotal.inc({ reason: 'subscription_mutated' });
    this.updateEntryGauge();
  }

  /**
   * Purges every cached list result.
   *
   * Called on POST (create), PATCH (update), and DELETE because any of those
   * mutations can change the result of any outstanding list query.
   * We iterate over `listKeys` — the set of every list key that was ever
   * written during this process lifetime — so evicted entries are silently
   * skipped (SWRCache.delete returns false for absent keys, which is fine).
   */
  invalidateLists(): void {
    for (const key of this.listKeys) {
      this.cache.delete(key);
    }
    // Clear the tracking set so evicted keys don't accumulate indefinitely.
    this.listKeys.clear();
    this.cacheInvalidationsTotal.inc({ reason: 'list_mutated' });
    this.updateEntryGauge();
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private updateEntryGauge(): void {
    this.cacheEntries.set(this.cache.size);
  }

  private recordResult(
    operation: WebhookCacheOperation,
    source: 'upstream' | 'cache_fresh' | 'cache_stale',
  ): void {
    if (source === 'cache_fresh' || source === 'cache_stale') {
      this.cacheHitsTotal.inc({ operation });
    } else {
      this.cacheMissesTotal.inc({ operation });
    }
  }
}
