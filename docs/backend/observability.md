# Backend Observability

This document explains service-level health signaling and Prometheus metrics exposure in `Talenttrust-Backend`.

## Endpoints

### `GET /health/live`

Returns process liveness only.

```json
{
  "status": "up",
  "service": "talenttrust-backend"
}
```

### `GET /health` and `GET /health/ready`

Returns service-level health with runtime and dependency signals.

```json
{
  "service": "talenttrust-backend",
  "status": "up",
  "timestamp": "2026-03-24T00:00:00.000Z",
  "uptimeSeconds": 102.34,
  "signals": {
    "eventLoopLagMs": 12,
    "heapUsedBytes": 23893648,
    "heapTotalBytes": 30523392,
    "heapUsedRatio": 0.78
  },
  "dependencies": []
}
```

Status behavior:

- `up`: all local and dependency checks are healthy.
- `degraded`: one or more checks are elevated but still serving.
- `down`: one or more checks are critical. HTTP status is `503`.

### `GET /metrics`

Exposes metrics in Prometheus text format.

If `METRICS_AUTH_TOKEN` is set, requests must include:

```text
Authorization: Bearer <token>
```

If auth is missing/invalid, route returns `401`.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3001` | API listener port |
| `SERVICE_NAME` | `talenttrust-backend` | Name used in health payload and metrics labels |
| `METRICS_ENABLED` | `true` | Set to `false` to return `404` on `/metrics` |
| `METRICS_AUTH_TOKEN` | _unset_ | Enables bearer-token protection for `/metrics` |
| `HTTP_METRICS_ROUTE_LABEL_LIMIT` | `100` | Maximum distinct HTTP route template labels before new routes are recorded as `other` |

## Exported Prometheus Metrics

- `http_requests_total{method,route,status_code}`
- `http_request_duration_seconds{method,route,status_code}`
- `service_health_status{service}` (`up=2`, `degraded=1`, `down=0`)
- `webhook_deliveries_total{outcome}`
- `webhook_dlq_depth`
- `webhook_rate_limit_tokens{provider_id}` - Current token count per provider in the rate-limiter bucket
- `webhook_rate_limit_queue_depth{provider_id}` - Current queue depth (number of waiting deliveries) per provider in the rate-limiter
- Node/process default metrics from `prom-client` (prefixed by `<service>_`)

## Security and Threat Notes

### Threat: unauthorized scraping of operational details

Mitigation:

- Token-gate `/metrics` with `METRICS_AUTH_TOKEN`.
- Restrict route at network boundary (ingress, WAF, service mesh) to trusted scrapers only.

### Threat: high cardinality metrics causing memory growth

Mitigation:

- Route labels use bounded path values from Express route templates.
- Route labels include the static mount path plus the matched template, for example `/api/v1/contracts/:id`.
- Unmatched requests collapse into the shared `unmatched` bucket.
- `HTTP_METRICS_ROUTE_LABEL_LIMIT` caps distinct route labels; routes first seen after the cap are recorded as `other`.
- No request payload, IDs, or user-provided fields are added as labels.
- Rate limit metrics use redacted provider IDs (first 4 chars + `****`) to bound cardinality.

### Threat: health endpoint leaking secrets

Mitigation:

- Health responses contain only runtime capacity indicators and dependency status.
- Avoid including credentials or raw stack traces in dependency details.

## Prometheus scrape example

```yaml
scrape_configs:
  - job_name: talenttrust-backend
    metrics_path: /metrics
    static_configs:
      - targets: ['talenttrust-backend:3001']
    authorization:
      type: Bearer
      credentials: ${METRICS_AUTH_TOKEN}
```

## Rate Limit Metrics Alerting

The rate limit gauges enable proactive alerting on provider-specific queue buildup:

### Suggested Alert Thresholds

- **Warning**: `webhook_rate_limit_queue_depth{provider_id} > 5` for 5 minutes
  - Indicates sustained throttling for a provider
  - May require capacity increase or provider investigation

- **Critical**: `webhook_rate_limit_queue_depth{provider_id} > 20` for 2 minutes
  - Indicates severe queue backlog
  - Risk of delivery delays and potential timeout cascades

- **Info**: `webhook_rate_limit_tokens{provider_id} < 2` for 10 minutes
  - Provider consistently running near capacity
  - Consider tuning `WEBHOOK_BUCKET_CAPACITY` or `WEBHOOK_REFILL_RATE_PER_SEC`

### Example Prometheus Alert Rule

```yaml
groups:
  - name: rate_limit_alerts
    rules:
      - alert: WebhookRateLimitQueueDepthWarning
        expr: webhook_rate_limit_queue_depth > 5
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Webhook rate limit queue depth elevated for {{ $labels.provider_id }}"
          description: "Provider {{ $labels.provider_id }} has {{ $value }} queued deliveries"

      - alert: WebhookRateLimitQueueDepthCritical
        expr: webhook_rate_limit_queue_depth > 20
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Webhook rate limit queue depth critical for {{ $labels.provider_id }}"
          description: "Provider {{ $labels.provider_id }} has {{ $value }} queued deliveries - immediate action required"
```

