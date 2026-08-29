# Contracts Read Endpoint Caching

**Issue:** #801 - Contracts read endpoints recompute on every request  
**Solution:** Bounded TTL-based LRU cache with explicit write-time invalidation

## Overview

This document describes the response caching layer added to the contracts module. The cache improves performance by reducing database round-trips for frequently accessed contracts data, while maintaining strict correctness guarantees: **no stale reads immediately after a write**.

## Design Principles

### 1. Bounded Memory (LRU)
- Cache uses **Least-Recently-Used (LRU) eviction** to enforce a configurable max-entry bound
- Once the bound is exceeded, the least-recently-used entry is evicted, preventing unbounded memory growth
- Particularly important for list/filtered queries with high key cardinality (many distinct filter combinations)

### 2. Time-To-Live (TTL)
- Each cached entry has an expiration timestamp based on configured TTL
- Expired entries are treated as cache misses and removed on access
- TTL is configurable via environment variables with sensible defaults

### 3. Write-Time Invalidation
- **Synchronous and explicit:** Every write path invalidates affected cache keys **before** returning the write response to the client
- **Targeted:** Prefer invalidating only the affected keys rather than flushing the entire cache
- **Correctness-first:** When in doubt, invalidate more broadly rather than risk serving stale data
- **No stale reads:** A client that writes then immediately reads sees fresh data

### 4. Metrics Integration
- Cache hit/miss events are emitted as Prometheus metrics (`cache_operations_total`)
- Metrics allow operators to tune cache behavior (TTL, bounds) based on actual usage patterns

## Configuration

Cache behavior is controlled via environment variables:

```env
# TTL in milliseconds for cached contract reads (default: 30000 = 30 seconds)
CACHE_CONTRACTS_TTL_MS=30000

# Maximum number of entries before LRU eviction (default: 1000)
CACHE_CONTRACTS_MAX_ENTRIES=1000
```

### Production Tuning

1. **Monitor cache metrics** to find the right balance:
   - High hit rate + memory growing → increase TTL, lower max entries
   - Low hit rate + constant eviction → decrease TTL, increase max entries

2. **For multi-instance deployments** without a shared cache layer:
   - Each instance maintains its own local LRU cache
   - Cache is instance-local; reads from one instance won't hit another's cache
   - If shared caching is needed later, consider adding Redis-backed caching

3. **Cache invalidation overhead**:
   - Invalidation is O(n) where n is the number of keys matching a pattern
   - For most workloads with <1000 cache entries, this is negligible
   - If invalidation becomes a bottleneck, consider maintaining an index of affected keys

## Cached Endpoints

### Read Endpoints (Cached)

| Endpoint | Cache Key | Invalidated By |
|----------|-----------|---|
| `GET /api/v1/contracts` | `contracts:list` | create, update, delete contract |
| `GET /api/v1/contracts/:id` | `contracts:single:{id}` | update, delete contract with that ID |
| `GET /api/v1/contracts` (paginated) | `contracts:page:{hash}` | create, update, delete contract |
| `GET /api/v1/contracts/stats` | `contracts:stats` | create, update, delete contract |
| `GET /api/v1/contracts/bounds` | `contracts:bounds` | never (immutable) |

### Write Endpoints (Trigger Invalidation)

| Endpoint | Method | Invalidates |
|----------|--------|---|
| `/api/v1/contracts` | POST | `contracts:list`, `contracts:stats`, `contracts:page:**` |
| `/api/v1/contracts/:id` | PATCH | `contracts:single:{id}`, `contracts:list`, `contracts:stats`, `contracts:page:**` |
| `/api/v1/contracts/:id` | DELETE | `contracts:single:{id}`, `contracts:list`, `contracts:stats`, `contracts:page:**` |

## Implementation Details

### Cache Service (`src/lib/cacheService.ts`)

Core caching logic:

```typescript
const cache = new CacheService(config, {
  onHit: (key) => metricsService.recordCacheHit('contracts'),
  onMiss: (key) => metricsService.recordCacheMiss('contracts'),
});

// Get or fetch
let result = cache.get('contracts:single:id-1');
if (!result) {
  result = await service.getContractById('id-1');
  cache.set('contracts:single:id-1', result);
}

// Invalidate specific key
cache.invalidateKey('contracts:single:id-1');

// Invalidate matching pattern
cache.invalidatePattern('contracts:page:**');
```

**Features:**
- TTL-aware: Expired entries are removed on access
- LRU eviction: Least-recently-used entries evicted when max is reached
- Pattern-based invalidation: Glob patterns (`*`, `**`) for flexible key matching
- Metrics callbacks: Decoupled from observability layer

### Cache Interceptor (`src/lib/contractsCacheInterceptor.ts`)

Wraps `ContractsService` with transparent caching and invalidation:

```typescript
const cachedService = createCachedContractsService(baseService, {
  contractsTtlMs: 30_000,
  contractsMaxEntries: 1000,
  metricsService,
});

// Reads are cached automatically
const contract = await cachedService.getContractById('id-1'); // First: miss + fetch
const contract = await cachedService.getContractById('id-1'); // Second: hit + return cached

// Writes invalidate affected cache keys
await cachedService.updateContract('id-1', {...});
```

**Key properties:**
- **Synchronous invalidation:** Cache is invalidated before the write function returns
- **Targeted invalidation:** Each write path only invalidates keys it affects
- **Error handling:** If a write fails, cache is NOT invalidated (old data remains safe)

### Metrics

Cache operations are tracked via `cache_operations_total` counter:

```prometheus
cache_operations_total{cache_type="contracts", operation="hit"} 1523
cache_operations_total{cache_type="contracts", operation="miss"} 247
```

The hit rate can be calculated as:
```
hit_rate = hits / (hits + misses)
```

## Invalidation Guarantees

### What Clients Can Rely On

1. **No stale reads after a write:**
   - If a client POSTs/PATCHs/DELETEs a contract and immediately GETs it, they see the updated state
   - The write handler invalidates all affected cache keys before responding

2. **Consistency across endpoints:**
   - After creating a contract, both `GET /contracts` (list) and `GET /contracts/stats` return the new contract
   - Invalidation is atomic: all affected keys are cleared together

3. **No cascading invalidations needed:**
   - Writes only affect contract-related cache keys
   - Unrelated cache (other modules) is never affected by contract writes

### What Could Go Wrong (and How It's Prevented)

**Scenario 1: Incomplete invalidation**
- Problem: A write updates a contract but doesn't invalidate a cached list query that includes it
- Prevention: The interceptor has explicit invalidation keys for each write type; test coverage verifies all paths

**Scenario 2: Stale writes**
- Problem: Two concurrent writes both see cached data before either invalidates it
- Prevention: Invalidation happens **synchronously before response**, so the second write sees a fresh read

**Scenario 3: Background job updates**
- Problem: A background job updates a contract but the cache isn't invalidated
- Prevention: This is a known gap. Mitigation: use a short TTL (30s default) so stale data is ephemeral, or implement event-driven invalidation for async updates

## Testing

### Test Coverage

All cache behaviors are tested in `src/lib/cacheService.test.ts` and `src/lib/contractsCacheInterceptor.test.ts`:

1. **Cold cache (miss):** First read is a cache miss, populates cache, underlying function called once
2. **Cache hit:** Repeated read returns cached value, underlying function NOT called again
3. **Write invalidation:** Read (hit) → write → read (miss, fresh fetch) confirms invalidation works
4. **LRU eviction:** Adding entries beyond the max bound evicts least-recently-used entry
5. **TTL expiry:** After configured TTL elapses, cached entry is expired and evicted
6. **Metrics:** Hit/miss counters increment correctly across all scenarios

### Running Tests

```bash
npm test -- cacheService.test.ts
npm test -- contractsCacheInterceptor.test.ts
```

## Troubleshooting

### High Cache Misses Despite Stable Workload

**Symptom:** `cache_operations_total{operation="miss"}` is rising while hit rate stays low

**Causes:**
- TTL too short: Entries expire before being reused
- Max entries too low: Eviction is too aggressive
- Key cardinality too high: Many unique filter combinations create unique keys

**Fix:**
- Increase `CACHE_CONTRACTS_TTL_MS` (e.g., 30s → 60s)
- Increase `CACHE_CONTRACTS_MAX_ENTRIES` (e.g., 1000 → 2000)
- Examine query patterns: are clients making too many unique filtered requests?

### Memory Growing Unbounded

**Symptom:** Process memory usage increases steadily

**Causes:**
- `contractsMaxEntries` is effectively not enforced (set to 0 or negative)
- Metrics callbacks are holding references to evicted data
- Underlying service is also caching data (double-caching)

**Fix:**
- Verify `CACHE_CONTRACTS_MAX_ENTRIES` is set to a reasonable value (e.g., 1000)
- Check metrics callbacks don't hold references to values
- Monitor `cache_service.size()` to see actual entry count

### Stale Data After Writes

**Symptom:** After POSTing/PATCHing a contract, a GET returns the old value

**Causes:**
- Cache invalidation path not being executed (middleware/interceptor not wired)
- Write path doesn't invalidate all affected keys
- Cache TTL is very long and there's a race condition

**Fix:**
- Verify the contracts router uses `createCachedContractsService()`
- Check interceptor invalidation keys match the write type
- Review write-time invalidation order: happens before or after DB write?
- Reduce TTL temporarily (e.g., 10s) to rule out TTL as cause

## Related Issues & Future Work

### Background Job Invalidation

Currently, cache is only invalidated on direct contract writes. Background jobs (e.g., event processors, dispute resolution) that update contracts do NOT invalidate cache. 

**Workaround:** Use a short TTL (30s default) to bound stale data window

**Future:** Implement event-driven cache invalidation so background events trigger invalidation

### Multi-Instance Caching

Each server instance has its own local cache. Reads from Client A on Server 1 don't benefit another client on Server 2.

**Future:** Add Redis-backed shared caching for multi-instance deployments

### Metrics Dashboard

Cache metrics are exposed via Prometheus but there's no pre-built Grafana dashboard.

**Future:** Create a dashboard showing hit rate, eviction rate, and TTL distribution

## See Also

- Config: `src/config/cache.ts`
- Cache Service: `src/lib/cacheService.ts`
- Interceptor: `src/lib/contractsCacheInterceptor.ts`
- Metrics Integration: `src/observability/registry.ts`
- Routes: `src/routes/contracts.routes.ts`
