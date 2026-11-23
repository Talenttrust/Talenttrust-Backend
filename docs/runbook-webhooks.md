# Webhooks Operations Runbook

Operational reference for configuring, monitoring, and troubleshooting the TalentTrust webhook subsystem.

For endpoint schemas and payload formats, see [Webhooks API Reference](webhooks.md).

## Architecture

| Component | File | Role |
| --- | --- | --- |
| Webhook manager & security helpers | `src/webhooks.ts` | `WebhookManager`, `validateWebhookUrl`, `verifyWebhookSignature`, `isWebhookAdminTokenValid` |
| Event emitter | `src/events.ts` | `StoreEventEmitter` and `WEBHOOK_EVENT_TYPES` |
| HTTP routes & auth middleware | `src/app.ts` | `/api/v1/webhook-subscriptions` router, `noStore`, `webhookAuth`, and `/metrics` |
| Metrics registry | `src/metrics.ts` | Prometheus text exposition for HTTP and escrow metrics |

Subscriptions and delivery history are held **in memory** inside `WebhookManager`. There is no database table or dead-letter queue; restarting the process clears all subscriptions and delivery history.

## Configuration

### Environment Variables

| Variable | Required | Default | Effect |
| --- | --- | --- | --- |
| `WEBHOOK_ADMIN_TOKEN` | Yes (to enable) | Unset | Bearer token required for `/api/v1/webhook-subscriptions*`. While unset, all webhook routes return `404`. |
| `NODE_ENV` | No | — | When `NODE_ENV === "production"`, `http://localhost` webhook URLs are rejected; only public `https://` URLs are allowed. |
| `METRICS_TOKEN` | No | Unset | Bearer token for `GET /metrics` (returns `404` while unset). |
| `PORT` | No | `3001` | HTTP server port (`src/server.ts`). |
| `BODY_LIMIT` | No | `100kb` | Express JSON request body limit (`src/config.ts`). |

### Runtime Defaults (`src/webhooks.ts`)

| Setting | Default | Notes |
| --- | --- | --- |
| `maxAttempts` | `6` | Total delivery attempts per event. |
| Per-attempt HTTP timeout | `5000` ms | Aborts with `delivery timeout`. |
| Backoff schedule | `min(30000, 1000 * 2^(attempt - 1))` ms ±10% jitter | Overridden by numeric `Retry-After` (seconds), capped at `30000` ms. |
| `maxHistory` | `1000` | Global in-memory delivery history cap; oldest records are evicted. |
| Default history page size | `50` (`MAX_WEBHOOK_HISTORY_LIMIT = 100`) | Controlled via `?limit=` on `GET /:id/deliveries`. |

## Failure Modes

### 1. All Webhook Endpoints Return `404`

- **Cause**: `WEBHOOK_ADMIN_TOKEN` is not set in the server environment.
- **Resolution**: Set `WEBHOOK_ADMIN_TOKEN` and restart the server.

### 2. `400 invalid_url` on Create/Update or Delivery Failure

- **Cause**: `validateWebhookUrl` rejected the URL because it is not HTTPS (or `http://localhost` in production), contains embedded credentials, fails DNS lookup (`Webhook hostname could not be resolved`), or resolves to a private/reserved IPv4/IPv6 range (`Webhook URL resolves to a private address`).
- **Resolution**: Update the subscription to a public HTTPS endpoint whose DNS records resolve only to public IPs.

### 3. Per-Attempt Timeout (`lastError: "delivery timeout"`)

- **Cause**: The receiver did not respond within `5000` ms.
- **Behavior**: Retried up to `6` times with exponential backoff and jitter, then marked `failed`.
- **Resolution**: Ensure the receiver acknowledges webhooks quickly (e.g., enqueue work asynchronously and return `2xx` immediately).

### 4. HTTP `4xx` vs. `5xx` Responses

- **Permanent `4xx`** (any `4xx` other than `408`, `425`, `429`): Retries stop immediately; delivery is marked `failed` with `lastError: "HTTP <status>"`. Fix the receiver or subscription configuration.
- **Retryable (`408`, `425`, `429`, `5xx`)**: Retried up to `6` times, honoring numeric `Retry-After` headers up to `30000` ms.

### 5. Subscriptions or History Missing After Restart

- **Cause**: `WebhookManager` stores subscriptions and up to `1000` deliveries in memory only.
- **Resolution**: Re-register subscriptions via `POST /api/v1/webhook-subscriptions` after a restart.

## Monitoring & Observability

### Delivery History API

Poll failed deliveries for a subscription directly:

```bash
curl "http://localhost:3001/api/v1/webhook-subscriptions/<id>/deliveries?status=failed&limit=50" \
  -H "Authorization: Bearer $WEBHOOK_ADMIN_TOKEN"
```

### Prometheus Metrics (`GET /metrics`)

When `METRICS_TOKEN` is set, `GET /metrics` (`src/app.ts`, `src/metrics.ts`) exports:

- `http_requests_total{method, route, status}` — includes management requests to `/api/v1/webhook-subscriptions*`.
- `http_request_duration_seconds{method, route}` — latency histogram for management routes.
- `escrow_mutations_total{action, result}` — store mutations that trigger webhook events.

There are currently no dedicated Prometheus counters for outbound webhook delivery outcomes; use `GET /api/v1/webhook-subscriptions/:id/deliveries` to inspect delivery status and `lastError`.

## Recovery Procedures

### 1. Diagnose Failed Deliveries

1. List subscriptions (`GET /api/v1/webhook-subscriptions`) to obtain the subscription `id`.
2. Query `GET /api/v1/webhook-subscriptions/:id/deliveries?status=failed&limit=50`.
3. Inspect `statusCode`, `attempts`, and `lastError` to distinguish timeouts, DNS/SSRF blocks, permanent `4xx` errors, and `5xx` outages.

### 2. Pause or Fix a Broken Subscription

```bash
curl -X PATCH http://localhost:3001/api/v1/webhook-subscriptions/<id> \
  -H "Authorization: Bearer $WEBHOOK_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"active": false}'
```

Once the receiver is healthy, re-enable with `{"active": true}` (or update `"url"`).

### 3. Rotate a Compromised Signing Secret

```bash
curl -X POST http://localhost:3001/api/v1/webhook-subscriptions/<id>/rotate-secret \
  -H "Authorization: Bearer $WEBHOOK_ADMIN_TOKEN"
```

Update the receiver with the returned `secret` immediately — the previous secret is invalidated as soon as rotation succeeds.

## Security Notes

- **Admin auth**: `WEBHOOK_ADMIN_TOKEN` is compared via SHA-256 + `crypto.timingSafeEqual` (`isWebhookAdminTokenValid`).
- **No caching**: `/api/v1/webhook-subscriptions*` sets `Cache-Control: no-store` and `Pragma: no-cache`.
- **SSRF protection**: `validateWebhookUrl` blocks private/reserved IPv4 and IPv6 ranges (including IPv4-mapped IPv6) and re-checks DNS before every delivery attempt.
- **HMAC-SHA256 signing**: Outbound payloads are signed as `sha256=HMAC-SHA256(secret, "${timestamp}.${rawBody}")`; receivers should enforce a timestamp window (default `300` s in `verifyWebhookSignature`).

## Related Documentation

- [Webhooks API Reference](webhooks.md)
- [Webhooks Request & Delivery Lifecycle](webhooks-flow.md)
- [Webhooks API Examples](webhooks-examples.md)
