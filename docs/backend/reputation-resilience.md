# Reputation Upstream Resilience

> Reference documentation for the `ReputationClient` — retry with exponential
> backoff + jitter and per-dependency circuit breaker for the external
> reputation service.

## Overview

The reputation upstream client protects outbound HTTP calls to an external
reputation service from transient failures and cascading outages. It layers
**bounded retries** (exponential backoff with jitter) below a **per-dependency
circuit breaker** so that:

- A single transient blip (5xx, timeout, network error) is retried and never
  visible to callers.
- Persistent degradation trips the circuit, failing fast with a typed
  `upstream_unavailable` error instead of queuing up blocked requests.
- Non-retryable errors (4xx, validation) pass through without retry and do
  **not** count toward the breaker threshold.

| Layer          | Source                                         | Role                                                              |
| -------------- | ---------------------------------------------- | ----------------------------------------------------------------- |
| **Circuit breaker** | `src/circuit-breaker/CircuitBreaker.ts`   | Per-dependency state machine (CLOSED / OPEN / HALF\_OPEN)         |
| **Retry policy**    | `src/utils/retry.ts`                       | Bounded exponential backoff with jitter                           |
| **Client**          | `src/dependencies/reputationClient.ts`     | Upstream HTTP client wrapping both layers with typed errors       |
| **Config**          | `src/dependencies/reputationConfig.ts`     | Zod-validated environment configuration with safe defaults        |

---

## Retry policy

### Safe / idempotent operations (retried)

| Operation      | HTTP Method | Retried | Failure classification                                        |
| -------------- | ---------- | ------- | ------------------------------------------------------------- |
| `getProfile`   | GET        | Yes     | 5xx, 429, timeout, network error                              |
| `listProfiles` | GET        | Yes     | 5xx, 429, timeout, network error                              |

These operations are **idempotent** (repeated GETs are safe). Failures are
retried up to `REPUTATION_CLIENT_MAX_ATTEMPTS` with a growing backoff:

```
delay_n = min(maxDelay, baseDelay × 2ⁿ) × jitter
```

where `jitter ∈ [0.5, 1.0]` gives a ±50% randomisation band. The jitter
spread prevents thundering-herd synchronisation when many requests fail at
once.

### Non-idempotent operations (never retried)

| Operation      | HTTP Method | Retried | Rationale                                                              |
| -------------- | ---------- | ------- | ---------------------------------------------------------------------- |
| `createRating` | POST       | **No**  | Side-effectful — automatic retry would risk duplicate ratings.         |

Non-idempotent operations still pass through the circuit breaker: if the
breaker is OPEN the call fails immediately with `upstream_unavailable`, but
an upstream error is never retried — callers are expected to handle the
failure directly.

### Excluded failures (not retried, do not count toward breaker)

- **4xx (except 429)**: validation, auth, forged requests — will not heal on retry.
- **429**: considered retryable (rate-limit with backoff).
- **5xx**: server errors — transient by nature.

---

## Circuit breaker

States and transitions:

```
                 failures >= failure_threshold
  CLOSED  ───────────────────────────────────────────── OPEN
    ▲                                                      │
    │                                      cooldown elapsed │
    │                                                      ▼
    │            probe succeeds               HALF_OPEN
    └──────────────────────────────────────────────────────┘
                    ▲                                      │
                    │              probe fails             │
                    └──────────────────────────────────────┘
```

| State       | Behaviour                                                                 |
| ----------- | ------------------------------------------------------------------------- |
| `CLOSED`    | Calls go through. Only *retryable* failures count toward `failure_threshold`. |
| `OPEN`      | Calls fail immediately — no upstream request is made. Returns `UpstreamUnavailableError`. |
| `HALF_OPEN` | One probe call is allowed. Success → CLOSED. Failure → OPEN (cooldown restarts). |

**Key design decisions:**

- **Only retryable failures count.** A 400 does not open the breaker — only
  transient upstream errors (5xx, timeout, network) trip the threshold.
- **Per-dependency scoping.** The `"reputation"` breaker is independent from
  `"contracts"`, `"stellar-rpc"`, and webhook provider breakers. One
  unhealthy dependency never disables unrelated services.
- **Race-free HALF\_OPEN.** A `probeInFlight` gate prevents multiple
  concurrent requests from all becoming probes. Only one probe runs at a time.
- **No retry for non-idempotent POST.** `createRating` bypasses the retry
  loop entirely, so a duplicate rating cannot be created by automatic retry.

---

## Error handling

| Error class                | Code                      | HTTP status (when wired) | Meaning                                  |
| -------------------------- | ------------------------- | ------------------------ | ---------------------------------------- |
| `UpstreamUnavailableError` | `upstream_unavailable`    | 503                      | Circuit OPEN or retries exhausted        |
| `ReputationError`          | (typed by `status` field) | reflects upstream        | Non-retryable upstream error (4xx, etc.) |

`ReputationError` preserves the upstream HTTP status and parsed body for
logs; API-facing error serialisation is handled by the existing
`mapErrorToPayload` → safe error policy.

---

## Configuration

| Variable                                | Default                                | Range       | Purpose                         |
| --------------------------------------- | -------------------------------------- | ----------- | ------------------------------- |
| `REPUTATION_CLIENT_BASE_URL`            | `https://example.invalid/reputation`   | valid URL   | Upstream reputation service     |
| `REPUTATION_CLIENT_TIMEOUT_MS`          | `5000`                                 | 100–120000  | Per-request timeout             |
| `REPUTATION_CLIENT_MAX_ATTEMPTS`        | `3`                                    | 1–20        | Total attempts (incl. first)    |
| `REPUTATION_CLIENT_BASE_DELAY_MS`       | `200`                                  | 0–60000     | Initial backoff before jitter   |
| `REPUTATION_CLIENT_MAX_DELAY_MS`        | `5000`                                 | 0–60000     | Backoff cap                     |
| `REPUTATION_CLIENT_CB_FAILURE_THRESHOLD`| `5`                                    | 1–100       | Consecutive failures → OPEN     |
| `REPUTATION_CLIENT_CB_SUCCESS_THRESHOLD`| `1`                                    | 1–20        | Successes in HALF\_OPEN → CLOSED |
| `REPUTATION_CLIENT_CB_TIMEOUT_MS`       | `30000`                                | 1000–300000 | Cooldown before HALF\_OPEN probe |

All values are validated at startup via Zod (`loadReputationClientConfig`).
Invalid values (non-numeric, out of range, `maxDelay < baseDelay`) cause the
process to fail cleanly rather than silently using unexpected values.

---

## Observability

### Structured logs

The client emits Pino-compatible structured log records on these events:

| Event                                 | Level | Metadata                                                                     |
| ------------------------------------- | ----- | ---------------------------------------------------------------------------- |
| `reputation_client_retry_attempting`  | warn  | `operation`, `attempt_number`, `max_attempts`, `delay_ms`, `error`           |
| `reputation_client_retry_exhausted`   | error | `operation`, `max_attempts`, `final_status` or `error_message`               |
| `reputation_client_request_rejected`  | warn  | `operation`, `breaker_state: "OPEN"`, `reason`                               |

When wired into the global `circuitBreakerRegistry`, the breaker's state is
also visible through the existing admin and health endpoints:

- `GET /api/v1/admin/circuit-breakers` — lists all breakers, including `"reputation"`.
- `GET /health` — the `circuit-breaker` probe reports `degraded` when any
  breaker is OPEN (returning HTTP 503 at the load-balancer level).

### Prometheus metrics (future)

No dedicated Prometheus metrics are emitted today. If needed, add a gauge
for breaker state (`reputation_breaker_state{status="CLOSED|OPEN|HALF_OPEN"}`)
and a counter for retry attempts — following the existing
`webhookMetrics.ts` pattern.

---

## Testing

### Unit tests

All tests use an injectable `HttpTransport` — no real network calls. The
`CircuitBreaker`, `withRetry`, and `sleep` are also injectable for
deterministic timing.

Key scenarios (from `src/dependencies/reputationClient.test.ts`):

1. Transient failure → retry → success (breaker stays CLOSED).
2. N consecutive failures trip the breaker to OPEN.
3. OPEN circuit fails fast without upstream requests.
4. Cooldown transitions OPEN → HALF\_OPEN; probe success → CLOSED; probe
   failure → OPEN.
5. Concurrent HALF\_OPEN probes reject extra callers.
6. Non-retryable 4xx errors are not retried and do not count toward breaker.
7. Attempts never exceed `maxAttempts`; no sleep after last attempt.
8. Backoff grows exponentially, is capped, and jitter stays within [0.5×, 1.0×].
9. Successful request resets the consecutive-failure counter.
10. Independent dependency breakers — reputation OPEN doesn't affect others.
11. Normal success path unchanged.
12. Integration: factory + registry + real `withRetry`, fake transport.

### Running

```bash
npm test -- --testPathPattern="reputationClient"
```

---

## Security review

| Concern                                           | Mitigation                                                                        |
| ------------------------------------------------- | --------------------------------------------------------------------------------- |
| Can retries duplicate a non-idempotent operation? | No — `createRating` (POST) never retries.                                         |
| Can concurrent requests bypass the breaker?       | No — `probeInFlight` gate prevents concurrent HALF\_OPEN probes.                  |
| Can multiple requests all become HALF\_OPEN?      | No — only one probe at a time; concurrency rejected with `UpstreamUnavailableError`. |
| Can failure counters race?                        | No — `CircuitBreaker` is synchronous (async fn execution is serial per call).     |
| Can successful request leave breaker OPEN?        | No — success always resets `failureCount` and in HALF\_OPEN closes the circuit.   |
| Can breaker remain OPEN forever?                  | No — cooldown `timeout` ensures transition to HALF\_OPEN.                         |
| Can retry delays grow unbounded?                  | No — capped at `maxDelayMs`.                                                      |
| Can malformed config create danger?               | No — Zod validation rejects invalid values at startup.                            |
| Can upstream internals leak through errors/logs?  | No — log metadata is structured and safe; raw responses not logged.               |
| Can one dep's breaker affect another?             | No — per-dependency breaker via registry; independent instances.                  |
| Do non-retryable failures count toward breaker?   | No — `recordFailure` predicate excludes 4xx from threshold and probe failure.     |

---

## Cross-references

- **Circuit breaker documentation**: `docs/backend/circuit-breaker.md`
- **Retry utilities**: `src/utils/retry.ts`
- **Contracts client** (same resilience pattern): `src/dependencies/contractsClient.ts`
- **Reputation runbook**: `docs/runbook-reputation.md`
- **Safe error policy**: `src/errors/safeErrors.ts`