# Webhooks API Documentation

This document describes every webhook-related endpoint provided by the TalentTrust Backend API. It covers webhook subscription management, metrics recording, and DLQ replay operations.

## Overview

The webhooks system consists of three primary API groups:

1. **Subscription Management** (`/api/v1/webhook-subscriptions/*`) — Create, read, update, and delete webhook subscriptions
2. **Metrics Recording** (`/api/v1/metrics/webhook/*`) — Record webhook delivery outcomes and DLQ metrics
3. **Admin Operations** (`/api/v1/admin/webhooks/*`) — Replay dead-letter queue entries

All endpoints follow the standard TalentTrust API response envelope contract (see [API.md](API.md)). All timestamps are ISO 8601 formatted strings.

---

## Webhook Event Schema

### Event Payload Structure

When a webhook is triggered, the following JSON payload is sent to the subscriber's endpoint:

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "event": "contract.created",
  "timestamp": "2024-07-20T14:30:00.000Z",
  "data": {
    "contractId": "abc123",
    "talentId": "talent-456",
    "action": "created"
  }
}
```

### Event Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string (UUID) | Unique identifier for this webhook delivery event. |
| `event` | string | The event type name (e.g., `contract.created`, `contract.updated`). |
| `timestamp` | string (ISO 8601) | When the webhook was generated. |
| `data` | object | The event-specific payload data. Structure varies by event type. |

### Payload Size Limits

- **Maximum payload size**: 1 MB (1,048,576 bytes) by default
- **Configurable via**: `WEBHOOK_MAX_PAYLOAD_SIZE_BYTES` environment variable
- **Range**: 1 KB to 10 MB
- Payloads exceeding this limit will be rejected before delivery attempts.

### Event Types

The system supports the following event types (examples):

- `contract.created` — Fired when a new contract is created
- `contract.updated` — Fired when a contract is updated
- `contract.deleted` — Fired when a contract is deleted
- `talent.verified` — Fired when a talent identity is verified

Event types are defined by the `eventType` field in webhook subscriptions. Subscribers only receive events for the event types they have subscribed to.

### Signature Headers (When Secret is Configured)

If a subscription includes a `secret`, the following headers are added:

- **`X-Signature`** — HMAC-SHA256 signature of the payload, prefixed with `sha256=`
- **`X-Timestamp`** — Unix timestamp in milliseconds when the signature was generated

See the [Signature Verification](#webhook-signature-verification-inbound) section for details on verifying these signatures.

### Standard Headers

All webhook deliveries include:

- **`Content-Type`** — `application/json`
- **`X-Correlation-Id`** — Optional correlation ID for distributed tracing (if provided)

---

## Webhook Subscription Management

Webhook subscriptions define event delivery endpoints for a consumer or globally. Each subscription specifies a target URL, event type to subscribe to, and an optional shared secret for HMAC signature verification.

### POST /api/v1/webhook-subscriptions

**Purpose:** Create a new webhook subscription.

**Access:** Requires `admin` role (JWT Bearer token).

**Request Headers:**
- `Authorization: Bearer <jwt>` (required) — Admin user JWT token
- `Content-Type: application/json` (required)
- `X-Request-Id` (optional) — Unique request identifier (UUID v4 or alphanumeric, max 128 chars)
- `X-Correlation-Id` (optional) — Correlation ID for distributed tracing (max 128 chars, alphanumeric + hyphens/underscores)

**Request Body:**
```json
{
  "consumerId": "00000000-0000-0000-0000-000000000001",
  "url": "https://webhook.example.com/events",
  "eventType": "contract.created",
  "secret": "shared-webhook-secret-key"
}
```

**Parameters:**
- `consumerId` (optional, string) — UUID of the consumer who owns this subscription. If omitted, the subscription is global.
- `url` (required, string) — Target URL for webhook delivery. Must be a valid HTTPS URL. URLs resolving to private/reserved addresses (localhost, 127.0.0.1, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16) are rejected.
- `eventType` (required, string) — Event type to subscribe to. Length 1–100 characters.
- `secret` (optional, string) — Shared signing secret. Length 1–256 characters. If provided, outbound webhooks will be signed with HMAC-SHA256 using this secret. If omitted, no signature is generated.

**Success Response (201 Created):**
```json
{
  "status": "success",
  "data": {
    "id": "12345678-1234-1234-1234-123456789abc",
    "consumerId": "00000000-0000-0000-0000-000000000001",
    "url": "https://webhook.example.com/events",
    "eventType": "contract.created",
    "active": true,
    "createdAt": "2024-07-20T14:30:00.000Z",
    "updatedAt": "2024-07-20T14:30:00.000Z"
  }
}
```

**Note:** The `secret` field is **never** included in API responses. Secrets are stored server-side and used only for outbound signature generation.

**Error Responses:**

| Status | Code | Condition | Example |
|--------|------|-----------|---------|
| 400 | `validation_error` | Invalid URL format (not a valid HTTP/HTTPS URL). | See validation error details below. |
| 400 | `invalid_url` | URL resolves to a private/reserved address (SSRF protection). | `{ "error": { "code": "invalid_url", "message": "Provided URL is invalid or resolved to a private/reserved address.", "requestId": "..." } }` |
| 400 | `validation_error` | Missing required fields, wrong types, or invalid field lengths. | `{ "error": { "code": "validation_error", "message": "Request validation failed", "requestId": "...", "details": [ { "field": "eventType", "message": "String must contain at least 1 character(s)" } ] } }` |
| 401 | `unauthorized` | Missing or invalid `Authorization` header. | `{ "error": { "code": "unauthorized", "message": "Authentication is required", "requestId": "..." } }` |
| 403 | `forbidden` | User is authenticated but does not have the `admin` role. | `{ "error": { "code": "forbidden", "message": "You do not have permission to perform this action", "requestId": "..." } }` |
| 500 | `internal_error` | Unexpected server error during database write. | `{ "error": { "code": "internal_error", "message": "An unexpected error occurred", "requestId": "..." } }` |

**Example Request:**
```bash
curl -X POST http://localhost:3001/api/v1/webhook-subscriptions \
  -H "Authorization: Bearer demo-admin-token" \
  -H "Content-Type: application/json" \
  -H "X-Request-Id: 550e8400-e29b-41d4-a716-446655440000" \
  -d '{
    "consumerId": "00000000-0000-0000-0000-000000000001",
    "url": "https://webhook.example.com/events",
    "eventType": "contract.created",
    "secret": "my-shared-secret-key"
  }'
```

**Example Response (201):**
```json
{
  "status": "success",
  "data": {
    "id": "87654321-4321-4321-4321-987654321def",
    "consumerId": "00000000-0000-0000-0000-000000000001",
    "url": "https://webhook.example.com/events",
    "eventType": "contract.created",
    "active": true,
    "createdAt": "2024-07-20T14:30:00.000Z",
    "updatedAt": "2024-07-20T14:30:00.000Z"
  }
}
```

---
### GET /api/v1/webhook-subscriptions

**Purpose:** List all webhook subscriptions with optional filtering and cursor-based pagination.

**Access:** Requires `admin` role (JWT Bearer token).

**Request Headers:**
- `Authorization: Bearer <jwt>` (required)
- `X-Request-Id` (optional)
- `X-Correlation-Id` (optional)

**Query Parameters:**
- `consumerId` (optional, string) — Filter by consumer UUID.
- `eventType` (optional, string) — Filter by event type.
- `active` (optional, string or boolean) — Filter by active status. Accepts `true` or `false` (case-insensitive strings or JSON boolean).
- `cursor` (optional, string) — Pagination cursor from the previous page's response. Omit on first request.
- `limit` (optional, integer) — Number of results per page. Default: 20, Min: 1, Max: 100.

**Success Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "data": [
      {
        "id": "12345678-1234-1234-1234-123456789abc",
        "consumerId": "00000000-0000-0000-0000-000000000001",
        "url": "https://webhook.example.com/events",
        "eventType": "contract.created",
        "active": true,
        "createdAt": "2024-07-20T14:30:00.000Z",
        "updatedAt": "2024-07-20T14:30:00.000Z"
      }
    ],
    "nextCursor": "eyJjcmVhdGVkQXQiOiIyMDI0LTA3LTIwVDEwOjAwOjAwLjAwMFoiLCJpZCI6IjEyMzQ1Njc4LTEyMzQtMTIzNC0xMjM0LTEyMzQ1Njc4OWFiYyJ9",
    "hasNextPage": true,
    "limit": 20
  }
}
```

**Note:** `nextCursor` is `null` when the current page is the last page. Results are ordered by `createdAt DESC`, with `id DESC` as a tie-breaker.

**Error Responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 400 | `validation_error` | Invalid `limit` (exceeds 100, non-positive, or not an integer) or malformed `cursor`. |
| 401 | `unauthorized` | Missing or invalid authentication. |
| 403 | `forbidden` | User lacks `admin` role. |
| 500 | `internal_error` | Unexpected database error. |

**Example Request:**
```bash
curl -X GET "http://localhost:3001/api/v1/webhook-subscriptions?eventType=contract.created&limit=10" \
  -H "Authorization: Bearer demo-admin-token"
```

**Example Response (200):**
```json
{
  "status": "success",
  "data": {
    "data": [
      {
        "id": "87654321-4321-4321-4321-987654321def",
        "consumerId": "00000000-0000-0000-0000-000000000001",
        "url": "https://webhook.example.com/events",
        "eventType": "contract.created",
        "active": true,
        "createdAt": "2024-07-20T14:30:00.000Z",
        "updatedAt": "2024-07-20T14:30:00.000Z"
      }
    ],
    "nextCursor": null,
    "hasNextPage": false,
    "limit": 10
  }
}
```

---

### GET /api/v1/webhook-subscriptions/:id

**Purpose:** Retrieve a single webhook subscription by ID.

**Access:** Requires `admin` role (JWT Bearer token).

**Request Headers:**
- `Authorization: Bearer <jwt>` (required)
- `X-Request-Id` (optional)
- `X-Correlation-Id` (optional)

**Path Parameters:**
- `id` (required, string) — UUID of the subscription to retrieve.

**Success Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "id": "12345678-1234-1234-1234-123456789abc",
    "consumerId": "00000000-0000-0000-0000-000000000001",
    "url": "https://webhook.example.com/events",
    "eventType": "contract.created",
    "active": true,
    "createdAt": "2024-07-20T14:30:00.000Z",
    "updatedAt": "2024-07-20T14:30:00.000Z"
  }
}
```

**Error Responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 400 | `validation_error` | Invalid UUID format in path parameter. |
| 401 | `unauthorized` | Missing or invalid authentication. |
| 403 | `forbidden` | User lacks `admin` role. |
| 404 | `not_found` | Subscription with the given ID does not exist. |
| 500 | `internal_error` | Unexpected database error. |

**Example Request:**
```bash
curl -X GET http://localhost:3001/api/v1/webhook-subscriptions/12345678-1234-1234-1234-123456789abc \
  -H "Authorization: Bearer demo-admin-token"
```

**Example Response (404):**
```json
{
  "error": {
    "code": "not_found",
    "message": "Webhook subscription not found.",
    "requestId": "550e8400-e29b-41d4-a716-446655440000"
  }
}
```

---
### PATCH /api/v1/webhook-subscriptions/:id

**Purpose:** Update an existing webhook subscription.

**Access:** Requires `admin` role (JWT Bearer token).

**Request Headers:**
- `Authorization: Bearer <jwt>` (required)
- `Content-Type: application/json` (required)
- `X-Request-Id` (optional)
- `X-Correlation-Id` (optional)

**Path Parameters:**
- `id` (required, string) — UUID of the subscription to update.

**Request Body (all fields optional):**
```json
{
  "url": "https://new-webhook.example.com/events",
  "eventType": "contract.updated",
  "secret": "new-shared-secret",
  "active": false
}
```

**Parameters:**
- `url` (optional, string) — New target URL. Must be valid HTTPS and not resolve to private/reserved addresses.
- `eventType` (optional, string) — New event type. Length 1–100 characters.
- `secret` (optional, string) — New signing secret. Length 1–256 characters.
- `active` (optional, boolean) — Enable/disable the subscription.

**Success Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "id": "12345678-1234-1234-1234-123456789abc",
    "consumerId": "00000000-0000-0000-0000-000000000001",
    "url": "https://new-webhook.example.com/events",
    "eventType": "contract.updated",
    "active": false,
    "createdAt": "2024-07-20T14:30:00.000Z",
    "updatedAt": "2024-07-20T15:45:30.000Z"
  }
}
```

**Error Responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 400 | `validation_error` | Invalid UUID in path or invalid field values. |
| 400 | `invalid_url` | URL resolves to a private/reserved address. |
| 401 | `unauthorized` | Missing or invalid authentication. |
| 403 | `forbidden` | User lacks `admin` role. |
| 404 | `not_found` | Subscription with the given ID does not exist. |
| 500 | `internal_error` | Unexpected database error. |

**Example Request:**
```bash
curl -X PATCH http://localhost:3001/api/v1/webhook-subscriptions/12345678-1234-1234-1234-123456789abc \
  -H "Authorization: Bearer demo-admin-token" \
  -H "Content-Type: application/json" \
  -d '{
    "active": false
  }'
```

**Example Response (200):**
```json
{
  "status": "success",
  "data": {
    "id": "12345678-1234-1234-1234-123456789abc",
    "consumerId": "00000000-0000-0000-0000-000000000001",
    "url": "https://webhook.example.com/events",
    "eventType": "contract.created",
    "active": false,
    "createdAt": "2024-07-20T14:30:00.000Z",
    "updatedAt": "2024-07-20T15:45:30.000Z"
  }
}
```

---

### DELETE /api/v1/webhook-subscriptions/:id

**Purpose:** Delete a webhook subscription permanently.

**Access:** Requires `admin` role (JWT Bearer token).

**Request Headers:**
- `Authorization: Bearer <jwt>` (required)
- `X-Request-Id` (optional)
- `X-Correlation-Id` (optional)

**Path Parameters:**
- `id` (required, string) — UUID of the subscription to delete.

**Success Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "id": "12345678-1234-1234-1234-123456789abc",
    "deleted": true
  }
}
```

**Error Responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 400 | `validation_error` | Invalid UUID format. |
| 401 | `unauthorized` | Missing or invalid authentication. |
| 403 | `forbidden` | User lacks `admin` role. |
| 404 | `not_found` | Subscription with the given ID does not exist. |
| 500 | `internal_error` | Unexpected database error. |

**Example Request:**
```bash
curl -X DELETE http://localhost:3001/api/v1/webhook-subscriptions/12345678-1234-1234-1234-123456789abc \
  -H "Authorization: Bearer demo-admin-token"
```

**Example Response (404):**
```json
{
  "error": {
    "code": "not_found",
    "message": "Webhook subscription not found.",
    "requestId": "550e8400-e29b-41d4-a716-446655440000"
  }
}
```

---
## Webhook Metrics Recording

These endpoints allow internal services and monitoring systems to record webhook delivery outcomes and dead-letter queue metrics. They are intended for internal use (e.g., called by background job processors).

### POST /api/v1/metrics/webhook/delivery

**Purpose:** Record the outcome of a webhook delivery attempt.

**Access:** Should be protected by metricsAuthMiddleware in production. Currently unprotected for development.

**Request Headers:**
- `Content-Type: application/json` (required)
- `X-Request-Id` (optional)
- `X-Correlation-Id` (optional)

**Request Body:**
```json
{
  "outcome": "success"
}
```

**Parameters:**
- `outcome` (required, string) — Delivery outcome. Must be one of: `"success"`, `"failure"`, `"dlq"`.

**Success Response (204 No Content):**
```
(empty body)
```

**Error Responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 400 | `validation_error` | Missing `outcome` field, invalid value, unknown fields present, or `outcome` is not a string. |
| 500 | `internal_error` | Unexpected error while recording the metric. |

**Validation Error Details:**
The `details` array in a 400 response provides field-level validation information:
```json
{
  "error": {
    "code": "validation_error",
    "message": "Request validation failed",
    "requestId": "550e8400-e29b-41d4-a716-446655440000",
    "details": [
      {
        "field": "outcome",
        "message": "outcome must be one of: success, failure, dlq"
      }
    ]
  }
}
```

**Example Request (success):**
```bash
curl -X POST http://localhost:3001/api/v1/metrics/webhook/delivery \
  -H "Content-Type: application/json" \
  -d '{
    "outcome": "success"
  }'
```

**Example Request (failure):**
```bash
curl -X POST http://localhost:3001/api/v1/metrics/webhook/delivery \
  -H "Content-Type: application/json" \
  -d '{
    "outcome": "failure"
  }'
```

**Example Response (400 validation error):**
```json
{
  "error": {
    "code": "validation_error",
    "message": "Request validation failed",
    "requestId": "550e8400-e29b-41d4-a716-446655440000",
    "details": [
      {
        "field": "outcome",
        "message": "Invalid enum value. Expected 'success' | 'failure' | 'dlq'"
      }
    ]
  }
}
```

---

### POST /api/v1/metrics/webhook/dlq-depth

**Purpose:** Set the current depth of the webhook dead-letter queue (DLQ) gauge.

**Access:** Should be protected by metricsAuthMiddleware in production. Currently unprotected for development.

**Request Headers:**
- `Content-Type: application/json` (required)
- `X-Request-Id` (optional)
- `X-Correlation-Id` (optional)

**Request Body:**
```json
{
  "depth": 42
}
```

**Parameters:**
- `depth` (required, integer) — Current DLQ depth. Must be a non-negative integer in the range [0, 10,000,000].

**Success Response (204 No Content):**
```
(empty body)
```

**Error Responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 400 | `validation_error` | `depth` is missing, not an integer, negative, non-finite (NaN/Infinity), exceeds 10,000,000, or unknown fields present. |
| 500 | `internal_error` | Unexpected error while setting the metric. |

**Validation Error Details:**
```json
{
  "error": {
    "code": "validation_error",
    "message": "Request validation failed",
    "requestId": "550e8400-e29b-41d4-a716-446655440000",
    "details": [
      {
        "field": "depth",
        "message": "DLQ depth must be an integer"
      }
    ]
  }
}
```

**Example Request (valid):**
```bash
curl -X POST http://localhost:3001/api/v1/metrics/webhook/dlq-depth \
  -H "Content-Type: application/json" \
  -d '{
    "depth": 100
  }'
```

**Example Response (400 validation error — exceeds max):**
```json
{
  "error": {
    "code": "validation_error",
    "message": "Request validation failed",
    "requestId": "550e8400-e29b-41d4-a716-446655440000",
    "details": [
      {
        "field": "depth",
        "message": "DLQ depth must be <= 10000000"
      }
    ]
  }
}
```

**Example Response (400 validation error — negative):**
```json
{
  "error": {
    "code": "validation_error",
    "message": "Request validation failed",
    "requestId": "550e8400-e29b-41d4-a716-446655440000",
    "details": [
      {
        "field": "depth",
        "message": "DLQ depth must be >= 0"
      }
    ]
  }
}
```

---
## Admin Operations

### POST /api/v1/admin/webhooks/dlq/replay-all

**Purpose:** Replay all pending dead-letter queue (DLQ) entries with controlled concurrency. This triggers retransmission of failed webhooks.

**Access:** Requires `admin` role (JWT Bearer token).

**Request Headers:**
- `Authorization: Bearer <jwt>` (required)
- `Content-Type: application/json` (optional)
- `X-Request-Id` (optional)
- `X-Correlation-Id` (optional)

**Request Body (optional):**
```json
{
  "concurrency": 5
}
```

**Parameters:**
- `concurrency` (optional, integer) — Maximum number of concurrent replays. Default: 5, Min: 1, Max: 50. Non-integer values are floored; values outside the range are clamped. If not provided, defaults to 5.

**Success Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "attempted": 42,
    "succeeded": 40,
    "failed": 2,
    "deduped": 0
  }
}
```

**Response Fields:**
- `attempted` — Total number of DLQ entries processed.
- `succeeded` — Number of successful re-deliveries.
- `failed` — Number of entries that failed re-delivery and remain in the DLQ.
- `deduped` — Number of entries skipped because they were already replayed (idempotency).

**Error Responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 401 | `unauthorized` | Missing or invalid `Authorization` header. |
| 403 | `forbidden` | User is authenticated but does not have the `admin` role. |
| 500 | `internal_error` | Unexpected error during replay. |

**Example Request (with concurrency override):**
```bash
curl -X POST http://localhost:3001/api/v1/admin/webhooks/dlq/replay-all \
  -H "Authorization: Bearer demo-admin-token" \
  -H "Content-Type: application/json" \
  -d '{
    "concurrency": 10
  }'
```

**Example Request (using default concurrency):**
```bash
curl -X POST http://localhost:3001/api/v1/admin/webhooks/dlq/replay-all \
  -H "Authorization: Bearer demo-admin-token"
```

**Example Response (200):**
```json
{
  "status": "success",
  "data": {
    "attempted": 42,
    "succeeded": 40,
    "failed": 2,
    "deduped": 0
  }
}
```

---

## Webhook Signature Verification (Inbound)

When a subscription includes a `secret`, outbound webhooks are signed using HMAC-SHA256. Integrators must verify signatures on received webhooks to confirm authenticity. This section documents the signature scheme.

### Signature Scheme

Each signed webhook includes two headers:

- **`X-Signature`** — The HMAC-SHA256 digest of the webhook payload, optionally prefixed with `sha256=`. Format: lowercase hex (64 characters).
- **`X-Timestamp`** — Unix timestamp in milliseconds when the webhook was generated.

### Verification Algorithm

1. **Extract headers:**
   - `signature` = value of `X-Signature` header
   - `timestamp` = value of `X-Timestamp` header (parse as integer milliseconds)

2. **Validate timestamp freshness:**
   - Calculate age = `now - timestamp`
   - Reject if age > 5 minutes (300,000 ms)
   - Error code: `unauthorized`, message: `"Webhook timestamp is too old"`

3. **Normalize the signature:**
   - Strip the optional `sha256=` prefix if present
   - Verify the result is a valid hex string of exactly 64 characters
   - If invalid, reject with error code `bad_request`, message: `"Webhook signature format is invalid"`

4. **Reconstruct the canonical string:**
   - Format: `"${timestamp}.${JSON.stringify(webhookPayload)}"`
   - Use standard JSON serialization with no extra whitespace

5. **Compute the expected signature:**
   - Use HMAC-SHA256 with the shared `secret` from your subscription
   - Hash the canonical string
   - Output as lowercase hex

6. **Compare signatures:**
   - Use constant-time comparison (e.g., `crypto.timingSafeEqual` in Node.js)
   - If they match, the webhook is authentic
   - If they don't match, reject with error code `invalid_webhook_signature`, message: `"Webhook signature does not match"`

### Verification Codes and Errors

| Code | Status | Message | Cause |
|------|--------|---------|-------|
| `valid` | N/A | Webhook signature is valid | Signature and timestamp both valid |
| `unauthorized` | 401 | Webhook timestamp is too old | Timestamp older than 5 minutes |
| `bad_request` | 400 | Webhook timestamp is invalid | Timestamp missing, malformed, non-finite, or ≤ 0 |
| `bad_request` | 400 | Webhook signature format is invalid | Signature not valid hex or wrong length |
| `bad_request` | 400 | Webhook secret is required | Secret not provided to verification function |
| `invalid_webhook_signature` | 403 | Webhook signature does not match | HMAC mismatch (tampering or wrong secret) |

### Example Verification (Node.js)

```javascript
const crypto = require('crypto');

function verifyWebhookSignature(payload, signatureHeader, timestampHeader, secret) {
  const timestamp = parseInt(timestampHeader, 10);
  const now = Date.now();
  const maxAgeMs = 5 * 60 * 1000; // 5 minutes
  
  // Check timestamp freshness
  if (now - timestamp > maxAgeMs) {
    throw new Error('Webhook timestamp is too old');
  }
  
  // Normalize signature (strip optional sha256= prefix)
  let sig = signatureHeader;
  if (sig.toLowerCase().startsWith('sha256=')) {
    sig = sig.slice(7);
  }
  
  // Verify hex format
  if (!/^[a-f0-9]{64}$/i.test(sig)) {
    throw new Error('Webhook signature format is invalid');
  }
  
  // Reconstruct canonical string
  const canonicalString = `${timestamp}.${JSON.stringify(payload)}`;
  
  // Compute expected signature
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(canonicalString)
    .digest('hex');
  
  // Constant-time comparison
  if (!crypto.timingSafeEqual(Buffer.from(sig.toLowerCase()), Buffer.from(expectedSignature))) {
    throw new Error('Webhook signature does not match');
  }
  
  return true;
}

// Example usage
const payload = { event: 'contract.created', data: { id: 'abc123' } };
const signature = 'sha256=abcd...'; // from X-Signature header
const timestamp = '1721507400000'; // from X-Timestamp header
const secret = 'my-shared-secret';

try {
  verifyWebhookSignature(payload, signature, timestamp, secret);
  console.log('Webhook verified successfully');
} catch (err) {
  console.error('Verification failed:', err.message);
}
```

### No-Secret Subscriptions

If a subscription is created **without** a `secret`, outbound webhooks are **not signed**. The `X-Signature` and `X-Timestamp` headers will not be present. You can still verify the webhook came from TalentTrust by:

- Checking the source IP address (if your network allows it)
- Using a firewall rule or API gateway to restrict access
- Verifying the webhook URL matches your subscription

We recommend always providing a `secret` for security.

---

## Common Error Scenarios

### Invalid HTTPS URL
**Condition:** Subscription URL is not HTTPS or is malformed.  
**Response Status:** 400 Bad Request  
**Response Code:** `validation_error`  
**Fix:** Provide a valid HTTPS URL.

```json
{
  "error": {
    "code": "validation_error",
    "message": "Request validation failed",
    "requestId": "...",
    "details": [
      {
        "field": "url",
        "message": "Invalid url"
      }
    ]
  }
}
```

### Private/Reserved Address (SSRF Protection)
**Condition:** URL resolves to 127.0.0.1, localhost, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, or 169.254.0.0/16.  
**Response Status:** 400 Bad Request  
**Response Code:** `invalid_url`  
**Fix:** Use a public URL that is externally reachable.

```json
{
  "error": {
    "code": "invalid_url",
    "message": "Provided URL is invalid or resolved to a private/reserved address.",
    "requestId": "..."
  }
}
```

### Missing Required Fields
**Condition:** POST/PATCH request is missing required fields or includes unknown fields.  
**Response Status:** 400 Bad Request  
**Response Code:** `validation_error`  
**Fix:** Ensure all required fields are present and no extra fields are included.

```json
{
  "error": {
    "code": "validation_error",
    "message": "Request validation failed",
    "requestId": "...",
    "details": [
      {
        "field": "url",
        "message": "Required"
      }
    ]
  }
}
```

### Resource Not Found
**Condition:** GET, PATCH, or DELETE request targets a non-existent subscription.  
**Response Status:** 404 Not Found  
**Response Code:** `not_found`  
**Fix:** Verify the subscription ID is correct and the subscription has not been deleted.

```json
{
  "error": {
    "code": "not_found",
    "message": "Webhook subscription not found.",
    "requestId": "..."
  }
}
```

### Insufficient Permissions
**Condition:** Request is authenticated but user lacks `admin` role.  
**Response Status:** 403 Forbidden  
**Response Code:** `forbidden`  
**Fix:** Use an admin token or request a user with admin privileges perform the operation.

```json
{
  "error": {
    "code": "forbidden",
    "message": "You do not have permission to perform this action",
    "requestId": "..."
  }
}
```

---

## Related Documentation

- [API.md](API.md) — General API conventions, response envelopes, and error handling
- [authentication-authorization.md](backend/authentication-authorization.md) — JWT authentication and role-based access control
- [queue-system.md](backend/queue-system.md) — Background job queue architecture
- [DLQ Implementation](../DLQ_IMPLEMENTATION_SUMMARY.md) — Dead-letter queue design and operations



---

## Feature Flag: WEBHOOKS_ENABLED

The entire webhooks subsystem is gated behind the `WEBHOOKS_ENABLED` environment variable.

### Configuration

| Variable | Default | Description |
|---|---|---|
| `WEBHOOKS_ENABLED` | `true` | Enable/disable the webhooks subsystem at runtime. |

### Behaviour

| State | `WEBHOOKS_ENABLED=true` | `WEBHOOKS_ENABLED=false` |
|-------|------------------------|--------------------------|
| `WebhookService.trigger()` | Queries subscriptions and delivers events | Immediate no-op — no subscriptions queried, no HTTP deliveries, no DLQ writes |
| `/api/v1/webhook-subscriptions` router | Mounted and functional | Not mounted — all endpoints return `404` |

### Safe default

Omitting `WEBHOOKS_ENABLED` from the environment is equivalent to `WEBHOOKS_ENABLED=true`. Webhooks remain enabled unless explicitly disabled.

### Usage examples

```bash
# Disable webhooks (e.g. during an incident or maintenance window)
WEBHOOKS_ENABLED=false npm start

# Re-enable (default — also achieved by omitting the variable)
WEBHOOKS_ENABLED=true npm start
```

### Notes

- The flag is read once at process startup via `parseBoolEnv`. Changing the variable at runtime requires a restart.
- The `features.webhooksEnabled` field in `src/config/features.ts` exposes the resolved boolean for use outside the service constructor.
- All non-trigger methods on `WebhookService` (DLQ reads, replays, stats) remain functional regardless of the flag.

---

## Webhook Signing — Outbound Delivery

### Signing Format

Every webhook with a configured secret is signed using HMAC-SHA256. The canonical message is:

```
${timestamp}.${JSON.stringify(payload.data)}
```

Where:
- `timestamp` is the current Unix time in **milliseconds** (`Date.now()`), generated fresh for each delivery attempt.
- `JSON.stringify(payload.data)` is the **exact bytes** sent as the HTTP request body.

The signature is then:

```
HMAC-SHA256(secret, canonicalMessage) → hex string (64 characters)
```

### Required Headers

| Header | Format | Description |
|--------|--------|-------------|
| `X-Signature` | `sha256=<64-hex-chars>` | HMAC-SHA256 signature of the canonical message. |
| `X-Timestamp` | `<unix-ms>` | Millisecond Unix timestamp used in signing. |
| `Content-Type` | `application/json` | Always present. |
| `X-Correlation-Id` | alphanumeric string | Present when a correlation ID is propagated. |

### How Subscribers Verify Signatures

```
1. Extract X-Timestamp from request headers.
2. Reject if abs(now - X-Timestamp) exceeds your replay window (recommended: 5 minutes).
3. Read the raw request body as a string — do NOT parse and re-serialize JSON.
4. Construct: canonicalMessage = `${X-Timestamp}.${rawBody}`
5. Compute: expectedSig = HMAC-SHA256(yourSecret, canonicalMessage).hexdigest()
6. Compare X-Signature (strip "sha256=" prefix) with expectedSig using constant-time comparison.
7. If mismatch: reject with HTTP 401.
```

**Critical:** Sign verification must use the **raw body bytes** received on the wire. Parsing and re-serializing JSON may alter field ordering or whitespace and will break signature verification.

### Security Properties

- Signature comparison uses `crypto.timingSafeEqual` to prevent timing oracle attacks.
- The `sha256=` prefix is stripped before comparison; both `sha256=<hex>` and bare `<hex>` are accepted.
- Each delivery attempt generates a **fresh timestamp and signature** — replays get new signatures too.
- The webhook secret is **never** logged, never returned in API responses, and stripped from DLQ views.

---

## Retry Behavior

### Policy

| Parameter | Default | Description |
|-----------|---------|-------------|
| Max retries | 5 | Number of retries after the initial attempt (6 total attempts). |
| Initial delay | 1 000 ms | Backoff before first retry. |
| Max delay | 30 000 ms | Cap on exponential backoff. |
| Multiplier | 2 | Exponential base. |
| Jitter | 10% | Random jitter to prevent thundering herd. |
| Timeout | 10 000 ms | Per-attempt HTTP request timeout (configurable). |

Delay formula: `min(initialDelay × 2^retryIndex, maxDelay) ± 10% jitter`

### Retryable Failures

The following failures trigger a retry:

- HTTP 5xx responses (transient server-side failures)
- Network/transport failures (timeouts, `ECONNRESET`, `ETIMEDOUT`, `ECONNABORTED`, `ECONNREFUSED`, DNS failures, etc.)

Retrying only these transient failures keeps retries bounded and avoids wasting attempts on permanent client errors.

### Non-Retryable Failures (Direct DLQ)

The following failures are moved **directly to the DLQ on the first attempt** (no retries):

- Payload exceeds `WEBHOOK_MAX_PAYLOAD_SIZE_BYTES` → `WEBHOOK_PAYLOAD_TOO_LARGE`
- Destination URL blocked by SSRF guard → `WEBHOOK_SSRF_BLOCKED`
- Per-host rate limit exceeded → `WEBHOOK_RATE_LIMITED`
- HTTP 4xx client error response → `WEBHOOK_DELIVERY_4XX` (permanent client error; retrying cannot succeed)

### After Retry Exhaustion

After all retryable attempts fail, the event is moved to the **Dead Letter Queue** with error code `WEBHOOK_RETRY_EXHAUSTED` and the last failure message.

---

## Dead Letter Queue (DLQ)

### Overview

Failed webhook deliveries are persisted to a SQLite-backed DLQ that survives service restarts.

| Property | Value |
|----------|-------|
| Storage | SQLite (`data/webhook-dlq.db` by default) |
| Max capacity | 10 000 entries (oldest-evict when full) |
| Poison message limit | 5 replay attempts before permanent drop |
| Secret storage | Secrets stored internally for replay, **never returned in API responses** |

### DLQ Entry Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | DLQ entry identifier. |
| `webhookId` | UUID | Original stable event ID (unchanged across all retry attempts). |
| `url` | string | Destination URL. |
| `body` | object | Event payload body. |
| `retryCount` | number | Number of delivery attempts made. |
| `failedAt` | ISO-8601 | When the final failure occurred. |
| `error` | string | Machine-readable failure reason (error code + message). |
| `replayedAt` | ISO-8601 &#124; null | When the entry was successfully replayed (null if pending). |

Note: `webhookSecret` is **never** present in DLQ views returned by the API.

---

## DLQ API

All DLQ endpoints require `admin` role authentication.

### GET /api/v1/webhook-subscriptions/dlq

List all dead-lettered webhook events.

**Response (200):**
```json
{
  "status": "success",
  "data": [
    {
      "id": "dlq-uuid-1",
      "webhookId": "event-uuid-stable",
      "url": "https://example.com/hook",
      "body": { "event": "contract.created" },
      "retryCount": 6,
      "failedAt": "2024-01-01T00:00:00.000Z",
      "error": "WEBHOOK_RETRY_EXHAUSTED: connection refused",
      "replayedAt": null
    }
  ],
  "meta": { "total": 10, "pending": 8, "replayed": 2 }
}
```

### GET /api/v1/webhook-subscriptions/dlq/stats

Returns DLQ statistics.

**Response (200):**
```json
{
  "status": "success",
  "data": { "total": 10, "pending": 8, "replayed": 2 }
}
```

### GET /api/v1/webhook-subscriptions/dlq/:id

Returns a single DLQ entry. Returns `404` if not found.

### POST /api/v1/webhook-subscriptions/dlq/:id/replay

Replays a single DLQ entry through the normal delivery pipeline with a **fresh timestamp and signature**. Returns `404` if not found, `422` if already replayed.

**Response (200):**
```json
{
  "status": "success",
  "data": { "id": "dlq-uuid-1", "replayed": true, "message": "Replay successful" }
}
```

### POST /api/v1/webhook-subscriptions/dlq/replay-all

Replays all pending (not yet replayed) DLQ entries with bounded concurrency (default: 5 parallel).

**Response (200):**
```json
{
  "status": "success",
  "data": { "attempted": 8, "succeeded": 7, "failed": 0, "deduped": 1 }
}
```

---

## Replay Behavior

- Replay uses the **same delivery pipeline** as normal event delivery (SSRF check, payload size check, signing, retry, DLQ).
- A **fresh `X-Timestamp`** and **fresh `X-Signature`** are generated for every replay attempt — old timestamps/signatures are never reused.
- Replay removes the entry from the DLQ **only on success**.
- If replay also fails, the entry remains in the DLQ for manual review or another replay attempt.
- **Deduplication:** if the same `webhookId` + `body` combination is already pending in the DLQ, the entry is marked replayed without re-attempting delivery.

---

## Delivery Semantics

### At-Least-Once Delivery

HTTP webhooks cannot guarantee exactly-once delivery. If the subscriber's server receives the request but the sender times out before receiving a response, the event will be retried.

Subscribers **must** implement idempotency using the stable event `webhookId`. The same `webhookId` is preserved across all retry attempts for a given event.

### Event ID Stability

Each logical event is assigned a UUID before the first delivery attempt. This UUID is preserved:
- Across all retry attempts for the same failure.
- In the DLQ entry (`webhookId` field).
- During replay (the `webhookId` is not regenerated on replay).

---

## Configuration Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `WEBHOOKS_ENABLED` | `true` | Master switch. When `false`, all webhook delivery is a no-op and subscription routes return 404. |
| `WEBHOOK_DELIVERY_TIMEOUT_MS` | `10000` | Per-attempt HTTP request timeout in milliseconds. Range: 100–120 000. |
| `WEBHOOK_MAX_PAYLOAD_SIZE_BYTES` | `1048576` | Maximum serialized payload size in bytes. Oversized payloads go directly to DLQ. Range: 1 024–10 485 760. |
| `WEBHOOK_HOST_RATE_LIMIT_MAX` | `60` | Maximum outbound deliveries per destination host per window. |
| `WEBHOOK_HOST_RATE_LIMIT_WINDOW_MS` | `60000` | Sliding window duration for per-host rate limiting. |
| `WEBHOOK_DLQ_PATH` | `data/webhook-dlq.db` | Path to the SQLite file used for DLQ persistence. Use `:memory:` for ephemeral (test) mode. |
| `WEBHOOK_RETRY_MAX_ATTEMPTS` | `6` | Total delivery attempts including the initial one (default 5 retries). Range: 1–100. |
| `WEBHOOK_RETRY_INITIAL_DELAY_MS` | `1000` | Initial retry backoff in milliseconds. Range: 100–60 000. |
| `WEBHOOK_RETRY_MAX_DELAY_MS` | `30000` | Cap on exponential backoff in milliseconds. Range: 1 000–600 000. |
| `WEBHOOK_RETRY_MULTIPLIER` | `2` | Exponential backoff multiplier. Range: 1–10. |
| `WEBHOOK_RETRY_JITTER_FACTOR` | `0.1` | Jitter offset (±) as a fraction of the delay. Range: 0–1. |

---

## Error Codes

| Code | HTTP | Description |
|------|------|-------------|
| `WEBHOOK_PAYLOAD_TOO_LARGE` | — | Serialized payload exceeds `WEBHOOK_MAX_PAYLOAD_SIZE_BYTES`. Event goes to DLQ without retry. |
| `WEBHOOK_SSRF_BLOCKED` | — | Destination URL is private/reserved. Event goes to DLQ without retry. |
| `WEBHOOK_RATE_LIMITED` | — | Per-host delivery rate limit exceeded. Event goes to DLQ without retry. |
| `WEBHOOK_RETRY_EXHAUSTED` | — | All retry attempts failed. Event moved to DLQ. |
| `WEBHOOK_DELIVERY_4XX` | — | Downstream returned a permanent 4xx client error. Event moved to DLQ without retry. |
| `WEBHOOK_DELIVERY_FAILED` | — | Single delivery attempt failed. |
| `WEBHOOK_DLQ_NOT_FOUND` | 404 | Requested DLQ entry does not exist. |
| `WEBHOOK_REPLAY_FAILED` | 422 | Replay attempt failed (already replayed, etc.). |
| `WEBHOOK_INVALID_CONFIGURATION` | — | Subscription configuration is invalid (e.g., malformed URL). |
