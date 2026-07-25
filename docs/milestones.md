# Milestones API Contract

Milestones in TalentTrust are a first-class field on the Contract resource. There are no standalone milestone endpoints — all milestone operations flow through the contracts API.

**Cross-references:** [`src/routes/contracts.routes.ts`](../src/routes/contracts.routes.ts), [`src/modules/contracts/dto/contract.dto.ts`](../src/modules/contracts/dto/contract.dto.ts), [`src/contracts/bounds.ts`](../src/contracts/bounds.ts)

---

## Table of Contents

- [Milestone Object Shape](#milestone-object-shape)
- [Policy Bounds](#policy-bounds)
- [Endpoints](#endpoints)
  - [Create Contract with Milestones](#create-contract-with-milestones)
  - [Update Contract (Including Milestones)](#update-contract-including-milestones)
  - [Get Contract (Including Milestones)](#get-contract-including-milestones)
  - [Get Contract Bounds](#get-contract-bounds)
- [Error Codes](#error-codes)
- [Authentication & Permissions](#authentication--permissions)
- [Idempotency](#idempotency)

---

## Milestone Object Shape

```json
{
  "title": "string (1-100 chars, required)",
  "description": "string (1-500 chars, defaults to '' on create)",
  "amount": "number (positive, required)",
  "deadline": "ISO 8601 datetime string (optional)",
  "completed": "boolean (defaults to false)"
}
```

### Field Constraints

| Field | Type | Required | Constraints | Source |
|-------|------|----------|-------------|--------|
| `title` | `string` | Yes | 1–100 characters | [`contract.dto.ts:16`](../src/modules/contracts/dto/contract.dto.ts#L16) |
| `description` | `string` | Create: no (default `''`), Update: yes | 1–500 characters | [`contract.dto.ts:17`](../src/modules/contracts/dto/contract.dto.ts#L17) |
| `amount` | `number` | Yes | Positive (`> 0`) | [`contract.dto.ts:18`](../src/modules/contracts/dto/contract.dto.ts#L18) |
| `deadline` | `string` | No | Valid ISO 8601 datetime | [`contract.dto.ts:19`](../src/modules/contracts/dto/contract.dto.ts#L19) |
| `completed` | `boolean` | No | Defaults to `false` | [`contract.dto.ts:20`](../src/modules/contracts/dto/contract.dto.ts#L20) |

---

## Policy Bounds

Defined in [`src/contracts/bounds.ts:9-10`](../src/contracts/bounds.ts#L9-L10):

| Constant | Value | Description |
|----------|-------|-------------|
| `MAX_MILESTONES_PER_CONTRACT` | `20` | Maximum number of milestones per contract |
| `MAX_CONTRACT_AMOUNT_STROOPS` | `100,000,000,000,000` | Maximum contract amount in stroops (10,000,000 XLM) |

**Additional business rule** (enforced in [`contracts.service.ts:71-81`](../src/services/contracts.service.ts#L71-L81)):
- The sum of all milestone `amount` values must not exceed the contract's `budget`.

---

## Endpoints

### Create Contract with Milestones

```
POST /api/v1/contracts
```

Creates a new contract with optional milestones.

#### Headers

| Header | Required | Description |
|--------|----------|-------------|
| `Authorization` | Yes | `Bearer <JWT>` |
| `Idempotency-Key` | Yes | UUID for idempotent creation |

#### Request Body

```json
{
  "title": "Website Redesign",
  "description": "Complete redesign of the company website",
  "clientId": "550e8400-e29b-41d4-a716-446655440000",
  "freelancerId": "660e8400-e29b-41d4-a716-446655440001",
  "budget": 5000000,
  "deadline": "2026-12-31T23:59:59.000Z",
  "status": "draft",
  "milestones": [
    {
      "title": "Design Mockups",
      "description": "Create wireframes and high-fidelity mockups",
      "amount": 1500000,
      "deadline": "2026-09-30T23:59:59.000Z",
      "completed": false
    },
    {
      "title": "Frontend Implementation",
      "description": "Implement responsive frontend based on approved mockups",
      "amount": 2000000,
      "deadline": "2026-11-30T23:59:59.000Z",
      "completed": false
    },
    {
      "title": "Final Delivery",
      "description": "Deploy to production and handoff documentation",
      "amount": 1500000,
      "deadline": "2026-12-31T23:59:59.000Z",
      "completed": false
    }
  ]
}
```

#### Required Contract Fields

| Field | Type | Constraints |
|-------|------|-------------|
| `title` | `string` | 5–100 characters |
| `description` | `string` | 10–1000 characters |
| `clientId` | `string` | Valid UUID |
| `budget` | `number` | Positive, ≤ `MAX_CONTRACT_AMOUNT_STROOPS` |
| `freelancerId` | `string` | Valid UUID (optional) |
| `deadline` | `string` | ISO 8601 datetime (optional) |
| `status` | `string` | `draft`, `active`, `completed`, `cancelled`, or `disputed` (optional) |
| `terms` | `string` | Free text (optional) |

#### Response (201 Created)

```json
{
  "status": "success",
  "data": {
    "id": "770e8400-e29b-41d4-a716-446655440002",
    "title": "Website Redesign",
    "clientId": "550e8400-e29b-41d4-a716-446655440000",
    "freelancerId": "660e8400-e29b-41d4-a716-446655440001",
    "amount": 5000000,
    "status": "draft",
    "createdAt": "2026-07-24T10:00:00.000Z",
    "version": 0
  },
  "requestId": "req-abc123"
}
```

> **Note:** Milestones are validated at the API layer but are not persisted in the database response. They are enforced for bounds checking (count and total amount) during creation.

#### Errors

| Status | Code | Trigger |
|--------|------|---------|
| `400` | `validation_error` | Invalid body fields (Zod validation) |
| `400` | `bad_request` | Missing `Idempotency-Key` header |
| `401` | `unauthorized` | Invalid or missing JWT |
| `409` | `conflict` | Reused `Idempotency-Key` with different body |
| `422` | `contract_bounds_error` | Milestone count > 20, or total amount > budget/cap |

---

### Update Contract (Including Milestones)

```
PATCH /api/v1/contracts/:id
```

Updates an existing contract. Supports partial updates via Optimistic Concurrency Control (OCC).

#### Headers

| Header | Required | Description |
|--------|----------|-------------|
| `Authorization` | Yes | `Bearer <JWT>` |

#### URL Parameters

| Param | Type | Description |
|-------|------|-------------|
| `id` | `string (UUID)` | Contract ID |

#### Request Body

```json
{
  "version": 0,
  "milestones": [
    {
      "title": "Design Mockups",
      "description": "Create wireframes and high-fidelity mockups - REVISED",
      "amount": 1800000,
      "deadline": "2026-10-15T23:59:59.000Z",
      "completed": true
    },
    {
      "title": "Frontend Implementation",
      "description": "Implement responsive frontend based on approved mockups",
      "amount": 2000000,
      "deadline": "2026-11-30T23:59:59.000Z",
      "completed": false
    },
    {
      "title": "Final Delivery",
      "description": "Deploy to production and handoff documentation",
      "amount": 1200000,
      "deadline": "2026-12-31T23:59:59.000Z",
      "completed": false
    }
  ]
}
```

#### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `version` | `integer ≥ 0` | OCC version from last read (required) |

#### Optional Fields (same as create, plus)

All contract fields are optional for PATCH. When `milestones` is provided, it replaces the entire milestones array.

#### Response (200 OK)

```json
{
  "status": "success",
  "data": {
    "id": "770e8400-e29b-41d4-a716-446655440002",
    "title": "Website Redesign",
    "clientId": "550e8400-e29b-41d4-a716-446655440000",
    "freelancerId": "660e8400-e29b-41d4-a716-446655440001",
    "amount": 5000000,
    "status": "draft",
    "createdAt": "2026-07-24T10:00:00.000Z",
    "version": 1
  },
  "requestId": "req-def456"
}
```

#### Errors

| Status | Code | Trigger |
|--------|------|---------|
| `400` | `validation_error` | Invalid body fields (Zod validation) |
| `400` | `ERR_MISSING_VERSION` | Missing `version` field |
| `400` | `ERR_INVALID_VERSION` | `version` is not a non-negative integer |
| `401` | `unauthorized` | Invalid or missing JWT |
| `404` | `not_found` | Contract not found |
| `409` | `ERR_CONFLICT` | Version conflict (stale OCC version) |
| `422` | `contract_bounds_error` | Milestone count > 20, or total amount > budget/cap |

---

### Get Contract (Including Milestones)

```
GET /api/v1/contracts/:id
```

Fetches a single contract by ID.

#### Headers

| Header | Required | Description |
|--------|----------|-------------|
| `Authorization` | Yes | `Bearer <JWT>` |

#### URL Parameters

| Param | Type | Description |
|-------|------|-------------|
| `id` | `string (UUID)` | Contract ID |

#### Response (200 OK)

```json
{
  "status": "success",
  "data": {
    "id": "770e8400-e29b-41d4-a716-446655440002",
    "title": "Website Redesign",
    "clientId": "550e8400-e29b-41d4-a716-446655440000",
    "freelancerId": "660e8400-e29b-41d4-a716-446655440001",
    "amount": 5000000,
    "status": "draft",
    "createdAt": "2026-07-24T10:00:00.000Z",
    "version": 0
  },
  "requestId": "req-ghi789"
}
```

#### Errors

| Status | Code | Trigger |
|--------|------|---------|
| `401` | `unauthorized` | Invalid or missing JWT |
| `404` | `not_found` | Contract not found |

---

### Get Contract Bounds

```
GET /api/v1/contracts/bounds
```

Returns the enforced per-contract limits for client discovery.

#### Headers

| Header | Required | Description |
|--------|----------|-------------|
| `Authorization` | Yes | `Bearer <JWT>` |

#### Response (200 OK)

```json
{
  "status": "success",
  "data": {
    "maxMilestonesPerContract": 20,
    "maxContractAmountStroops": 100000000000000
  },
  "requestId": "req-jkl012"
}
```

#### Errors

| Status | Code | Trigger |
|--------|------|---------|
| `401` | `unauthorized` | Invalid or missing JWT |

---

## Error Codes

### Standard Error Envelope

```json
{
  "status": "error",
  "error": {
    "code": "contract_bounds_error",
    "message": "Milestone count 21 exceeds maximum of 20",
    "requestId": "req-abc123"
  }
}
```

### Validation Error Envelope (Zod)

```json
{
  "status": "error",
  "error": {
    "code": "validation_error",
    "message": "Request validation failed",
    "requestId": "req-abc123",
    "details": [
      {
        "path": ["body", "milestones", "0", "title"],
        "message": "String must contain at least 1 character(s)",
        "code": "too_short"
      }
    ]
  }
}
```

### Complete Error Reference

| HTTP Status | Code | Message | Source |
|-------------|------|---------|--------|
| `400` | `validation_error` | Request validation failed | [`validate.middleware.ts:46-51`](../src/middleware/validate.middleware.ts#L46-L51) |
| `400` | `bad_request` | Idempotency-Key header is required | [`contractIdempotency.ts:67-74`](../src/middleware/contractIdempotency.ts#L67-L74) |
| `400` | `ERR_MISSING_VERSION` | version field is required for updates | [`appError.ts:80-82`](../src/errors/appError.ts#L80-L82) |
| `400` | `ERR_INVALID_VERSION` | version must be a non-negative integer | [`appError.ts:85-88`](../src/errors/appError.ts#L85-L88) |
| `401` | `unauthorized` | Authentication is required | [`contractIdempotency.ts:80-88`](../src/middleware/contractIdempotency.ts#L80-L88) |
| `404` | `not_found` | The requested resource was not found | [`appError.ts:67-70`](../src/errors/appError.ts#L67-L70) |
| `409` | `ERR_CONFLICT` | Version conflict | [`appError.ts:91-94`](../src/errors/appError.ts#L91-L94) |
| `409` | `conflict` | Idempotency-Key was reused with a different request body | [`contractIdempotency.ts:97-104`](../src/middleware/contractIdempotency.ts#L97-L104) |
| `422` | `contract_bounds_error` | Milestone count N exceeds maximum of 20 | [`bounds.ts:63`](../src/contracts/bounds.ts#L63) |
| `422` | `contract_bounds_error` | Total milestone amount exceeds maximum contract amount of 100000000000000 stroops | [`bounds.ts:73`](../src/contracts/bounds.ts#L73) |
| `422` | `contract_bounds_error` | Total milestone amount exceeds maximum contract amount (milestones total N exceeds budget of M) | [`contracts.service.ts:78-79`](../src/services/contracts.service.ts#L78-L79) |
| `500` | `internal_error` | An unexpected error occurred | [`appError.ts:193-202`](../src/errors/appError.ts#L193-L202) |

---

## Authentication & Permissions

All milestones endpoints require a valid JWT Bearer token.

### Permission Matrix

| Role | Create | Read | Update | Delete | List |
|------|--------|------|--------|--------|------|
| `admin` | ALLOW | ALLOW | ALLOW | ALLOW | ALLOW |
| `client` | ALLOW | OWN | OWN | DENY | OWN |
| `freelancer` | DENY | OWN | OWN | DENY | OWN |
| `auditor` | DENY | ALLOW | DENY | DENY | ALLOW |

**OWN** = Only if the authenticated user's ID matches the contract's `clientId` (verified via [`getContractOwnerId`](../src/routes/contracts.routes.ts#L30-L33) DB lookup).

### JWT Payload

```json
{
  "sub": "user-id",
  "email": "user@example.com",
  "role": "client",
  "iat": 1690000000,
  "exp": 1690003600
}
```

Algorithm: HS256.

---

## Idempotency

Contract creation (`POST /api/v1/contracts`) requires an `Idempotency-Key` header. Keys are scoped to the authenticated user.

| Scenario | Response |
|----------|----------|
| First request with key | Process normally, cache response |
| Replay with same key + same body | Return cached response with `Idempotency-Replayed: true` header |
| Replay with same key + different body | `409 Conflict` |
| Missing key | `400 Bad Request` |

Source: [`src/middleware/contractIdempotency.ts`](../src/middleware/contractIdempotency.ts)

---

## Optimistic Concurrency Control (OCC)

All `PATCH` requests must include a `version` field. The update succeeds only if the stored version matches the supplied value; the version is then atomically incremented. If another writer updated the contract first, a `409 Version Conflict` error is returned.

**Flow:**
1. `GET /api/v1/contracts/:id` → returns current `version`
2. `PATCH /api/v1/contracts/:id` with `version` from step 1
3. If version matches → update succeeds, version incremented
4. If version differs → `409 ERR_CONFLICT`

Source: [`src/services/contracts.service.ts:130-167`](../src/services/contracts.service.ts#L130-L167)
