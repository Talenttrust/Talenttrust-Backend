# Cache Layer

## Overview

The backend now uses a small in-memory cache layer for safe read-mostly contract reads.

Cached operations:

- `GET /api/v1/contracts`
- `GET /api/v1/contracts/:id`

These are the current best candidates for caching because they are deterministic, shared across callers, and derived from the same source-of-truth contract service.

## Architecture

The cache layer is introduced through:

- `src/cache/cache-store.ts`
- `src/cache/in-memory-cache.ts`
- `src/config/cache-config.ts`
- `src/services/cached-contract-service.ts`

`CachedContractService` wraps the existing `ContractService` and keeps cache concerns out of the route handlers.

## Strategy

- backend: in-memory cache
- key namespaces:
  - `contracts:list`
  - `contracts:detail:<normalized-id>`
- TTL: configurable, default 30 seconds
- max entries: configurable, default 100

## Invalidation

After `POST /api/v1/contracts` succeeds, the cache layer invalidates:

- the contracts list key
- the newly created contract detail key

This keeps stale list responses from being served after writes.

## Fallback behavior

Cache failures are treated as non-fatal:

- cache read failure -> fallback to source
- cache write failure -> still return source response
- cache delete failure -> write still succeeds

Correctness is prioritized over cache availability.

## Security assumptions and threat scenarios

Validated assumptions:

- only non-user-specific contract data is cached
- no credentials, sessions, or secrets are stored in cache
- no authorization decisions are cached
- cache keys use explicit namespaces and normalized identifiers

Threat scenarios considered:

- cross-user leakage: avoided by caching only shared public data
- cache poisoning via raw input: reduced by explicit key builders and route validation
- stale data after writes: mitigated by invalidation plus TTL
- cache outage: mitigated by fallback to source
- unbounded memory growth: reduced by TTL and max item eviction

## Testing

The test suite covers:

- cache hit/miss behavior
- TTL expiry
- max item eviction
- route-level cache behavior
- invalidation after writes
- disabled cache mode
- graceful fallback on cache failure

Run:

```bash
npm test
npm test -- --coverage
```

## Limitations

- The current backend is single-process and in-memory, so cache state is process-local.
- There is no distributed invalidation because the repo does not currently use Redis or another shared cache backend.
- If the API gains user-scoped/private read endpoints later, those should not be added to this cache without explicit scoping and security review.
