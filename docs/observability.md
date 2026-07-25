# Observability Metrics Catalog

## Introduction

This document provides a comprehensive catalog of all Prometheus metrics exported by the Talenttrust-Backend service. It is designed for operators, SREs, and platform engineers who need to build dashboards, configure alerts, and monitor the system's health and performance.

**Audience:**
- Operations teams setting up Prometheus scraping
- SREs writing alert rules
- Platform engineers building monitoring dashboards
- Developers instrumenting new features

**How to Use This Catalog:**
1. Review the **Metrics Scrape Endpoint** section to configure Prometheus
2. Consult the **Exported Metrics Catalog** table to understand available metrics
3. Reference **Service Level Objectives** for SLO-based alerting
4. Check **Cardinality Controls** to understand memory and performance implications

---

## Metrics Scrape Endpoint

### Endpoint Contract

**URL:** `GET /metrics`

**Port:** Configured via the `PORT` environment variable (default: `3001`)

**Full endpoint:** `http://<host>:3001/metrics`

**Content-Type:** `text/plain; version=0.0.4; charset=utf-8` (Prometheus text exposition format)

**Response Format:** Prometheus text-based exposition format as defined in the [Prometheus documentation](https://prometheus.io/docs/instrumenting/exposition_formats/#text-based-format)

---

### Authentication

#### When METRICS_AUTH_TOKEN is Set

When the `METRICS_AUTH_TOKEN` environment variable is configured with a non-empty string, every scrape request MUST include an `Authorization` header with a Bearer token:

```
Authorization: Bearer <token>
```

The supplied token must match the configured `METRICS_AUTH_TOKEN` value exactly.

#### When METRICS_AUTH_TOKEN is Not Set

When `METRICS_AUTH_TOKEN` is absent or empty, the `/metrics` endpoint is **unauthenticated**. Any request will be allowed.

**⚠️ Security Recommendation:** Unauthenticated access is only appropriate in isolated development or test environments. **Set `METRICS_AUTH_TOKEN` in all staging and production deployments.**

#### Authentication Failure Responses

If the `Authorization` header is missing, does not start with `Bearer `, or the supplied token does not match the configured token, the middleware returns:

- **HTTP Status:** `401 Unauthorized`
- **Response Body:** `{"error":"Unauthorized"}`

#### Constant-Time Comparison (Timing-Attack Mitigation)

The `metricsAuthMiddleware` uses `crypto.timingSafeEqual` to prevent timing side-channel attacks:

1. Both the configured token and the supplied token are converted to `Buffer` instances
2. `timingSafeEqual` is called **only when both buffers have equal byte length**
3. Mismatched lengths result in an immediate `false` without calling `timingSafeEqual`
4. This prevents timing-based token-length enumeration attacks

**Rationale:** If an attacker could measure response times, they could potentially deduce the length of the configured token by observing when the comparison takes longer (indicating same length). By short-circuiting on length mismatch, we eliminate this side channel.

---

### Example Prometheus Scrape Configuration

```yaml
scrape_configs:
  - job_name: talenttrust-backend
    metrics_path: /metrics
    static_configs:
      - targets: ['talenttrust-backend:3001']
    authorization:
      type: Bearer
      credentials: ${METRICS_AUTH_TOKEN}
    scrape_interval: 15s
    scrape_timeout: 10s
```

**Notes:**
- Replace `${METRICS_AUTH_TOKEN}` with your actual token value or use Prometheus configuration templating
- Adjust `scrape_interval` based on your monitoring requirements (15s is recommended)
- Ensure the target hostname/IP is correct for your deployment

---

### METRICS_ENABLED Flag

**Environment Variable:** `METRICS_ENABLED`

**Default:** `true`

**Accepted Values:**
- `true`, `1`, `yes`, `on` → Metrics endpoint is enabled
- `false`, `0`, `no`, `off` → Metrics endpoint returns HTTP `404 Not Found`

**Behavior When Set to `false`:**

The `GET /metrics` endpoint returns:
- **HTTP Status:** `404 Not Found`
- **Purpose:** Allows completely disabling metrics export in environments where it's not needed

---

## Cardinality Controls

Prometheus metrics with unbounded label values can cause memory growth and performance degradation. The Talenttrust-Backend implements several cardinality controls to prevent label explosion.

### HTTP_METRICS_ROUTE_LABEL_LIMIT

**Environment Variable:** `HTTP_METRICS_ROUTE_LABEL_LIMIT`

**Default:** `100`

**Accepted Range:** `1` to `10,000`

**Purpose:** Hard cap on the number of distinct route template values that `MetricsService` will admit into the `route` label of `http_requests_total` and `http_request_duration_seconds`.

**Behavior:**

1. **Below the Limit:** Each unique route template is tracked individually with its full template as the label value (e.g., `/api/v1/contracts/:id`)

2. **At the Limit:** When the count of tracked route labels equals the limit AND a new, previously unseen route template arrives:
   - The new route is recorded under the label value `"other"`
   - The tracked-route count does not increase past the cap
   - All subsequent new routes are also recorded as `"other"`

3. **Unmatched Requests:** Requests that match no Express route handler (i.e., `req.route` is `undefined`) are recorded under the label value `"unmatched"`, **regardless of the current tracked route count**

**Example:**

```
HTTP_METRICS_ROUTE_LABEL_LIMIT=3

Request 1: GET /health → route label: "/health"
Request 2: GET /metrics → route label: "/metrics"
Request 3: GET /api/users → route label: "/api/users"
Request 4: GET /api/contracts → route label: "other" (limit reached)
Request 5: GET /unknown → route label: "unmatched" (no route match)
```

---

### Provider ID Redaction

**Affected Metrics:**
- `webhook_rate_limit_tokens{provider_id}`
- `webhook_rate_limit_queue_depth{provider_id}`

**Format:** `<first-4-chars>****`

**Example:** Provider ID `stripe-webhook-prod-12345` → Label value `stri****`

**Purpose:** Bounds per-provider cardinality to the number of distinct provider-ID prefixes. This ensures that even with thousands of unique provider IDs, the metric cardinality remains manageable.

---

### Label Value Sources (Security & Cardinality)

All label values on every exported series originate exclusively from one of these **four permitted sources**:

1. **HTTP method string** — Examples: `GET`, `POST`, `PUT`, `DELETE`, `PATCH`
2. **Matched Express route template** — Examples: `/api/v1/contracts/:id`, `/health`, `/metrics`
3. **HTTP status code string** — Examples: `"200"`, `"404"`, `"500"`
4. **Member of a finite enumeration defined in source code** — Examples:
   - `outcome`: `success`, `failure`, `dlq`
   - `operation`: `enqueue`, `drop_overflow`, `drop_poison`
   - `provider`: `stripe`, `github`, `slack`, `sendgrid`, `generic`
   - `reason`: `timeout`, `4xx_client_error`, `5xx_server_error`, etc.

**❌ What is NOT Used as Labels:**
- Request payload data
- Query parameters
- Path segments containing user input (actual IDs, usernames, etc.)
- Error messages or stack traces
- Timestamps or sequence numbers
- Any unbounded runtime strings

---

## Exported Metrics Catalog

### Metrics Table

| Metric Name | Type | Labels | Unit | Description | Source Module | Histogram Buckets |
|-------------|------|--------|------|-------------|---------------|-------------------|
| `http_requests_total` | Counter | `method`, `route`, `status_code` | total (dimensionless count) | Total number of HTTP requests. | `src/observability/metrics-service.ts` | N/A |
| `http_request_duration_seconds` | Histogram | `method`, `route`, `status_code` | seconds | Duration of HTTP requests in seconds. Measures end-to-end request latency. | `src/observability/metrics-service.ts` | `0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, +Inf` |
| `service_health_status` | Gauge | `service` | dimensionless (encoded: `2=up`, `1=degraded`, `0=down`) | Current service health status based on runtime signals and dependency checks. See Health Status section for encoding details. | `src/observability/health-service.ts` | N/A |
| `webhook_deliveries_total` | Counter | `outcome` | total (dimensionless count) | Total webhook delivery attempts by outcome. Possible outcomes: `success`, `failure`, `dlq`. Incremented by MetricsService. | `src/observability/metrics-service.ts` | N/A |
| `webhook_dlq_depth` | Gauge | (no labels) | entries | Current number of entries in the webhook dead-letter queue. Represents absolute count, not a delta. Set by MetricsService. | `src/observability/metrics-service.ts` | N/A |
| `webhook_rate_limit_tokens` | Gauge | `provider_id` | tokens | Current token count per provider in the rate-limiter bucket. Provider IDs are redacted to first 4 characters + `****`. | `src/observability/metrics-service.ts` | N/A |
| `webhook_rate_limit_queue_depth` | Gauge | `provider_id` | entries | Current queue depth (number of waiting deliveries) per provider in the rate-limiter. Provider IDs are redacted to first 4 characters + `****`. | `src/observability/metrics-service.ts` | N/A |
| `webhook_dlq_operations_total` | Counter | `operation` | total (dimensionless count) | Total number of webhook DLQ core operations. Possible operations: `enqueue`, `drop_overflow`, `drop_poison`. Incremented by `src/utils/webhookMetrics.ts`. | `src/utils/webhookMetrics.ts` | N/A |
| `webhook_dlq_replays_total` | Counter | `outcome` | total (dimensionless count) | Total tracking counts of webhook DLQ manual or batch replay jobs executed. Possible outcomes: `success`, `failed`, `idempotent_noop`, `error`. Incremented by `src/utils/webhookMetrics.ts`. | `src/utils/webhookMetrics.ts` | N/A |
| `webhook_delivery_attempts_total` | Counter | `status`, `provider`, `reason` | total (dimensionless count) | Total number of webhook delivery attempts. Registered via `createWebhookMetrics()` factory in `src/webhookMetrics.ts`. | `src/webhookMetrics.ts` | N/A |
| `webhook_delivery_latency_seconds` | Histogram | `status`, `provider` | seconds | Webhook delivery latency in seconds. | `src/webhookMetrics.ts` | `0.1, 0.5, 1, 2, 5, 10, +Inf` |
| `webhook_delivery_retries_total` | Counter | `provider`, `reason` | total (dimensionless count) | Total number of webhook delivery retries due to transient failures. | `src/webhookMetrics.ts` | N/A |
| `webhook_breaker_state` | Gauge | `provider` | dimensionless (encoded: `0=CLOSED`, `1=OPEN`, `2=HALF_OPEN`) | Current circuit-breaker state per provider. See encoding details below. | `src/webhookMetrics.ts` | N/A |
| `talenttrust_backend_*` | Various | Various | Various | Node.js process and runtime default metrics collected by `prom-client`. Prefix derived from `SERVICE_NAME` environment variable (default: `talenttrust-backend`). | `prom-client` library (via `collectDefaultMetrics()`) | N/A |

---

### Histogram Bucket Documentation

Histograms in Prometheus use predefined buckets to approximate distributions. Quantile estimates (p50, p95, p99) are **interpolated linearly** across the declared buckets.

**Important:** Resolution degrades beyond the largest finite bucket boundary. For accurate high-percentile estimates, ensure the bucket boundaries cover your expected latency range.

#### `http_request_duration_seconds` Buckets

Buckets (in seconds): `0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, +Inf`

- `0.005s` = 5ms
- `0.01s` = 10ms
- `0.05s` = 50ms
- `0.1s` = 100ms
- `0.25s` = 250ms
- `0.5s` = 500ms
- `1s` = 1 second
- `2.5s` = 2.5 seconds
- `5s` = 5 seconds
- `+Inf` = infinite (catches all remaining observations)

**Resolution Notes:**
- Excellent resolution for sub-second latencies (0-1s)
- Good resolution for 1-5s latencies
- Degrades for latencies > 5s (all captured in the +Inf bucket)

#### `webhook_delivery_latency_seconds` Buckets

Buckets (in seconds): `0.1, 0.5, 1, 2, 5, 10, +Inf`

- `0.1s` = 100ms
- `0.5s` = 500ms
- `1s` = 1 second
- `2s` = 2 seconds
- `5s` = 5 seconds
- `10s` = 10 seconds
- `+Inf` = infinite

**Resolution Notes:**
- Optimized for webhook delivery latencies (typically 100ms - 10s range)
- Good resolution for 0-10s latencies
- Degrades for latencies > 10s

---

### WebhookMetrics DLQ Series Details

#### Ownership Table

This table clarifies which module increments or sets each DLQ-related series:

| Series Name | Incremented By | Set By |
|-------------|----------------|--------|
| `webhook_dlq_operations_total` | `src/utils/webhookMetrics.ts` (`incrementDlqOperation()`) | — |
| `webhook_dlq_replays_total` | `src/utils/webhookMetrics.ts` (`incrementDlqReplay()`) | — |
| `webhook_deliveries_total` | `src/observability/metrics-service.ts` (`recordWebhookDelivery()`) | — |
| `webhook_dlq_depth` | — | `src/observability/metrics-service.ts` (`setWebhookDlqDepth()`) |

**Key Distinction:**
- **Counters** (`*_total`) are incremented on each event
- **Gauges** (`*_depth`) are set to an absolute value

---

#### Label Value Semantics

##### `webhook_dlq_operations_total` — `operation` Label

| Value | Meaning | When Incremented |
|-------|---------|------------------|
| `enqueue` | Event accepted into the DLQ | A webhook delivery failed and the event was successfully enqueued into the dead-letter queue for later retry |
| `drop_overflow` | Event rejected because the DLQ is at capacity | The DLQ is full and a new failed event cannot be enqueued; the event is permanently dropped |
| `drop_poison` | Event permanently discarded after exceeding the maximum retry limit | An event has been retried the maximum number of times and still fails; it is removed from the DLQ as a "poison pill" |

**Operational Significance:**
- High `enqueue` rate → Many webhook failures, but DLQ is functioning
- Non-zero `drop_overflow` → **Critical:** DLQ capacity exhausted, losing failed events
- High `drop_poison` → **Warning:** Many events cannot be delivered even after retries; investigate destination service or payload validity

---

##### `webhook_dlq_replays_total` — `outcome` Label

| Value | Meaning | When Incremented |
|-------|---------|------------------|
| `success` | Replayed event delivered successfully | A DLQ event was re-attempted and the destination service returned a 2xx success response |
| `failed` | Replay attempt returned a non-2xx response | A DLQ event was re-attempted but the destination service returned a 4xx or 5xx error response |
| `idempotent_noop` | Event skipped because it was already delivered | The DLQ replay logic detected that this event was already successfully delivered (idempotency check passed), so it was skipped |
| `error` | Replay attempt threw an unexpected exception | An unexpected error occurred during the replay attempt (e.g., network timeout, DNS failure, internal error) |

**Operational Significance:**
- High `success` rate → DLQ replay is working well
- High `failed` rate → Destination service may still be unhealthy or events are invalid
- Non-zero `idempotent_noop` → Normal; indicates idempotency protection is working
- High `error` rate → **Warning:** Infrastructure issues (network, DNS, etc.) affecting replay attempts

---

##### `webhook_deliveries_total` — `outcome` Label

| Value | Meaning |
|-------|---------|
| `success` | Webhook delivered successfully on first attempt (2xx response) |
| `failure` | Webhook delivery failed (non-2xx response or network error) |
| `dlq` | Webhook delivery failed and was enqueued to the DLQ |

---

### Gauge Numeric Encodings

#### `service_health_status` Encoding

| Numeric Value | Health State |
|---------------|--------------|
| `2` | `up` — Service is fully operational |
| `1` | `degraded` — Service is running but experiencing elevated latency or resource usage |
| `0` | `down` — Service is critically impaired or unavailable |

**Usage in Alerts:**
```promql
service_health_status{service="talenttrust-backend"} < 2
```
This expression fires when the service is either `degraded` or `down`.

---

#### `webhook_breaker_state` Encoding

| Numeric Value | Circuit Breaker State |
|---------------|-----------------------|
| `0` | `CLOSED` — Circuit is closed, requests are flowing normally |
| `1` | `OPEN` — Circuit is open, requests are being blocked due to high failure rate |
| `2` | `HALF_OPEN` — Circuit is testing recovery, allowing a limited number of requests through |

**Usage in Alerts:**
```promql
webhook_breaker_state{provider="stripe"} == 1
```
This expression fires when the circuit breaker for the `stripe` provider is open (blocking requests).

---

## Service Level Objectives (SLOs)

Service Level Objectives (SLOs) define target reliability metrics for key operations. The following SLOs are configured in `src/operations/service-objectives.ts`.

---

### healthCheck Operation

#### SLO Targets

| Dimension | Target Value | Prometheus Series |
|-----------|-------------|-------------------|
| Success Rate | 99.99% | `http_requests_total` |
| p95 Latency | 50ms | `http_request_duration_seconds` |
| p99 Latency | 100ms | `http_request_duration_seconds` |

#### Alert Thresholds

| Threshold | Value | Evaluation Window |
|-----------|-------|-------------------|
| Max Error Rate | 0.1% | 300 seconds (5 minutes) |
| Max Average Latency | 150ms | 300 seconds (5 minutes) |

#### Prometheus Alert Rule

```yaml
groups:
  - name: healthCheck_slo
    rules:
      - alert: HealthCheckSLOBreach
        expr: |
          (
            sum(rate(http_requests_total{route="/health", status_code!~"2.."}[5m]))
            /
            sum(rate(http_requests_total{route="/health"}[5m]))
          ) > 0.001
        for: 5m
        labels:
          severity: critical
          operation: healthCheck
        annotations:
          summary: "Health check SLO breached: error rate > 0.1%"
          description: "Health check operation is experiencing {{ $value | humanizePercentage }} error rate, exceeding the 0.1% threshold."

      - alert: HealthCheckLatencySLOBreach
        expr: |
          histogram_quantile(0.95,
            sum(rate(http_request_duration_seconds_bucket{route="/health"}[5m])) by (le)
          ) > 0.050
        for: 5m
        labels:
          severity: critical
          operation: healthCheck
        annotations:
          summary: "Health check SLO breached: p95 latency > 50ms"
          description: "Health check p95 latency is {{ $value | humanizeDuration }}, exceeding the 50ms threshold."
```

---

### contractsApi Operation

#### SLO Targets

| Dimension | Target Value | Prometheus Series |
|-----------|-------------|-------------------|
| Success Rate | 99.9% | `http_requests_total` |
| p95 Latency | 200ms | `http_request_duration_seconds` |
| p99 Latency | 500ms | `http_request_duration_seconds` |

#### Alert Thresholds

| Threshold | Value | Evaluation Window |
|-----------|-------|-------------------|
| Max Error Rate | 1.0% | 300 seconds (5 minutes) |
| Max Average Latency | 400ms | 300 seconds (5 minutes) |

#### Prometheus Alert Rule

```yaml
groups:
  - name: contractsApi_slo
    rules:
      - alert: ContractsApiSLOBreach
        expr: |
          (
            sum(rate(http_requests_total{route=~"/api/v1/contracts.*", status_code!~"2.."}[5m]))
            /
            sum(rate(http_requests_total{route=~"/api/v1/contracts.*"}[5m]))
          ) > 0.01
        for: 5m
        labels:
          severity: warning
          operation: contractsApi
        annotations:
          summary: "Contracts API SLO breached: error rate > 1.0%"
          description: "Contracts API is experiencing {{ $value | humanizePercentage }} error rate, exceeding the 1.0% threshold."

      - alert: ContractsApiLatencySLOBreach
        expr: |
          histogram_quantile(0.95,
            sum(rate(http_request_duration_seconds_bucket{route=~"/api/v1/contracts.*"}[5m])) by (le)
          ) > 0.200
        for: 5m
        labels:
          severity: warning
          operation: contractsApi
        annotations:
          summary: "Contracts API SLO breached: p95 latency > 200ms"
          description: "Contracts API p95 latency is {{ $value | humanizeDuration }}, exceeding the 200ms threshold."
```

---

## Health Status Gauge

### Numeric Encoding (Recap)

- `service_health_status = 2` → `up`
- `service_health_status = 1` → `degraded`
- `service_health_status = 0` → `down`

---

### Runtime Signal Thresholds

The `HealthService` evaluates two runtime signals to determine the service health status:

#### Event Loop Lag Thresholds

| Condition | Health State |
|-----------|--------------|
| `eventLoopLagMs >= 1000` | `down` |
| `eventLoopLagMs >= 250` | `degraded` |
| `eventLoopLagMs < 250` | `up` (for this signal) |

**Note:** The boundary value itself triggers the transition (≥, not >).

**Alert-Ready Expression:**
```promql
# Alert when event loop lag is degraded or worse
event_loop_lag_ms >= 250
```

---

#### Heap Used Ratio Thresholds

| Condition | Health State |
|-----------|--------------|
| `heapUsedRatio >= 0.95` | `down` |
| `heapUsedRatio >= 0.85` | `degraded` |
| `heapUsedRatio < 0.85` | `up` (for this signal) |

**Where:** `heapUsedRatio = heapUsed / heapTotal`

**Alert-Ready Expression:**
```promql
# Alert when heap usage is degraded or worse
(talenttrust_backend_nodejs_heap_size_used_bytes / talenttrust_backend_nodejs_heap_size_total_bytes) >= 0.85
```

---

### Status Merge Logic

The `HealthService` evaluates:
1. Event loop lag signal
2. Heap used ratio signal
3. All registered dependency checkers (if any)

The **worst status wins**: `down > degraded > up`

**Special Case:** If a dependency checker throws an exception during its `check()` method, the dependency status is treated as `down`.

**Example:**
- Event loop lag: `up`
- Heap used ratio: `degraded`
- Database dependency: `up`
- Redis dependency: exception thrown → `down`

**Final Status:** `down` (worst of: up, degraded, up, down)

---

### Prometheus Alert Rule

```yaml
groups:
  - name: service_health
    rules:
      - alert: ServiceHealthDegraded
        expr: service_health_status{service="talenttrust-backend"} < 2
        for: 1m
        labels:
          severity: warning
        annotations:
          summary: "Service health degraded or down"
          description: "Talenttrust-Backend service health status is {{ $value }} (0=down, 1=degraded, 2=up). Check event loop lag, heap usage, and dependency health."
```

**Explanation:**
- Fires when `service_health_status < 2` (i.e., `degraded` or `down`)
- Waits for 1 minute before firing to avoid flapping
- Targets the service by the `service` label

---

## Appendix: Coverage and Testing

All metrics documented in this catalog are validated by a comprehensive automated test suite that achieves ≥95% line and branch coverage across:

- `src/observability/metrics-service.ts`
- `src/observability/health-service.ts`
- `src/middleware/metricsAuth.ts`
- `src/utils/webhookMetrics.ts`

**Round-Trip Verification:**

The test suite includes automated checks that ensure this documentation stays synchronized with the actual registered metrics:

1. Every metric listed in this catalog is verified to be registered by the application
2. No undocumented metrics are allowed (excluding default `talenttrust_backend_*` metrics)
3. All documented label names are verified to be observable in the metrics output

**CI Coverage Reports:**

Coverage reports are uploaded as artifacts in every CI run and can be accessed via the GitHub Actions UI under the "test" job artifacts.

---

## Summary

This catalog documents the complete set of Prometheus metrics exported by Talenttrust-Backend, including:

- ✅ 13+ application-specific metrics
- ✅ Default Node.js runtime metrics
- ✅ Authentication and scrape endpoint configuration
- ✅ Cardinality controls and label safety guarantees
- ✅ SLO targets and ready-to-use alert rules
- ✅ Health status gauge encoding and thresholds
- ✅ WebhookMetrics DLQ series with ownership and semantics

For questions or issues with this catalog, please consult the implementation code or open an issue in the repository.
