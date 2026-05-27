# Circuit Breaker for RPC Failures

> Reference documentation for the TalentTrust circuit-breaker module.

## Overview

The circuit breaker protects the backend from cascading failures when an upstream service (Stellar/Soroban RPC, Horizon API) degrades. Instead of queuing up blocked requests, calls fail fast with a typed `CircuitOpenError` so the API can return `503` immediately.

---

## State Machine

```
CLOSED ──(consecutive failures ≥ threshold)──► OPEN
OPEN   ──(timeout elapsed)                  ──► HALF_OPEN
HALF_OPEN ──(probe succeeds ≥ successThreshold)──► CLOSED
HALF_OPEN ──(probe fails)                   ──► OPEN
```

| State       | Behaviour                                                                    |
| ----------- | ---------------------------------------------------------------------------- |
| `CLOSED`    | Normal. Failures are counted.                                                |
| `OPEN`      | Fails fast — throws `CircuitOpenError` immediately without calling upstream. |
| `HALF_OPEN` | One probe call is allowed through. Success → CLOSED, failure → OPEN.         |

---

## Configuration

`CircuitBreaker` accepts an options object:

| Option             | Default     | Description                                            |
| ------------------ | ----------- | ------------------------------------------------------ |
| `failureThreshold` | `5`         | Consecutive failures before tripping to OPEN           |
| `successThreshold` | `1`         | Consecutive successes in HALF_OPEN before closing      |
| `timeout`          | `30_000`    | Milliseconds in OPEN before transitioning to HALF_OPEN |
| `name`             | `'default'` | Label used in error messages and logs                  |

The `StellarClient` singleton reads `STELLAR_RPC_URL` from the environment:

| Environment variable | Default                               | Description                       |
| -------------------- | ------------------------------------- | --------------------------------- |
| `STELLAR_RPC_URL`    | `https://soroban-testnet.stellar.org` | Stellar/Soroban JSON-RPC endpoint |

---

## API

### `CircuitBreaker`

```ts
import { CircuitBreaker, CircuitOpenError } from "./circuit-breaker";

const breaker = new CircuitBreaker({
  name: "stellar-rpc",
  failureThreshold: 3,
});

try {
  const result = await breaker.execute(() => fetchFromStellar());
} catch (err) {
  if (err instanceof CircuitOpenError) {
    res.status(503).set("Retry-After", "30").json({ error: err.message });
  }
}
```

| Method        | Returns                             | Description                                    |
| ------------- | ----------------------------------- | ---------------------------------------------- |
| `execute(fn)` | `Promise<T>`                        | Runs `fn` or throws `CircuitOpenError` if OPEN |
| `getState()`  | `'CLOSED' \| 'OPEN' \| 'HALF_OPEN'` | Current state                                  |
| `getStats()`  | `CircuitStats`                      | State + counters snapshot                      |
| `reset()`     | `void`                              | Force back to CLOSED (admin/test use only)     |

### `StellarClient`

```ts
import { stellarClient } from "./rpc/stellarClient";

const response = await stellarClient.call({ method: "getLatestLedger" });
const stats = stellarClient.getCircuitStats();
```

---

## Ops Endpoint

```
GET /api/v1/circuit-breaker/status
```

Returns current circuit state and counters:

```json
{
  "circuitBreaker": {
    "state": "CLOSED",
    "failureCount": 0,
    "successCount": 0,
    "lastFailureTime": null
  }
}
```

Use this in monitoring dashboards and alerting rules.

---

## HTTP Error Responses

When the circuit is OPEN, routes that call upstream services should return:

```
HTTP 503 Service Unavailable
Retry-After: 30
Content-Type: application/json

{ "error": "Circuit \"stellar-rpc\" is OPEN — call rejected to protect upstream." }
```

---

## Security Notes

| Concern            | Mitigation                                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------------- |
| Cascading failures | Circuit breaker trips to OPEN after `failureThreshold` consecutive failures, halting further calls. |
| Error ambiguity    | `CircuitOpenError` is a distinct typed class — callers can return 503 vs 500 correctly.             |
| Probe concurrency  | `probeInFlight` flag prevents multiple simultaneous probes from all resetting the failure count.    |
| Admin reset        | `reset()` exposes a force-close. Protect any API endpoint that calls this behind authentication.    |
| RPC endpoint       | `STELLAR_RPC_URL` is read from environment — never hard-code production URLs in source.             |

---

## Testing

All tests use mock transports — no real network calls:

```bash
npm test -- --coverage
```

Expected: ≥ 95% coverage on `src/circuit-breaker/*` and `src/rpc/stellarClient.ts`.
