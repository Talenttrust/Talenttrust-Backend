# Health API Reference

The TalentTrust Backend exposes three read-only health endpoints. They are
registered directly on the Express app in `src/app.ts`; the readiness logic
lives in `HealthService` in `src/health.ts`.

| Endpoint | Purpose | Touches dependencies? | Source |
|---|---|---|---|
| `GET /health` | Service summary: version, uptime, pause state, last readiness checks | No (reads cached state only) | `src/app.ts` |
| `GET /health/live` | Liveness probe: "is the process up?" | No | `HealthService.live()` in `src/health.ts` |
| `GET /health/ready` | Readiness probe: "can this instance serve traffic?" | Yes: Soroban RPC + store (cached) | `HealthService.ready()` in `src/health.ts` |

All three are `GET` only. There is no `POST /health` route; any other method
on these paths gets `405 Method Not Allowed` from the app's generic handler
(`src/methods.ts`).
The endpoints are not authenticated and have no dedicated rate limiter.
Readiness is protected from probe storms by its result cache instead (see
[Caching and single-flight](#caching-and-single-flight)).

The machine-readable contract for these routes is in `src/openapi.ts` (schemas
`Health`, `Liveness`, `Readiness` and `HealthCheck`), served at
`GET /openapi.json`.

---

## GET /health/live

Liveness probe. `HealthService.live()` returns a constant and never calls the
RPC, the store or any other dependency, so a slow or broken dependency can
never make an orchestrator restart a healthy process.

| Status | Condition |
|---|---|
| `200 OK` | The process is up and the Express app is handling requests |

```json
{ "status": "ok" }
```

Schema (`Liveness`): exactly one property, `status`, always `"ok"`.

---

## GET /health/ready

Readiness probe. `HealthService.ready()` runs four checks **in parallel**, each
with its own timeout, and maps the aggregate result to an HTTP status.

### The four checks

| Key | What it does | `pass` when | `fail` detail (fixed strings) |
|---|---|---|---|
| `rpc` | Calls Soroban RPC `getHealth` | RPC reports `status: "healthy"` | `rpc reported '<status>'` |
| `network` | Calls RPC `getNetwork` and compares the passphrase with the configured one | Passphrases match exactly | `passphrase mismatch: configured '<STELLAR_NETWORK>', rpc reported '<passphrase>'`, or `no passphrase known for network '<name>' (set STELLAR_NETWORK_PASSPHRASE)` |
| `contract` | Calls RPC `getLedgerEntries` for the escrow contract's persistent instance ledger entry (`ESCROW_CONTRACT_ID`) | The ledger entry exists | `contract instance ledger entry not found` |
| `storage` | Calls `store.list()` on the in-memory `EscrowStore` | The call does not throw | `store read failed` |

Every check also has two generic failure details:

| Detail | Meaning |
|---|---|
| `timeout` | The check did not settle within `HEALTH_CHECK_TIMEOUT_MS` |
| `check raised` | The check threw (for example a network error talking to the RPC) |

Failure details are fixed strings by design. They never contain the RPC URL,
anything derived from it, or raw error messages, so a misconfigured
`STELLAR_RPC_URL` (which may embed a credential) cannot leak through a public
probe. This is covered by `tests/health.test.ts`.

The RPC client (`createSorobanRpcClient` in `src/health.ts`) loads
`@stellar/stellar-sdk` lazily: no RPC traffic happens until the first
`/health/ready` request.

### Status mapping

| `status` | HTTP | Condition |
|---|---|---|
| `ready` | `200 OK` | Every check is `pass` |
| `degraded` | `200 OK` | No check is `fail`, at least one is `warn` |
| `unready` | `503 Service Unavailable` | At least one check is `fail` |

All four checks are critical, so any single `fail` makes the instance
`unready`. The `warn` status and the `degraded` verdict are part of the
response contract, but none of the four current checks emits `warn`, so in
practice the probe answers `ready` (200) or `unready` (503). Treat `degraded`
as "serving, but look at it".

### Response body

Both 200 and 503 return the same `ReadinessReport` shape:

```ts
interface ReadinessReport {
  status: 'ready' | 'degraded' | 'unready';
  checks: Record<'rpc' | 'network' | 'contract' | 'storage', CheckResult>;
  checkedAt: string; // ISO-8601 time the checks ran (not the time of this request)
}

interface CheckResult {
  status: 'pass' | 'fail' | 'warn';
  latencyMs: number; // wall time of this check, >= 0
  detail?: string;   // present on failure only
}
```

Ready example:

```json
{
  "status": "ready",
  "checks": {
    "rpc":      { "status": "pass", "latencyMs": 84 },
    "network":  { "status": "pass", "latencyMs": 79 },
    "contract": { "status": "pass", "latencyMs": 112 },
    "storage":  { "status": "pass", "latencyMs": 0 }
  },
  "checkedAt": "2026-11-23T10:15:02.418Z"
}
```

Unready example (HTTP 503):

```json
{
  "status": "unready",
  "checks": {
    "rpc":      { "status": "fail", "latencyMs": 2001, "detail": "timeout" },
    "network":  { "status": "fail", "latencyMs": 2001, "detail": "timeout" },
    "contract": { "status": "fail", "latencyMs": 2001, "detail": "timeout" },
    "storage":  { "status": "pass", "latencyMs": 0 }
  },
  "checkedAt": "2026-11-23T10:15:02.418Z"
}
```

### Timeouts

Each check is raced against `HEALTH_CHECK_TIMEOUT_MS` (default `2000`). Because
checks run in parallel, a fully stuck RPC makes `/health/ready` answer in
roughly one timeout, not four. A timed-out check is reported as
`{ "status": "fail", "detail": "timeout" }`.

### Caching and single-flight

A completed report is cached for `HEALTH_CACHE_MS` (default `10000`):

- While the cache is fresh, every `/health/ready` request is answered from it
  without touching the RPC. `checkedAt` shows when the cached run happened.
- When the cache is stale, the first request starts a new run. Requests that
  arrive while that run is in flight wait for the **same** run instead of
  starting their own (single-flight), so N concurrent probes cost one set of
  RPC calls.
- Failed reports are cached too. After fixing a dependency, readiness can stay
  `unready` for up to `HEALTH_CACHE_MS`.

The cache is per process. Each instance or serverless invocation keeps its own.

### Configuration

| Variable | Default | Used for |
|---|---|---|
| `HEALTH_CHECK_TIMEOUT_MS` | `2000` | Per-check timeout (`config.healthCheckTimeoutMs`) |
| `HEALTH_CACHE_MS` | `10000` | Readiness result cache lifetime (`config.healthCacheMs`) |
| `STELLAR_RPC_URL` | `https://soroban-testnet.stellar.org` | RPC used by the `rpc`, `network` and `contract` checks |
| `STELLAR_NETWORK` | `testnet` | Network name; picks the expected passphrase |
| `STELLAR_NETWORK_PASSPHRASE` | Derived from `STELLAR_NETWORK` | Explicit expected passphrase for the `network` check |
| `ESCROW_CONTRACT_ID` | Built-in testnet contract | Contract whose instance entry the `contract` check looks up |

`HEALTH_CHECK_TIMEOUT_MS` and `HEALTH_CACHE_MS` are parsed by `envInt` in
`src/config.ts`. They must be positive integers; anything else (including `0`)
stops the process at startup with `Invalid <NAME>: "<value>"`.

`src/config.ts` resolves the expected passphrase as `STELLAR_NETWORK_PASSPHRASE`,
then the known passphrase for `STELLAR_NETWORK` (`testnet`, `mainnet`, `public`,
`futurenet`), then the **testnet** passphrase. An unrecognised
`STELLAR_NETWORK` therefore expects the testnet passphrase, and the `network`
check fails against any non-testnet RPC until `STELLAR_NETWORK_PASSPHRASE` is
set.

---

## GET /health

Service summary for dashboards and humans. It does **not** run the readiness
checks and never makes an RPC call on the request path, so it stays fast when
dependencies are down. Do not use it as a readiness probe: it answers 200 even
when `/health/ready` would answer 503.

### HTTP status codes

| Status | Condition |
|---|---|
| `200 OK` | Normal operation |
| `503 Service Unavailable` | The server is draining during graceful shutdown |

### 200 response body

```ts
{
  status:        'ok';
  version:       string;            // config.version
  uptimeSeconds: number;            // whole seconds since createApp()
  storage:       string;            // currently always "in-memory"
  paused:        boolean;           // last known pause state
  pauseSource:   'chain' | 'env' | 'none';
  timestamp:     string;            // ISO-8601 time of this response
  checks?:       Record<string, CheckResult>; // last readiness run, see below
}
```

| Field | Notes |
|---|---|
| `paused` / `pauseSource` | From `PauseGuard.peek()` in `src/pauseGuard.ts`. Non-blocking: returns the cached state and, if the cache is older than `PAUSE_CHECK_TTL_MS`, refreshes it in the background. `env` means the `API_PAUSED=true` override; `chain` means the contract's `is_paused()` returned true (or the RPC failed with `PAUSE_FAIL_MODE=closed`); `none` means not paused. With `PAUSE_CHECK_CHAIN=false` only the env override is consulted. |
| `checks` | The `checks` map of the most recent `/health/ready` run (`HealthService.lastReport()`). **Absent until `/health/ready` has run at least once** in this process. It does not trigger a run and may be stale. |

Example:

```json
{
  "status": "ok",
  "version": "1.0.0",
  "uptimeSeconds": 3721,
  "storage": "in-memory",
  "paused": false,
  "pauseSource": "none",
  "timestamp": "2026-11-23T10:15:04.002Z",
  "checks": {
    "rpc":      { "status": "pass", "latencyMs": 84 },
    "network":  { "status": "pass", "latencyMs": 79 },
    "contract": { "status": "pass", "latencyMs": 112 },
    "storage":  { "status": "pass", "latencyMs": 0 }
  }
}
```

### Draining (503)

On `SIGTERM` or `SIGINT`, `startServer()` in `src/server.ts` sets the app's
`draining` flag, stops accepting connections and waits up to
`SHUTDOWN_GRACE_MS` (default `10000`) for in-flight requests. While draining,
`GET /health` answers:

```http
HTTP/1.1 503 Service Unavailable
Connection: close
Content-Type: application/json

{ "status": "draining" }
```

Only `/health` reports draining. `/health/live` and `/health/ready` keep their
normal behaviour for as long as the process accepts requests.

---

## Choosing a probe

| Consumer | Endpoint | Why |
|---|---|---|
| Kubernetes `livenessProbe` | `/health/live` | Never fails because of a dependency, so no restart loops when the RPC is down |
| Kubernetes `readinessProbe` / load balancer target health | `/health/ready` | 503 takes the instance out of rotation when RPC, network, contract or store is broken |
| Uptime monitor, status page, on-call quick look | `/health` | Cheap; shows version, uptime, pause state and the last readiness result; 503 while draining |

Example Kubernetes configuration:

```yaml
livenessProbe:
  httpGet: { path: /health/live, port: 3001 }
  periodSeconds: 10
readinessProbe:
  httpGet: { path: /health/ready, port: 3001 }
  periodSeconds: 10
  timeoutSeconds: 5   # keep above HEALTH_CHECK_TIMEOUT_MS
```

Keep the probe's own timeout above `HEALTH_CHECK_TIMEOUT_MS` so the
orchestrator receives the 503 body instead of timing out itself.

---

## Source and tests

| Path | Contents |
|---|---|
| `src/health.ts` | `HealthService`, `CheckResult`, `ReadinessReport`, `createSorobanRpcClient` |
| `src/app.ts` | Route handlers for `/health`, `/health/live`, `/health/ready` |
| `src/server.ts` | Graceful shutdown and the `draining` flag |
| `src/pauseGuard.ts` | `PauseGuard.peek()` used for `paused` / `pauseSource` |
| `src/config.ts` | `HEALTH_CHECK_TIMEOUT_MS`, `HEALTH_CACHE_MS`, network and contract settings |
| `src/openapi.ts` | OpenAPI schemas for all three endpoints |
| `tests/health.test.ts` | Probe behaviour: status mapping, timeouts, single-flight, caching, no URL leaks |
| `tests/health-docs.test.ts` | Keeps this page and the runbook in sync with the source tree |

## Related

- [`docs/runbook-health.md`](runbook-health.md): troubleshooting failed probes
- [`docs/configuration.md`](configuration.md): all environment variables
- [`docs/observability.md`](observability.md): metrics and logging
