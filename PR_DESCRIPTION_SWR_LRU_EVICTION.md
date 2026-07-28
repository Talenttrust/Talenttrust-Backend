# feat(utils): add bounded LRU eviction to SWRCache (#416)

## Summary

`SWRCache` was unbounded and could grow without limit under high-cardinality workloads (per-user, per-contract, or otherwise uncoalesced key spaces). This change introduces a configurable cap with insertion-order **LRU eviction**, while preserving SWR semantics and never corrupting in-flight revalidations if an entry is evicted mid-flight.

## Problem

- `SWRCache.cache` was an unbounded `Map`. A burst of unique keys (e.g. a large request fan-out with unique correlation IDs) would grow memory without bound.
- No way to assert or observe the cache's size from outside the class for tests or runtime metrics.
- The `revalidate` promise chain used chained `.then`/`.catch` — a synchronous throw inside the fetcher or a caught-then-rethrown error path left `activeFetches` cleaned up only on success, so a rejected fetcher could not be cleanly retried by the next `get()`.

## Solution

### 1. `src/utils/swrCache.ts`
- New `SWRCacheOptions` interface with `maxEntries?: number`. Default is exported as `DEFAULT_MAX_ENTRIES = 1000`.
- `maxEntries` is validated at construction time. **Non-positive, non-integer, `NaN`, and `+Infinity` all throw `RangeError`** — this prevents misconfiguration from silently disabling the cap.
- Public `size` getter exposes the current entry count for observability and tests.
- **Insertion-order LRU.** Map iteration order is the source of truth for recency. Every `get()` that hits an entry, and every write via the cap-enforcing setter, performs a **delete-then-set** step so the entry is treated as most-recently-used. (`Map.set` on an existing key does NOT reorder, so the two-step is required for true LRU semantics.)
- **Cap enforcement on every write.** When `cache.size > maxEntries`, the insertion-order-oldest key is purged iteratively until the bound holds. Cost is `O(maxEntries)` worst case per write.
- **In-flight invariant preserved.** `activeFetches` is tracked independently of cache membership. If an entry is evicted while its upstream revalidation is still pending, the pending promise still resolves and the original `get()` caller receives the awaited data. When the revalidation eventually lands, `setEntry` may displace the new LRU victim without corrupting any state.
- `revalidate` rewired with `try/catch/finally` so `activeFetches.delete(key)` **always** runs, including on synchronous throws from the upstream fetcher. The catch clause continues to log via `console.error` and re-throws so callers can observe the rejection.

### 2. `src/utils/swrCache.test.ts`
- 10 new tests in the `SWRCache with bounded LRU eviction (#416)` describe block:
  - Default cap is exactly 1000
  - User-supplied `maxEntries` is respected
  - `RangeError` on `0`, `-1`, `1.5`, `NaN`, `+Infinity`
  - Cap holds at `maxEntries=100` and `maxEntries=3`
  - **Touch-on-read promotion** keeps a touched entry alive through a later overflow
  - Cap holds at `maxEntries=1`
  - `size` reflects state at every stage of eviction
  - **In-flight revalidation integrity** under eviction pressure — the slow revalidator completes and writes back even after its entry was evicted mid-flight
  - **`activeFetches` cleanup** when the fetcher rejects — coalescing still holds during the rejection (single upstream call across two concurrent getters), and a follow-up `get()` refetches cleanly with the new data

### 3. `docs/backend/caching.md`
- New **Capacity & LRU Eviction** section under the SWR overview: constructor option table, eviction policy prose, in-flight invariant description, and a tuning recommendation for high-cardinality vs. small-cache scenarios.

## Security / Correctness Notes

- **Cap is configurable but never disabled by accident.** Constructor validation prevents `0`, negatives, non-integers, and `NaN` from silently producing an unbounded cache.
- **Eviction never blocks the caller.** Worst-case cost per write is `O(maxEntries)`, and `maxEntries` is a small tunable constant.
- **No new attack surface.** Eviction runs on writes, which are already in trusted process code; it does not affect request handlers or untrusted input parsing.
- **The try/catch/finally refactor closes a pre-existing leak** where a synchronous throw inside the upstream fetcher could leave `activeFetches` populated and silently break coalescing for subsequent callers of the same key.

## Testing

```
# All 15 SWRCache tests pass (5 pre-existing + 10 new)
npx jest src/utils/swrCache.test.ts

# No new TypeScript errors in the touched files
npx tsc --noEmit -p tsconfig.json
```

## Out of Scope

- `src/db/migrations.ts` has pre-existing TS syntax errors on this branch that are unrelated to this PR. They predate this change and do not block the SWRCache tests; they are tracked separately.

## Migration / Compatibility

- **No call-site code changes required.** The constructor's old signature `new SWRCache()` continues to work, defaulting to a 1000-entry cap. Existing callers of `get(key, fetcher, { ttlMs, swrMs })` are source-compatible.
- **Memory footprint changes** from "unbounded" to "bounded by 1000 entries by default". Customers holding cache instances for high-cardinality workloads should set `maxEntries` to match expected cardinality.
- **No environment variables or secrets introduced.**

## Reference Docs

- RFC for 200 OK / stale response shape: see existing SWR section in `docs/backend/caching.md`.
- LRU section: new "Capacity & LRU Eviction" section in the same file.

Closes #416
