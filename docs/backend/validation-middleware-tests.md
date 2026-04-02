# Validation Middleware — Test Coverage

## Overview

This document describes the test strategy, coverage, and security assumptions for the three validation middleware layers in TalentTrust Backend.

## Middleware Under Test

| File | Mechanism | Validates |
|---|---|---|
| `src/middleware/validation.ts` | Zod (sync) | `body`, `params`, `query` individually |
| `src/middleware/requestValidation.ts` | Custom `ObjectSchema` | `body`, `params`, `query` together |
| `src/middleware/validate.middleware.ts` | Zod (async) | Combined `{ body, query, params }` object |
| `src/validation/requestSchema.ts` | Core engine | `validateSegment` — used by `requestValidation.ts` |

## Test Files

| Test File | Type | Cases |
|---|---|---|
| `src/middleware/validation.test.ts` | Unit | 15 |
| `src/middleware/requestValidation.test.ts` | Unit | 22 |
| `src/middleware/validate.middleware.test.ts` | Unit | 11 |
| `src/validation/requestSchema.test.ts` | Unit | 28 |

## What Is Tested

### Happy Paths
- Valid body/params/query calls `next()` with no arguments
- Optional fields may be absent without error
- Boundary values (min/max) are accepted
- Validated values are written back to `req`

### Rejection: Unknown Fields
- Extra body keys are rejected (`body.x is not allowed`)
- Extra query keys are rejected
- Extra param keys are rejected
- Zod `.strict()` schemas reject extra fields

### Rejection: Required Fields
- Missing required body field → 400
- Missing required param → 400
- `null` value treated as missing for required fields

### Rejection: Type Mismatches
- String where number expected (type coercion attack)
- Number where string expected
- String `"true"` where boolean expected

### Rejection: Constraint Violations
- String below `minLength`
- String above `maxLength`
- Number below `min`
- Number above `max`
- Value not in `enum`
- String not matching `pattern`

### Rejection: Non-Finite Numbers
- `Infinity` → rejected as non-finite
- `-Infinity` → rejected as non-finite
- `NaN` → rejected as non-finite

### Rejection: Non-Object Segments
- Array body → rejected
- `null` body → rejected
- Primitive (string/number) body → rejected

### Error Propagation
- Non-Zod errors forwarded to `next(error)` — not leaked to client
- Aggregated errors from all three segments returned in one response

## Security Assumptions

1. **Unknown field rejection** — All three middleware layers reject fields not declared in the schema. This prevents field injection and prototype pollution attempts.

2. **Type coercion prevention** — Strict type checking prevents attacks where a string `"100"` is passed where a number is expected (common in query-string injection).

3. **Non-finite number rejection** — `Infinity`, `-Infinity`, and `NaN` are explicitly rejected to prevent downstream arithmetic errors or DoS via unexpected numeric behavior.

4. **Non-object segment rejection** — Array and null bodies are rejected before field-level validation, preventing prototype pollution via `__proto__` in arrays.

5. **Error message safety** — Non-Zod errors (e.g., internal failures) are forwarded to `next()` and never serialized to the client response, preventing stack trace leakage.

6. **Strict schema by default** — The custom `validateSegment` engine always rejects unknown keys regardless of whether `.strict()` is called. Zod-based middleware requires explicit `.strict()` for the same guarantee.

## Running Tests

```bash
# Run all validation middleware tests
npm test -- --testPathPatterns="src/middleware/validation\.test$|src/middleware/requestValidation\.test$|src/middleware/validate\.middleware\.test$|src/validation/requestSchema\.test$"

# Run with coverage
npm run test:ci -- --testPathPatterns="validation"
```

## Dependencies

`zod` must be installed as a runtime dependency (used by `validation.ts` and `validate.middleware.ts`):

```bash
npm install zod
```
