# Metrics Subsystem — Operations Runbook

## Overview

This runbook covers the Prometheus metrics subsystem for the Talenttrust-Backend
service. It is intended for operators, SREs, and on-call engineers who need to
diagnose, restore, or configure metrics collection.

Related documentation:
- [Observability Metrics Catalog](./observability.md) — full metric catalogue, label semantics, SLOs
- [Configuration Reference](./configuration.md) — environment variable reference

---

## Architecture

```
┌──────────────┐     trackHttpRequest()      ┌──────────────────┐
│  Express App  │ ──────────────────────────▶  │  MetricsService  │
│  (app.ts)     │                              │  (own Registry)  │
└──────────────┘                              └────────┬─────────┘
       │                                                │
       │  res.on('finish')                              │ getMetrics()
       │  records:                                      │
       │   • http_requests_total                        ▼
       │   • http_request_duration_seconds    ┌──────────────────┐
       │                                      │  /metrics        │
       │                                      │  (NOT WIRED)     │
       ▼                                      └──────────────────┘
┌──────────────────────────┐
│  Other Registries        │
│                          │
│  • default register      │  ← contractMetadata.ts, events/idempotency.ts
│  • webhookDlqRegistry    │  ← utils/webhookMetrics.ts
│  • webhookMetrics()      │  ← webhookDelivery.ts
└──────────────────────────┘
```

**Key architectural points:**
- `MetricsService` uses its own `Registry` — not the default prom-client register.
- `getMetrics()` returns only that registry's metrics.
- Multiple modules register on other registries (default register, isolated
  registries). These are **not** included in the `/metrics` output.
- The `/metrics` HTTP endpoint is **not wired up** in production route
  registration (see [Known Issue: Missing `/metrics` Endpoint](#known-issue-missing-metrics-endpoint)).

---

## Configuration

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `PORT` | `3001` | No | Server port (affects metrics scrape URL) |
| `SERVICE_NAME` | `talenttrust-backend` | No | Used as health-check label and `collectDefaultMetrics` prefix |
| `METRICS_ENABLED` | `true` | No | Whether to enable metrics export |
| `METRICS_AUTH_TOKEN` | (unset) | Production | Bearer token protecting the `/metrics` endpoint |
| `HTTP_METRICS_ROUTE_LABEL_LIMIT` | `100` | No | Max distinct route labels before collapsing to `"other"` |
| `DLQ_METRICS_INTERVAL_MS` | `30000` | No | Interval for DLQ depth sampling |

---

## Collecting Metrics

### Prometheus Scrape Configuration

```yaml
scrape_configs:
  - job_name: talenttrust-backend
    metrics_path: /metrics
    static_configs:
      - targets: ['localhost:3001']
    authorization:
      type: Bearer
      credentials: ${METRICS_AUTH_TOKEN}
    scrape_interval: 15s
    scrape_timeout: 10s
```

### Manual Verification

```bash
# Without auth (dev only):
curl http://localhost:3001/metrics

# With auth:
curl -H "Authorization: Bearer $METRICS_AUTH_TOKEN" \
  http://localhost:3001/metrics
```

**Note:** These commands will return `404` until the `/metrics` route is
registered (see [Known Issue](#known-issue-missing-metrics-endpoint)).

---

## Known Issue: Missing `/metrics` Endpoint

### Symptom

`GET /metrics` returns HTTP `404 Not Found`.

### Root Cause

The `metricsAuthMiddleware` and `MetricsService.getMetrics()` are fully
implemented and tested, but the Express route registration

```ts
app.get('/metrics', metricsAuthMiddleware, async (req, res) => { ... });
```

is **absent** from `src/app.ts` and `src/index.ts`.

### Workaround

Metrics can still be retrieved programmatically:

```ts
import { MetricsService } from './observability/metrics-service';

const service = new MetricsService('talenttrust-backend');
const metrics = await service.getMetrics();
console.log(metrics);
```

Or scraped via a custom endpoint (e.g., a health-check handler that calls
`getMetrics()` internally).

### Resolution

Add the route in `src/app.ts` after line 77 (`app.use(httpLoggerMiddleware)`):

```ts
app.get('/metrics', metricsAuthMiddleware, async (_req, res) => {
  const metrics = await metricsService.getMetrics();
  res.set('Content-Type', metricsService.contentType);
  res.end(metrics);
});
```

---

## Common Failure Scenarios

### 1. All `http_requests_total` values show `route="unmatched"`

**Symptom:** Every request recorded under the `"unmatched"` label.

**Cause:** The `trackHttpRequest` middleware runs before Express route matching.
`req.route` is `undefined` because the middleware is registered before routes.

**Check:**
```bash
# Query for unmatched routes
curl -s http://localhost:3001/metrics | grep 'http_requests_total.*unmatched'
```

**Fix:** Ensure `trackHttpRequest` middleware is placed **after** all route
registrations in the middleware chain, or at least after the routes it should
track. In `app.ts` (line 77), it is registered before routes (lines 85–94),
which is correct — routes are mounted after middleware. Verify no middleware
calls `next()` before routes are matched.

If the issue persists, check that `app.use(metricsService.trackHttpRequest.bind(metricsService))`
is placed before the routes but after `express.json()` and other preprocessing
middleware.

---

### 2. New routes silently recorded as `route="other"`

**Symptom:** After deploying a new endpoint, all traffic appears under
`route="other"`. Previously known routes continue to appear normally.

**Cause:** `HTTP_METRICS_ROUTE_LABEL_LIMIT` (default 100) has been reached.
The `boundRouteLabel` method (line 205 of `metrics-service.ts`) caps unique
route labels and assigns any new routes to the `"other"` bucket.

**Check:**
```bash
# Count distinct route labels currently tracked
curl -s http://localhost:3001/metrics | \
  grep 'http_requests_total{' | \
  sed 's/.*route="\([^"]*\)".*/\1/' | \
  sort -u | wc -l
```

**Fix:**
1. Increase `HTTP_METRICS_ROUTE_LABEL_LIMIT` in the environment.
2. Or reduce route cardinality by consolidating Express route templates.

---

### 3. Metrics show zero observations for a known endpoint

**Symptom:** Certain routes never appear in `http_requests_total` or
`http_request_duration_seconds`.

**Causes and checks:**

**a) Middleware ordering.** Verify the `trackHttpRequest` middleware runs for
the route. Check that:
- No middleware short-circuits (returns early without `next()`).
- The route is registered after the middleware.

**b) Route template mismatch.** Express nested routers produce compound route
paths via `req.baseUrl + req.route.path`. Verify the actual path pattern:
```ts
// Add temporary debug logging in metrics-service.ts extractRoute()
console.log('baseUrl:', req.baseUrl, 'routePath:', req.route?.path);
```

**c)** The route may be served by a different service instance (load balancer
sticky-session issue).

---

### 4. Metrics endpoint returns empty response (no metrics at all)

**Symptom:** `GET /metrics` returns `200 OK` with an empty body.

**Cause:** The `MetricsService` registry is empty or `getMetrics()` resolved
to an empty string. This can happen if:
- The `MetricsService` was instantiated but never used (no requests processed).
- A custom registry was passed but no metrics were registered on it.

**Check:**
```bash
curl -v http://localhost:3001/metrics  # Check Content-Type header
```

If `Content-Type` is missing or wrong, the `MetricsService` constructor may
have thrown during metric registration.

**Fix:** Ensure `MetricsService` is created with the default registry or a
properly configured one. Verify no `Error: Cannot register metric twice`
appears in application logs.

---

### 5. Webhook metrics missing or stale

**Symptom:** `webhook_deliveries_total`, `webhook_dlq_depth`, or
`webhook_rate_limit_*` metrics are absent or show outdated values.

**Causes:**

**a) Multiple registries.** Webhook metrics are registered on different
registries than `MetricsService`:
- `webhook_delivery_attempts_total` etc. → `webhookMetrics.ts` (accepted
  registry or default register)
- `webhook_dlq_operations_total` → `utils/webhookMetrics.ts` (isolated
  `webhookDlqRegistry`)
- `webhook_deliveries_total` → `MetricsService` registry

Only the `MetricsService` registry is returned by `getMetrics()`.

**Check:**
```ts
// In a Node REPL or test:
import { register } from 'prom-client';
const metrics = await register.getMetricsAsJSON();
console.log(metrics.map(m => m.name));
```

**Fix:** Either consolidate all metrics onto a single registry, or expose
multiple scrape targets for each registry.

**b) Rate-limit sampling not started.** `webhook_rate_limit_tokens` and
`webhook_rate_limit_queue_depth` are only populated when
`startRateLimitMetricsSampling()` is called. Check that the rate limiter
initialization code calls this method.

**Check:**
```bash
curl -s http://localhost:3001/metrics | grep webhook_rate_limit
```

If empty, verify `startRateLimitMetricsSampling()` is called during app
startup.

---

### 6. `service_health_status` stuck at `2` (up) despite problems

**Symptom:** Health gauge never transitions to `degraded` or `down`.

**Cause:** `recordHealthStatus()` is never called, or the health-check logic
is not wired to update the gauge.

**Check:**
- Search for calls to `recordHealthStatus()` in the codebase.
- Verify the health-check service or controller invokes it.

**Fix:** Wire the health-check evaluation loop to call
`metricsService.recordHealthStatus()` whenever status changes.

---

### 7. Duplicate metric registration errors

**Symptom:** Application logs show `Error: Cannot register metric twice`.

**Cause:** A metric with the same name was registered on the same registry
twice. This happens when:
- `MetricsService` is instantiated multiple times.
- Multiple modules register the same metric on the default
  `prom-client.register`.

**Check:** Search for all occurrences of `new Counter`, `new Gauge`, `new Histogram`.

**Fix:** Ensure shared metrics use a shared registry instance. The
`MetricsService` constructor accepts an optional `Registry` parameter — pass
the same registry instance to all consumers.

---

## Recovery Procedures

### Step 1: Validate Configuration

```bash
# 1. Check METRICS_AUTH_TOKEN is set in production
echo "Token set: ${METRICS_AUTH_TOKEN:+yes}"

# 2. Check PORT matches Prometheus scrape target
echo "Port: $PORT"

# 3. Check HTTP_METRICS_ROUTE_LABEL_LIMIT
echo "Route label limit: ${HTTP_METRICS_ROUTE_LABEL_LIMIT:-100}"
```

### Step 2: Verify Endpoint Reachability

```bash
# 4. Local connectivity (auth not required if METRICS_AUTH_TOKEN is unset)
curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/metrics
# Expected: 200, 401, or 404
```

Interpreting HTTP status:
- `200` — Metrics exposed (may be empty).
- `401` — Auth configured; `METRICS_AUTH_TOKEN` required.
- `404` — Known issue (see above); /metrics not wired.

### Step 3: Check Application Logs

```bash
# 5. Search for metric-related errors
grep -i 'metric\|register\|registry\|prometheus' /var/log/app.log
```

### Step 4: Inspect Prometheus Targets (if Prometheus is deployed)

```bash
# 6. Via Prometheus UI or API
curl http://prometheus:9090/api/v1/targets | jq '.data.activeTargets[] | select(.job=="talenttrust-backend")'
```

### Step 5: Restore Metrics

If metrics are missing or corrupted:

1. **Restart the service** — All metrics are in-memory; restarting resets them
   to zero. This is safe for counters (they will resume from zero) but gauges
   must be re-populated by their sampling loops.

2. **Verify metrics reappear** after restart:
   ```bash
   # After restart, confirm http_requests_total counts new requests
   curl http://localhost:3001/health
   curl -s http://localhost:3001/metrics | grep 'http_requests_total'
   ```

3. **If metrics do not reappear:**
   - Check that `collectDefaultMetrics` does not throw (Node.js version
     compatibility issue).
   - Verify `prom-client` is the expected version in `package.json`.
   - Check for `Error: Metric with name ... already exists` logs.

---

## Alerting Guidance

### Critical Alerts

| Condition | Severity | Action |
|-----------|----------|--------|
| `up{job="talenttrust-backend"} == 0` | Critical | Service is down. Investigate process health. |
| `service_health_status < 2` | Warning | Service degraded. Check event loop lag, heap usage, dependencies. |
| `webhook_dlq_operations_total{operation="drop_overflow"} > 0` | Critical | DLQ full; events being dropped. Increase DLQ capacity. |

### Diagnostic Queries

```promql
# Request rate by route
sum by (route) (rate(http_requests_total[5m]))

# P95 latency by route
histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))

# Error rate by route
sum by (route) (rate(http_requests_total{status_code=~"5.."}[5m])) /
sum by (route) (rate(http_requests_total[5m]))

# Webhook delivery success rate
sum(rate(webhook_deliveries_total{outcome="success"}[5m])) /
sum(rate(webhook_deliveries_total[5m]))
```

---

## Source Reference

| Component | File | Role |
|-----------|------|------|
| MetricsService | `src/observability/metrics-service.ts` | Metric registration, HTTP tracking, scrape output |
| Observability config | `src/observability/observability-config.ts` | Env-var parsing |
| Auth middleware | `src/middleware/metricsAuth.ts` | Bearer token guard for `/metrics` |
| Health service | `src/observability/health-service.ts` | Health-status evaluation |
| Webhook metrics | `src/webhookMetrics.ts` | Webhook-specific counters/histograms |
| DLQ metrics | `src/utils/webhookMetrics.ts` | DLQ operation counters |
| SLO evaluator | `src/operations/service-objectives.ts` | SLO breach detection |
| App wiring | `src/app.ts` | Middleware registration, MetricsService creation |
