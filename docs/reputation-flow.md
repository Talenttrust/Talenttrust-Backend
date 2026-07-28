# Reputation Request Lifecycle

This document walks a reputation request end-to-end through every layer of the
Talenttrust-Backend codebase: from the HTTP wire all the way to the SQLite row
and the immutable audit log entry. It covers both operations exposed by the
reputation router.

---

## Table of Contents

1. [Routes at a Glance](#1-routes-at-a-glance)
2. [End-to-End Flow Diagram](#2-end-to-end-flow-diagram)
3. [Layer-by-Layer Walkthrough](#3-layer-by-layer-walkthrough)
   - [3.1 Application Bootstrap](#31-application-bootstrap)
   - [3.2 Global Middleware Stack](#32-global-middleware-stack)
   - [3.3 Router Entry & Authentication](#33-router-entry--authentication)
   - [3.4 Permission Check](#34-permission-check)
   - [3.5 Request Validation (POST / PUT only)](#35-request-validation-post--put-only)
   - [3.6 Controller](#36-controller)
   - [3.7 Service — Business Logic & Anti-Abuse Guards](#37-service--business-logic--anti-abuse-guards)
   - [3.8 Repository — Persistence](#38-repository--persistence)
   - [3.9 Audit Log](#39-audit-log)
   - [3.10 Response](#310-response)
4. [Permission Matrix](#4-permission-matrix)
5. [Data Shapes](#5-data-shapes)
6. [Error Catalogue](#6-error-catalogue)
7. [Key Source Files](#7-key-source-files)

---

## 1. Routes at a Glance

Both routes are mounted under `/api/v1/reputation` in
[`src/app.ts`](../src/app.ts).

| Method | Path                       | Controller method                 | Permission checked      |
|--------|----------------------------|-----------------------------------|-------------------------|
| GET    | `/api/v1/reputation/:id`   | `ReputationController.getProfile` | `reviews` → `read`      |
| PUT    | `/api/v1/reputation/:id`   | `ReputationController.createRating` | `reviews` → `create`  |

> **Note:** There is no separate POST route. The rating-creation endpoint uses
> HTTP `PUT` with the freelancer's UUID as the path parameter (`:id` = `targetId`).

---

## 2. End-to-End Flow Diagram

```
Client
  │
  │  Authorization: Bearer <JWT>
  ▼
┌─────────────────────────────────────────────────────────────┐
│                     Express app                             │
│                                                             │
│  requestIdMiddleware   → stamps X-Request-Id                │
│  createRequestLimits   → body-size + content-type guard     │
│  express.json()        → parses JSON body                   │
│  httpLoggerMiddleware  → structured request log             │
│  metricsService        → Prometheus HTTP counters           │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
             /api/v1/reputation  router
                           │
                    ┌──────┴────────┐
                    │  requireAuth  │  ← applied to ALL routes
                    │  (JWT verify) │    via router.use()
                    └──────┬────────┘
                           │  401 if token missing / invalid / expired
                           ▼
              ┌────────────────────────┐
              │  requirePermission     │
              │  'reviews' → 'read'    │  GET /:id
              │  'reviews' → 'create'  │  PUT /:id
              └────────────┬───────────┘
                           │  403 if role denied by PERMISSION_MATRIX
                           ▼
              ┌────────────────────────┐
              │  validateSchema (Zod)  │  PUT /:id only
              │  updateReputationSchema│
              └────────────┬───────────┘
                           │  400 if body fails Zod rules
                           ▼
              ┌────────────────────────┐
              │   ReputationController │
              │   .getProfile()        │  GET
              │   .createRating()      │  PUT
              └────────────┬───────────┘
                           │
                           ▼
              ┌────────────────────────┐
              │   ReputationService    │
              │  (static methods)      │
              │                        │
              │  Guard 1: self-rating  │
              │  Guard 2: duplicate    │
              │  Guard 3: contract     │
              │           participation│
              │  Guard 4: comment spam │
              └────────────┬───────────┘
                           │  ForbiddenError / ConflictError / ValidationError
                           ▼
              ┌────────────────────────┐
              │  ReputationRepository  │
              │  (SQLite prepared stmts│
              │   via better-sqlite3)  │
              └────────────┬───────────┘
                           │
                           ▼
              ┌────────────────────────┐
              │     AuditService       │
              │  action: REPUTATION_   │
              │          UPDATED       │
              │  severity: INFO        │
              │  comment: sha256 hash  │
              └────────────┬───────────┘
                           │
                           ▼
                    200 / 400 / 403
                    404 / 409 / 422
                    500 JSON response
```

---

## 3. Layer-by-Layer Walkthrough

### 3.1 Application Bootstrap

**File:** [`src/app.ts`](../src/app.ts)

`createApp()` is called once at startup. Before routes are registered it calls:

```ts
const db = getDb();
ReputationService.initialize(db);
```

This injects the open SQLite database connection into `ReputationService` as a
static singleton (`ReputationService.repository`). Every subsequent call to
`createRating` or `getProfile` uses this shared repository instance. If
`initialize()` has not been called the service throws:

```
Error: ReputationService not initialized. Call initialize() first.
```

The reputation router is then mounted:

```ts
app.use('/api/v1/reputation', reputationRouter);
```

---

### 3.2 Global Middleware Stack

Before the request reaches the reputation router it passes through five
app-wide middlewares registered in `createApp()`:

| Middleware | Source | Purpose |
|---|---|---|
| `requestIdMiddleware` | `src/middleware/requestId.ts` | Stamps `X-Request-Id` onto `res.locals.requestId`; used in every error response body |
| `createRequestLimitsMiddleware()` | `src/middleware/requestLimits.ts` | Enforces `MAX_REQUEST_BODY_SIZE`, optional JSON content-type enforcement, and path exclusions |
| `express.json()` | Express built-in | Parses `application/json` bodies; unparseable bodies → `400 SyntaxError` |
| `httpLoggerMiddleware` | `src/middleware/httpLogger.ts` | Structured request/response log (pino) |
| `metricsService.trackHttpRequest` | `src/observability/metrics-service.ts` | Increments Prometheus `http_requests_total` counter |

---

### 3.3 Router Entry & Authentication

**File:** [`src/routes/reputation.routes.ts`](../src/routes/reputation.routes.ts)

The router applies `requireAuth` globally to all routes via:

```ts
router.use(requireAuth);
```

**`requireAuth`** ([`src/middleware/authorization.ts`](../src/middleware/authorization.ts)):

1. Reads the `Authorization` header. Must start with `Bearer `.
2. Calls `jwt.verify(token, JWT_SECRET, JWT_VERIFY_OPTIONS)`.
   - Algorithm is pinned to `['HS256']` — `alg: none` and RS/HS confusion
     attacks are rejected before signature verification.
   - An expired token (`exp` in the past) throws `TokenExpiredError` → 401.
3. Validates required claims: `sub` (user ID), `email`.
4. Re-validates `role` against the `ALL_ROLES` allowlist
   (`admin | auditor | client | freelancer`). A token carrying an unrecognised
   role string is rejected even if the signature is valid.
5. Attaches `req.user = { id, email, role }`.

Any failure → `401 Unauthorized`.

---

### 3.4 Permission Check

**File:** [`src/middleware/authorization.ts`](../src/middleware/authorization.ts) →
[`src/lib/authorization.ts`](../src/lib/authorization.ts)

Both routes call `requirePermission(resource, action)`:

```ts
// GET /:id
router.get('/:id', requirePermission('reviews', 'read'), ReputationController.getProfile);

// PUT /:id
router.put('/:id', requirePermission('reviews', 'create'), validateSchema(...), ReputationController.createRating);
```

`requirePermission` calls `isAuthorized({ user, resource, action })`, which
looks up the cell in `PERMISSION_MATRIX`:

```ts
reviews: {
  create: { admin: ALLOW,  auditor: DENY,  client: ALLOW,  freelancer: ALLOW },
  read:   { admin: ALLOW,  auditor: ALLOW, client: ALLOW,  freelancer: ALLOW },
  update: { admin: ALLOW,  auditor: DENY,  client: OWN,    freelancer: OWN  },
  delete: { admin: ALLOW,  auditor: DENY,  client: DENY,   freelancer: DENY },
  list:   { admin: ALLOW,  auditor: ALLOW, client: ALLOW,  freelancer: ALLOW },
}
```

Neither `read` nor `create` carry an `ownOnly` restriction, so no database
lookup is needed to resolve the record owner. The check is a pure role table
lookup.

Any failure → `403 Forbidden`.

---

### 3.5 Request Validation (POST / PUT only)

**File:** [`src/modules/reputation/dto/reputation.dto.ts`](../src/modules/reputation/dto/reputation.dto.ts)
→ [`src/middleware/validate.middleware.ts`](../src/middleware/validate.middleware.ts)

Applied only to the `PUT /:id` route via `validateSchema(updateReputationSchema)`.

The Zod schema enforces:

| Field | Type | Rules |
|---|---|---|
| `reviewerId` | `string` | Min length 1, required |
| `contextId` | `string` | Must be a valid UUID v4 |
| `rating` | `number` | Finite, integer, min 1, max 5 |
| `comment` | `string` (optional) | Max 1000 chars; must not have any single character comprising > 50% of the text (spam check) |

`validateSchema` calls `schema.parseAsync({ body, query, params })`. On
failure it returns:

```json
{
  "error": {
    "code": "validation_error",
    "message": "Request validation failed",
    "requestId": "<id>",
    "details": [{ "path": ["body", "rating"], "message": "...", "code": "..." }]
  }
}
```
HTTP status: `400`.

---

### 3.6 Controller

**File:** [`src/controllers/reputation.controller.ts`](../src/controllers/reputation.controller.ts)

#### `getProfile` (GET `/:id`)

```ts
const profile = ReputationService.getProfile(req.params.id);
res.status(200).json({ status: 'success', data: profile });
```

Delegates entirely to the service. The only controller-level guard is a check
for the `'Freelancer ID is required'` error message which maps to a `400`.

#### `createRating` (PUT `/:id`)

Adds a **defense-in-depth** rating validation layer on top of the Zod
middleware:

```ts
const isValidRating =
  typeof rating === 'number' &&
  Number.isFinite(rating) &&
  Number.isInteger(rating) &&
  rating >= 1 && rating <= 5;

if (!payload || !payload.reviewerId || !isValidRating) {
  res.status(400).json({ error: { code: 'bad_request', ... } });
  return;
}
```

This guard fires if the Zod middleware is bypassed (e.g., direct controller
invocation in tests or middleware misconfiguration).

Errors from the service are caught by `handleControllerError` and mapped:

| Error class | HTTP status |
|---|---|
| `ValidationError` | 422 |
| `ForbiddenError` | 403 |
| `ConflictError` | 409 |
| Any other `AppError` | `error.statusCode` |
| Unknown | 500 |

---

### 3.7 Service — Business Logic & Anti-Abuse Guards

**File:** [`src/services/reputation.service.ts`](../src/services/reputation.service.ts)

`ReputationService.createRating(reviewerId, targetId, rating, contextId, comment?)` runs
five ordered guards before any write:

#### Guard 1 — Self-rating prevention

```ts
if (reviewerId === targetId) {
  throw new ForbiddenError('Users cannot rate themselves');
}
```

#### Guard 2 — Duplicate-rating prevention (application level)

```ts
const existing = this.repository.findByReviewerTargetContext(reviewerId, targetId, contextId);
if (existing) throw new ConflictError('Rating already exists ...');
```

A DB-level `UNIQUE(reviewer_id, target_id, context_id)` constraint acts as a
safety net if the application check is somehow bypassed.

#### Guard 3 — Contract-participation check

```ts
const reviewerParticipates = this.repository.verifyContractParticipation(contextId, reviewerId);
const targetParticipates   = this.repository.verifyContractParticipation(contextId, targetId);
if (!reviewerParticipates || !targetParticipates) {
  throw new ForbiddenError('Only contract participants can submit ratings');
}
```

This prevents arbitrary users from rating each other without a shared contract.
The repository executes:

```sql
SELECT COUNT(*) as count FROM contracts
WHERE id = ? AND (client_id = ? OR freelancer_id = ?)
```

#### Guard 4 — Comment spam detection (defense-in-depth)

Mirrors the Zod check: rejects comments where any single character comprises
more than 50% of the text. Applied after Zod has already validated, so this
only fires on direct service invocations.

#### Guard 5 — Persist

Calls `this.repository.create(...)` — see §3.8.

#### Guard 6 — Mandatory audit trail

Calls `auditService.log(...)` — see §3.9. If the audit write fails the error
is **re-thrown**, intentionally blocking the response with
`'Failed to create audit trail. Rating not persisted.'`

---

#### `getProfile` — Score computation

`ReputationService.getProfile(targetId)`:

1. Fetches all reputation entries for the target from the repository.
2. Computes a simple mean score.
3. Reads `REPUTATION_DECAY_LAMBDA` and `REPUTATION_SCORE_ALGORITHM_VERSION`
   from env (defaults: `0.005` / `'exp-decay-v1'`).
4. Calls `computeWeightedReputationScore(entries, now, lambda)`:
   - For each entry computes `weight = exp(−λ × ageInDays)`.
   - Returns `weightedSum / totalWeight` (0 when no entries).
5. Returns a `ReputationProfile` with both `score` (simple mean) and
   `weightedScore` (decay-adjusted), both rounded to 2 decimal places.

---

### 3.8 Repository — Persistence

**File:** [`src/repositories/reputationRepository.ts`](../src/repositories/reputationRepository.ts)

All SQL is executed through `better-sqlite3` prepared statements — no string
interpolation, no SQL injection surface.

#### Write path (`create`)

```ts
this.db.prepare(`
  INSERT INTO reputation_entries
    (id, reviewer_id, target_id, rating, comment, context_id, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`).run(id, entry.reviewerId, entry.targetId, entry.rating,
       entry.comment ?? null, entry.contextId, createdAt);
```

The `reputation_entries` table (migration v4) schema:

```sql
CREATE TABLE IF NOT EXISTS reputation_entries (
  id          TEXT    PRIMARY KEY,
  reviewer_id TEXT    NOT NULL REFERENCES users(id),
  target_id   TEXT    NOT NULL REFERENCES users(id),
  rating      INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  comment     TEXT    CHECK (length(comment) <= 1000),
  context_id  TEXT    NOT NULL REFERENCES contracts(id),
  created_at  TEXT    NOT NULL,
  UNIQUE(reviewer_id, target_id, context_id)
);
```

A `SQLITE_CONSTRAINT_UNIQUE` error is caught and re-thrown as `ConflictError`.

#### Read path (`findByTargetId`)

```ts
SELECT * FROM reputation_entries
WHERE target_id = ?
ORDER BY created_at DESC
```

Used by `getProfile` to fetch all reviews for a freelancer.

#### Participation check (`verifyContractParticipation`)

```ts
SELECT COUNT(*) as count FROM contracts
WHERE id = ? AND (client_id = ? OR freelancer_id = ?)
```

Returns `true` when count > 0.

---

### 3.9 Audit Log

**File:** [`src/audit/service.ts`](../src/audit/service.ts)

Every successful `createRating` call produces an immutable audit entry:

```ts
auditService.log({
  action:     'REPUTATION_UPDATED',
  severity:   'INFO',
  actor:      reviewerId,
  resource:   'reputation',
  resourceId: targetId,
  metadata: {
    rating,
    comment: comment ? sha256(comment) : undefined,
    contextId,
  },
});
```

Key properties:

- **Action:** `REPUTATION_UPDATED` — one of the pre-defined `AuditAction` literals.
- **Severity:** `INFO`.
- **Comment hashing:** The comment plaintext is never stored in the audit log.
  It is replaced with a SHA-256 hex digest so reviewers can verify whether two
  entries reference the same comment without exposing the content.
- **Hash chain:** The audit repository appends each entry to an immutable
  chain. Each entry stores `previousHash` (the hash of the preceding entry)
  enabling tamper detection via `auditService.verifyIntegrity()`.

If the audit write throws, `ReputationService.createRating` re-throws the
error to the controller. The controller's `handleControllerError` maps it as a
generic 500.

---

### 3.10 Response

#### Success — GET `/:id`

```json
HTTP 200 OK
{
  "status": "success",
  "data": {
    "freelancerId": "550e8400-e29b-41d4-a716-446655440000",
    "score": 4.33,
    "jobsCompleted": 0,
    "totalRatings": 3,
    "reviews": [
      {
        "reviewerId": "123e4567-e89b-12d3-a456-426614174000",
        "rating": 5,
        "comment": "Excellent freelancer",
        "createdAt": "2025-07-20T10:00:00.000Z"
      }
    ],
    "lastUpdated": "2025-07-20T10:00:00.000Z",
    "weightedScore": 4.51,
    "scoreAlgorithm": "exp-decay-v1"
  }
}
```

#### Success — PUT `/:id`

```json
HTTP 200 OK
{
  "status": "success",
  "data": { /* ReputationProfile of the rated freelancer */ }
}
```

> The route currently returns `200` for a successful rating creation. This is
> intentional — the response body contains the updated profile. A `201 Created`
> would be more idiomatic REST for a resource creation; this is a known design
> note for a future revision.

---

## 4. Permission Matrix

The reputation routes use the **`reviews`** resource key in the permission
matrix (defined in [`src/lib/authorization.ts`](../src/lib/authorization.ts)).
There is no separate `reputation` key.

| Action | admin | auditor | client | freelancer |
|--------|-------|---------|--------|------------|
| `create` | ✅ | ❌ | ✅ | ✅ |
| `read` | ✅ | ✅ | ✅ | ✅ |
| `update` | ✅ | ❌ | own only | own only |
| `delete` | ✅ | ❌ | ❌ | ❌ |
| `list` | ✅ | ✅ | ✅ | ✅ |

The two reputation endpoints use `create` (PUT `/:id`) and `read` (GET `/:id`).
All authenticated roles except `auditor` can submit ratings; all roles can read
profiles.

---

## 5. Data Shapes

### Request body — PUT `/api/v1/reputation/:id`

```ts
{
  reviewerId: string;   // non-empty; the caller's user ID
  contextId:  string;   // UUID v4; the shared contract
  rating:     number;   // integer 1–5 inclusive
  comment?:   string;   // optional; max 1000 chars; no spam (>50% single char)
}
```

### `ReputationProfile` (response)

Defined in [`src/types/reputation.ts`](../src/types/reputation.ts):

```ts
interface ReputationProfile {
  freelancerId:  string;   // target user ID
  score:         number;   // simple mean of all ratings (2 dp)
  jobsCompleted: number;   // deprecated legacy field, always 0
  totalRatings:  number;
  reviews:       Review[];
  lastUpdated:   string;   // ISO 8601; createdAt of most recent entry
  weightedScore: number;   // exp-decay-weighted mean (2 dp)
  scoreAlgorithm: string;  // e.g. "exp-decay-v1"
}

interface Review {
  reviewerId: string;
  rating:     number;
  comment?:   string;
  createdAt:  string;  // ISO 8601
}
```

### `ReputationEntry` (internal / DB domain)

Defined in [`src/repositories/reputationRepository.ts`](../src/repositories/reputationRepository.ts):

```ts
interface ReputationEntry {
  id:         string;
  reviewerId: string;
  targetId:   string;
  rating:     number;
  comment?:   string;
  contextId:  string;
  createdAt:  string;
}
```

---

## 6. Error Catalogue

| Scenario | Guard / layer | HTTP | Body code |
|---|---|---|---|
| Missing / malformed `Authorization` header | `requireAuth` | 401 | `unauthorized` |
| Expired JWT | `requireAuth` | 401 | `unauthorized` |
| Invalid JWT signature | `requireAuth` | 401 | `unauthorized` |
| Unknown role claim | `requireAuth` | 401 | `unauthorized` |
| Role denied by permission matrix | `requirePermission` | 403 | `forbidden` |
| Invalid `rating` (non-integer, out of range) | Zod (`validateSchema`) | 400 | `validation_error` |
| Invalid `contextId` (not a UUID) | Zod (`validateSchema`) | 400 | `validation_error` |
| Missing `reviewerId` | Zod / controller guard | 400 | `bad_request` / `validation_error` |
| Comment > 1000 chars | Zod / service | 400 / 422 | `validation_error` |
| Comment spam (>50% single char) | Zod / service | 400 / 422 | `validation_error` |
| Self-rating (`reviewerId === targetId`) | `ReputationService` guard 1 | 403 | `forbidden` |
| Duplicate rating (same reviewer + target + context) | `ReputationService` guard 2 | 409 | `conflict` |
| Reviewer or target not on contract | `ReputationService` guard 3 | 403 | `forbidden` |
| Audit log write failure | `ReputationService` guard 6 | 500 | `internal_error` |
| Missing `Freelancer ID` (`getProfile` called with empty string) | Controller | 400 | `bad_request` |
| Unhandled service error | Controller | 500 | `internal_error` |

---

## 7. Key Source Files

| File | Role |
|---|---|
| [`src/app.ts`](../src/app.ts) | App factory; calls `ReputationService.initialize(db)`, mounts router at `/api/v1/reputation` |
| [`src/routes/reputation.routes.ts`](../src/routes/reputation.routes.ts) | Route definitions; applies `requireAuth` globally, `requirePermission` per-route, `validateSchema` on PUT |
| [`src/middleware/authorization.ts`](../src/middleware/authorization.ts) | `requireAuth` (JWT verification) and `requirePermission` (matrix lookup) implementations |
| [`src/lib/authorization.ts`](../src/lib/authorization.ts) | `PERMISSION_MATRIX` — the authoritative role → action → allow/deny table |
| [`src/modules/reputation/dto/reputation.dto.ts`](../src/modules/reputation/dto/reputation.dto.ts) | Zod schema (`updateReputationSchema`) for PUT body validation |
| [`src/middleware/validate.middleware.ts`](../src/middleware/validate.middleware.ts) | `validateSchema` middleware factory |
| [`src/controllers/reputation.controller.ts`](../src/controllers/reputation.controller.ts) | HTTP layer; delegates to service; maps service errors to HTTP codes |
| [`src/services/reputation.service.ts`](../src/services/reputation.service.ts) | Core business logic; anti-abuse guards; `computeWeightedReputationScore`; audit call |
| [`src/repositories/reputationRepository.ts`](../src/repositories/reputationRepository.ts) | SQLite data access layer; all queries use prepared statements |
| [`src/types/reputation.ts`](../src/types/reputation.ts) | Public domain types: `ReputationProfile`, `Review`, `UpdateReputationPayload` |
| [`src/audit/service.ts`](../src/audit/service.ts) | Immutable audit log; `REPUTATION_UPDATED` entries written on every successful rating |
| [`src/db/migrations.ts`](../src/db/migrations.ts) | Migration v4 — `reputation_entries` table DDL |
