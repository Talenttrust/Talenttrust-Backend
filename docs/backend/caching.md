# Caching Layer (Stale-While-Revalidate)

The TalentTrust Backend implements a robust Stale-While-Revalidate (SWR) caching mechanism. This enables high availability and resilience when querying slower upstream dependencies like the Stellar/Soroban RPC or external APIs.

## Architecture

The utility is provided via `SWRCache` (`src/utils/swrCache.ts`). It holds data in memory and ensures that requests are highly performant.

### Request Coalescing (Stampede Prevention)

When a cache completely misses or expires, the SWR layer coalesces identical overlapping requests. This ensures only *one* upstream fetch is fired, mitigating cache stampedes and preventing backend overloads.

### Status Degradation Signals

When a key is served via the `stale` threshold, the caching layer responds with `degraded: true` and sets `source: 'cache_stale'`. The consumer logic will seamlessly execute a background update to refresh the key's state transparently.

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