# Request Validation Framework

## Overview

This backend uses a schema-based validation middleware to validate request segments before handler logic runs.

Validated segments:

- `req.params`
- `req.query`
- `req.body`

## Implementation

- Schema utilities: `src/validation/requestSchema.ts`
- Middleware factory: `src/middleware/requestValidation.ts`
- Route integration: `src/index.ts`

### Structured doc comments

Exported schema and middleware APIs include structured JSDoc comments describing behavior and constraints.

## Validation behavior

For each segment (`params`, `query`, `body`):

1. Reject non-object inputs.
2. Reject unknown keys (strict allow-list).
3. Enforce required fields.
4. Enforce primitive types (`string`, `number`, `boolean`).
5. Enforce optional constraints (`minLength`, `maxLength`, `min`, `max`, `enum`, `pattern`).

On validation failure, middleware returns `400`:

```json
{
  "error": "Validation failed",
  "details": ["body.title is required"]
}
```

## Security assumptions and threat scenarios

### Assumptions

- API consumers send JSON bodies for protected endpoints.
- Incoming data is untrusted.

### Threat scenarios addressed

- **Unexpected field injection**: blocked by unknown-key rejection.
- **Type confusion**: blocked by strict primitive type checks.
- **Input boundary abuse**: constrained with range and length checks.

### Explicit non-goals

- No authentication/authorization changes.
- No business rule validation outside schema constraints.