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

## Exported Prometheus Metrics

- `http_requests_total{method,route,status_code}`
- `http_request_duration_seconds{method,route,status_code}`
- `service_health_status{service}` (`up=2`, `degraded=1`, `down=0`)
- Node/process default metrics from `prom-client` (prefixed by `<service>_`)

## Security and Threat Notes

### Threat: unauthorized scraping of operational details

Mitigation:

- Token-gate `/metrics` with `METRICS_AUTH_TOKEN`.
- Restrict route at network boundary (ingress, WAF, service mesh) to trusted scrapers only.

### Threat: high cardinality metrics causing memory growth

Mitigation:

- Route labels use bounded path values from Express route templates.
- No request payload, IDs, or user-provided fields are added as labels.

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

