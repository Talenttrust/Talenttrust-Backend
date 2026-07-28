# Reputation API — Request Examples

Copy-paste `curl` examples for the reputation endpoints, verified against the
current route/controller/service implementation (`src/routes/reputation.routes.ts`,
`src/controllers/reputation.controller.ts`, `src/services/reputation.service.ts`)
and the passing test suite (`src/controllers/reputation.controller.test.ts`,
`src/services/reputation.service.test.ts`, `src/controllers/reputation.validation.test.ts`).

For full field-by-field reference, error codes, and the scoring algorithm, see
[`docs/reputation.md`](./reputation.md). This file focuses on runnable examples only.

## Base URL and authentication

All endpoints below assume a local server on port 3001 and require a bearer JWT:

```bash
BASE_URL="http://localhost:3001"
TOKEN="<your-jwt>"   # must decode to { sub, email, role } with role in [admin, client, freelancer, auditor]
```

A request with no `Authorization` header, or an invalid/expired token, returns
`401 Unauthorized` before any route handler runs.

---

## GET /api/v1/reputation/:id

Retrieves the aggregated reputation profile for a freelancer. Available to
every authenticated role.

### Example request

```bash
curl -s -X GET "$BASE_URL/api/v1/reputation/api-user-123" \
  -H "Authorization: Bearer $TOKEN"
```

### Example response — 200 OK (freelancer with ratings)

```json
{
  "status": "success",
  "data": {
    "freelancerId": "api-user-123",
    "score": 4.5,
    "jobsCompleted": 0,
    "totalRatings": 10,
    "reviews": [],
    "lastUpdated": "2026-07-26T00:00:00.000Z",
    "weightedScore": 4.5,
    "scoreAlgorithm": "exp-decay-v1"
  }
}
```

`jobsCompleted` is a deprecated legacy field — it is always `0`. Do not rely on it.

### Example response — 200 OK (new freelancer, no ratings yet)

A freelancer with no ratings yet does **not** 404 — a zero-valued profile is
returned instead:

```json
{
  "status": "success",
  "data": {
    "freelancerId": "brand-new-user",
    "score": 0,
    "jobsCompleted": 0,
    "totalRatings": 0,
    "reviews": [],
    "lastUpdated": "2026-07-26T00:00:00.000Z",
    "weightedScore": 0,
    "scoreAlgorithm": "exp-decay-v1"
  }
}
```

### Example response — 401 Unauthorized

```bash
curl -s -X GET "$BASE_URL/api/v1/reputation/api-user-123"
```

```json
{
  "error": {
    "code": "unauthorized",
    "message": "Missing or malformed Authorization header.",
    "requestId": "unknown"
  }
}
```

---

## PUT /api/v1/reputation/:id

Submits a new reputation rating for a freelancer.

### Example request — valid payload

```bash
curl -s -X PUT "$BASE_URL/api/v1/reputation/api-user-123" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "reviewerId": "123e4567-e89b-12d3-a456-426614174000",
    "contextId": "550e8400-e29b-41d4-a716-446655440000",
    "rating": 5,
    "comment": "Excellent freelancer, highly recommended!"
  }'
```

### Example response — 200 OK

```json
{
  "status": "success",
  "data": {
    "freelancerId": "api-user-123",
    "score": 4.5,
    "jobsCompleted": 0,
    "totalRatings": 10,
    "reviews": [],
    "lastUpdated": "2026-07-26T00:00:00.000Z",
    "weightedScore": 4.5,
    "scoreAlgorithm": "exp-decay-v1"
  }
}
```

> ### ⚠️ Known limitation — ratings are not actually persisted
>
> `ReputationController.createRating` (`src/controllers/reputation.controller.ts`)
> calls `(ReputationService as any).updateProfile(id, payload)` if that method
> exists, otherwise falls back to `ReputationService.getProfile(id)`. **No
> `updateProfile` method exists anywhere on `ReputationService`** — only
> `createRating` and `getProfile` are defined
> (`src/services/reputation.service.ts`). The ternary in the controller
> therefore *always* takes the fallback branch.
>
> **In practice today: a `PUT` request with a fully valid payload passes every
> validation and permission check, returns `200 OK`, and the response body is
> simply the freelancer's current, unmodified profile.** The submitted
> `rating`/`comment`/`contextId` are validated but never written to storage,
> and none of the real `ReputationService.createRating` guards (self-rating
> prevention, duplicate prevention, contract-participation check, audit
> logging) are ever exercised via this HTTP path.
>
> This is confirmed by `src/controllers/reputation.controller.test.ts`, whose
> `createRating` success/error-path tests all mock
> `ReputationService.getProfile` (not `createRating`) — the mock the real
> code path actually calls. The full `ReputationService.createRating` logic
> is unit-tested directly in `src/services/reputation.service.test.ts`, but
> is not reachable through this route.
>
> The examples above document the endpoint's **actual current behavior**
> (validates, authenticates, returns 200, does not persist) rather than its
> intended design, per this issue's requirement to verify examples against
> the route. Wiring the controller to the real `ReputationService.createRating`
> method is a separate fix, out of scope for this documentation issue.

### Example request — invalid rating (out of range)

```bash
curl -s -X PUT "$BASE_URL/api/v1/reputation/api-user-123" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "reviewerId": "123e4567-e89b-12d3-a456-426614174000",
    "contextId": "550e8400-e29b-41d4-a716-446655440000",
    "rating": 6
  }'
```

### Example response — 400 Bad Request (Zod schema validation)

```json
{
  "error": "Validation failed",
  "details": [
    "body.rating: Rating must be at most 5"
  ]
}
```

### Example request — missing required field

```bash
curl -s -X PUT "$BASE_URL/api/v1/reputation/api-user-123" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "reviewerId": "123e4567-e89b-12d3-a456-426614174000",
    "rating": 3
  }'
```

Missing `contextId` fails schema validation (it's a required UUID field):

```json
{
  "error": "Validation failed",
  "details": [
    "body.contextId: contextId must be a valid UUID"
  ]
}
```

### Example response — 401 Unauthorized

Same shape as the `GET` endpoint's 401 — missing/invalid/expired bearer token.

### Example response — 403 Forbidden (role lacks permission)

An `auditor` role does not have `reviews.create` permission:

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

## Notes on response shape inconsistency

The two endpoints use different error envelopes depending on which layer
raises the error:

- Route/middleware-level errors (401, 403 from `requirePermission`, 500 from
  `getProfile`) use: `{ "error": { "code", "message", "requestId" } }`
- Zod schema validation errors (400 on `PUT`) use: `{ "error": "Validation failed", "details": [...] }`
- Service-layer business-rule errors that *would* fire from
  `ReputationService.createRating` directly (403 self-rating, 409 duplicate,
  422 spam) use the legacy shape: `{ "status": "error", "message": "..." }`
  — but see the known limitation above: this code path is not currently
  reachable via `PUT /api/v1/reputation/:id` in production.

See [`docs/backend/error-handling.md`](./backend/error-handling.md) for the
project-wide error envelope policy.
