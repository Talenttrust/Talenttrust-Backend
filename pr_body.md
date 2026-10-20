## Summary

Implements strict Zod-based request validation for all `/api/v1` routes, eliminating ad-hoc `Number()` coercion bugs.

### Changes

- **Dependencies**: Added `zod` and `zod-to-json-schema`
- **Validation schemas** (`src/validation/schemas.ts`): Strict schemas for params, query, and body with:
  - `IdParam`: `^[1-9][0-9]{0,15}$` (positive integer)
  - `MilestoneIndexParam`: `0-19` regex
  - `CreateContractBody`: title ≤120, token ≤64, milestones 1-20, strict object
  - `DepositBody`: amount positive int
  - `DisputeBody`: raisedBy required, reason 1-1000 chars
  - `ResolveBody`: freelancerBps int 0-10000 (no coercion)
  - `RateBody`: rating int 1-5 (no coercion)
  - `ListQuery`: status enum, party ≤64
  - All bodies use `.strict()` to reject unknown keys

- **Middleware** (`src/validation/middleware.ts`): `validate({params, query, body})` replaces req.params/query/body with parsed values, returns 400 `validation_failed` with `details: [{path, message}]` on failure

- **Routes** (`src/app.ts`): Every `/api/v1` route wired through validate middleware

- **OpenAPI** (`src/openapi.ts`): Documents `ValidationError` schema, references in all 400 responses, path params as strings with patterns

- **Tests** (`tests/app.test.ts`): Added tests verifying:
  - `resolve {freelancerBps: null}` → 400, contract stays Disputed
  - `rate {rating: true}` → 400
  - `GET /contracts/0x1` → 400
  - `POST /milestones/abc/release` → 400
  - `?status=bogus` → 400
  - Unknown keys rejected with named path
  - Multi-error bodies report all issues
  - Boundary values (120/121 title, 20/21 milestones, 0/10000/-1/10001 freelancerBps)

### Verification

```
npm run lint  ✓
npm run build ✓
npm test      ✓ (12 tests pass)
```

### Curl verification

```bash
# resolve with null → 400
curl -XPOST localhost:3001/api/v1/contracts/2/resolve -d '{"freelancerBps":null}'
# → {"error":"validation_failed","message":"body.freelancerBps: Invalid input: expected number, received null",...}

# rate with boolean → 400
curl -XPOST localhost:3001/api/v1/contracts/1/reputation -d '{"rating":true}'
# → {"error":"validation_failed","message":"body.rating: Invalid input: expected number, received boolean",...}

# hex path param → 400
curl localhost:3001/api/v1/contracts/0x1
# → {"error":"validation_failed","message":"params.id: id must be a positive integer",...}

# invalid milestone index → 400
curl -XPOST localhost:3001/api/v1/contracts/1/milestones/abc/release
# → {"error":"validation_failed","message":"params.index: index must be an integer 0..19",...}

# bogus status → 400
curl 'localhost:3001/api/v1/contracts?status=bogus'
# → {"error":"validation_failed","message":"query.status: Invalid option...",...}
```

Closes #1559