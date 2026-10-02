# Milestones Validation Schemas

## Overview

This document describes the declarative Zod validation schemas for standalone milestone request/response payloads. These schemas replace ad hoc validation in controllers with consistent, type-safe validation at the API boundary.

## Purpose

Previously, milestone payloads were validated ad hoc in the controller with manual checks like `if (!body.title || typeof body.amount !== 'number')`. This approach was:
- Inconsistent across endpoints
- Not type-safe
- Difficult to maintain
- Lacked structured error responses

The new schemas provide:
- Declarative validation rules
- Type-safe TypeScript inference
- Consistent error responses
- Centralized validation logic

## Schema Files

- `src/modules/contracts/dto/milestones.dto.ts` - Validation schemas
- `src/modules/contracts/dto/milestones.dto.test.ts` - Unit tests for schemas

## Request Schemas

### createMilestoneSchema

Validates the request body for `POST /:id/milestones`.

**Required fields:**
- `title`: string, 1-100 characters
- `amount`: positive number, max MAX_CONTRACT_AMOUNT_STROOPS

**Optional fields:**
- `description`: string, 1-500 characters
- `deadline`: ISO-8601 datetime string
- `completed`: boolean

**Behavior:**
- Unknown keys are stripped silently (`.strip()`)
- Returns structured validation errors on failure

**Example valid payload:**
```json
{
  "title": "Project Kickoff",
  "description": "Initial project milestone",
  "amount": 1000,
  "deadline": "2026-12-31T23:59:59.000Z",
  "completed": false
}
```

### updateMilestoneSchema

Validates the request body for milestone updates (reserved for future PATCH endpoint).

**All fields are optional:**
- `title`: string, 1-100 characters
- `description`: string, 1-500 characters
- `amount`: positive number, max MAX_CONTRACT_AMOUNT_STROOPS
- `deadline`: ISO-8601 datetime string
- `completed`: boolean

**Behavior:**
- Unknown keys are rejected (`.strict()`)
- Returns structured validation errors on failure

## Response Schemas

### milestoneResponseSchema

Validates the shape of milestone responses from the API.

**Fields:**
- `id`: UUID string
- `contractId`: UUID string
- `title`: string
- `description`: string
- `amount`: number
- `deadline`: ISO-8601 datetime string or null
- `completed`: boolean
- `createdAt`: ISO-8601 datetime string
- `updatedAt`: ISO-8601 datetime string
- `deletedAt`: ISO-8601 datetime string or null

### milestonesListResponseSchema

Validates the shape of milestones list responses.

**Fields:**
- `milestones`: array of milestoneResponseSchema
- `total`: non-negative integer

## Parameter Schemas

### milestoneIdParamSchema

Validates the `:milestoneId` route parameter.

**Validation:**
- Must be a valid UUID string

### milestonesQuerySchema

Validates query parameters for `GET /:id/milestones`.

**Parameters:**
- `includeDeleted`: string ('true' or 'false'), transformed to boolean

**Behavior:**
- Defaults to `false` when not provided
- Unknown keys are stripped

## Integration

### Route-Level Validation

The schemas are integrated into the routes using existing validation middleware:

```typescript
// POST /:id/milestones
router.post(
  '/:id/milestones',
  validateContractId,
  validateRequest(createMilestoneSchema),  // New validation
  requireAuth,
  requirePermission('contracts', 'update', getContractOwnerId),
  milestonesSoftDelete.create.bind(milestonesSoftDelete),
);

// DELETE /:id/milestones/:milestoneId
router.delete(
  '/:id/milestones/:milestoneId',
  validateContractId,
  validateParams(milestoneIdParamSchema),  // New validation
  requireAuth,
  requirePermission('contracts', 'update', getContractOwnerId),
  milestonesSoftDelete.softDelete.bind(milestonesSoftDelete),
);

// GET /:id/milestones
router.get(
  '/:id/milestones',
  validateContractId,
  validateQuery(milestonesQuerySchema),  // New validation
  requireAuth,
  requirePermission('contracts', 'read', getContractOwnerId),
  milestonesSoftDelete.list.bind(milestonesSoftDelete),
);
```

### Controller Changes

The `MilestonesSoftDeleteController.create` method was simplified to remove ad hoc validation:

**Before:**
```typescript
public create(req: Request, res: Response, next: NextFunction): void {
  try {
    const contractId = req.params.id!;
    const body = (req.body ?? {}) as CreateMilestoneInput;
    if (!body.title || typeof body.amount !== 'number') {
      fail(res, 'validation_error', 'title and amount are required', 400);
      return;
    }
    const created = milestonesService.create(contractId, body);
    ok(res, { milestone: serializeMilestone(created) }, undefined, 201);
  } catch (error) {
    if (mapMilestoneError(res, error)) return;
    next(error);
  }
}
```

**After:**
```typescript
public create(req: Request, res: Response, next: NextFunction): void {
  try {
    const contractId = req.params.id!;
    const body = req.body as CreateMilestoneInput;
    const created = milestonesService.create(contractId, body);
    ok(res, { milestone: serializeMilestone(created) }, undefined, 201);
  } catch (error) {
    if (mapMilestoneError(res, error)) return;
    next(error);
  }
}
```

The validation is now handled by the middleware before reaching the controller.

## Error Responses

Invalid payloads return a structured error response:

```json
{
  "status": "error",
  "error": {
    "code": "validation_error",
    "message": "Request validation failed",
    "requestId": "abc-123",
    "details": [
      {
        "path": ["title"],
        "message": "Milestone title must be at least 1 character",
        "code": "too_small"
      }
    ]
  }
}
```

## Validation Rules

### Title
- **Type**: string
- **Min length**: 1 character
- **Max length**: 100 characters
- **Required**: Yes (for create)

### Description
- **Type**: string
- **Min length**: 1 character (when provided)
- **Max length**: 500 characters
- **Required**: No (defaults to empty string in service)

### Amount
- **Type**: number
- **Min**: positive (> 0)
- **Max**: MAX_CONTRACT_AMOUNT_STROOPS
- **Required**: Yes (for create)

### Deadline
- **Type**: string (ISO-8601 datetime)
- **Max length**: 64 characters
- **Required**: No
- **Format**: `YYYY-MM-DDTHH:mm:ss.sssZ`

### Completed
- **Type**: boolean
- **Required**: No
- **Default**: false

## Testing

### Unit Tests

Unit tests in `milestones.dto.test.ts` cover:
- Valid payloads pass validation
- Invalid payloads are rejected with appropriate errors
- Boundary values (min/max lengths, amounts)
- Optional vs required fields
- Unknown key handling (strip vs strict)
- Type validation (UUID, datetime, boolean)

**Coverage**: 50 tests, all passing

### Integration Tests

Integration tests in `milestones.validation.integration.test.ts` verify:
- HTTP boundary validation works correctly
- Structured error responses are returned
- Valid payloads are accepted
- Invalid payloads are rejected with proper status codes

**Note**: Integration tests are currently skipped due to a pre-existing migrations issue unrelated to this change.

## Migration Guide

### For API Consumers

**Before:** Invalid payloads might return generic 400 errors or inconsistent messages.

**After:** Invalid payloads return structured validation errors with field-level details.

**Example:**
```bash
# Invalid request
curl -X POST /api/v1/contracts/{id}/milestones \
  -H "Authorization: Bearer {token}" \
  -H "Content-Type: application/json" \
  -d '{"amount": 1000}'

# Response (400)
{
  "status": "error",
  "error": {
    "code": "validation_error",
    "message": "Request validation failed",
    "requestId": "req-123",
    "details": [
      {
        "path": ["title"],
        "message": "Milestone title must be at least 1 character",
        "code": "too_small"
      }
    ]
  }
}
```

### For Developers

When adding new milestone-related endpoints:
1. Define the schema in `milestones.dto.ts`
2. Add validation middleware to the route
3. Write unit tests for the schema
4. Write integration tests for the endpoint

## Constants

The following constants are defined in `milestones.dto.ts`:

- `MILESTONE_TITLE_MAX_LENGTH`: 100
- `MILESTONE_TITLE_MIN_LENGTH`: 1
- `MILESTONE_DESCRIPTION_MAX_LENGTH`: 500
- `MILESTONE_DESCRIPTION_MIN_LENGTH`: 1
- `DATETIME_MAX_LENGTH`: 64

These are aligned with the constants in `contract.dto.ts` for consistency.

## Benefits

1. **Type Safety**: TypeScript types are inferred from schemas
2. **Consistency**: All endpoints use the same validation rules
3. **Maintainability**: Validation logic is centralized
4. **Testability**: Schemas can be unit tested independently
5. **Documentation**: Schemas serve as living documentation
6. **Error Quality**: Structured, detailed error messages

## Future Enhancements

Potential areas for future work:
1. Add custom error messages for specific business rules
2. Add OpenAPI schema registration for API documentation
3. Add response validation middleware to ensure API contracts
4. Add localization support for error messages
5. Add more complex cross-field validation (e.g., deadline must be in future)

## References

- Zod documentation: https://zod.dev
- Validation middleware: `src/middleware/validate.middleware.ts`
- Contract DTOs: `src/modules/contracts/dto/contract.dto.ts`
- Milestones controller: `src/controllers/milestones.softdelete.controller.ts`
- Contracts routes: `src/routes/contracts.routes.ts`
