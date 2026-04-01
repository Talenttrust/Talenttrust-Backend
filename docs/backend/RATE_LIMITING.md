# Rate Limiting & Abuse Guard

**Location:** `src/middleware/rateLimiter.ts` + `src/lib/rateLimitStore.ts`  
**Feature branch:** `feature/backend-10-rate-limiting-and-abuse-guard`

---

## Overview

This document describes the rate-limiting and abuse-guard system implemented for TalentTrust's public API. The implementation uses a **sliding-window counter** algorithm with an **adaptive abuse guard** that applies exponential back-off blocks to repeat offenders.

---

## Architecture

```
Request
  │
  ▼
┌──────────────────────────────────────────────┐
│  rateLimiterMiddleware  (Express middleware)  │
│                                              │
│  1. Extract key (IP / custom keyFn)          │
│  2. Check hard-block → 429 if blocked        │
│  3. Sliding-window counter (RateLimitStore)  │
│  4. Limit exceeded?                          │
│     ├─ No  → set headers, call next()        │
│     └─ Yes → check abuse threshold           │
│              ├─ Below → 429 + Retry-After    │
│              └─ At/above → hard-block + 429  │
└──────────────────────────────────────────────┘
```

---

## Algorithm

### Sliding Window Counter

- Each unique key (default: client IP) gets a counter and a `windowStart` timestamp.
- On each request, if `now - windowStart > windowMs`, the window resets to `now` with `count = 0`.
- `count` is incremented before the limit check, so the check is `count > maxRequests`.

### Abuse Guard

| Event | Action |
|---|---|
| `count > maxRequests` | Violation recorded |
| violations in `blockWindowMs` reaches `abuseThreshold` | Key is hard-blocked for `blockDurationMs` |
| Subsequent abuse after unblocking | Block duration **doubles** (exponential back-off), capped at `maxBlockDurationMs` |

---

## Configuration Reference

All options are passed to `createRateLimiter(config)`.  
Environment variables (set in `.env` or process environment) override defaults for the `index.ts` instance.

| Option | Env var | Default | Description |
|---|---|---|---|
| `maxRequests` | `RATE_LIMIT_MAX_REQUESTS` | `100` | Max requests per window |
| `windowMs` | `RATE_LIMIT_WINDOW_MS` | `60000` | Window size in ms |
| `abuseThreshold` | `RATE_LIMIT_ABUSE_THRESHOLD` | `5` | Violations before hard-block |
| `blockWindowMs` | – | `300000` | Observation window for violations |
| `blockDurationMs` | `RATE_LIMIT_BLOCK_MS` | `600000` | Initial block duration |
| `maxBlockDurationMs` | – | `86400000` | Maximum block duration (24 h) |
| `keyFn` | – | IP extraction | Custom key derivation function |
| `sendHeaders` | – | `true` | Emit `X-RateLimit-*` headers |
| `store` | – | new instance | Shared `RateLimitStore` |

---

## Response Headers

| Header | When | Value |
|---|---|---|
| `X-RateLimit-Limit` | Always (if `sendHeaders`) | Configured `maxRequests` |
| `X-RateLimit-Remaining` | Always (if `sendHeaders`) | Requests left in window |
| `X-RateLimit-Reset` | Always (if `sendHeaders`) | Seconds until window resets |
| `Retry-After` | 429 responses | Seconds to wait |
| `X-RateLimit-Blocked` | Hard-block 429 | `"true"` |

---

## Response Bodies (429)

**Rate limit exceeded (not yet blocked):**
```json
{
  "error": "Too Many Requests",
  "message": "Rate limit exceeded. Try again in 42 second(s).",
  "retryAfter": 42
}
```

**Abuse guard – hard block:**
```json
{
  "error": "Too Many Requests",
  "message": "Abuse detected. Your access has been temporarily blocked.",
  "retryAfter": 600
}
```

---

## Security Notes

1. **Key hashing** – Raw IP addresses are never stored; the store uses SHA-256 hashes. This prevents PII leaking in heap snapshots or memory dumps.
2. **X-Forwarded-For trust** – The default `keyFn` takes the *first* value from `X-Forwarded-For`. In production behind a single reverse proxy, set `app.set('trust proxy', 1)` and supply a `keyFn` that uses `req.ip` to prevent clients spoofing multiple XFF values.
3. **No external dependency** – The store is fully in-process. For multi-instance deployments, replace `RateLimitStore` with a Redis-backed adapter and share it via the `store` option.
4. **Health endpoint excluded** – `/health` is intentionally not rate-limited so load-balancer probes and monitoring agents are never blocked.
5. **Exponential back-off** – Repeat offenders face doubling block durations, significantly raising the cost of sustained abuse.

---

## Threat Model

| Threat | Mitigation |
|---|---|
| DDoS from single IP | Hard-block after `abuseThreshold` violations; exponential back-off |
| IP spoofing via XFF | Use `trust proxy` + `req.ip`-based `keyFn` in production |
| Memory exhaustion | Background sweep purges expired entries every `windowMs` |
| Heap dump leaking IPs | Keys stored as SHA-256 hashes |
| Clock manipulation | All timing via `Date.now()`; block expiry checked on every request |

---

## Usage Examples

### Default (IP-based, applied to all `/api/` routes)

```ts
import { createRateLimiter } from './middleware/rateLimiter';

const limiter = createRateLimiter(); // 100 req/min, 5-violation block
app.use('/api/', limiter);
```

### Stricter limits for an auth endpoint

```ts
const authLimiter = createRateLimiter({
  maxRequests: 5,
  windowMs: 60_000,
  abuseThreshold: 3,
  blockDurationMs: 3_600_000, // 1 hour
});
app.post('/api/v1/auth/login', authLimiter, loginHandler);
```

### API-key-scoped limiting

```ts
const apiKeyLimiter = createRateLimiter({
  maxRequests: 1000,
  windowMs: 60_000,
  keyFn: (req) => req.headers['x-api-key'] as string ?? req.ip ?? 'unknown',
});
```

### Shared store across multiple limiter instances

```ts
import { RateLimitStore } from './utils/rateLimitStore';

const store = new RateLimitStore();
const readLimiter  = createRateLimiter({ maxRequests: 200, store });
const writeLimiter = createRateLimiter({ maxRequests: 50,  store });
```

---

## Running Tests

```bash
npm install
npm test              # run all tests with coverage report
npm run test:coverage # explicit coverage run
```

Expected output: ≥ 95 % coverage on branches, functions, lines, and statements for `src/middleware/rateLimiter.ts` and `src/utils/rateLimitStore.ts`.