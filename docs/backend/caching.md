# Caching Layer (Stale-While-Revalidate)

The TalentTrust Backend implements a robust Stale-While-Revalidate (SWR) caching mechanism. This enables high availability and resilience when querying slower upstream dependencies like the Stellar/Soroban RPC or external APIs.

## Architecture

The utility is provided via `SWRCache` (`src/utils/swrCache.ts`). It holds data in memory and ensures that requests are highly performant.

### Request Coalescing (Stampede Prevention)

When a cache completely misses or expires, the SWR layer coalesces identical overlapping requests. This ensures only *one* upstream fetch is fired, mitigating cache stampedes and preventing backend overloads.

### Status Degradation Signals

When a key is served via the `stale` threshold, the caching layer responds with `degraded: true` and sets `source: 'cache_stale'`. The consumer logic will seamlessly execute a background update to refresh the key's state transparently.

## Capacity & LRU Eviction

`SWRCache` is bounded: it stores at most `maxEntries` items and evicts the
least-recently-used entry whenever a write would exceed the cap. The class
exposes a `size` getter for observability and tests so callers can verify the
bound at any point in their request lifecycle.

| Constructor option | Type | Default | Description |
| --- | --- | --- | --- |
| `maxEntries` | `number` | `1000` | Maximum cached entries before eviction. Must be a positive integer; any other value triggers a `RangeError` at construction time. |

```typescript
import { SWRCache } from '../utils/swrCache';

// Default cap of 1000.
const defaultCache = new SWRCache();

// Explicit cap for a hot or untrusted-traffic scenario.
const boundedCache = new SWRCache({ maxEntries: 5_000 });

// Observability: read the current entry count.
console.log(boundedCache.size);
```

Eviction policy:

- **Insertion-order LRU.** `Map`'s iteration order is the source of truth for
  recency: every successful `get()` that hits an entry, and every write that
  backs an entry, performs a `delete`-then-`set` so the entry is treated as
  most-recently-used. (`Map.set` on an existing key does NOT reorder, so the
  two-step is required for true LRU semantics.)
- **Cap enforcement on every write.** When `cache.size` would exceed
  `maxEntries`, the insertion-order-oldest key is purged until the bound
  holds. The cost per write is `O(maxEntries)` in the worst case, but
  `maxEntries` is a small tunable constant so the work is bounded.
- **In-flight revalidation is never corrupted.** `activeFetches` is tracked
  in a separate Map, decoupled from cache membership. If a cache entry is
  evicted while its upstream revalidation is still pending, the pending
  promise still resolves and the caller observing the original `get()` call
  receives the awaited data. When the revalidation eventually lands, it
  inserts the freshly-fetched entry (and may displace the current LRU
  victim) without corrupting any state.

Pick a smaller cap if your keyspace is very high cardinality (e.g.
per-user or per-contract keys) or if your upstream responses are large;
pick a larger cap when responses are small and revalidation is expensive.

## Access Control & Scoped Keys

To prevent data exposure between authorization bounds, caching keys **must** be scoped to the active caller if the payload contains user-specific data.

**Correct Usage Example:**
```typescript
import { SWRCache } from '../utils/swrCache';

const contractsCache = new SWRCache();

export async function getContractsHandler(req: Request, res: Response) {
  const userId = req.user.id;
  
  // ✅ Securely scoping the key to the authenticated user ID
  const cacheKey = `contracts:list:${userId}`;
  
  const result = await contractsCache.get(
    cacheKey,
    () => fetchUpstreamContracts(userId),
    { ttlMs: 5000, swrMs: 30000 }
  );
  
  return res.status(200).json({
    data: result.data,
    meta: {
      degraded: result.degraded,
      source: result.source
    }
  });
}
```
*Failure to scope keys can lead to cross-tenant data spillage.* Use strict identification bounds when forming string keys.