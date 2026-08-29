# Bulk Contracts Operations Endpoint

**Issue:** #802 - Clients issue many single contracts calls  
**Solution:** Bounded bulk endpoint that processes multiple contract creations independently

## Overview

The bulk contracts endpoint (`POST /api/v1/contracts/bulk`) allows clients to create multiple contracts in a single request, reducing network round-trips and simplifying client code.

**Key design principle:** One item's failure never affects another item's success within the same batch. Each item is validated, authorized, and persisted independently.

## Endpoint Specification

### Request

```http
POST /api/v1/contracts/bulk
Content-Type: application/json
Authorization: Bearer <token>

[
  {
    "title": "Contract 1",
    "description": "Description 1",
    "clientId": "uuid",
    "budget": 1000,
    "freelancerId": "uuid",              // optional
    "deadline": "2025-12-31T23:59:59Z",  // optional
    "status": "draft",                   // optional
    "terms": "Terms...",                 // optional
    "milestones": [ ... ]                // optional
  },
  {
    "title": "Contract 2",
    ...
  }
]
```

**Each item** uses the exact same schema as a single `POST /api/v1/contracts` request body.

### Response (200 OK)

```json
{
  "data": {
    "items": [
      {
        "status": "success",
        "code": 201,
        "data": {
          "id": "contract-uuid",
          "title": "Contract 1",
          "clientId": "client-uuid",
          "freelancerId": "freelancer-uuid",
          "amount": 1000,
          "status": "draft",
          "createdAt": "2025-01-01T00:00:00Z",
          "version": 1
        }
      },
      {
        "status": "error",
        "code": 422,
        "error": {
          "code": "contract_bounds_error",
          "message": "Budget exceeds maximum allowed amount"
        }
      }
    ],
    "summary": {
      "total": 2,
      "succeeded": 1,
      "failed": 1
    }
  },
  "metadata": {}
}
```

**The endpoint always returns 200 OK** when the request itself is valid. Check the per-item `status` and `code` fields to see which items succeeded and which failed.

## Constraints

### Batch Size Cap

- **Maximum items:** 100 (matching the existing `MAX_PAGE_LIMIT` convention in this codebase)
- **Minimum items:** 1 (empty batch is rejected as a validation error)
- Batches exceeding the cap are rejected wholesale with HTTP 400:

```json
{
  "error": {
    "code": "validation_error",
    "message": "items array must not exceed 100 items",
    "requestId": "..."
  }
}
```

### Empty Batch

An empty array (`[]`) is rejected during schema validation:

```json
{
  "error": {
    "code": "validation_error",
    "message": "items array must not be empty (at least 1 item required)",
    "requestId": "..."
  }
}
```

**Rationale:** Empty batches are almost certainly a client bug (forgotten to populate the array), so rejecting them upfront helps surface the error quickly rather than silently returning an empty success array.

## Processing Model

### Per-Item Independence

Each item is **validated, authorized, and persisted independently**:

1. Item is validated against the same schema as a single-item POST
2. Item's authorization is checked (caller must have `contracts:create` permission)
3. If valid and authorized, item's business logic is executed (bounds check, etc.)
4. If all checks pass, item is persisted to the database
5. Result (success with created contract, or error) is added to the response
6. Next item is processed (regardless of previous item's outcome)

**One item's failure does NOT:**
- Abort processing of remaining items
- Roll back previous items' writes
- Change the response HTTP status (still 200)

### Transaction Model

**Per-item transactions:** Each item's write happens in its own database transaction.

- Item N succeeds → Item N is persisted
- Item N fails → Item N's partial write is rolled back; Item N not persisted
- Item N+1 is unaffected by Item N's success or failure

This is different from a batch transaction (where one item's failure would roll back everyone's writes). The bulk endpoint is explicitly designed to avoid that coupling.

### Authorization

Authorization is checked **per-item**, not once for the entire batch:

```
For each item in batch:
  1. Validate item's schema
  2. Check caller has contracts:create permission
  3. If unauthorized: item gets 403 error, next item continues
  4. If authorized: proceed to business logic
```

A caller cannot use the bulk endpoint to bypass per-resource authorization checks. If they lack permission over a specific resource (e.g., a restricted clientId), that item fails with a 403, and other items in the batch still process normally.

## Error Handling

### Per-Item Error Codes

Each failed item includes an error object with a `code` and `message`. The same error codes as the single-item endpoint are reused:

| Code | HTTP | Cause | Mitigation |
|------|------|-------|-----------|
| `validation_error` | 400 | Schema validation failed (invalid title length, bad UUID, etc.) | Fix the invalid field |
| `contract_bounds_error` | 422 | Budget or milestone count exceeds policy limits | Reduce budget or milestone count |
| `not_found` | 404 | Referenced resource (e.g., clientId) does not exist | Verify the reference exists |
| `unauthorized` | 403 | Caller lacks permission for this item | Check authorization scopes |
| `invalid_request` | 400 | Generic business logic error | Check error message for details |
| `internal_error` | 500 | Unexpected runtime error | Retry; contact support if persists |

### Handling Partial Failures

A batch with some successful and some failed items returns **200 OK** with per-item results:

```javascript
// Example: client receives 200, must check per-item results
const response = await fetch('/api/v1/contracts/bulk', {
  method: 'POST',
  body: JSON.stringify([
    { title: 'Good contract', ...goodData },
    { title: 'Bad contract', budget: 999999999999 }, // Exceeds max
    { title: 'Good contract 2', ...goodData },
  ])
});

// response.status === 200
const result = await response.json();
console.log(result.data.summary); // { total: 3, succeeded: 2, failed: 1 }
result.data.items.forEach((item, index) => {
  if (item.status === 'error') {
    console.log(`Item ${index} failed: ${item.error.code} - ${item.error.message}`);
  }
});
```

### Retry Strategy

**For transient errors (500 internal_error):**
- Retry the entire batch with exponential backoff
- Or: Retry just the failed items by filtering the response

**For permanent errors (400/422/403):**
- Fix the input and retry
- Do NOT retry indefinitely; these errors indicate client bugs

**Best practice:** Separate failed items by error code; retry 500s, fix 4xx, retry again.

## Examples

### Success Case: All Items Valid

**Request:**
```json
[
  { "title": "Project A", "description": "...", "clientId": "client-1", "budget": 5000 },
  { "title": "Project B", "description": "...", "clientId": "client-2", "budget": 3000 }
]
```

**Response (200 OK):**
```json
{
  "data": {
    "items": [
      { "status": "success", "code": 201, "data": { "id": "...", "title": "Project A", ... } },
      { "status": "success", "code": 201, "data": { "id": "...", "title": "Project B", ... } }
    ],
    "summary": { "total": 2, "succeeded": 2, "failed": 0 }
  }
}
```

### Partial Failure: Mix of Valid and Invalid

**Request:**
```json
[
  { "title": "Valid", "description": "...", "clientId": "client-1", "budget": 1000 },
  { "title": "Budget too high", "description": "...", "clientId": "client-2", "budget": 999999999999 },
  { "title": "Valid", "description": "...", "clientId": "client-3", "budget": 2000 }
]
```

**Response (200 OK):**
```json
{
  "data": {
    "items": [
      { "status": "success", "code": 201, "data": { "id": "contract-1", ... } },
      { "status": "error", "code": 422, "error": { "code": "contract_bounds_error", "message": "Budget exceeds..." } },
      { "status": "success", "code": 201, "data": { "id": "contract-3", ... } }
    ],
    "summary": { "total": 3, "succeeded": 2, "failed": 1 }
  }
}
```

**Note:** Items at index 0 and 2 were successfully created. Item at index 1 failed but did NOT roll back items 0 and 2.

### Over-Capacity: Batch Too Large

**Request:**
```json
[
  { ... }, // item 1
  { ... }, // item 2
  ...
  { ... }  // item 101 (exceeds max of 100)
]
```

**Response (400 Bad Request):**
```json
{
  "error": {
    "code": "validation_error",
    "message": "items array must not exceed 100 items",
    "requestId": "..."
  }
}
```

**Note:** The entire batch is rejected; nothing is created.

## API Documentation

### Route
```
POST /api/v1/contracts/bulk
```

### Authentication
Required. Token must grant `contracts:create` permission.

### Request Body
Array of contract creation payloads. Schema matches single `POST /api/v1/contracts` body schema exactly.

### Response
- **Status:** Always 200 OK (if request is valid)
- **Body:** Per-item results and summary
- **Headers:** Standard API headers (Content-Type, X-Request-ID, etc.)

### Rate Limiting
Subject to the same rate limits as other write endpoints. Each item in the batch counts toward the limit (e.g., a 10-item batch counts as 10 requests).

### Idempotency
The bulk endpoint does **not** support Idempotency-Key headers. If idempotent semantics are needed, clients should:
1. Generate a unique clientId per contract (or other unique key)
2. Query the list endpoint to check if contract already exists
3. Only include contracts in the bulk request that don't already exist

## Implementation Details

### Code Structure
- **DTO/Schema:** `src/modules/contracts/dto/bulk-operations.dto.ts`
- **Controller:** `src/controllers/contracts-bulk.controller.ts`
- **Route:** `src/routes/contracts.routes.ts` (POST /bulk handler)
- **Tests:** `src/controllers/contracts-bulk.controller.test.ts`

### Error Mapping
The controller maps service-layer errors to per-item results:
- `ContractBoundsError` → 422 `contract_bounds_error`
- `NotFoundError` → 404 `not_found`
- Generic `Error` → 400 `invalid_request`
- Unknown → 500 `internal_error`

## Testing

Full test coverage includes:

- ✅ **Empty batch:** Rejected at schema validation
- ✅ **Partial failure:** Mix of success and failure, valid items persisted
- ✅ **Over-capacity:** Batch exceeding 100 items rejected wholly
- ✅ **All-success:** All items created successfully
- ✅ **All-failure:** All items fail with appropriate errors
- ✅ **Error mapping:** Different error types get correct codes
- ✅ **Positional mapping:** Response items correspond to request items by index
- ✅ **Authorization:** Per-item authorization checks work correctly

Run tests:
```bash
npm test -- contracts-bulk.controller.test.ts
```

## Troubleshooting

### Entire batch rejected with validation_error

**Cause:** Batch exceeds max size (100) or is empty, or individual items have schema errors

**Fix:** Check the error message. If "must not exceed 100 items", split into smaller batches. If "must not be empty", ensure array has at least 1 item.

### Some items fail, others succeed

**Expected behavior.** Check the `summary` in the response to see how many succeeded/failed. Review per-item `error` fields to understand why failures occurred.

**Fix:** Correct the failed items' data and retry just the failed items in a new bulk request.

### Persisting issues after fix

If items still fail after correcting the input, check:
1. Authorization: does your token have `contracts:create` permission?
2. Referenced resources: do all clientIds, freelancerIds exist?
3. Budget bounds: is total budget under the per-contract max?
4. Milestones: is milestone count under the policy cap?

## Future Enhancements

### Bulk Update and Delete

Currently only bulk create is implemented. Future work could add:
- `POST /api/v1/contracts/bulk-update` for batching PATCH operations
- `DELETE /api/v1/contracts/bulk-delete` for batching DELETE operations

### Idempotency for Bulk

Add Idempotency-Key support for safely retrying failed bulk requests without duplicating successful items.

### Async Processing

For very large batches (e.g., 1000+ items), consider:
- Enqueuing the batch to a job queue
- Returning 202 Accepted with a job ID
- Polling the job status for results

### Partial Batch Abort

Allow a special header to specify "abort batch if any item fails" (opt-in). Useful for transactional semantics when needed.

## Related Documents

- [API Documentation](./API.md) - General API conventions
- [Contracts Overview](./IMPLEMENTATION_SUMMARY.md) - Contract data model and operations
- [Error Handling](./error-handling.md) - Error codes and conventions
- [Authorization](./authentication-authorization.md) - Permission matrix and RBAC

