# Runbook: Health Subsystem

This runbook covers configuration, failure modes, alert thresholds, and
recovery steps for all health endpoints in `Talenttrust-Backend`.

**Audience:** On-call engineers, SREs, and DevOps  
**Last updated:** see git log  
**Related docs:** [`docs/health.md`](health.md) · [`docs/backend/bluegreen.md`](backend/bluegreen.md) · [`docs/backend/circuit-breaker.md`](backend/circuit-breaker.md)

---

## Table of contents

1. [Endpoint overview](#1-endpoint-overview)
2. [Configuration reference](#2-configuration-reference)
3. [Rate limiting](#3-rate-limiting)
4. [Probe reference](#4-probe-reference)
5. [Failure modes and recovery](#5-failure-modes-and-recovery)
6. [Alert thresholds](#6-alert-thresholds)
7. [Blue-green drain interaction](#7-blue-green-drain-interaction)
8. [Debugging checklist](#8-debugging-checklist)
9. [Source file map](#9-source-file-map)

---

## 1. Endpoint overview

| Endpoint | Method | Purpose | Source |
|---|---|---|---|
| `/health` | GET | Aggregate probe check — full dependency status | `src/health/router.ts` |
| `/health` | POST | Legacy liveness ping — no probes, always 200 | `src/routes/health.ts` |
| `/health/live` | GET | Blue-green liveness — process alive only | `src/health.ts` |
| `/health/ready` | GET | Blue-green readiness — traffic gating | `src/health.ts` |

All four routes are protected by the **health rate limiter** (see §3).  
All four set `Cache-Control: no-store` on responses.

### Quick status guide

| HTTP status | Meaning |
|---|---|
| `200` | Healthy / alive / ready |
| `400` | Bad request body or query params (validation error) |
| `429` | Rate limit exceeded — back off and retry |
| `503` | Not ready — dependency down or drain in progress |

---

## 2. Configuration reference

### Probe behaviour

| Variable | Default | Description |
|---|---|---|
| `NODE_ENV` | `development` | Set to `production` to strip `detail` fields from responses |
| `SERVICE_NAME` | `talenttrust-backend` | Service label in all health response bodies |
| `ACTIVE_COLOR` | `blue` | Blue-green slot label included in `/health/ready` responses |
| `REQUIRED_ENV_VARS` | `""` | Comma-separated list of env var names the `env` probe checks |
| `REDIS_HOST` | `localhost` | Redis hostname for the `redis` probe |
| `REDIS_PORT` | `6379` | Redis port for the `redis` probe |
| `REDIS_PASSWORD` | *(unset)* | Redis password for the `redis` probe (optional) |
| `STELLAR_RPC_URL` | *(unset)* | Soroban/Horizon RPC URL for the `stellar-rpc` probe |
| `QUEUE_PROBE_TIMEOUT_MS` | `3000` | Max ms the `queue` probe waits for queue health data |
| `QUEUE_FAILED_THRESHOLD` | `10` | Failed jobs per queue before `queue` probe reports `degraded` |
| `QUEUE_BACKLOG_THRESHOLD` | `100` | Waiting jobs per queue before `queue` probe reports `degraded` |

### Probe timeouts

| Probe | Timeout | Source |
|---|---|---|
| `db` | 3 000 ms | Hardcoded in `src/health/probes.ts` (`DB_PROBE_TIMEOUT_MS`) |
| `redis` | 3 000 ms | Hardcoded in `src/health/probes.ts` (`REDIS_PROBE_TIMEOUT_MS`) |
| `stellar-rpc` | 5 000 ms | Hardcoded in `src/health/probes.ts` (AbortController) |
| `queue` | `QUEUE_PROBE_TIMEOUT_MS` | Configurable, default 3 000 ms |
| `/health/ready` per-probe | 3 000 ms | Hardcoded in `src/health.ts` (`READY_PROBE_TIMEOUT_MS`) |

> **Note:** `/health/ready` wraps each probe in its own `withTimeout()` — the per-probe timeout (3 000 ms) is separate from the internal probe timeout. In practice they race and the lower value wins.

---

## 3. Rate limiting

All health routes are protected by a per-client sliding-window rate limiter.

**Key extraction** (`src/health/rateLimitKey.ts`):  
Priority: `X-API-Key` header → first IP in `X-Forwarded-For` → `req.ip` → socket address

**Algorithm:** sliding-window counter with exponential back-off abuse guard  
**Implementation:** `src/middleware/rateLimiter.ts`, `src/config/rateLimit.ts` (`health` tier)

### Configuration

| Variable | Default | Description |
|---|---|---|
| `RL_HEALTH_MAX` | `60` | Max requests per window per client |
| `RL_HEALTH_WINDOW_MS` | `60000` | Window duration in ms (1 minute) |
| `RL_HEALTH_ABUSE_THRESHOLD` | `10` | Violations before hard-block is applied |
| `RL_BLOCK_DURATION_MS` | `600000` | Initial hard-block duration (10 minutes) |
| `RL_MAX_BLOCK_MS` | `86400000` | Maximum hard-block duration (24 hours) |

### Response headers on every health request

| Header | Description |
|---|---|
| `X-RateLimit-Limit` | Configured cap (e.g. `60`) |
| `X-RateLimit-Remaining` | Requests left in current window |
| `X-RateLimit-Reset` | Seconds until window resets |

### 429 response body

```json
{
  "error": {
    "code": "rate_limited",
    "message": "Too many requests — please try again later",
    "requestId": "<uuid>"
  }
}
```

`Retry-After: <seconds>` is also set.

### Recovery from 429

1. Check if a monitoring agent or load-balancer probe is misconfigured and polling too fast.
2. Increase `RL_HEALTH_MAX` or `RL_HEALTH_WINDOW_MS` in the environment and restart.
3. If a client was hard-blocked (repeated violations), wait for `RL_BLOCK_DURATION_MS` to expire, or restart the service to clear in-memory state.

> **Multi-replica note:** The rate limiter uses an in-process `Map` store by default. Each replica maintains its own counter. Under a load balancer, a client can issue up to `RL_HEALTH_MAX × replicas` requests per window before any single replica throttles them. If consistent cross-replica enforcement is needed, configure a shared Redis store via `RATE_LIMIT_STORE_TYPE=redis` and `REDIS_URL`.

---

## 4. Probe reference

Probes are defined in `src/health/probes.ts` and used by `GET /health` (via `src/health/router.ts`) and `GET /health/ready` (via `src/health.ts`).

### `env` probe

Checks that every variable listed in `REQUIRED_ENV_VARS` exists in `process.env`.  
**Never exposes values.**

| Result | Condition |
|---|---|
| `up` | All listed variables are present (or list is empty) |
| `down` | One or more listed variables are missing |

**Failure detail:** `Missing vars: VAR_A, VAR_B`

**Recovery:** Set the missing environment variable(s) and restart the service.

---

### `db` probe

Runs `SELECT 1` against the SQLite database singleton (`src/db/database.ts`).

| Result | Condition |
|---|---|
| `up` | Query completes in < 1 000 ms |
| `degraded` | Query completes in 1 000 – 3 000 ms |
| `down` | Query takes ≥ 3 000 ms, times out, or throws |

**Relevant env vars:** `DB_PATH`, `DB_BUSY_TIMEOUT`

**Common failures:**

| Symptom | Likely cause | Recovery |
|---|---|---|
| `detail: "db probe timeout"` | DB file locked by another process, disk I/O saturation | Check for long-running transactions; check disk health |
| `detail: "SQLITE_CANTOPEN"` | `DB_PATH` is wrong or the file does not exist | Verify `DB_PATH`; check file permissions |
| `detail: "SQLITE_CORRUPT"` | Database file corruption | Restore from backup; see `docs/backend/database.md` |
| Degraded (slow) | High write contention, slow disk | Check `DB_BUSY_TIMEOUT`; consider increasing it |

---

### `redis` probe

Opens a short-lived Redis connection, sends `PING`, then disconnects.

| Result | Condition |
|---|---|
| `up` | PING succeeds within 3 000 ms |
| `down` | Connection refused, PING times out, or any error |

**Relevant env vars:** `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`

**Common failures:**

| Symptom | Likely cause | Recovery |
|---|---|---|
| `detail: "connect ECONNREFUSED"` | Redis not running or wrong host/port | Verify `REDIS_HOST`/`REDIS_PORT`; start Redis |
| `detail: "WRONGPASS"` | Wrong `REDIS_PASSWORD` | Correct the password env var |
| `detail: "Command timed out"` | Redis overloaded or network latency | Check Redis memory and CPU; check network path |

---

### `stellar-rpc` probe

Sends a lightweight `GET` to `STELLAR_RPC_URL`. Aborts after 5 000 ms.

| Result | Condition |
|---|---|
| `up` | HTTP status < 500 |
| `down` | `STELLAR_RPC_URL` not set, status ≥ 500, or request fails/times out |

**Relevant env vars:** `STELLAR_RPC_URL`

**Common failures:**

| Symptom | Likely cause | Recovery |
|---|---|---|
| `detail: "STELLAR_RPC_URL not set"` | Env var missing | Set `STELLAR_RPC_URL` and restart |
| `detail: "HTTP 503"` | Stellar/Soroban network maintenance | Monitor Stellar network status; no action needed if temporary |
| `detail: "fetch failed"` or `"ECONNREFUSED"` | Network partition or wrong URL | Check connectivity to the RPC host; verify URL |
| `detail: "This operation was aborted"` | Request timed out after 5 000 ms | Check latency to RPC host; consider a closer region |

---

### `queue` probe

Calls `QueueManager.getInstance().getHealth()` and checks failed/waiting job counts.

| Result | Condition |
|---|---|
| `up` | All queues within thresholds |
| `degraded` | At least one queue exceeds `QUEUE_FAILED_THRESHOLD` or `QUEUE_BACKLOG_THRESHOLD` |
| `down` | Health check times out or throws |

**Relevant env vars:** `QUEUE_PROBE_TIMEOUT_MS`, `QUEUE_FAILED_THRESHOLD`, `QUEUE_BACKLOG_THRESHOLD`

**Common failures:**

| Symptom | Likely cause | Recovery |
|---|---|---|
| `detail: "contract-processing: 15 failed jobs"` | Worker crash or upstream error | Check worker logs; inspect DLQ; replay or discard failed jobs |
| `detail: "contract-processing: 120 waiting jobs"` | Workers not consuming fast enough | Scale workers; check for blocking jobs |
| `detail: "queue probe timeout"` | BullMQ/Redis unresponsive | Check Redis; check `QUEUE_PROBE_TIMEOUT_MS` |

---

### `circuit-breaker` probe

Queries `circuitBreakerRegistry.getAll()` — no external I/O.

| Result | Condition |
|---|---|
| `up` | No breakers in `OPEN` state |
| `degraded` | One or more breakers open |
| `down` | Registry query throws |

**Common failures:**

| Symptom | Likely cause | Recovery |
|---|---|---|
| `detail: "2 breaker(s) open"` | Upstream dependency failing repeatedly | Identify the tripped breaker from service logs; fix the upstream; breaker auto-closes after `CB_TIMEOUT_MS` |

See `docs/backend/circuit-breaker.md` for breaker configuration.

---

## 5. Failure modes and recovery

### `/health/ready` returns 503 — `reason: "drain-in-progress"`

**Cause:** SIGTERM was received and graceful shutdown has started. `isReadinessDraining()` returns `true`.  
**Expected?** Yes — this is intentional during deployments and restarts.  
**Action:** No action needed. The load balancer will stop routing traffic to this instance. The 503 will clear when the process exits and a new process starts.

If 503 persists unexpectedly:
- Check if the process is stuck during shutdown (deadlocked drain).
- Check worker logs for `http_drain_timeout` or `bullmq_worker_timeout`.
- Force-kill the process: `kill -9 <pid>` (last resort — in-flight requests will be dropped).

---

### `/health/ready` returns 503 — dependency check failure

One or more probes in the `checks` array have `ok: false`.

1. Identify the failing probe from the `checks` array (or from `GET /health` for more detail).
2. Follow the recovery steps in §4 for the relevant probe.
3. Once the dependency recovers, `/health/ready` will return 200 automatically on the next poll — no restart needed.

---

### All health endpoints returning 429

The rate limiter has tripped for the requesting client.

1. Identify the client from logs — search for `rate_limited` at the health route.
2. Check if a monitoring agent is polling faster than `RL_HEALTH_MAX` / `RL_HEALTH_WINDOW_MS`.
3. If legitimate, increase `RL_HEALTH_MAX` in environment and restart.
4. If a hard-block was applied, the client must wait for `RL_BLOCK_DURATION_MS` (default 10 min) or the service must be restarted to clear in-memory state.

---

### `/health/live` returning non-200

`/health/live` has no dependency checks. A non-200 response means:
- The process is not running — the container/pod has crashed. Restart it.
- A middleware (e.g. security, request limits) is rejecting requests before they reach the handler. Check application startup logs.

---

### `GET /health` returning 503 but `/health/ready` returning 200

`GET /health` runs more probes than `/health/ready` (includes `env`, `queue`, `circuit-breaker`). One of those extra probes is failing. Check the `probes` array in the response body for the failing probe and follow §4.

---

## 6. Alert thresholds

Recommended monitoring rules (adapt to your alerting platform):

| Alert | Condition | Severity | Action |
|---|---|---|---|
| Health endpoint down | `/health/live` non-200 for > 30 s | Critical | Page on-call; restart service |
| Not ready | `/health/ready` 503 for > 2 min (outside deployment window) | High | Check dependency probes; see §4 |
| DB slow | `db` probe `status: "degraded"` for > 5 min | Medium | Check disk I/O, DB busy timeout |
| Queue degraded | `queue` probe `status: "degraded"` for > 10 min | Medium | Inspect failed jobs; check workers |
| Circuit breaker open | `circuit-breaker` probe `status: "degraded"` | Medium | Identify open breaker; fix upstream |
| Rate limit spike | `429` rate on `/health/*` > 10 req/min | Low | Identify polling client; tune `RL_HEALTH_MAX` |
| Stellar RPC down | `stellar-rpc` probe `status: "down"` for > 5 min | Medium | Check `STELLAR_RPC_URL`; monitor Stellar network |

---

## 7. Blue-green drain interaction

During a blue-green deployment (`npm run deploy:switch-green` or similar):

1. The router is updated to point traffic at the new color.
2. SIGTERM is sent to the old-color process.
3. `registerShutdownHandlers()` in `src/shutdown.ts` sets `draining = true`.
4. `isReadinessDraining()` returns `true`.
5. `/health/ready` immediately returns `503 { reason: "drain-in-progress" }` without running any probes.
6. The load balancer stops sending traffic to the old color.
7. The process finishes draining HTTP connections, webhook deliveries, and BullMQ workers, then exits.

**Expected log sequence during drain:**

```
shutdown_initiated
http_drained
webhook_deliveries_drained    (or webhook_drain_timeout + webhook_drain_flushed_to_dlq)
shutdown_drainers_drained     (if drain handlers registered)
bullmq_worker_closed
connection_closed
shutdown_complete
```

**If the process does not exit within the expected window** (`httpTimeoutMs` + `webhookDrainTimeoutMs` + `workerTimeoutMs`, each defaulting to 30 s):
- Check for stuck webhook deliveries: look for `webhook_drain_timeout` in logs.
- Check for stuck BullMQ jobs: look for `bullmq_worker_timeout`.
- Force-kill as a last resort.

See `docs/backend/bluegreen.md` for full deployment procedure.

---

## 8. Debugging checklist

**Service not passing readiness checks:**

- [ ] Run `curl http://localhost:PORT/health` and inspect the `probes` array.
- [ ] Run `curl http://localhost:PORT/health/ready` and inspect `checks`.
- [ ] Check `NODE_ENV` — in `production`, `detail` fields are stripped from responses; add a non-prod replica for diagnosis.
- [ ] Verify all required env vars with `curl http://localhost:PORT/health?verbose=true` in non-production.
- [ ] Check Redis connectivity: `redis-cli -h $REDIS_HOST -p $REDIS_PORT ping`.
- [ ] Check SQLite: `sqlite3 $DB_PATH "SELECT 1"`.
- [ ] Check `STELLAR_RPC_URL` reachability: `curl $STELLAR_RPC_URL`.
- [ ] Check queue health directly via BullMQ dashboard or `QueueManager.getHealth()`.

**Getting 429 on health endpoints:**

- [ ] Check `X-RateLimit-Remaining` on a successful response to see remaining headroom.
- [ ] Check `X-RateLimit-Reset` to see when the window resets.
- [ ] Identify the rate-limited client from application logs (`rate_limited`, `requestId`).
- [ ] Verify `RL_HEALTH_MAX` and `RL_HEALTH_WINDOW_MS` match your polling interval.

**Drain not completing:**

- [ ] Check for `webhook_drain_timeout` log event.
- [ ] Check for `bullmq_worker_timeout` log event.
- [ ] Check for long-running HTTP connections (kept-alive load balancer probes).
- [ ] Verify `WEBHOOK_DRAIN_TIMEOUT_MS` covers your p99 delivery latency.

---

## 9. Source file map

| File | Role |
|---|---|
| `src/health.ts` | `GET /health/live` and `GET /health/ready` router + rate limiter mount |
| `src/health/probes.ts` | All probe implementations (`env`, `db`, `redis`, `stellar-rpc`, `queue`, `circuit-breaker`) |
| `src/health/rateLimitKey.ts` | Per-client key extraction for the health rate limiter |
| `src/health/router.ts` | `GET /health` router — aggregates all probes |
| `src/health/checker.ts` | `runHealthCheck()` — runs probes concurrently and builds the response |
| `src/health/validation.ts` | Zod schemas for `POST /health` body and `GET /health` query params |
| `src/health/types.ts` | `ProbeResult` and `Probe` type definitions |
| `src/routes/health.ts` | `GET /health` and `POST /health` legacy routes + rate limiter |
| `src/config/rateLimit.ts` | All rate-limit tier configs including the `health` tier |
| `src/middleware/rateLimiter.ts` | `createRateLimiter()` — sliding-window middleware factory |
| `src/shutdown.ts` | `isReadinessDraining()`, `registerShutdownHandlers()` |
| `src/app.ts` | Mounts all health routers at `/health` |
