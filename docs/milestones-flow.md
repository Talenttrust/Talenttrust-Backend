# Milestones Request Lifecycle

Milestones in TalentTrust are a first-class field on the Contract resource. There are no standalone milestone endpoints — all milestone operations flow through the contracts API via three routes:

| Method | Path | Operation |
|--------|------|-----------|
| `POST` | `/api/v1/contracts` | Create contract with milestones |
| `PATCH` | `/api/v1/contracts/:id` | Update milestones on an existing contract |
| `GET` | `/api/v1/contracts/:id` | Read back the stored contract (including milestones) |

---

## End-to-End Request Flow

```
HTTP Request
     │
     ▼
┌─────────────────────────────┐
│  requestContext middleware   │  seeds requestId + correlationId
└─────────────┬───────────────┘
              │
              ▼
┌─────────────────────────────┐
│  contractIdempotency (POST) │  deduplicates by Idempotency-Key + userId
│  validateContractId (PATCH) │  rejects oversized / empty :id params
└─────────────┬───────────────┘
              │
              ▼
┌─────────────────────────────┐
│       requireAuth           │  verifies HS256 JWT; attaches req.user
└─────────────┬───────────────┘
              │
              ▼
┌─────────────────────────────┐
│    requirePermission        │  RBAC check; ownOnly resolves clientId from DB
└─────────────┬───────────────┘
              │
              ▼
┌─────────────────────────────┐
│  validateSchema / validate  │  Zod schema strips unknown fields, enforces
│  UpdateContract middleware  │  types, lengths, and required fields → 400
└─────────────┬───────────────┘
              │
              ▼
┌─────────────────────────────┐
│     ContractsController     │  extracts DTO from req.body, calls service
└─────────────┬───────────────┘
              │
              ▼
┌─────────────────────────────┐
│      ContractsService       │  validateContractBounds → ContractBoundsError
│                             │  budget vs milestone total check → 422
└─────────────┬───────────────┘
              │
              ▼
┌─────────────────────────────┐
│    ContractRepository       │  parameterised SQL; OCC version check → 409
│    (SQLite via better-      │  INSERT / UPDATE ... WHERE version = ?
│     sqlite3)                │
└─────────────┬───────────────┘
              │
              ▼
         HTTP Response
```

---

## Stage-by-Stage Walkthrough

### 1. Request Context

**Source:** [`src/middleware/requestContext.ts`](../src/middleware/requestContext.ts)

Every inbound request is assigned a `requestId` (from `X-Request-Id` header or generated) and an optional `correlationId` (from `X-Correlation-Id`). These are stored in `AsyncLocalStorage` and automatically included in every log record emitted downstream — no manual parameter passing required.

---

### 2. Idempotency (POST only)

**Source:** [`src/middleware/contractIdempotency.ts`](../src/middleware/contractIdempotency.ts)

`POST /api/v1/contracts` requires an `Idempotency-Key` header. The middleware:

1. Rejects missing keys with `400 bad_request`.
2. Hashes the key + `userId` to form a cache key.
3. On a cache hit with the **same** body hash → returns the cached response with `Idempotency-Replayed: true`.
4. On a cache hit with a **different** body hash → returns `409 conflict`.
5. On a miss → proceeds and caches the response after the handler completes.

---

### 3. Route Parameter Validation (PATCH / GET)

**Source:** [`src/routes/contracts.routes.ts`](../src/routes/contracts.routes.ts) — `validateContractId`

The `:id` param is validated against `contractIdParamSchema` (Zod) before auth runs. This rejects empty strings and IDs exceeding 128 characters with `400 validation_error`, preventing oversized inputs from reaching the DB.

---

### 4. Authentication

**Source:** [`src/middleware/authorization.ts`](../src/middleware/authorization.ts) — `requireAuth`

Validates the `Authorization: Bearer <token>` header using `jsonwebtoken` with HS256 pinned via `JWT_VERIFY_OPTIONS`. On success, attaches a typed `User` (`id`, `email`, `role`) to `req.user`. Failures return `401 unauthorized`.

Required JWT payload:

```json
{ "sub": "<userId>", "email": "<email>", "role": "admin|client|freelancer", "exp": ... }
```

---

### 5. Authorization

**Source:** [`src/middleware/authorization.ts`](../src/middleware/authorization.ts) — `requirePermission`  
**Source:** [`src/lib/authorization.ts`](../src/lib/authorization.ts) — `isAuthorized`

Evaluates the PERMISSION_MATRIX for the `contracts` resource:

| Role | create | read | update | delete | list |
|------|--------|------|--------|--------|------|
| `admin` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `client` | ✅ | own | own | ❌ | own |
| `freelancer` | ❌ | own | own | ❌ | own |
| `auditor` | ❌ | ✅ | ❌ | ❌ | ✅ |

For `ownOnly` entries, `getContractOwnerId` performs a DB lookup to resolve the contract's `clientId`. If the record does not exist, `404 not_found` is returned rather than leaking whether the record exists but is forbidden.

---

### 6. Schema Validation

**Source (POST):** [`src/middleware/validate.middleware.ts`](../src/middleware/validate.middleware.ts) with `createContractSchema`  
**Source (PATCH):** [`src/modules/contracts/validation.middleware.ts`](../src/modules/contracts/validation.middleware.ts) with `updateContractSchema`  
**Source (schemas):** [`src/modules/contracts/dto/contract.dto.ts`](../src/modules/contracts/dto/contract.dto.ts)

Zod validates and strips unknown fields from `req.body`. Milestone-specific constraints enforced here:

| Field | Constraint | Error |
|-------|-----------|-------|
| `title` | 1–100 chars, required | `400 validation_error` |
| `description` | 1–500 chars (required on update, optional on create) | `400 validation_error` |
| `amount` | positive number, ≤ `MAX_CONTRACT_AMOUNT_STROOPS` | `400 validation_error` |
| `deadline` | valid ISO-8601 datetime (optional) | `400 validation_error` |
| `completed` | boolean, defaults to `false` | `400 validation_error` |

Milestone **count** is intentionally not capped at this layer — it is enforced by the service layer as a `422 contract_bounds_error` to keep the error codes distinct.

---

### 7. Controller

**Source:** [`src/controllers/contracts.controller.ts`](../src/controllers/contracts.controller.ts)

The controller is a thin HTTP adapter. It:

- Extracts the validated DTO from `req.body`.
- Calls the appropriate `ContractsService` method.
- Maps `ContractBoundsError` → `422 contract_bounds_error`.
- Delegates all other errors to the Express error handler via `next(error)`.

---

### 8. Service — Business Rules

**Source:** [`src/services/contracts.service.ts`](../src/services/contracts.service.ts)

Two bounds checks run before any DB write:

1. **`validateContractBounds(budget, milestones)`** — enforces:
   - `budget ≤ MAX_CONTRACT_AMOUNT_STROOPS` (100 000 000 000 000 stroops)
   - `milestones.length ≤ MAX_MILESTONES_PER_CONTRACT` (20)
   - `sum(milestone.amount) ≤ MAX_CONTRACT_AMOUNT_STROOPS`

2. **Budget cap** — `sum(milestone.amount) ≤ budget` (the caller-supplied contract budget, which is tighter than the absolute policy cap).

Both throw `ContractBoundsError` on failure, which the controller maps to `422`.

For `updateContract`, the service also enforces OCC:

- Missing `version` → `MissingVersionError` → `400 ERR_MISSING_VERSION`
- Non-integer or negative `version` → `InvalidVersionError` → `400 ERR_INVALID_VERSION`
- Stale `version` (DB mismatch) → `VersionConflictError` → `409 ERR_CONFLICT`

---

### 9. Repository — Persistence

**Source:** [`src/repositories/contractRepository.ts`](../src/repositories/contractRepository.ts)

All SQL uses parameterised prepared statements (`better-sqlite3`). The OCC update is a single atomic statement:

```sql
UPDATE contracts
SET    title = ?, status = ?, amount = ?, ..., version = version + 1
WHERE  id = ? AND version = ?
```

If `changes === 0`, the repository checks whether the row exists:
- Row exists → `VersionConflictError` (stale version)
- Row absent → `NotFoundError` → `404 not_found`

---

## Error Reference

| HTTP | Code | Source layer | Trigger |
|------|------|-------------|---------|
| `400` | `bad_request` | Idempotency middleware | Missing `Idempotency-Key` |
| `400` | `validation_error` | Zod schema | Invalid field types / lengths |
| `400` | `ERR_MISSING_VERSION` | Service | `version` field absent on PATCH |
| `400` | `ERR_INVALID_VERSION` | Service | `version` not a non-negative integer |
| `401` | `unauthorized` | `requireAuth` | Invalid / expired / missing JWT |
| `403` | `forbidden` | `requirePermission` | Role not permitted for action |
| `404` | `not_found` | Repository / permission | Contract does not exist |
| `409` | `conflict` | Idempotency middleware | Same key, different body |
| `409` | `ERR_CONFLICT` | Repository | Stale OCC version |
| `422` | `contract_bounds_error` | Service | Milestone count or amount exceeds policy |
| `500` | `internal_error` | Global error handler | Unexpected runtime error |

All error responses follow the standard envelope:

```json
{
  "error": {
    "code": "contract_bounds_error",
    "message": "Milestone count 21 exceeds maximum of 20",
    "requestId": "req-abc123"
  }
}
```

---

## Key Source Files

| File | Role |
|------|------|
| [`src/routes/contracts.routes.ts`](../src/routes/contracts.routes.ts) | Route registration, param/query validation, middleware wiring |
| [`src/middleware/contractIdempotency.ts`](../src/middleware/contractIdempotency.ts) | POST idempotency guard |
| [`src/middleware/authorization.ts`](../src/middleware/authorization.ts) | `requireAuth` + `requirePermission` |
| [`src/modules/contracts/dto/contract.dto.ts`](../src/modules/contracts/dto/contract.dto.ts) | Zod schemas for create and update |
| [`src/modules/contracts/validation.middleware.ts`](../src/modules/contracts/validation.middleware.ts) | PATCH body validation middleware |
| [`src/controllers/contracts.controller.ts`](../src/controllers/contracts.controller.ts) | HTTP adapter, error mapping |
| [`src/services/contracts.service.ts`](../src/services/contracts.service.ts) | Business rules, bounds checks, OCC validation |
| [`src/contracts/bounds.ts`](../src/contracts/bounds.ts) | Policy constants and `validateContractBounds` |
| [`src/repositories/contractRepository.ts`](../src/repositories/contractRepository.ts) | SQLite persistence, atomic OCC update |
