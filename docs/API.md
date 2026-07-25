## Response Envelope Contract

All API endpoints return a consistent JSON envelope.

### Success Response

```json
{
  "status": "success",
  "data": <payload>,
  "meta": <optional pagination or extra metadata>,
  "requestId": "trace-id-from-request"
}
```

### Error Response

```json
{
  "status": "error",
  "error": {
    "code": "machine_readable_code",
    "message": "Human readable message",
    "requestId": "trace-id-from-request"
  }
}
```

### Helper Functions

Use `ok(res, data, meta?, status?)` and `fail(res, code, message, status?)` from `src/utils/apiResponse.ts` in all controllers.

- `requestId` is always included from `res.locals.requestId`
- Falls back to `"unknown"` if requestId is not set
- `meta` is omitted from the response when not provided

---
# TalentTrust Backend API Documentation

## Overview

The TalentTrust Backend API provides RESTful endpoints for managing escrow contract metadata. This API follows a modular architecture with proper separation of concerns, authentication, validation, and comprehensive error handling.

## Base URL

```
http://localhost:3001/api/v1
```

## Request Sanitization

Incoming request data is sanitized by the `sanitize` middleware
(`src/middleware/sanitize.ts`) before it reaches route handlers. The
sanitization contract is:

- **Scope:** `req.body`, `req.query`, and `req.params` are sanitized recursively
  (nested objects and arrays included).
- **Strings:** every string value is trimmed and passed through a strict XSS
  filter that strips all HTML tags (and the body of `<script>`/`<style>`).
- **Type preservation:** the sanitizer is generic and returns the same shape as
  its input, so `req.query`/`req.params` retain their expected string/array
  structures (e.g. `?tag=a&tag=b` stays an array of strings).
- **Prototype-pollution safe:** the keys `__proto__`, `constructor`, and
  `prototype` are dropped during recursion and the result uses a `null`
  prototype, so a crafted payload cannot reach `Object.prototype`.
- **Idempotent and non-mutating:** running the middleware twice yields the same
  result, and the original input objects are copied rather than mutated.
- **Pass-through values:** `Date` and `Buffer` instances are returned unchanged;
  non-string primitives (numbers, booleans, `null`) are preserved as-is.

## Request Headers

### Standard Request Headers

All requests support the following standard headers for request tracing and correlation:

#### X-Request-Id

Unique identifier for each HTTP request. If provided, the server will echo back the same value in the response; otherwise, a new UUID v4 is generated server-side.

- **Type:** String (UUID v4 or alphanumeric+hyphen/underscore, max 128 chars)
- **Required:** No
- **Example:** `X-Request-Id: 550e8400-e29b-41d4-a716-446655440000`

#### X-Correlation-Id

Optional correlation ID for distributed tracing across service boundaries. Enables tracking a single logical operation through multiple services and components (e.g., from API ingress through event processing to outbound webhook deliveries).

- **Type:** String (alphanumeric+hyphen/underscore, max 128 chars)
- **Required:** No
- **Format:** Alphanumeric characters, hyphens, and underscores only
- **Example:** `X-Correlation-Id: trace-12345-abc`

**Security Note:** The correlation ID is validated for injection attacks. Only safe characters are accepted; invalid IDs are rejected, omitted from outbound webhook headers, and not echoed back in the response.

### Propagation Through the System

When a request includes `X-Correlation-Id`:
1. The ID is validated and attached to the request-scoped logger context
2. The ID is included in all event processing audit records (for deduplication and tracing)
3. The ID is propagated to outbound webhook deliveries in the `X-Correlation-Id` header
4. The ID is echoed back in the response header `X-Correlation-Id`

This enables end-to-end tracing of a single logical operation across:
- API request ingress
- Event ingestion and processing
- Webhook delivery attempts
- All related log entries

### Example: Distributed Tracing Flow

```bash
# 1. Client initiates request with correlation ID
curl -X GET http://localhost:3001/api/v1/contracts \
  -H "X-Correlation-Id: my-trace-id-001"

# 2. Response includes both request ID and echoed correlation ID
# Response Headers:
# X-Request-Id: 550e8400-e29b-41d4-a716-446655440000
# X-Correlation-Id: my-trace-id-001
```

The same `X-Correlation-Id` value will appear in:
- Request-scoped logs
- Event processing audit records
- Webhook delivery attempt headers

## Authentication

The API uses Bearer token authentication. Include the token in the Authorization header:

```
Authorization: Bearer <token>
```

### Demo Tokens
- `demo-admin-token` - Admin user with full access
- `demo-user-token` - Regular user with limited access

## Error Responses

All terminal API errors are serialized through the safe error message policy.
Internal exception details, stack traces, file paths, SQL fragments, dependency hostnames, tokens, and secrets are logged only through redacted structured logs and are never returned to API clients.

Every policy-managed error response uses this envelope:

```json
{
  "error": {
    "code": "machine_readable_code",
    "message": "safe client-facing message",
    "requestId": "request-correlation-id"
  }
}
```

Validation responses may include a `details` array with field-level Zod issue metadata. These details are also passed through the same safe-message filters.

Common status/code mappings:

| Status | Code | Message |
|---:|---|---|
| 400 | `invalid_json` | Malformed JSON payload |
| 400 | `validation_error` | Request validation failed |
| 401 | `unauthorized` | Authentication is required |
| 403 | `forbidden` | You do not have permission to perform this action |
| 404 | `not_found` | The requested resource was not found |
| 409 | `conflict` | The request conflicts with the current state |
| 413 | `payload_too_large` | Payload Too Large |
| 415 | `unsupported_media_type` | Unsupported Media Type |
| 500 | `internal_error` | An unexpected error occurred |
| 503 | `dependency_unavailable` | A required service is temporarily unavailable |

Use the returned `requestId` when contacting support; it ties the response to redacted server-side logs without exposing sensitive internals.

### Request Validation Middleware

All request validation is consolidated in `src/middleware/validate.middleware.ts`.

| Middleware | Purpose | Import Path |
|---|---|---|
| `validateSchema(schema)` | Validates `body`, `query`, and `params` together | `./validate.middleware` |
| `validateRequest(schema)` | Validates `req.body` only | `./validate.middleware` (canonical) / `./validation` (deprecated shim) |
| `validateParams(schema)` | Validates `req.params` only | `./validate.middleware` (canonical) / `./validation` (deprecated shim) |
| `validateQuery(schema)` | Validates `req.query` only | `./validate.middleware` (canonical) / `./validation` (deprecated shim) |

The deprecated paths `./validation` and `./requestValidation` are thin re-exports and will be removed in a future version. Update new imports to use `./validate.middleware` directly.

**Validation error shape (400):**

```json
{
  "error": {
    "code": "validation_error",
    "message": "Request validation failed",
    "requestId": "unknown",
    "details": [
      { "path": ["fieldName"], "message": "Expected string, received number", "code": "invalid_type" }
    ]
  }
}
```

The `details` array uses the `ValidationIssue` shape from `src/errors/appError.ts` (`path: string[]`, `message: string`, `code: string`).

## Configuration API
### Get Application Configuration
**GET** `/api/config`

**Access**: Public

Returns application configuration including allowed assets.

## System & Dependency Health
### Get Dependency Scan Report
**GET** `/api/v1/dependency-scan`

**Access**: Admin (`Authorization: Bearer <admin-token>`)

Admin-only. Returns production dependency scan status and remediation guidance.

## Admin Operations
Admin endpoints provide operational visibility and are secured via the `adminAuthGuard`.

### Queue Health
**GET** `/api/v1/admin/queue-health`

Returns health metrics for the background job queues, including recent failures and pending job counts.

### Circuit Breakers
**GET** `/api/v1/admin/circuit-breakers`

Returns the current state (closed, open, half-open) and failure/success counters for all registered upstream circuit breakers. Useful for monitoring upstream dependency health without exposing internals to unauthenticated callers.

## Deployment API (Blue/Green)
Manage zero-downtime deployments. All deployment routes are mounted at `/api/v1/admin/deploy` and require admin authentication via JWT or API key.

### Get Deployment Status
**GET** `/api/v1/admin/deploy/status`

Returns the current deployment state without modifying it. Returns 200 with deployment state JSON.

### Switch to Green
**POST** `/api/v1/admin/deploy/switch-green`

Promotes the green instance to active status.
- Idempotent if already green (returns 202 Accepted or 200 OK).
- Returns 502 Bad Gateway if the green instance is unhealthy.
- Returns 409 Conflict if a switch is already in progress.

### Rollback to Blue
**POST** `/api/v1/admin/deploy/rollback`

Reverts traffic to the blue instance. Idempotent if already blue (returns `200 OK`).

## Webhooks API

The Webhooks API provides endpoints for managing webhook subscriptions, recording delivery metrics, and replaying failed deliveries. See [webhooks.md](webhooks.md) for comprehensive documentation covering all webhook subscription management, signature verification, and admin operations.

### Quick Links

- **Subscription Management** — Create, list, retrieve, update, and delete webhook subscriptions
- **Metrics Recording** — Record webhook delivery outcomes and DLQ depth
- **Admin Operations** — Replay dead-letter queue entries with controlled concurrency

For full endpoint reference, error codes, request/response shapes, and signature verification examples, see [webhooks.md](webhooks.md).

## Contracts API

### Overview

The Contracts API provides endpoints for managing escrow contract records. Contract records include a `version` field that enables Optimistic Concurrency Control (OCC) on update operations.

### Authentication & Authorization

All contract endpoints require a valid `Authorization: Bearer <jwt>` header (HS256, signed with `JWT_SECRET`).

#### Role-based access matrix

| Method | Path | admin | client | freelancer |
|--------|------|-------|--------|------------|
| GET | `/contracts` | ✅ | ❌ (ownOnly — collection requires owner resolver) | ❌ (ownOnly) |
| POST | `/contracts` | ✅ | ✅ | ❌ |
| GET | `/contracts/:id` | ✅ | ✅ (ownOnly) | ✅ (ownOnly) |
| PATCH | `/contracts/:id` | ✅ | ✅ (ownOnly) | ✅ (ownOnly) |
| DELETE | `/contracts/:id` | ✅ | ❌ | ❌ |

**ownOnly** — the caller's JWT `sub` must equal the contract's `clientId`. The owner check is resolved from the database; it is never derived from caller-supplied parameters.

#### Error responses

- `401 Unauthorized` — missing header, malformed token, expired token, wrong secret, or invalid role claim.
- `403 Forbidden` — authenticated but role/ownership check failed.
- `404 Not Found` — the contract does not exist (also returned by `requirePermission` when the `getResourceOwnerId` resolver returns `null`, to avoid leaking resource existence to non-owners).

### The `version` Field

Every contract record carries a `version` field:

- **Type:** `integer` (non-negative)
- **Initial value:** `0` - set automatically when a contract is created
- **Increment:** incremented by exactly `1` on every successful update

The `version` field is included in all GET and PATCH responses. Clients must echo back the `version` they last read when submitting an update; the server accepts the write only when the stored version matches, then atomically increments it.

### Endpoints
#### List Contracts
**GET** `/api/v1/contracts`

Retrieves a list of available contracts.

#### Get Contract Bounds
**GET** `/api/v1/contracts/bounds`

Retrieves global statistical bounds and limits for contracts.

#### Get Contract Stats
**GET** `/api/v1/contracts/stats`

Retrieves contract system statistics (e.g., total active volume, total completed volume).

#### Create Contract
**POST** `/api/v1/contracts`

Creates a new escrow contract.

**Access**: Admin or Client (`Authorization: Bearer <jwt>`)

**Request Body:**
```json
{
  "title": "Escrow Contract Title",
  "description": "Escrow contract detailed description",
  "clientId": "00000000-0000-0000-0000-000000000001",
  "freelancerId": "00000000-0000-0000-0000-000000000002",
  "budget": 5000,
  "milestones": [
    {
      "title": "Milestone 1",
      "amount": 2500
    },
    {
      "title": "Milestone 2",
      "amount": 2500
    }
  ]
}
```

**Response (201) - Created:**
```json
{
  "status": "success",
  "data": {
    "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "title": "Escrow Contract Title",
    "clientId": "00000000-0000-0000-0000-000000000001",
    "freelancerId": "00000000-0000-0000-0000-000000000002",
    "amount": 5000,
    "status": "draft",
    "version": 0,
    "createdAt": "2024-01-15T10:00:00.000Z"
  }
}
```

**Validation and Bounds Check Errors:**
- `400 Bad Request` — validation error. Triggered for invalid types, negative amounts, or if the contract budget exceeds the maximum permitted global contract amount limit.
- `422 Unprocessable Entity` — contract bounds error. Triggered if the number of milestones exceeds the maximum global limit, or if the sum of milestone amounts does not match the contract's total budget.

**Error Response (422) Example:**
```json
{
  "status": "error",
  "error": {
    "code": "ContractBoundsError",
    "message": "Milestone count (12) exceeds maximum limit (10).",
    "requestId": "trace-id"
  }
}
```


#### Get Contract by ID
**GET** `/api/v1/contracts/:id`

Retrieves details for a single contract by its UUID.

#### Update Contract

**PATCH** `/api/v1/contracts/:id`

Updates an existing contract record using Optimistic Concurrency Control. The request body must include the `version` value from the most recent read of the contract. The server performs an atomic compare-and-swap: if the stored version matches the supplied version, the update is applied and the version is incremented by 1. If the versions do not match (indicating a concurrent modification), the request is rejected with a 409 conflict error.

**Request Body:**
```json
{
  "version": 3,
  "title": "Updated contract title"
}
```

**Response (200) - success:**
```json
{
  "status": "success",
  "data": {
    "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "title": "Updated contract title",
    "clientId": "user-uuid-1",
    "freelancerId": "user-uuid-2",
    "amount": 10000,
    "status": "active",
    "version": 4,
    "createdAt": "2024-01-15T10:00:00.000Z"
  }
}
```

The `version` in the response (`4`) is exactly 1 greater than the version supplied in the request (`3`).

**Response (409) - version conflict:**
```json
{
  "success": false,
  "error": {
    "code": "ERR_CONFLICT",
    "message": "Version conflict"
  }
}
```

Returned when the supplied `version` does not match the stored version, meaning another client has modified the contract since you last read it.

**Response (400) - missing version:**
```json
{
  "success": false,
  "error": {
    "code": "ERR_MISSING_VERSION",
    "message": "version field is required for updates"
  }
}
```

Returned when the request body does not include a `version` field.

**Response (400) - invalid version:**
```json
{
  "success": false,
  "error": {
    "code": "ERR_INVALID_VERSION",
    "message": "version must be a non-negative integer"
  }
}
```

Returned when `version` is present but is not a non-negative integer (e.g., a negative number, a float, a string, or `null`).

#### Delete Contract
**DELETE** `/api/v1/contracts/:id`

Soft deletes a contract by ID. Requires authentication.

### Client Retry Strategy

When you receive a `409 ERR_CONFLICT` response, the recommended approach is:

1. **Fetch the latest contract** — `GET /api/v1/contracts/:id`
2. **Extract the current `version`** from the response body
3. **Resubmit your update** with the new `version` value

This ensures your update is applied on top of the most recent state of the contract, preventing lost updates.

```bash
# Step 1: fetch latest contract
curl -X GET http://localhost:3001/api/v1/contracts/a1b2c3d4 \
  -H "Authorization: Bearer demo-user-token"

# Step 2: note the version in the response, e.g. "version": 5

# Step 3: resubmit with the current version
curl -X PATCH http://localhost:3001/api/v1/contracts/a1b2c3d4 \
  -H "Authorization: Bearer demo-user-token" \
  -H "Content-Type: application/json" \
  -d '{
    "version": 5,
    "title": "My updated title"
  }'
```

---

## Contract Metadata API

### Overview

Contract metadata allows storing key-value pairs associated with escrow contracts. Metadata can be marked as sensitive for data protection.

### Data Types

Supported data types for metadata values:
- `string` - Text values (default)
- `number` - Numeric values
- `boolean` - True/false values
- `json` - JSON objects/arrays

### Endpoints

#### Create Metadata

**POST** `/contracts/{contractId}/metadata`

Creates a new metadata record for a contract.

**Request Body:**
```json
{
  "key": "string",
  "value": "string",
  "data_type": "string|number|boolean|json",
  "is_sensitive": "boolean"
}
```

**Response (201):**
```json
{
  "id": "uuid",
  "contract_id": "uuid",
  "key": "string",
  "value": "string",
  "data_type": "string",
  "is_sensitive": "boolean",
  "created_by": "uuid",
  "created_at": "ISO8601",
  "updated_at": "ISO8601"
}
```

**Error Responses:**
- `401` - Authentication required
- `400` - Validation failed
- `404` - Contract not found
- `409` - Metadata key already exists for this contract

#### List Metadata

**GET** `/contracts/{contractId}/metadata`

Retrieves paginated metadata records for a contract with optional filtering.

**Query Parameters:**
- `page` (number, default: 1) - Page number for pagination
- `limit` (number, default: 20, max: 100) - Items per page
- `key` (string) - Filter by metadata key
- `data_type` (string) - Filter by data type

**Response (200):**
```json
{
  "records": [
    {
      "id": "uuid",
      "contract_id": "uuid",
      "key": "string",
      "value": "string",
      "data_type": "string",
      "is_sensitive": "boolean",
      "created_by": "uuid",
      "created_at": "ISO8601",
      "updated_at": "ISO8601"
    }
  ],
  "total": 10,
  "page": 1,
  "limit": 20
}
```

**Error Responses:**
- `401` - Authentication required
- `400` - Invalid parameters

#### Get Single Metadata

**GET** `/contracts/{contractId}/metadata/{id}`

Retrieves a specific metadata record by ID.

**Response (200):**
```json
{
  "id": "uuid",
  "contract_id": "uuid",
  "key": "string",
  "value": "string",
  "data_type": "string",
  "is_sensitive": "boolean",
  "created_by": "uuid",
  "updated_by": "uuid",
  "created_at": "ISO8601",
  "updated_at": "ISO8601"
}
```

**Error Responses:**
- `401` - Authentication required
- `404` - Metadata not found

#### Update Metadata

**PATCH** `/contracts/{contractId}/metadata/{id}`

Updates an existing metadata record. Only mutable fields can be updated.

**Request Body:**
```json
{
  "value": "string",
  "is_sensitive": "boolean"
}
```

**Response (200):**
```json
{
  "id": "uuid",
  "contract_id": "uuid",
  "key": "string",
  "value": "string",
  "data_type": "string",
  "is_sensitive": "boolean",
  "created_by": "uuid",
  "updated_by": "uuid",
  "created_at": "ISO8601",
  "updated_at": "ISO8601"
}
```

**Error Responses:**
- `401` - Authentication required
- `400` - Attempting to update immutable fields
- `404` - Metadata not found

#### Delete Metadata

**DELETE** `/contracts/{contractId}/metadata/{id}`

Soft deletes a metadata record. The record is marked as deleted but retained in the database.

**Response (204):** No content

**Error Responses:**
- `401` - Authentication required

## Reputation API
Manage freelancer reviews and ratings. Registered dynamically in the OpenAPI registry. All reputation routes require a valid JWT.

### Get Reputation Profile
**GET** `/api/v1/reputation/:id`

**Permissions**: Requires `reviews.read` (Admin, Client, Freelancer).

Retrieves aggregated scores, total ratings, and a list of reviews for the specific freelancer.

### Submit a Reputation Review
**PUT** `/api/v1/reputation/:id`

(*Also aliased via **POST*** `/api/v1/reputation/:id/rate`)

**Permissions**: Requires `reviews.create`.

Submits a new rating and comment. Duplicate ratings from the same user or self-ratings will trigger a `409 Conflict` or `403 Forbidden` response utilizing the standard Error Envelope.

Request Body:

```JSON
{
  "reviewerId": "123e4567-e89b-12d3-a456-426614174000",
  "rating": 5,
  "comment": "Excellent freelancer!"
}
```

## Jobs DLQ API

### Overview

Dead-letter queue (DLQ) endpoints allow administrators to inspect failed jobs and trigger controlled replays.
These endpoints are protected and audited.

### Authorization

- Requires `Authorization: Bearer <token>`
- Only `demo-admin-token` (or admin users in production auth) can access these routes
- Non-admin users receive `403 Admin role required`

### List DLQ Entries

**GET** `/jobs/dlq`

Optional query parameters:
- `type` - job type (`email-notification`, `contract-processing`, `reputation-update`, `blockchain-sync`)
- `limit` - number of items (default: 50, max: 100)
- `offset` - pagination offset (default: 0)

**Response (200):**
```json
{
  "entries": [
    {
      "jobId": "123",
      "jobType": "email-notification",
      "name": "email-notification",
      "data": {
        "to": "user@example.com",
        "subject": "Welcome",
        "body": "..."
      },
      "failedReason": "Invalid email address",
      "attemptsMade": 1,
      "finishedOn": 1713786060000,
      "timestamp": 1713786059000,
      "replayDeduplicationKey": "replay:email-notification:123"
    }
  ],
  "limit": 50,
  "offset": 0,
  "count": 1
}
```

### Reprocess a Failed Job

**POST** `/jobs/dlq/reprocess`

**Request Body:**
```json
{
  "type": "email-notification",
  "jobId": "123",
  "reason": "Retry after dependency incident resolved"
}
```

Rules:
- `reason` is required and must be at least 5 characters
- Replay is idempotent via deterministic dedupe key: `replay:<type>:<originalJobId>`

**Response (202):** replay enqueued
```json
{
  "replayJobId": "replay:email-notification:123",
  "deduplicated": false,
  "originalJobId": "123",
  "jobType": "email-notification"
}
```

**Response (200):** replay already exists (deduped)
```json
{
  "replayJobId": "replay:email-notification:123",
  "deduplicated": true,
  "originalJobId": "123",
  "jobType": "email-notification"
}
```

**Error Responses:**
- `400` - invalid type or missing fields
- `401` - authentication required
- `403` - admin role required
- `404` - failed job not found
- `409` - job is not in failed state

## Sensitive Data Protection

Metadata marked as `is_sensitive: true` is strictly protected using a **fail-closed** masking policy:

- **Owners** (users who created the metadata) can see the actual clear-text value
- **Admins** can see all sensitive clear-text values
- **Other authenticated users** see `***REDACTED***` instead of the actual value
- **Unknown/Unauthenticated callers** (or any scenario where user context is missing) ALWAYS see `***REDACTED***` instead of the actual value

## Validation Rules

### Key Validation
- Required field
- 1-255 characters
- Only alphanumeric characters, underscores, and hyphens allowed
- Regex: `^[a-zA-Z0-9_-]+$`

### Value Validation
- Required field
- 1-10,000 characters

### Data Types
- Must be one of: `string`, `number`, `boolean`, `json`
- Defaults to `string` if not specified

## Pagination

### Cursor-Based Pagination (Contracts List — recommended)

The `GET /api/v1/contracts` endpoint uses **cursor-based pagination**.  Unlike
offset pagination this approach is O(log n) — it does not degrade as the
dataset grows and it never skips or duplicates rows when records are inserted
between requests.

#### Query Parameters

| Parameter | Type   | Default | Constraints          | Description                                      |
|-----------|--------|---------|----------------------|--------------------------------------------------|
| `limit`   | number | `20`    | 1–100 (inclusive)    | Maximum items to return in one page.             |
| `cursor`  | string | —       | opaque base-64 token | Pagination cursor from the previous page's `nextCursor`. Omit on the first page. |

#### Response Shape

```json
{
  "status": "success",
  "data": {
    "data": [
      {
        "id": "uuid",
        "title": "string",
        "status": "PENDING",
        "createdAt": "ISO8601"
      }
    ],
    "nextCursor": "eyJjcmVhdGVkQXQiOiIyMDI0LTAxLTAxVDAwOjAwOjAwLjAwMFoiLCJpZCI6InV1aWQifQ",
    "hasNextPage": true,
    "limit": 20
  }
}
```

- `nextCursor` is `null` when the current page is the last page.
- `hasNextPage` is `true` when `nextCursor` is non-null.
- The cursor is opaque — do not attempt to parse or construct it manually.

#### Traversal Example

```bash
# First page (no cursor)
curl "http://localhost:3001/api/v1/contracts?limit=10" \
  -H "Authorization: Bearer demo-user-token"

# Next page (use nextCursor from previous response)
curl "http://localhost:3001/api/v1/contracts?limit=10&cursor=<nextCursor>" \
  -H "Authorization: Bearer demo-user-token"
```

#### Ordering

Results are ordered by `createdAt DESC`, with `id DESC` as a tie-breaker when
two contracts share an identical timestamp.  This ordering is stable — adding
new contracts does not change the position of existing items relative to each
other.

#### Error Responses

- `400 Bad Request` — `limit` exceeds 100, is non-positive, or `cursor` is malformed.

### Legacy Offset Pagination (Metadata endpoints)

Metadata list endpoints still use offset-based pagination:

| Parameter | Type   | Default | Constraints | Description          |
|-----------|--------|---------|-------------|----------------------|
| `page`    | number | `1`     | > 0         | Page number.         |
| `limit`   | number | `20`    | 1–100       | Items per page.      |

```json
{
  "records": [...],
  "total": 100,
  "page": 1,
  "limit": 20
}
```

## Error Handling

All endpoints return consistent error responses:

```json
{
  "error": "Error message",
  "details": [
    {
      "field": "field.name",
      "message": "Validation error message"
    }
  ]
}
```

### Common Error Codes
- `400` - Bad Request (validation errors, invalid parameters)
- `401` - Unauthorized (missing or invalid authentication)
- `404` - Not Found (resource doesn't exist)
- `409` - Conflict (duplicate key, resource conflict)
- `422` - Unprocessable Entity (business logic violations)
- `500` - Internal Server Error

## Examples

### Creating Metadata

```bash
curl -X POST http://localhost:3001/api/v1/contracts/123/metadata \
  -H "Authorization: Bearer demo-user-token" \
  -H "Content-Type: application/json" \
  -d '{
    "key": "contract_amount",
    "value": "10000.00",
    "data_type": "number",
    "is_sensitive": true
  }'
```

### Listing Metadata with Filters

```bash
curl -X GET "http://localhost:3001/api/v1/contracts/123/metadata?page=1&limit=10&data_type=number" \
  -H "Authorization: Bearer demo-user-token"
```

### Updating Metadata

```bash
curl -X PATCH http://localhost:3001/api/v1/contracts/123/metadata/456 \
  -H "Authorization: Bearer demo-user-token" \
  -H "Content-Type: application/json" \
  -d '{
    "value": "15000.00"
  }'
```

### Deleting Metadata

```bash
curl -X DELETE http://localhost:3001/api/v1/contracts/123/metadata/456 \
  -H "Authorization: Bearer demo-user-token"
```

## Health Check

**GET** `/health/live`

Returns process liveness only. This endpoint should stay up even while dependencies are degraded.

**Response (200):**
```json
{
  "status": "ok",
  "service": "talenttrust-backend",
  "probe": "live"
}
```

**GET** `/health/ready`

Returns readiness for traffic. It checks SQLite, the Soroban RPC endpoint, and the queue/Redis dependency with bounded timeouts and returns `503` when any dependency is unavailable.

**Response (200):**
```json
{
  "status": "ready",
  "service": "talenttrust-backend",
  "probe": "ready",
  "activeColor": "blue",
  "checks": [
    { "name": "db", "ok": true, "latencyMs": 1 },
    { "name": "stellar-rpc", "ok": true, "latencyMs": 2 },
    { "name": "queue", "ok": true, "latencyMs": 3 }
  ]
}
```

## Development

### Running Tests

```bash
npm test
```

### Starting Development Server

```bash
npm run dev
```

### Building for Production

```bash
npm run build
npm start
```
