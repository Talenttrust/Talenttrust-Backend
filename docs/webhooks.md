# Webhooks API Reference

The TalentTrust Backend delivers real-time escrow event notifications via `WebhookManager` (`src/webhooks.ts`), subscribed to `StoreEventEmitter` (`src/events.ts`) and exposed under `/api/v1/webhook-subscriptions` in `src/app.ts`.

Subscriptions and delivery history are stored in memory for the lifetime of the server process.

## Authentication

All `/api/v1/webhook-subscriptions` endpoints require the `WEBHOOK_ADMIN_TOKEN` environment variable and a matching bearer token:

```http
Authorization: Bearer <WEBHOOK_ADMIN_TOKEN>
```

- If `WEBHOOK_ADMIN_TOKEN` is unset, every webhook route returns `404` (`not_found`).
- If the header is missing or does not match (checked with constant-time SHA-256 comparison in `isWebhookAdminTokenValid`), the route returns `401` (`unauthorized`).
- All responses under `/api/v1/webhook-subscriptions` include `Cache-Control: no-store` and `Pragma: no-cache` so signing secrets are never cached.

## Subscription Management Endpoints

### `POST /api/v1/webhook-subscriptions`

Creates a new webhook subscription and generates a signing secret (`whsec_<base64>`).

**Request body:**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | `string` | Yes | HTTPS endpoint URL. `http://localhost` is allowed only when `NODE_ENV !== "production"`. Private/reserved IPv4/IPv6 addresses, embedded credentials, and unresolvable hostnames are rejected. |
| `events` | `string[] \| string` | Yes* | One or more supported event types from `WEBHOOK_EVENT_TYPES` or `"*"` for all events. Duplicates are removed. |
| `eventType` | `string[] \| string` | Yes* | Legacy alias accepted when `events` is omitted. |
| `filter` | `object` | No | Optional delivery filter with `parties` (1–50 non-empty strings matching `contract.client` or `contract.freelancer`) and/or `contractIds` (1–50 positive safe integers matching `contract.id`). |

\* Provide either `events` or `eventType`.

**Response (`201 Created`):**

Returns the public subscription fields plus `secret` (returned only on creation and secret rotation):

```json
{
  "id": "87654321-4321-4321-4321-987654321def",
  "url": "https://hooks.example.com/talenttrust",
  "events": ["contract.created", "milestone.released"],
  "filter": {
    "parties": ["GCLIENTADDRESS..."],
    "contractIds": [1, 2]
  },
  "active": true,
  "createdAt": "2026-07-26T10:00:00.000Z",
  "updatedAt": "2026-07-26T10:00:00.000Z",
  "secret": "whsec_..."
}
```

### `GET /api/v1/webhook-subscriptions`

Lists all subscriptions (without `secret`).

**Response (`200 OK`):** `{ "data": [WebhookSubscriptionPublic, ...] }`

### `GET /api/v1/webhook-subscriptions/:id`

Returns a single `WebhookSubscriptionPublic` object by ID, or `404` (`webhook_not_found`).

### `PATCH /api/v1/webhook-subscriptions/:id`

Updates an existing subscription. All fields are optional:

| Field | Type | Description |
| --- | --- | --- |
| `url` | `string` | Re-validated with `validateWebhookUrl`. |
| `events` / `eventType` | `string[] \| string` | Replaces subscribed event types. |
| `active` | `boolean` | Enables or pauses event delivery. |
| `filter` | `object \| null` | Replaces the filter, or removes it when set to `null`. |

**Response (`200 OK`):** Updated `WebhookSubscriptionPublic`.

### `DELETE /api/v1/webhook-subscriptions/:id`

Deletes a subscription.

**Response (`200 OK`):** `{ "id": "<id>", "deleted": true }`

### `POST /api/v1/webhook-subscriptions/:id/rotate-secret`

Generates a new `whsec_<base64>` signing secret for the subscription and updates `updatedAt`.

**Response (`200 OK`):** `WebhookSubscriptionPublic` plus the new `secret`.

### `GET /api/v1/webhook-subscriptions/:id/deliveries`

Returns recent delivery attempts for a subscription, ordered newest-first.

**Query parameters:**

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `limit` | integer | `50` | Maximum records to return (`1`–`100`). |
| `status` | string | — | Filter by delivery status: `pending`, `success`, or `failed`. |

**Response (`200 OK`):** `{ "data": [WebhookDelivery, ...] }`

Each `WebhookDelivery` record contains: `id`, `subscriptionId`, `eventId`, `eventType`, `status`, `attempts`, optional `statusCode`, optional `lastError`, `createdAt`, and `updatedAt`.

## Error Responses

Errors follow RFC 9457 (`Content-Type: application/problem+json`) with `type`, `title`, `status`, `detail`, `error`, `message`, and `requestId`.

| Status | Error Code | Cause |
| --- | --- | --- |
| `400` | `invalid_url` | Malformed URL, non-HTTPS (outside non-production `localhost`), embedded credentials, DNS lookup failure, or private/reserved IP. |
| `400` | `invalid_events` | Empty or unsupported event type. |
| `400` | `invalid_filter` | Invalid `filter` shape, unknown keys, or invalid `parties`/`contractIds`. |
| `400` | `invalid_active` | `active` is not a boolean. |
| `400` | `invalid_limit` | `limit` query param is not an integer between `1` and `100`. |
| `400` | `invalid_status` | `status` query param is not `pending`, `success`, or `failed`. |
| `401` | `unauthorized` | Missing or invalid `Authorization: Bearer` token. |
| `404` | `not_found` | `WEBHOOK_ADMIN_TOKEN` is not configured. |
| `404` | `webhook_not_found` | Subscription ID does not exist. |

## Event Types & Payload Envelope

Supported event types (`WEBHOOK_EVENT_TYPES` in `src/events.ts`):

- `contract.created`
- `contract.updated`
- `contract.funded`
- `milestone.released`
- `dispute.raised`
- `dispute.resolved`
- `contract.cancelled`
- `reputation.issued`
- `reputation.updated`
- `contract.drift_detected`

Subscriptions may also specify `"*"` to receive all event types.

Every outbound `POST` body is the JSON-serialized `EscrowEvent` envelope:

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "eventId": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "eventType": "contract.created",
  "timestamp": "2026-07-26T10:00:00.000Z",
  "data": {
    "contract": { "id": 1 }
  }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `id` | string (UUID) | Unique event record identifier. |
| `eventId` | string (UUID) | Event identifier echoed in `X-Event-ID`. |
| `eventType` | string | One of `WEBHOOK_EVENT_TYPES`. |
| `timestamp` | string (ISO 8601) | UTC timestamp when the event was emitted. |
| `data` | object | Event-specific payload (deep-cloned on emit). |

## Outbound Headers & Signature Verification

Every delivery sends:

| Header | Value |
| --- | --- |
| `Content-Type` | `application/json` |
| `X-Signature` | `sha256=<hex>` — HMAC-SHA256 of `${timestamp}.${rawBody}` using the subscription `secret` |
| `X-Timestamp` | Unix epoch milliseconds when the attempt was signed |
| `X-Event-Type` | `event.eventType` |
| `X-Event-ID` | `event.eventId` |
| `X-Delivery-ID` | Unique UUID for the `WebhookDelivery` record |

Receivers can verify signatures using `verifyWebhookSignature(secret, headers, rawBody, toleranceSec = 300)` exported from `src/webhooks.ts`:
1. Parse `X-Timestamp` as an integer (milliseconds) and reject if `Math.abs(Date.now() - timestamp) > toleranceSec * 1000`.
2. Require `X-Signature` to match `/^sha256=([0-9a-f]{64})$/i`.
3. Compute `HMAC-SHA256(secret, "${timestamp}.${rawBody}")` and compare in constant time (`crypto.timingSafeEqual`).

## Failure Handling, Retries & History

- **URL re-validation:** `validateWebhookUrl` runs before every delivery attempt to guard against DNS rebinding.
- **Timeout:** Each HTTP attempt times out after `5000` ms (`delivery timeout`).
- **Attempts:** Up to `6` attempts by default (`maxAttempts`).
- **Retryable vs. permanent failures:**
  - `2xx`: delivery marked `success`.
  - `4xx` except `408`, `425`, `429`: treated as permanent; retries stop immediately and delivery is marked `failed`.
  - `408`, `425`, `429`, `5xx`, timeouts, and network/DNS errors: retried until `maxAttempts` is reached, then marked `failed`.
- **Backoff:** Exponential delay `min(30000, 1000 * 2^(attempt - 1))` ms with ±10% jitter. If the receiver returns a numeric non-negative `Retry-After` header (seconds), that value is used instead, capped at `30000` ms.
- **Bounded history:** `WebhookManager` retains up to `1000` delivery records (`maxHistory`) in memory and evicts the oldest records when the cap is exceeded.

## Related Documentation

- [Webhooks Request & Delivery Lifecycle](webhooks-flow.md)
- [Webhooks API Examples](webhooks-examples.md)
- [Webhooks Operations Runbook](runbook-webhooks.md)
