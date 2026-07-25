# Webhooks Operations Runbook

This runbook describes the configuration, failure modes, alerting signals, and recovery procedures for the TalentTrust webhooks subsystem. It is intended for operators who need to diagnose and resolve webhook delivery problems.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Configuration](#configuration)
3. [API Endpoints](#api-endpoints)
4. [Failure Modes](#failure-modes)
5. [Alerting & Monitoring](#alerting--monitoring)
6. [Recovery Procedures](#recovery-procedures)
7. [Security Notes](#security-notes)
8. [Related Documentation](#related-documentation)

---

## Architecture Overview

The webhooks subsystem consists of the following components:

| Component | Path | Role |
|-----------|------|------|
| Subscription routes | `src/routes/webhook-subscription.routes.ts` | REST API for CRUD on webhook subscriptions |
| Delivery service | `src/services/webhook.service.ts` | Sends outbound webhook deliveries with retry and DLQ fallback |
| Retry policy | `src/queue/webhook-retry-policy.ts` | Exponential backoff with jitter (max 5 retries) |
| Dead-letter queue | `src/queue/webhook-dlq.ts` | Persistent SQLite storage for failed deliveries |
| DLQ metrics | `src/webhookMetrics.ts` | Prometheus counters/gauges for delivery observability |
| SSRF guard | `src/utils/ssrf.ts` | Blocks webhook URLs pointing to private/internal addresses |
| Signature utility | `src/utils/webhook-signing.util.ts` | HMAC-SHA256 payload signing and verification |
| Subscription repository | `src/repositories/webhook-subscription.repository.ts` | SQLite persistence for subscription records |
| Admin routes | `src/routes/admin.routes.ts` | DLQ replay and circuit-breaker reset endpoints |
| App entry | `src/app.ts` | Mounts the webhook subscription router at `/api/v1/webhook-subscriptions` |

### Delivery Flow

```
trigger(eventType, data)
  → find all active subscriptions matching eventType
  → for each subscription, call send(payload) asynchronously
  → send() applies SSRF check → per-host rate limit → HTTP POST with retry
  → on persistent failure → persist to DLQ
  → DLQ entries can be replayed via admin endpoint
```

---

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `WEBHOOK_DELIVERY_TIMEOUT_MS` | No | `10000` | Per-attempt HTTP timeout for outbound webhook requests. Validated: integer 100–120000 ms. Defined in `src/config/env.schema.ts`. |
| `WEBHOOK_DLQ_PATH` | No | `data/webhook-dlq.db` (cwd) | File path for the webhook DLQ SQLite database. See `src/queue/webhook-dlq.ts`. |
| `WEBHOOK_HOST_RATE_LIMIT_MAX` | No | `60` | Max deliveries per destination host per rate-limit window. See `src/services/webhook.service.ts`. |
| `WEBHOOK_HOST_RATE_LIMIT_WINDOW_MS` | No | `60000` | Sliding-window length in ms for per-host rate limiting. |

### Validation

All webhook environment variables are validated at startup via `validateEnv()` in `src/config/env.schema.ts`. Invalid values cause an immediate process exit (or throw in test mode) with a clear error message.

### Retry Policy

Defined in `src/queue/webhook-retry-policy.ts`:

| Parameter | Value |
|-----------|-------|
| Max retries | 5 |
| Initial delay | 1 000 ms |
| Multiplier | 2 (exponential) |
| Jitter | 10 % |
| Max delay cap | 30 000 ms |

Total worst-case retry window is approximately 62 seconds (1 + 2 + 4 + 8 + 16 = 31 s of backoff, capped at 30 s per attempt, plus timeout).

### DLQ Capacity & Poison Handling

| Parameter | Default | Description |
|-----------|---------|-------------|
| `maxCapacity` | 10 000 entries | Oldest pending entries are evicted when at capacity. |
| `maxReplayAttempts` | 5 | Entries exceeding this are permanently dropped as poison messages. |

---

## API Endpoints

### Subscription Management

All endpoints require admin JWT authentication (`requireAuth` + `requireRole('admin')`) and are prefixed with `/api/v1/webhook-subscriptions`. See `src/routes/webhook-subscription.routes.ts`.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/` | Create a subscription. URL is validated against SSRF rules. |
| `GET` | `/` | List subscriptions with filter and cursor-based pagination. |
| `GET` | `/:id` | Retrieve a single subscription (secret redacted). |
| `PATCH` | `/:id` | Update a subscription (URL re-validated against SSRF). |
| `DELETE` | `/:id` | Delete a subscription. |

### DLQ & Replay (Admin)

All endpoints require admin JWT authentication. See `src/routes/admin.routes.ts`.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/v1/admin/webhooks/dlq/replay-all` | Bulk replay all pending DLQ entries. Accepts optional `concurrency` (1–50, default 5). |
| `POST` | `/api/v1/admin/circuit-breaker/:name/reset` | Reset a circuit breaker by provider name. |

The `replay-all` endpoint processes entries in batches of `concurrency` using `Promise.allSettled`. Partial failures are tolerated — individual entry failures do not abort the batch. Returns a summary with `attempted`, `succeeded`, `failed`, and `deduped` counts.

---

## Failure Modes

### 1. Destination URL is Private (SSRF Blocked)

- **Symptom**: Delivery fails immediately with `SSRF_BLOCKED` error, entry goes to DLQ.
- **Cause**: The subscription URL resolves to a private/internal IP address (127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, link-local, loopback, etc.) and `SSRF_ALLOW_PRIVATE_HOSTS` is not set to `true`.
- **Detection**: DLQ `lastError` contains `SSRF_BLOCKED`. Metric label `reason=unknown` with status `failure`.
- **Recovery**: Update the subscription URL to a public endpoint, or set `SSRF_ALLOW_PRIVATE_HOSTS=true` in non-production environments only.

### 2. Per-Host Rate Limit Exceeded

- **Symptom**: Delivery fails immediately with `RATE_LIMITED` error, entry goes to DLQ.
- **Cause**: The destination host is receiving more than `WEBHOOK_HOST_RATE_LIMIT_MAX` (default 60) deliveries per `WEBHOOK_HOST_RATE_LIMIT_WINDOW_MS` (default 60 000 ms).
- **Detection**: DLQ `lastError` contains `RATE_LIMITED: host <hostname> exceeded delivery limit`.
- **Recovery**: Wait for the window to roll off, or reduce the number of concurrent subscriptions to the same host. Adjust `WEBHOOK_HOST_RATE_LIMIT_MAX` or `WEBHOOK_HOST_RATE_LIMIT_WINDOW_MS` if needed.

### 3. HTTP Timeout

- **Symptom**: Delivery attempt times out after `WEBHOOK_DELIVERY_TIMEOUT_MS` (default 10 000 ms). Retry is attempted with exponential backoff. After 5 retries, entry moves to DLQ.
- **Cause**: The downstream webhook endpoint is slow or unresponsive.
- **Detection**: Metric `webhook_delivery_attempts_total` with `reason=timeout`. DLQ `lastError` contains `ETIMEDOUT` or `ECONNABORTED`.
- **Recovery**: Verify the downstream endpoint is healthy. Increase `WEBHOOK_DELIVERY_TIMEOUT_MS` if the endpoint is legitimately slow (up to 120 000 ms).

### 4. Connection Refused / DNS Failure

- **Symptom**: Immediate connection failure on first attempt. Retries may succeed if intermittent; otherwise DLQ after exhaustion.
- **Cause**: The downstream host is down, or DNS cannot resolve the hostname.
- **Detection**: Metric `webhook_delivery_attempts_total` with `reason=connection_refused` or `reason=dns_resolution_failure`.
- **Recovery**: Check the downstream service health and DNS configuration. Verify the subscription URL is correct.

### 5. 4xx Client Error

- **Symptom**: The downstream server responds with a 4xx status code. Not retried (treated as permanent).
- **Cause**: Invalid payload, authentication failure, or the endpoint does not accept the content type.
- **Detection**: Metric `webhook_delivery_attempts_total` with `reason=4xx_client_error`.
- **Recovery**: Inspect the downstream logs. Fix the subscription configuration or payload format. Do not retry 4xx errors — fix the root cause.

### 6. 5xx Server Error

- **Symptom**: The downstream server responds with a 5xx status code. Retried with exponential backoff.
- **Cause**: Temporary upstream outage at the webhook receiver.
- **Detection**: Metric `webhook_delivery_attempts_total` with `reason=5xx_server_error`.
- **Recovery**: Wait for the downstream service to recover. Retries will continue automatically. If all retries exhaust, the entry goes to DLQ for manual replay.

### 7. DLQ Capacity Overflow

- **Symptom**: Oldest pending entries are silently evicted to make room for new failures.
- **Cause**: The DLQ reaches `maxCapacity` (default 10 000) and new delivery failures arrive.
- **Detection**: Metric `webhook_dlq_operations_total` with `operation=drop_overflow`.
- **Recovery**: Replay pending entries promptly via the admin replay endpoint. Increase `maxCapacity` in the DLQ configuration if overflow is frequent.

### 8. Poison Message (Max Replay Attempts Exceeded)

- **Symptom**: An entry is permanently dropped after 5 replay attempts.
- **Cause**: The downstream endpoint consistently rejects the payload or is unreachable.
- **Detection**: Metric `webhook_dlq_operations_total` with `operation=drop_poison`.
- **Recovery**: Investigate the specific DLQ entry to understand why the receiver consistently fails. Fix the receiver or remove the subscription. The message is not recoverable once dropped.

### 9. Circuit Breaker Open

- **Symptom**: Deliveries to a specific provider are skipped entirely (fast-path to DLQ) without making HTTP requests.
- **Cause**: Consecutive failures exceeded the threshold (default 5). The breaker opens and blocks further attempts for the cooldown period (default 60 000 ms).
- **Detection**: Metric `webhook_breaker_state` with value `1` (OPEN). Metric `webhook_delivery_attempts_total` with `reason=circuit_open`.
- **Recovery**: Wait for the cooldown period to elapse; the breaker will transition to HALF_OPEN and probe the endpoint. If the probe succeeds, it closes. If it fails, it reopens. Operators can also reset the breaker manually via `POST /api/v1/admin/circuit-breaker/:name/reset`.

---

## Alerting & Monitoring

### Prometheus Metrics

The webhook subsystem exports the following metrics (defined in `src/webhookMetrics.ts`):

| Metric | Labels | Description |
|--------|--------|-------------|
| `webhook_delivery_attempts_total` | `status`, `provider`, `reason` | Total delivery attempts. `reason` values: `timeout`, `4xx_client_error`, `5xx_server_error`, `dns_resolution_failure`, `connection_refused`, `circuit_open`, `unknown`. |
| `webhook_delivery_latency_seconds` | `status`, `provider` | Histogram of delivery latency in seconds. Buckets: 0.1, 0.5, 1, 2, 5, 10. |
| `webhook_delivery_retries_total` | `provider`, `reason` | Total retry attempts due to transient failures. |
| `webhook_dlq_operations_total` | `operation` | Operation counts. Values: `enqueue`, `drop_overflow`, `drop_poison`. |
| `webhook_breaker_state` | `provider` | Current circuit-breaker state: 0=CLOSED, 1=OPEN, 2=HALF_OPEN. |

### Suggested Alerting Rules

| Condition | Severity | Threshold |
|-----------|----------|-----------|
| `rate(increase(webhook_dlq_operations_total{operation="enqueue"}[5m]) > 10)` | Warning | Sustained high DLQ enqueue rate indicates downstream failures. |
| `rate(increase(webhook_dlq_operations_total{operation="drop_overflow"}[5m]) > 0)` | Critical | DLQ overflow — entries are being silently lost. |
| `rate(increase(webhook_dlq_operations_total{operation="drop_poison"}[5m]) > 0)` | Warning | Poison messages detected — investigate root cause. |
| `webhook_breaker_state{provider="..."} == 1` | Critical | Circuit breaker is OPEN for any provider. |
| `rate(increase(webhook_delivery_attempts_total{reason="timeout"}[5m]) > 5)` | Warning | High timeout rate — downstream endpoints may be degraded. |
| `rate(increase(webhook_delivery_attempts_total{reason="connection_refused"}[5m]) > 5)` | Warning | Connection refused — downstream endpoint may be down. |

### Key Observability Queries

```promql
-- Pending DLQ entries
webhook_dlq_operations_total{operation="enqueue"} - webhook_dlq_operations_total{operation="drop_overflow"} - webhook_dlq_operations_total{operation="drop_poison"}

-- Success rate over last 5 minutes
rate(webhook_delivery_attempts_total{status="success"}[5m]) / rate(webhook_delivery_attempts_total[5m])

-- Average delivery latency (p99)
histogram_quantile(0.99, rate(webhook_delivery_latency_seconds_bucket[5m]))
```

---

## Recovery Procedures

### Procedure 1: Replay Failed Webhooks (Single Entry)

1. Identify the DLQ entry ID (e.g., from logs or a query).
2. Verify the subscription is still active and the URL is correct.
3. Call the replay endpoint:
   ```bash
   curl -X POST http://localhost:3001/api/v1/admin/webhooks/dlq/replay-all \
     -H "Authorization: Bearer <admin-token>" \
     -H "Content-Type: application/json" \
     -d '{"concurrency": 5}'
   ```
4. Check the response for `succeeded`, `failed`, and `deduped` counts.
5. If the specific entry failed, check the DLQ `lastError` field for details and fix the downstream issue.

### Procedure 2: Bulk Replay All Pending DLQ Entries

1. Check DLQ stats to understand the scope:
   ```bash
   curl -s http://localhost:3001/api/v1/admin/queue-health | jq .
   ```
2. Assess the downstream health — ensure receivers are ready to accept traffic before replaying.
3. Start the replay with controlled concurrency:
   ```bash
   curl -X POST http://localhost:3001/api/v1/admin/webhooks/dlq/replay-all \
     -H "Authorization: Bearer <admin-token>" \
     -H "Content-Type: application/json" \
     -d '{"concurrency": 10}'
   ```
4. Monitor the response. A high `failed` count indicates a systemic issue — pause and investigate before retrying.
5. Re-run if partial failures occurred, but be aware of idempotency — deduplication keys prevent duplicate deliveries.

### Procedure 3: Reset a Circuit Breaker

1. Identify the provider name from metrics or logs.
2. Reset the breaker:
   ```bash
   curl -X POST http://localhost:3001/api/v1/admin/circuit-breaker/<provider-name>/reset \
     -H "Authorization: Bearer <admin-token>"
   ```
3. Monitor `webhook_breaker_state` to confirm it transitions to CLOSED (0).
4. Check `webhook_delivery_attempts_total` for resumed normal deliveries.

### Procedure 4: Handle DLQ Overflow

1. Check `drop_overflow` metric to confirm overflow is occurring:
   ```bash
   curl http://localhost:3001/api/v1/metrics | grep webhook_dlq_operations_total{operation="drop_overflow"}
   ```
2. Run a bulk replay to drain the queue.
3. If overflow persists, the DLQ capacity needs to be increased or the root cause of failures must be fixed.
4. To increase capacity, adjust the `maxCapacity` parameter in `WebhookDLQStorage` (currently hardcoded in `src/queue/webhook-dlq.ts`).

### Procedure 5: Handle Poison Messages

1. Identify poison messages via `drop_poison` metric or by querying DLQ entries with high `replayAttempts`.
2. Inspect the entry's `lastError` and `body` to understand why the receiver consistently fails.
3. Fix the downstream receiver or remove the problematic subscription.
4. Note: Poison messages are permanently dropped and cannot be recovered via replay.

---

## Security Notes

- **SSRF Protection**: All subscription URLs are validated by `isSafeUrl()` in `src/utils/ssrf.ts`. Private/internal addresses are blocked by default. In production, `SSRF_ALLOW_PRIVATE_HOSTS` is ignored — private hosts are always blocked. In non-production, set `SSRF_ALLOW_PRIVATE_HOSTS=true` to allow private hosts for development.
- **Secret Handling**: The webhook `secret` (signing key for outbound payloads) is never returned in API responses. It is stored in the database but redacted by `sanitizeSubscription()` in `src/routes/webhook-subscription.routes.ts`. The DLQ view (`WebhookDLQView`) also strips `webhookSecret`.
- **Admin Authentication**: All DLQ replay and circuit-breaker endpoints require admin JWT authentication (`requireAuth` + `requireRole('admin')`).
- **Correlation IDs**: Outbound HTTP headers use sanitized correlation IDs restricted to `[A-Za-z0-9._-]` with max length 256, preventing header injection (CRLF).
- **HMAC Signing**: Payloads are signed with HMAC-SHA256 using the subscription's secret. Signatures include a timestamp to prevent replay attacks (max age: 5 minutes).

---

## Related Documentation

- [Webhook DLQ](WEBHOOK-DLQ.md) — Deep-dive on DLQ persistence, replay, and graceful-shutdown drain.
- [Webhook Subscriptions](WEBHOOK_SUBSCRIPTIONS.md) — Database schema and API endpoint reference.
- [Webhook Signature Verification](../webhook-signature-verification.md) — HMAC signing and verification details.
- [Environment Variables](../backend/environment-variables.md) — Full list of environment variables with defaults.
- [Circuit Breaker](../backend/circuit-breaker.md) — Circuit breaker patterns and configuration.
- [Observability](../observability.md) — Metrics and monitoring setup.
