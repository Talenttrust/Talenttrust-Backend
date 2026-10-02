# Circuit Breaker for RPC Failures

> Reference documentation for the TalentTrust circuit-breaker module.

## Overview

The circuit breaker protects the backend from cascading failures when an upstream service (Stellar/Soroban RPC, Horizon API) degrades. Instead of queuing up blocked requests, calls fail fast with a typed `CircuitOpenError` so the API can return `503` immediately.

The system has three layers:

| Layer | File | Role |
| ----- | ---- | ---- |
| **Breaker** | `src/circuit-breaker/CircuitBreaker.ts` | Generic state machine (the core) |
| **Registry** | `src/circuit-breaker/registry.ts` | Singleton that manages all named breakers |
| **Client** | `src/rpc/stellarClient.ts` | `StellarClient` that wraps Stellar RPC calls in a breaker |

---

## State Machine

```
               failureCount >= failureThreshold
  CLOSED ──────────────────────────────────────────────────► OPEN
    ▲                                                          │
    │                                     timeout elapsed      │
    │                                                          ▼
    │           successCount >= successThreshold             HALF_OPEN
    └──────────────────────────────────────────────────────────┘
                    ▲                                          │
                    │           any probe fails                │
                    └──────────────────────────────────────────┘
```

| State | Behaviour |
| ----- | --------- |
| `CLOSED` | Normal operation. Every failure increments `failureCount`; every success resets it to `0`. When `failureCount >= failureThreshold` the circuit trips to OPEN. |
| `OPEN` | Fails fast — throws `CircuitOpenError` immediately without calling upstream. After `timeout` ms (measured from `lastFailureTime`) the circuit transitions to HALF_OPEN on the next call to `execute()`, `getState()`, or `getStats()`. |
| `HALF_OPEN` | Allows exactly one probe call at a time (`probeInFlight` gate). Success increments `successCount`; when `successCount >= successThreshold` the circuit resets to CLOSED. Failure transitions back to OPEN (and resets `successCount` to `0`). |

### Counters

| Counter | Reset condition |
| ------- | --------------- |
| `failureCount` | Any success in any state, or on transition to CLOSED |
| `successCount` | Any failure in HALF_OPEN, or on entry to HALF_OPEN, or on transition to CLOSED |
| `probeInFlight` | After the probe call completes (success or failure), or on reset |

---

## Configuration

### `CircuitBreaker` options (constructor)

| Option | Default | Description |
| ------ | ------- | ----------- |
| `failureThreshold` | `5` | Consecutive failures before tripping to OPEN |
| `successThreshold` | `1` | Consecutive successes in HALF_OPEN before closing |
| `timeout` | `30_000` | Milliseconds in OPEN before transitioning to HALF_OPEN |
| `name` | `'default'` | Label used in error messages, logs, and the `X-Circuit-Name` header |

These defaults are set in `CircuitBreaker.ts:94-97` and confirmed in `StellarClient.ts:81-86`.

### `StellarClient` environment

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `STELLAR_RPC_URL` | `https://soroban-testnet.stellar.org` | Stellar/Soroban JSON-RPC endpoint |
| `STELLAR_RPC_TIMEOUT_MS` | _(not set)_ | Per-request HTTP timeout (use alongside the breaker) |

The `StellarClient` singleton in `src/rpc/stellarClient.ts:121` creates a `CircuitBreaker` named `"stellar-rpc"` with thresholds `{ failureThreshold: 5, successThreshold: 1, timeout: 30_000 }`.

---

## API

### `CircuitBreaker`

```ts
import { CircuitBreaker, CircuitOpenError } from "../circuit-breaker";

const breaker = new CircuitBreaker({
  name: "stellar-rpc",
  failureThreshold: 3,
});

try {
  const result = await breaker.execute(() => fetchFromStellar());
} catch (err) {
  if (err instanceof CircuitOpenError) {
    res
      .status(503)
      .set("Retry-After", "30")
      .set("X-Circuit-Name", err.circuitName)
      .json({ error: err.message });
  }
}
```

| Method | Returns | Description |
| ------ | ------- | ----------- |
| `execute(fn)` | `Promise<T>` | Runs `fn` or throws `CircuitOpenError` if OPEN; records success/failure |
| `getState()` | `'CLOSED' \| 'OPEN' \| 'HALF_OPEN'` | Current state (triggers timeout transition) |
| `getStats()` | `CircuitStats` | State + `failureCount`, `successCount`, `lastFailureTime` |
| `reset()` | `void` | Force back to CLOSED (admin/test use only) |

### `CircuitStats` shape

```ts
interface CircuitStats {
  state: CircuitState;
  failureCount: number;
  successCount: number;
  lastFailureTime: number | null; // epoch ms of most recent failure
}
```

### `CircuitOpenError`

| Property | Type | Description |
| -------- | ---- | ----------- |
| `name` | `string` | Always `"CircuitOpenError"` (useful for `instanceof` checks) |
| `circuitName` | `string` | The breaker name — use this to set the `X-Circuit-Name` response header |
| `message` | `string` | Human-readable message like `Circuit "stellar-rpc" is OPEN — call rejected to protect upstream.` |

### `BreakerStatus` (registry)

```ts
interface BreakerStatus extends CircuitStats {
  name: string;
  config: {
    failureThreshold: number;
    successThreshold: number;
    timeoutMs: number;
  };
}
```

### `StellarClient`

```ts
import { stellarClient } from "../rpc/stellarClient";

const response = await stellarClient.call({ method: "getLatestLedger" });
const stats = stellarClient.getCircuitStats();
```

| Method | Returns | Description |
| ------ | ------- | ----------- |
| `call(payload)` | `Promise<RpcResponse>` | Routes the RPC call through the `"stellar-rpc"` breaker |
| `getCircuitStats()` | `CircuitStats` | Stats of the underlying breaker |
| `getBreaker()` | `CircuitBreaker` | Direct access to the breaker (for routes or tests) |

---

## HTTP Error Responses

When the circuit is OPEN, routes should include **both** headers:

```
HTTP/1.1 503 Service Unavailable
Retry-After: 30
X-Circuit-Name: stellar-rpc
Content-Type: application/json

{ "error": "Circuit \"stellar-rpc\" is OPEN — call rejected to protect upstream." }
```

| Header | Source | Purpose |
| ------ | ------ | ------- |
| `Retry-After` | `breaker` timeout value (seconds) | Lets proxies and clients know when to retry |
| `X-Circuit-Name` | `error.circuitName` from `CircuitOpenError` | Lets ops teams identify the failing upstream without parsing the body |

---

## Reading Breaker Status

### Via the admin API (recommended)

```
GET /api/v1/admin/circuit-breakers
Authorization: Bearer <admin-jwt>
```

Response:

```json
{
  "status": "success",
  "data": {
    "breakers": [
      {
        "name": "stellar-rpc",
        "state": "CLOSED",
        "failureCount": 0,
        "successCount": 0,
        "lastFailureTime": null,
        "config": {
          "failureThreshold": 5,
          "successThreshold": 1,
          "timeoutMs": 30000
        }
      }
    ],
    "timestamp": 1719000000000
  }
}
```

Requires the `admin` role (`src/routes/admin.routes.ts:46-57`).

### Via the health probe

The `circuitBreakerProbe` in `src/health/probes.ts:209-229` calls `circuitBreakerRegistry.getAll()` and returns `ok: false` (degraded) when at least one breaker is OPEN. This feeds into the `/health` endpoint.

### Programmatic access

```ts
import { circuitBreakerRegistry } from "../circuit-breaker";

// All breakers
const all: BreakerStatus[] = circuitBreakerRegistry.getAll();

// Get or create a named breaker
const breaker = circuitBreakerRegistry.getOrCreate("my-service", {
  failureThreshold: 3,
  successThreshold: 2,
  timeout: 15_000,
});
```

---

## Resetting Breakers

### Via the admin API (recommended)

```
POST /api/v1/admin/circuit-breaker/:name/reset
Authorization: Bearer <admin-jwt>
```

Response:

```json
{ "success": true, "name": "stellar-rpc" }
```

Requires the `admin` role or admin API key scope (`src/routes/admin.routes.ts:90-108`). Protected by `adminAuthGuard`. A failed reset (breaker not found) returns `400` with safe error formatting.

The `resetBreaker` method in `registry.ts:71-87` also records an audit entry via `auditService.log()` with action `ADMIN_ACTION`, severity `INFO`, actor identifier, and resource type `circuit_breaker`.

### Programmatic reset (test/admin scripts only)

```ts
import { circuitBreakerRegistry } from "../circuit-breaker";

const ok = circuitBreakerRegistry.reset("stellar-rpc");
```

**Warning**: `reset()` forces the breaker back to CLOSED and clears all counters. Only use from authenticated admin endpoints or tests.

---

## Security Notes

| Concern | Mitigation |
| ------- | ---------- |
| Cascading failures | Circuit trips to OPEN after `failureThreshold` consecutive failures, halting further calls. |
| Error ambiguity | `CircuitOpenError` is a distinct typed class — callers can return 503 vs 500 correctly (see `src/circuit-breaker/errors.ts`). |
| Probe concurrency | `probeInFlight` flag prevents multiple simultaneous HALF_OPEN probes from resetting state (see `CircuitBreaker.ts:118-123`). |
| Admin reset | `reset()` exposes a force-close. The admin endpoint at `POST /api/v1/admin/circuit-breaker/:name/reset` is protected by `adminAuthGuard` (JWT admin role or API key scope). `resetBreaker()` logs an audit entry. |
| RPC endpoint | `STELLAR_RPC_URL` is read from environment — never hard-code production URLs in source. |
| X-Circuit-Name | The circuit name is exposed in error headers so ops can identify the failing upstream. The name itself is a simple identifier (e.g. `"stellar-rpc"`); no sensitive data is leaked. |

---

## Testing

All tests use mock transports — no real network calls:

```bash
npm test -- --coverage
```

Expected: ≥ 95% coverage on `src/circuit-breaker/*` and `src/rpc/stellarClient.ts`.

Key test scenarios:
- `CircuitBreaker.test.ts`: state transitions, threshold counting, probe concurrency, `CircuitOpenError` carries name, `getStats()` reflects current state
- `registry.test.ts`: singleton behaviour, `getAll()` returns `BreakerStatus` with config, `reset()` and `resetBreaker()` with audit logging, `clear()` for test isolation
- `stellarClient.test.ts`: breaker integration, `CircuitOpenError` propagation
- `admin.routes.test.ts`: authenticated access to status/reset endpoints, `404` for unknown breaker names
- `probes.test.ts`: `circuitBreakerProbe` returns degraded when any breaker is OPEN

---

## Cross-references

- **Soroban RPC integration**: `docs/backend/SOROBAN_RPC.md`
- **Registry source**: `src/circuit-breaker/registry.ts`
- **Breaker source**: `src/circuit-breaker/CircuitBreaker.ts`
- **Stellar client source**: `src/rpc/stellarClient.ts`
- **Admin routes**: `src/routes/admin.routes.ts`
- **Health probe**: `src/health/probes.ts` (`circuitBreakerProbe`)
