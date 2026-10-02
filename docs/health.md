# Health API Reference

The TalentTrust Backend exposes three health endpoints, all mounted under `/health`.
Together they serve load-balancer readiness checks, blue-green deployment orchestration,
and integration-level dependency diagnostics.

| Endpoint | Purpose | Source |
|---|---|---|
| `GET /health` | Aggregate dependency-probe check | `src/health/router.ts` |
| `POST /health` | Legacy liveness ping | `src/routes/health.ts` |
| `GET /health/live` | Blue-green liveness probe | `src/health.ts` |
| `GET /health/ready` | Blue-green readiness probe | `src/health.ts` |

---

## GET /health

Full dependency-probe check. Runs all registered probes concurrently and returns
an aggregated health verdict. The HTTP status code reflects overall health so
load balancers can act on it without parsing the body.

**Handler**: `src/health/router.ts` → `buildHealthRouter()`  
**Checker**: `src/health/checker.ts` → `runHealthCheck()`  
**Probes**: `src/health/probes.ts`

### Response headers

| Header | Value |
|---|---|
| `Cache-Control` | `no-store` (always set) |
| `Content-Type` | `application/json` |

### HTTP status codes

| Status | Condition |
|---|---|
| `200 OK` | All probes returned `status: "up"` or `ok: true` |
| `503 Service Unavailable` | One or more probes returned `status: "degraded"` or `status: "down"` |

### Response body

```ts
{
  status:        "ok" | "degraded";  // aggregate verdict
  service:       string;             // always "talenttrust-backend"
  timestamp:     string;             // ISO-8601 time of the check
  uptimeSeconds: number;             // process.uptime() in whole seconds
  probes:        ProbeResult[];      // one entry per registered probe
}
```

Each `ProbeResult`:

```ts
{
  name:      string;                         // probe identifier
  ok?:       boolean;                        // true when status is "up"
  status?:   "up" | "degraded" | "down";    // canonical health status
  detail?:   string;                         // error text or latency note (non-production only)
  latencyMs: number;                         // probe round-trip in milliseconds
}
```

> **Production security**: when `NODE_ENV=production` the `detail` field is
> stripped from every probe before the response is sent, preventing internal
> topology leakage to unauthenticated callers. `name`, `ok`, and `latencyMs`
> are always present.

### Example — healthy (200)

```bash
curl http://localhost:3001/health
```

```json
{
  "status": "ok",
  "service": "talenttrust-backend",
  "timestamp": "2026-07-24T12:49:31.799Z",
  "uptimeSeconds": 3721,
  "probes": [
    { "name": "env",            "ok": true,  "status": "up",   "latencyMs": 0  },
    { "name": "db",             "ok": true,  "status": "up",   "latencyMs": 3  },
    { "name": "redis",          "ok": true,  "status": "up",   "latencyMs": 11 },
    { "name": "stellar-rpc",    "ok": true,  "status": "up",   "latencyMs": 87 },
    { "name": "queue",          "ok": true,  "status": "up",   "latencyMs": 5  },
    { "name": "circuit-breaker","ok": true,  "status": "up",   "latencyMs": 0  }
  ]
}
```

### Example — degraded (503)

```json
{
  "status": "degraded",
  "service": "talenttrust-backend",
  "timestamp": "2026-07-24T12:49:31.799Z",
  "uptimeSeconds": 3721,
  "probes": [
    { "name": "env",            "ok": true,  "status": "up",       "latencyMs": 0    },
    { "name": "db",             "ok": false, "status": "down",     "latencyMs": 5001, "detail": "db probe timeout" },
    { "name": "redis",          "ok": true,  "status": "up",       "latencyMs": 9    },
    { "name": "stellar-rpc",    "ok": true,  "status": "up",       "latencyMs": 90   },
    { "name": "queue",          "ok": false, "status": "degraded", "latencyMs": 12,   "detail": "contract-processing: 15 failed jobs" },
    { "name": "circuit-breaker","ok": true,  "status": "up",       "latencyMs": 0    }
  ]
}
```

---

## POST /health

Legacy liveness endpoint included for backwards compatibility with older clients
and monitoring scripts that use POST. Returns the same static payload regardless
of dependency state — it does **not** run probes.

**Handler**: `src/routes/health.ts`

### HTTP status codes

| Status | Condition |
|---|---|
| `200 OK` | Always |

### Response body

```json
{
  "status": "ok",
  "service": "talenttrust-backend"
}
```

### Example

```bash
curl -X POST http://localhost:3001/health
```

```json
{ "status": "ok", "service": "talenttrust-backend" }
```

---

## GET /health/live

Lightweight liveness probe for blue-green deployments. Only checks that the
process is running — no dependency probes are executed. Use this as a container
or load-balancer liveness check that should almost never fail.

**Handler**: `src/health.ts` → `healthRouter`

### HTTP status codes

| Status | Condition |
|---|---|
| `200 OK` | Always (process is alive) |

### Response headers

| Header | Value |
|---|---|
| `Cache-Control` | `no-store` |

### Response body

```ts
{
  status:  "ok";
  service: string;   // SERVICE_NAME env var, defaults to "talenttrust-backend"
  probe:   "live";
}
```

### Example

```bash
curl http://localhost:3001/health/live
```

```json
{
  "status": "ok",
  "service": "talenttrust-backend",
  "probe": "live"
}
```

---

## GET /health/ready

Readiness probe for blue-green deployments. Runs three dependency probes
(db, stellar-rpc, redis) concurrently with a 3-second per-probe timeout and
returns a traffic-gating verdict. Use this probe to control whether a slot
should receive traffic during a deployment or drain.

**Handler**: `src/health.ts` → `healthRouter`  
**Probes run**: `dbProbe`, `stellarRpcProbe`, `redisProbe` (from `src/health/probes.ts`)

### HTTP status codes

| Status | Condition |
|---|---|
| `200 OK` | All three dependency probes returned `ok: true` |
| `503 Service Unavailable` | Any probe failed, timed out, or drain is in progress |

### Response headers

| Header | Value |
|---|---|
| `Cache-Control` | `no-store` |

### Response body — ready (200)

```ts
{
  status:      "ready";
  service:     string;          // SERVICE_NAME env var
  probe:       "ready";
  activeColor: "blue" | "green"; // ACTIVE_COLOR env var, defaults to "blue"
  checks:      CheckSnapshot[]; // one entry per probe (db, stellar-rpc, queue)
}
```

Each `CheckSnapshot`:

```ts
{
  name:      string;   // "db" | "stellar-rpc" | "queue"
  ok:        boolean;
  latencyMs: number;
  detail?:   string;   // error message (non-production only)
}
```

> **Note**: the `checks` array labels the redis probe as `"queue"` in the
> current implementation (`src/health.ts`). This is a known naming quirk —
> it reflects a past mapping of the redis probe to the queue slot.

### Response body — not ready (503, dependency failure)

```ts
{
  status:      "not-ready";
  service:     string;
  probe:       "ready";
  activeColor: string;
  checks:      CheckSnapshot[];
}
```

### Response body — not ready (503, drain in progress)

```ts
{
  status:      "not-ready";
  service:     string;
  probe:       "ready";
  reason:      "drain-in-progress";
  activeColor: string;
}
```

> When `isReadinessDraining()` returns `true` (set during graceful shutdown),
> the probe immediately returns 503 with `reason: "drain-in-progress"` without
> running any dependency probes. This is how the service signals to the load
> balancer that it should stop sending new requests.

### Example — ready (200)

```bash
curl http://localhost:3001/health/ready
```

```json
{
  "status": "ready",
  "service": "talenttrust-backend",
  "probe": "ready",
  "activeColor": "blue",
  "checks": [
    { "name": "db",          "ok": true, "latencyMs": 3  },
    { "name": "stellar-rpc", "ok": true, "latencyMs": 90 },
    { "name": "queue",       "ok": true, "latencyMs": 11 }
  ]
}
```

### Example — not ready, db down (503)

```json
{
  "status": "not-ready",
  "service": "talenttrust-backend",
  "probe": "ready",
  "activeColor": "blue",
  "checks": [
    { "name": "db",          "ok": false, "latencyMs": 3001, "detail": "db probe timeout" },
    { "name": "stellar-rpc", "ok": true,  "latencyMs": 88   },
    { "name": "queue",       "ok": true,  "latencyMs": 12   }
  ]
}
```

### Example — drain in progress (503)

```json
{
  "status": "not-ready",
  "service": "talenttrust-backend",
  "probe": "ready",
  "reason": "drain-in-progress",
  "activeColor": "blue"
}
```

---

## Probes reference

All probes are defined in `src/health/probes.ts`.

### `env`

Verifies that every variable listed in `REQUIRED_ENV_VARS` exists in the
process environment. Does **not** expose values — only checks for presence.

| State | Condition |
|---|---|
| `up` | All listed vars are set (or list is empty) |
| `down` | One or more listed vars are missing |

**Configuration:**

| Variable | Default | Description |
|---|---|---|
| `REQUIRED_ENV_VARS` | `""` | Comma-separated list of env var names that must exist |

### `db`

Verifies SQLite connectivity by running a hardcoded `SELECT 1` query through
the shared `getDb()` singleton. No user input is involved.

| State | Condition |
|---|---|
| `up` | Query completes in < 1 000 ms |
| `degraded` | Query completes between 1 000 ms and 3 000 ms |
| `down` | Query takes ≥ 3 000 ms, times out, or throws |

**Configuration:**

| Variable | Default | Description |
|---|---|---|
| `DB_PATH` | `talenttrust.db` | Path to the SQLite file |
| `DB_BUSY_TIMEOUT` | `5000` | SQLite busy timeout in ms |

### `redis`

Tests Redis reachability by opening a short-lived connection and sending a
`PING` command. Disconnects immediately after.

| State | Condition |
|---|---|
| `up` | PING succeeds within 3 000 ms |
| `down` | Connection fails, PING times out, or any error occurs |

**Configuration:**

| Variable | Default | Description |
|---|---|---|
| `REDIS_HOST` | `localhost` | Redis hostname |
| `REDIS_PORT` | `6379` | Redis port |
| `REDIS_PASSWORD` | *(unset)* | Redis password (optional) |

### `stellar-rpc`

Checks reachability of the Stellar/Soroban RPC endpoint with a lightweight
`GET` request. Aborts after 5 seconds.

| State | Condition |
|---|---|
| `up` | HTTP response status < 500 |
| `down` | `STELLAR_RPC_URL` is not set, response status ≥ 500, or request fails/times out |

**Configuration:**

| Variable | Default | Description |
|---|---|---|
| `STELLAR_RPC_URL` | *(unset)* | Soroban/Horizon RPC base URL to probe |

### `queue`

Checks BullMQ job-queue health via `QueueManager.getHealth()`. Reports
`degraded` when failed-job or waiting-backlog counts exceed configurable
thresholds; reports `down` on timeout or internal error.

| State | Condition |
|---|---|
| `up` | No queue exceeds the failed or backlog thresholds |
| `degraded` | At least one queue has too many failed or waiting jobs |
| `down` | Health check times out or throws |

**Configuration:**

| Variable | Default | Description |
|---|---|---|
| `QUEUE_PROBE_TIMEOUT_MS` | `3000` | Max time (ms) to wait for queue health data |
| `QUEUE_FAILED_THRESHOLD` | `10` | Max failed jobs per queue before `degraded` |
| `QUEUE_BACKLOG_THRESHOLD` | `100` | Max waiting jobs per queue before `degraded` |

### `circuit-breaker`

Reports the count of circuit breakers currently in the `OPEN` state by
querying `circuitBreakerRegistry.getAll()`. No external I/O is performed.

| State | Condition |
|---|---|
| `up` | No breakers are open |
| `degraded` | One or more breakers are open |
| `down` | Registry query throws |

---

## Security notes

- `Cache-Control: no-store` is set on all responses to prevent stale health
  data from being served by caches or proxies.
- `detail` fields are stripped from `GET /health` and `GET /health/ready`
  responses when `NODE_ENV=production`, preventing internal error messages,
  hostnames, and latency thresholds from reaching unauthenticated callers.
- The `env` probe checks variable existence only — it never includes values.
- The `db` probe runs a hardcoded `SELECT 1` with no user input, making SQL
  injection impossible.
- The `stellar-rpc` probe performs outbound HTTP; the target URL is controlled
  by `STELLAR_RPC_URL` which is validated at startup by the config schema.

---

## Configuration summary

| Variable | Default | Relevant probes |
|---|---|---|
| `NODE_ENV` | `development` | All — strips `detail` in `production` |
| `REQUIRED_ENV_VARS` | `""` | `env` |
| `DB_PATH` | `talenttrust.db` | `db` |
| `DB_BUSY_TIMEOUT` | `5000` | `db` |
| `REDIS_HOST` | `localhost` | `redis` |
| `REDIS_PORT` | `6379` | `redis` |
| `REDIS_PASSWORD` | *(unset)* | `redis` |
| `STELLAR_RPC_URL` | *(unset)* | `stellar-rpc` |
| `QUEUE_PROBE_TIMEOUT_MS` | `3000` | `queue` |
| `QUEUE_FAILED_THRESHOLD` | `10` | `queue` |
| `QUEUE_BACKLOG_THRESHOLD` | `100` | `queue` |
| `SERVICE_NAME` | `talenttrust-backend` | `GET /health/live`, `GET /health/ready` |
| `ACTIVE_COLOR` | `blue` | `GET /health/ready` |

---

## Related documentation

- [`docs/backend/health.md`](backend/health.md) — earlier overview (env and stellar-rpc probes)
- [`docs/backend/circuit-breaker.md`](backend/circuit-breaker.md) — circuit breaker states and configuration
- [`docs/backend/bluegreen.md`](backend/bluegreen.md) — blue-green deployment and drain signalling
- [`docs/backend/database.md`](backend/database.md) — SQLite schema and configuration
- [`docs/backend/queue-system.md`](backend/queue-system.md) — BullMQ queue configuration
