# Reputation API

Reference documentation for the TalentTrust Backend reputation endpoints.
Every section maps directly to the source code; cross-references are noted inline.

## Table of contents

- [Overview](#overview)
- [Base URL](#base-url)
- [Authentication](#authentication)
- [Authorization](#authorization)
- [Error envelope](#error-envelope)
- [Endpoints](#endpoints)
  - [GET /api/v1/reputation/:id](#get-apiv1reputationid)
  - [PUT /api/v1/reputation/:id](#put-apiv1reputationid)
- [Data types](#data-types)
  - [ReputationProfile](#reputationprofile)
  - [Review](#review)
  - [UpdateReputationPayload](#updatereputationpayload)
- [Error codes](#error-codes)
- [Scoring algorithm](#scoring-algorithm)
- [Related docs](#related-docs)

---

## Overview

The Reputation API lets integrators read a freelancer's public reputation
profile and submit a new rating against a completed contract.  All endpoints
require a valid JWT bearer token.

### Feature Flag

The reputation system is controlled by the `REPUTATION_ENABLED` environment
variable. When set to `false` (default), all reputation endpoints return a
`403 Forbidden` error with the message "Reputation system is currently disabled".
This allows the reputation behavior to be toggled at runtime without requiring
a deployment.

To enable the reputation system, set `REPUTATION_ENABLED=true` in your
environment configuration.

Source files:

| Layer | File |
|-------|------|
| Routes | `src/routes/reputation.routes.ts` |
| Controller | `src/controllers/reputation.controller.ts` |
| Service | `src/services/reputation.service.ts` |
| Repository | `src/repositories/reputationRepository.ts` |
| DTO / validation | `src/modules/reputation/dto/reputation.dto.ts` |
| Types | `src/types/reputation.ts` |

---

## Base URL

```
/api/v1/reputation
```

---

## Authentication

All reputation routes are protected by the `requireAuth` middleware (added at
the router level in `reputation.routes.ts`).  Requests must include a valid
JWT in the `Authorization` header:

```
Authorization: Bearer <token>
```

A missing or invalid token returns `401 Unauthorized` before any route handler
runs.

Demo tokens for local testing:

| Token | Role |
|-------|------|
| `demo-admin-token` | `admin` |
| `demo-user-token` | `freelancer` |

---

## Authorization

Role-based access control is enforced by the `requirePermission` middleware
after authentication.  The permission matrix for the `reviews` resource
(`src/lib/authorization.ts`) is:

| Role | `reviews.read` | `reviews.create` |
|------|:-:|:-:|
| `admin` | ✅ | ✅ |
| `auditor` | ✅ | ❌ |
| `client` | ✅ | ✅ |
| `freelancer` | ✅ | ✅ |

Callers with a denied action receive `403 Forbidden` with the error code
`forbidden`.

---

## Error envelope

All error responses follow the project-standard envelope:

```json
{
  "error": {
    "code": "machine_readable_code",
    "message": "human-readable message",
    "requestId": "correlation-id"
  }
}
```

Some service-layer errors (403, 409, 422) use a legacy two-field shape:

```json
{
  "status": "error",
  "message": "human-readable message"
}
```

Both shapes are described per-endpoint below.

---

## Endpoints

### GET /api/v1/reputation/:id

Retrieves the aggregated reputation profile for a single freelancer.

**Permission required:** `reviews.read` — granted to every authenticated role.

#### Path parameters

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `id` | string (UUID) | ✅ | The freelancer's user ID. |

#### Request

No body.

```bash
curl -X GET http://localhost:3001/api/v1/reputation/550e8400-e29b-41d4-a716-446655440000 \
  -H "Authorization: Bearer demo-admin-token"
```

#### Responses

**200 OK — profile found (including new users with no ratings)**

A `200` is always returned when the request is valid.  New freelancers with
no ratings receive a zero-valued profile rather than a 404.

```json
{
  "status": "success",
  "data": {
    "freelancerId": "550e8400-e29b-41d4-a716-446655440000",
    "score": 4.25,
    "jobsCompleted": 0,
    "totalRatings": 4,
    "reviews": [
      {
        "reviewerId": "123e4567-e89b-12d3-a456-426614174000",
        "rating": 5,
        "comment": "Delivered ahead of schedule.",
        "createdAt": "2024-06-01T10:00:00.000Z"
      },
      {
        "reviewerId": "223e4567-e89b-12d3-a456-426614174001",
        "rating": 4,
        "comment": "Good communication throughout.",
        "createdAt": "2024-04-15T08:30:00.000Z"
      }
    ],
    "lastUpdated": "2024-06-01T10:00:00.000Z",
    "weightedScore": 4.58,
    "scoreAlgorithm": "exp-decay-v1"
  }
}
```

**Response body fields — see [ReputationProfile](#reputationprofile) for full
type details.**

---

**400 Bad Request**

Only reached if the service receives a missing `targetId` (not possible via
normal HTTP routing, but covered defensively).

```json
{
  "error": {
    "code": "bad_request",
    "message": "Freelancer ID is required",
    "requestId": "req-abc123"
  }
}
```

---

**401 Unauthorized**

```json
{
  "error": {
    "code": "unauthorized",
    "message": "Authentication required.",
    "requestId": "req-abc123"
  }
}
```

---

**500 Internal Server Error**

```json
{
  "error": {
    "code": "internal_error",
    "message": "An unexpected error occurred",
    "requestId": "req-abc123"
  }
}
```

---

**403 Forbidden — reputation system disabled**

Returned when the `REPUTATION_ENABLED` feature flag is set to `false`.

```json
{
  "status": "error",
  "message": "Reputation system is currently disabled"
}
```

---

### PUT /api/v1/reputation/:id

Submits a new reputation rating for a freelancer.  The caller must be an
authenticated contract participant (either `client` or `freelancer` — or
`admin`) and must not have already rated the same subject on the same contract.

**Permission required:** `reviews.create` — granted to `admin`, `client`, and
`freelancer`.  Denied to `auditor`.

#### Path parameters

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `id` | string (UUID) | ✅ | The target freelancer's user ID (the person being rated). |

#### Request body

`Content-Type: application/json`

Schema source: `src/modules/reputation/dto/reputation.dto.ts`

| Field | Type | Required | Constraints | Description |
|-------|------|:--------:|-------------|-------------|
| `reviewerId` | string | ✅ | Min 1 character | The authenticated user submitting the rating. |
| `contextId` | string (UUID) | ✅ | Valid UUID format | The contract/engagement this rating is tied to. |
| `rating` | integer | ✅ | Finite integer, 1–5 inclusive | The numeric score. Decimals, `NaN`, and `Infinity` are rejected. |
| `comment` | string | ❌ | Max 1000 chars; no single character may exceed 50% of the text | Optional free-text review. |

```json
{
  "reviewerId": "123e4567-e89b-12d3-a456-426614174000",
  "contextId": "550e8400-e29b-41d4-a716-446655440001",
  "rating": 5,
  "comment": "Excellent freelancer, highly recommended!"
}
```

#### Request

```bash
curl -X PUT http://localhost:3001/api/v1/reputation/550e8400-e29b-41d4-a716-446655440000 \
  -H "Authorization: Bearer demo-admin-token" \
  -H "Content-Type: application/json" \
  -d '{
    "reviewerId": "123e4567-e89b-12d3-a456-426614174000",
    "contextId": "550e8400-e29b-41d4-a716-446655440001",
    "rating": 5,
    "comment": "Excellent freelancer, highly recommended!"
  }'
```

#### Responses

**200 OK — rating accepted**

The updated profile is returned.  Note: The route is registered as `PUT`, and
the controller currently returns `200` (not `201`).

```json
{
  "status": "success",
  "data": {
    "freelancerId": "550e8400-e29b-41d4-a716-446655440000",
    "score": 4.50,
    "jobsCompleted": 0,
    "totalRatings": 2,
    "reviews": [
      {
        "reviewerId": "123e4567-e89b-12d3-a456-426614174000",
        "rating": 5,
        "comment": "Excellent freelancer, highly recommended!",
        "createdAt": "2024-07-01T12:00:00.000Z"
      }
    ],
    "lastUpdated": "2024-07-01T12:00:00.000Z",
    "weightedScore": 4.62,
    "scoreAlgorithm": "exp-decay-v1"
  }
}
```

---

**400 Bad Request — Zod validation failure**

Returned by the `validateSchema` middleware when the request body does not
satisfy the DTO schema.  Shape matches the project validation framework:

```json
{
  "error": "Validation failed",
  "details": [
    "body.rating: Rating must be an integer",
    "body.contextId: contextId must be a valid UUID"
  ]
}
```

The controller also has a defense-in-depth guard that returns a different 400
shape if it somehow receives an invalid payload after the middleware:

```json
{
  "error": {
    "code": "bad_request",
    "message": "Invalid payload: reviewerId and a valid integer rating (1–5) are required",
    "requestId": "req-abc123"
  }
}
```

---

**401 Unauthorized**

```json
{
  "error": {
    "code": "unauthorized",
    "message": "Authentication required.",
    "requestId": "req-abc123"
  }
}
```

---

**403 Forbidden — self-rating**

A user may not rate themselves (`reviewerId === id`).

```json
{
  "status": "error",
  "message": "Users cannot rate themselves"
}
```

---

**403 Forbidden — not a contract participant**

Both the reviewer and the target must appear on the referenced contract
(`contextId`).

```json
{
  "status": "error",
  "message": "Only contract participants can submit ratings"
}
```

---

**403 Forbidden — permission denied**

Returned by `requirePermission` when the caller's role does not have
`reviews.create` access (e.g., `auditor`).

```json
{
  "error": {
    "code": "forbidden",
    "message": "You do not have permission to perform this action.",
    "requestId": "req-abc123"
  }
}
```

---

**403 Forbidden — reputation system disabled**

Returned when the `REPUTATION_ENABLED` feature flag is set to `false`.

```json
{
  "status": "error",
  "message": "Reputation system is currently disabled"
}
```

---

**409 Conflict — duplicate rating**

One rating is allowed per `(reviewerId, targetId, contextId)` triple.  Both
an application-level check and a SQLite `UNIQUE` constraint enforce this.

```json
{
  "status": "error",
  "message": "Rating already exists for this reviewer, target, and context"
}
```

---

**422 Unprocessable Entity — business rule violation**

Returned when a comment passes Zod schema validation but fails a service-layer
content policy (e.g., spam detection).

```json
{
  "status": "error",
  "message": "Comment contains excessive repetitive content"
}
```

---

**500 Internal Server Error**

```json
{
  "status": "error",
  "message": "Internal server error"
}
```

---

## Data types

### ReputationProfile

Returned in the `data` field of all successful responses.

Source: `src/types/reputation.ts`

```typescript
interface ReputationProfile {
  freelancerId: string;    // UUID of the rated freelancer
  score: number;           // Arithmetic mean of all ratings, rounded to 2 decimal places (0.0–5.0)
  jobsCompleted: number;   // Legacy field; always 0 — deprecated, do not rely on this value
  totalRatings: number;    // Total number of individual ratings received
  reviews: Review[];       // Array of individual review objects, ordered by createdAt DESC
  lastUpdated: string;     // ISO 8601 timestamp of the most recent rating, or current time if none
  weightedScore: number;   // Recency-weighted score using exponential time decay (0.0–5.0)
  scoreAlgorithm: string;  // Algorithm identifier, e.g. "exp-decay-v1"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `freelancerId` | string (UUID) | The rated user's ID. |
| `score` | number | Simple arithmetic mean of all ratings.  Rounded to 2 decimal places.  `0` when there are no ratings. |
| `jobsCompleted` | number | **Deprecated** legacy field — always `0`. |
| `totalRatings` | number | Count of rating entries for this freelancer. |
| `reviews` | `Review[]` | Individual review records, newest first. |
| `lastUpdated` | string (ISO 8601) | Timestamp of the most recent review; current UTC time if no reviews exist. |
| `weightedScore` | number | Exponential time-decay weighted score.  Newer ratings have higher weight. `0` when there are no ratings. |
| `scoreAlgorithm` | string | Algorithm version identifier, controlled by `REPUTATION_SCORE_ALGORITHM_VERSION` env var (default: `"exp-decay-v1"`). |

---

### Review

Source: `src/types/reputation.ts`

```typescript
interface Review {
  reviewerId: string;   // UUID of the user who submitted the rating
  rating: number;       // Integer 1–5
  comment?: string;     // Optional free-text comment (absent if no comment was provided)
  createdAt: string;    // ISO 8601 timestamp when the rating was persisted
}
```

| Field | Type | Description |
|-------|------|-------------|
| `reviewerId` | string (UUID) | The rater's user ID. |
| `rating` | integer (1–5) | Numeric score. |
| `comment` | string (optional) | Free-text review comment.  Omitted from the object entirely if not provided. |
| `createdAt` | string (ISO 8601) | UTC creation timestamp. |

---

### UpdateReputationPayload

The shape accepted by `PUT /api/v1/reputation/:id`.

Source: `src/modules/reputation/dto/reputation.dto.ts`

```typescript
const updateReputationSchema = z.object({
  reviewerId: z.string().min(1),
  contextId:  z.string().uuid(),
  rating:     z.number().finite().int().min(1).max(5),
  comment:    z.string().max(1000).refine(isNotSpamComment).optional(),
});
```

| Field | Type | Required | Constraints |
|-------|------|:--------:|-------------|
| `reviewerId` | string | ✅ | Non-empty. |
| `contextId` | string (UUID) | ✅ | Must be a valid UUID (format `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`). |
| `rating` | integer | ✅ | Finite, integer, inclusive range [1, 5].  `NaN`, `Infinity`, `-Infinity`, and decimal values are all rejected. |
| `comment` | string | ❌ | Maximum 1000 characters.  Rejected if any single character makes up >50% of the text (spam guard). |

---

## Error codes

The following error codes may appear in Reputation API responses.  Codes are
stable API contract strings; clients may branch on them safely.

| HTTP status | Error code | Trigger |
|:-----------:|------------|---------|
| 400 | `bad_request` | Missing or invalid `reviewerId`, missing or out-of-range `rating` (defense-in-depth guard in controller). |
| 400 | `validation_error` | Zod schema validation failure from `validateSchema` middleware. |
| 401 | `unauthorized` | Missing or invalid JWT bearer token. |
| 403 | `forbidden` | `requirePermission` denied the caller's role, or service-layer self-rating / contract-participation check failed. |
| 403 | `forbidden` | `REPUTATION_ENABLED` feature flag is set to `false`. |
| 409 | `conflict` | Duplicate `(reviewerId, targetId, contextId)` rating already exists. |
| 422 | `validation_error` | Service-layer comment validation failure (spam, whitespace-only). |
| 500 | `internal_error` | Unexpected server error (DB failure, audit log failure, etc.). |

> **Note on 403 response shape.** Middleware-level 403 uses the project
> envelope (`{ "error": { "code": "forbidden", ... } }`).  Service-layer 403
> (self-rating, non-participant) uses the legacy shape
> (`{ "status": "error", "message": "..." }`).

---

## Scoring algorithm

### score (arithmetic mean)

A simple average of all rating values, rounded to 2 decimal places.

```
score = sum(ratings) / count(ratings)
```

### weightedScore (exponential time decay)

Recent ratings contribute more than older ones.  The formula is:

```
weight_i     = exp(-λ × age_i_in_days)
weightedScore = Σ(rating_i × weight_i) / Σ(weight_i)
```

Where `λ` is `REPUTATION_DECAY_LAMBDA` (default `0.005`).

With the default decay constant, a rating loses roughly half its weight every
139 days.

| Age | Weight (λ=0.005) |
|-----|-----------------|
| 0 days (today) | 1.000 |
| 30 days | 0.861 |
| 90 days | 0.638 |
| 180 days | 0.407 |
| 365 days | 0.166 |
| 730 days | 0.028 |

`weightedScore` returns `0` for a freelancer with no ratings.

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `REPUTATION_DECAY_LAMBDA` | `0.005` | Decay constant λ.  Positive float, range (0, 1]. Higher values decay faster. |
| `REPUTATION_SCORE_ALGORITHM_VERSION` | `exp-decay-v1` | Algorithm identifier returned in `scoreAlgorithm`. |

Full details: [`docs/reputation-scoring.md`](./reputation-scoring.md)

---

## Anti-abuse protections

The following guards are applied (in order) on every `PUT` request:

1. **Authentication** — JWT token required (`requireAuth` middleware).
2. **Role-based permission** — `reviews.create` checked (`requirePermission` middleware).
3. **Schema validation** — Zod DTO validates body shape, types, and ranges (`validateSchema` middleware).
4. **Defense-in-depth guard** — Controller re-validates `reviewerId` presence and rating bounds.
5. **Self-rating prevention** — `reviewerId === targetId` → 403.
6. **Duplicate prevention** — One rating per `(reviewerId, targetId, contextId)` → 409.  Enforced at both application and database (`UNIQUE` constraint) levels.
7. **Contract participation check** — Both reviewer and target must appear on the contract referenced by `contextId` → 403.
8. **Comment validation** — Enforced by Zod (max length, spam pattern) and service layer (defense-in-depth).
9. **Audit log** — Every successful write produces an immutable audit entry.  If audit logging fails the entire request fails; no silent skips.

---

## Observability

Every `GET` and `PUT` reputation request emits:

- `reputation_requests_total` with bounded operation, status, status-code, and error-cause labels
- `reputation_request_duration_seconds` with the same bounded labels
- `reputation_errors_total` for client and server failures
- A structured `reputation_request` completion log with method, operation, status, status code, error cause, and duration

The instrumentation runs before authentication and validation, so `401`, `403`,
and `400` failures are included. It never logs or labels freelancer IDs,
reviewer IDs, comments, request bodies, headers, or raw exception messages.
Metrics are available from the Prometheus scrape endpoint at `GET /metrics`.

---

## Related docs

- [`docs/backend/reputation-system.md`](./backend/reputation-system.md) — internal architecture, DB schema, anti-abuse design.
- [`docs/reputation-scoring.md`](./reputation-scoring.md) — algorithm deep-dive, edge cases, bulk recompute.
- [`docs/backend/authentication-authorization.md`](./backend/authentication-authorization.md) — full RBAC matrix and token lifecycle.
- [`docs/backend/error-handling.md`](./backend/error-handling.md) — project-wide error envelope and status-code guarantees.
- [`docs/backend/request-validation-framework.md`](./backend/request-validation-framework.md) — how `validateSchema` middleware works.
