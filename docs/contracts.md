# Contracts API Documentation

This document provides comprehensive reference for the TalentTrust Contracts API endpoints. All endpoints require authentication (Bearer token in `Authorization` header) and follow standard error envelopes.

## Overview

The Contracts API manages escrow contracts on the TalentTrust platform. It supports CRUD operations, pagination, optimistic concurrency control, and policy bounds enforcement.

## General Information

### Base URL
```
https://api.talenttrust.com/api/v1/contracts
```

### Authentication
```http
Authorization: Bearer <your-jwt-token>
```

### Error Envelope
```json
{
  "error": {
    "code": "error_code",
    "message": "Human-readable error message",
    "requestId": "correlation-id"
  }
}
```

## Routes

### 1. List Contracts (GET /api/v1/contracts)

#### Description
Retrieve a paginated list of contracts. Supports both cursor-based pagination (new) and offset-based pagination (legacy).

#### Parameters
| Name | Type | In | Required | Description |
|------|------|----|----------|-------------|
| limit | number | query | false | Page size, 1–100 (default: 20). Used with cursor pagination when cursor is present. |
| cursor | string | query | false | Opaque cursor for navigating pages (from `nextCursor` of previous response). Enables cursor mode. |
| page | number | query | false | Page number (1-indexed), used with offset pagination when cursor is absent. |
| status | string | query | false | Filter by contract status (draft, active, completed, cancelled, disputed) |
| clientId | string | query | false | Filter by client user ID (UUID) |
| freelancerId | string | query | false | Filter by freelancer user ID (UUID) |
| budget | number | query | false | Filter by maximum budget |
| sortBy | string | query | false | Sort field (e.g., "createdAt") |
| sortOrder | string | query | false | Sort order: "asc" or "desc" |

#### Success Response (200)
```json
{
  "status": "success",
  "data": {
    "data": [...contracts...],
    "nextCursor": "string | null",
    "hasNextPage": true,
    "limit": 20,
    "page": 1,
    "total": 0
  }
}
```

#### Success Response (legacy offset mode)
```json
{
  "status": "success",
  "data": [...contracts...],
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 0,
    "totalPages": 1
  }
}
```

#### Example Request
```http
GET /api/v1/contracts?limit=10&cursor=cursor-string
```

```http
GET /api/v1/contracts?page=1&limit=50&status=draft
```

#### Error Responses
| Status | Code | Description |
|--------|------|-------------|
| 400 | validation_error | Invalid pagination parameters |

#### Handler Reference
- Source: `src/controllers/contracts.controller.ts:84`
- Uses `getContractsCursor` for cursor mode or `parsePaginationQuery` for legacy mode

---

### 2. Get Contract By ID (GET /api/v1/contracts/:id)

#### Description
Retrieve a single contract by its UUID.

#### Parameters
| Name | Type | In | Required | Description |
|------|------|----|----------|-------------|
| id | string | path | true | Contract UUID |

#### Success Response (200)
```json
{
  "status": "success",
  "data": {
    "id": "uuid-string",
    "title": "Project Title",
    "clientId": "uuid-string",
    "freelancerId": "uuid-string | null",
    "amount": 1000000,
    "status": "draft",
    "createdAt": "2024-01-15T10:30:00.000Z",
    "version": 0
  }
}
```

#### Example Request
```http
GET /api/v1/contracts/550e8400-e29b-41d4-a716-446655440000
```

#### Error Responses
| Status | Code | Description |
|--------|------|-------------|
| 404 | not_found | Contract not found |

#### Handler Reference
- Source: `src/controllers/contracts.controller.ts:148`
- Throws `NotFoundError` when contract doesn't exist

---

### 3. Get Contract History (GET /api/v1/contracts/:id/history)

#### Description
Retrieve contract history events from the event ingestion service.

#### Parameters
| Name | Type | In | Required | Description |
|------|------|----|----------|-------------|
| id | string | path | true | Contract UUID |

#### Success Response (200)
```json
{
  "eventId": "uuid-string",
  "contractId": "uuid-string",
  "type": "CONTRACT_CREATED | CONTRACT_FUNDED | CONTRACT_COMPLETED | CONTRACT_CANCELLED",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "payload": {...}
}
```

#### Example Request
```http
GET /api/v1/contracts/550e8400-e29b-41d4-a716-446655440000/history
```

#### Error Responses
| Status | Code | Description |
|--------|------|-------------|
| 500 | internal_error | Event ingestion service error |

#### Handler Reference
- Source: `src/routes/contracts.routes.ts:56`
- Direct call to `eventIngestionService.getContractHistory()`

---

### 4. Get Policy Bounds (GET /api/v1/contracts/bounds)

#### Description
Discover per-contract policy limits without hardcoding them.

#### Success Response (200)
```json
{
  "maxMilestonesPerContract": 20,
  "maxContractAmountStroops": 100000000000000
}
```

#### Example Request
```http
GET /api/v1/contracts/bounds
```

#### Handler Reference
- Source: `src/controllers/contracts.controller.ts:232`
- Returns `CONTRACT_BOUNDS` from `src/contracts/bounds.ts:17`

---

### 5. Get Contract Statistics (GET /api/v1/contracts/stats)

#### Description
Retrieve aggregate statistics about all contracts.

#### Success Response (200)
```json
{
  "status": "success",
  "data": {
    "total": 100,
    "totalBudget": 5000000000,
    "byStatus": {
      "draft": 10,
      "active": 50,
      "completed": 30,
      "cancelled": 5,
      "disputed": 5
    }
  }
}
```

#### Example Request
```http
GET /api/v1/contracts/stats
```

#### Error Responses
| Status | Code | Description |
|--------|------|-------------|
| 422 | contract_bounds_error | Policy validation error (bounds violation) |

#### Handler Reference
- Source: `src/controllers/contracts.controller.ts:215`
- Catches `ContractBoundsError` and returns 422

---

### 6. Create Contract (POST /api/v1/contracts)

#### Description
Create a new escrow contract. Supports Idempotency-Key header for safe retries.

#### Request Body Schema
```json
{
  "title": "Project Title",
  "description": "Project description...",
  "freelancerId": "uuid-string | null",
  "clientId": "uuid-string",
  "budget": 1000000,
  "deadline": "2024-12-31T23:59:59.000Z",
  "status": "draft",
  "terms": "Project terms and conditions",
  "milestones": [
    {
      "title": "Milestone 1",
      "description": "First milestone",
      "amount": 500000,
      "deadline": "2024-02-15T23:59:59.000Z"
    }
  ]
}
```

#### Parameters
| Name | Type | In | Required | Description |
|------|------|----|----------|-------------|
| Idempotency-Key | string | header | false | Prevent duplicate submissions |

#### Success Response (201)
```json
{
  "status": "success",
  "data": {
    "id": "uuid-string",
    "title": "Project Title",
    "clientId": "uuid-string",
    "freelancerId": "uuid-string | null",
    "amount": 1000000,
    "status": "draft",
    "createdAt": "2024-01-15T10:30:00.000Z",
    "version": 0
  }
}
```

#### Example Request
```http
POST /api/v1/contracts
Authorization: Bearer <token>
Content-Type: application/json
Idempotency-Key: request-id-123

{
  "title": "Create Landing Page",
  "description": "Design and develop a landing page for our product",
  "clientId": "550e8400-e29b-41d4-a716-446655440000",
  "freelancerId": "550e8400-e29b-41d4-a716-446655440001",
  "budget": 500000,
  "deadline": "2024-03-15T23:59:59.000Z",
  "milestones": [
    {
      "title": "Design",
      "description": "Create wireframes and visual mockups",
      "amount": 200000,
      "deadline": "2024-01-20T23:59:59.000Z"
    },
    {
      "title": "Development",
      "description": "Implement the UI components",
      "amount": 300000,
      "deadline": "2024-02-28T23:59:59.000Z"
    }
  ]
}
```

#### Error Responses
| Status | Code | Description |
|--------|------|-------------|
| 422 | contract_bounds_error | Budget or milestone bounds exceeded |
| 400 | validation_error | Request schema validation failed |

#### Handler Reference
- Source: `src/controllers/contracts.controller.ts:164`
- Catches `ContractBoundsError` and returns 422

---

### 7. Update Contract (PATCH /api/v1/contracts/:id)

#### Description
Update an existing contract using Optimistic Concurrency Control (OCC).

#### Request Body Schema
```json
{
  "version": 0,
  "title": "Updated Project Title",
  "description": "Updated description",
  "budget": 600000,
  "milestones": [
    {
      "title": "Updated Milestone",
      "amount": 300000
    }
  ],
  "freelancerId": "uuid-string | null",
  "status": "active"
}
```

#### Parameters
| Name | Type | In | Required | Description |
|------|------|----|----------|-------------|
| id | string | path | true | Contract UUID |

#### Success Response (200)
```json
{
  "status": "success",
  "data": {
    "id": "uuid-string",
    "title": "Updated Project Title",
    "clientId": "uuid-string",
    "freelancerId": "uuid-string | null",
    "amount": 600000,
    "status": "active",
    "createdAt": "2024-01-15T10:30:00.000Z",
    "version": 1
  }
}
```

#### Example Request
```http
PATCH /api/v1/contracts/550e8400-e29b-41d4-a716-446655440000
Authorization: Bearer <token>
Content-Type: application/json

{
  "version": 0,
  "budget": 600000,
  "status": "active"
}
```

#### Error Responses
| Status | Code | Description |
|--------|------|-------------|
| 422 | contract_bounds_error | Budget or milestone bounds exceeded |
| 409 | conflict | Version conflict (another client updated) |
| 400 | validation_error | Missing version or invalid input |
| 404 | not_found | Contract not found |

#### Handler Reference
- Source: `src/controllers/contracts.controller.ts:182`
- Uses `updateContract` service method with OCC validation

---

### 8. Delete Contract (DELETE /api/v1/contracts/:id)

#### Description
Delete a contract (admin only).

#### Parameters
| Name | Type | In | Required | Description |
|------|------|----|----------|-------------|
| id | string | path | true | Contract UUID |

#### Success Response (200)
```json
{
  "status": "success",
  "data": {
    "message": "Contract deleted successfully"
  }
}
```

#### Example Request
```http
DELETE /api/v1/contracts/550e8400-e29b-41d4-a716-446655440000
Authorization: Bearer <token>
```

#### Error Responses
| Status | Code | Description |
|--------|------|-------------|
| 404 | not_found | Contract not found |

#### Handler Reference
- Source: `src/controllers/contracts.controller.ts:201`
- Throws `NotFoundError` if contract doesn't exist

## Permission Matrix

| Resource | Admin | Client (ownOnly) | Freelancer (ownOnly) | Guest |
|----------|-------|------------------|----------------------|-------|
| contracts | CRUD | CR | CR | — |

## Error Codes Reference

### Application Error Codes
- `not_found` - Resource not found (404)
- `unauthorized` - Authentication required (401)
- `forbidden` - Permission denied (403)
- `validation_error` - Request schema validation (400)
- `ERR_MISSING_VERSION` - OCC version field missing (400)
- `ERR_INVALID_VERSION` - OCC version malformed (400)
- `ERR_CONFLICT` - OCC version conflict (409)
- `contract_metadata_mismatch` - Metadata validation (400)

### Policy Error Codes
- `contract_bounds_error` - Budget or milestone limits exceeded (422)

## Contract Status Values

Valid status values for the `status` field:
- `draft` - New contract, not yet active
- `active` - Work in progress
- `completed` - Project finished
- `cancelled` - Contract cancelled
- `disputed` - Under dispute

## Migration Notes

- Cursor-based pagination replaces legacy offset pagination
- Both pagination modes are supported for backward compatibility
- Version field (OCC) required for updates
- Idempotency-Key header safe retry mechanism available for contract creation
