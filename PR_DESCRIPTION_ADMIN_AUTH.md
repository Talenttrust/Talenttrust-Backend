# Admin Authentication Guard for DLQ & Deploy Endpoints

## Issue
**#283**: Secure DLQ list and deploy status endpoints with admin authentication to prevent unauthorized access to sensitive operations and webhook replay capabilities.

## Summary
This PR adds a comprehensive admin authentication guard (`adminAuthGuard`) middleware that secures all admin-only endpoints with two independent authentication methods: JWT with admin role verification and API key with admin-level scope validation. All DLQ management and blue-green deployment operations now require proven admin credentials before execution.

## Changes

### New Files
- **`src/middleware/adminAuthGuard.ts`** — Admin auth guard middleware supporting JWT and API key authentication with scope/role validation
- **`src/middleware/adminAuthGuard.test.ts`** — 19 test cases covering JWT validation, API key auth, scope checks, demo tokens, and error handling
- **`src/routes/deploy.routes.ts`** — Deploy status, switch-green, and rollback endpoints protected by adminAuthGuard
- **`src/routes/deploy.routes.test.ts`** — Deploy route tests with auth validation, credential redaction, and deployment state verification

### Modified Files
- **`src/index.ts`**
  - Protect `GET /api/v1/jobs/dlq` with `adminAuthGuard`
  - Protect `POST /api/v1/jobs/dlq/reprocess` with `adminAuthGuard`
  - Import adminAuthGuard middleware

- **`src/app.ts`** — Setup admin auth middleware integration

- **`src/config/env.schema.ts`** — Add `JWT_SECRET` validation for admin auth

- **`docs/api-keys.md`** — Document admin scopes (`deploy:*`, `jobs:admin`, `jobs:*`, `*`) and JWT role requirements

## Authentication Methods

### JWT Bearer Tokens
```http
Authorization: Bearer <jwt>
```
- Validated with `jsonwebtoken` using `JWT_SECRET` (HS256)
- Requires JWT `role` claim to be one of: `admin`, `superadmin`
- Rejects expired tokens and invalid signatures
- Demo token for tests: `demo-admin-token`

### API Keys
```http
X-API-Key: <key>
```
- Verified against stored API key hashes using `crypto.timingSafeEqual`
- Requires scope in `['deploy:*', 'jobs:admin', 'jobs:*', '*']`
- Checks expiration and activation status
- Returns 403 if key lacks admin scope

## Error Responses

All responses follow RFC 7231 and RFC 6585 standards:

- **401 Unauthorized** — Missing credentials or invalid token/key
- **403 Forbidden** — Valid credentials but insufficient permissions
- **No sensitive diagnostics** — Error messages never leak role/scope details

Example:
```json
{
  "error": {
    "code": "unauthorized",
    "message": "Authentication required. Provide Bearer JWT or X-API-Key.",
    "requestId": "abc-123"
  }
}
```

## Protected Endpoints

### DLQ Management (require admin auth)
- `GET /api/v1/jobs/dlq?type=<job-type>&limit=<n>&offset=<n>`
- `POST /api/v1/jobs/dlq/reprocess` (with audit logging)

### Blue-Green Deployment (require admin auth)
- `GET /api/v1/admin/deploy/status`
- `POST /api/v1/admin/deploy/switch-green`
- `POST /api/v1/admin/deploy/rollback`

## Security Features

- **Timing-safe comparison** for API key validation prevents timing attacks
- **Credential redaction** in logs via `redactSecret()` utility
- **Demo token bypass** for test environments only (`demo-admin-token`)
- **Audit logging** for all admin operations (DLQ reprocess, deployment state changes)
- **No partial grants** — single failed auth attempt rejects immediately

## Test Coverage

**19 tests** validate:
- ✅ Missing credentials (401)
- ✅ Invalid JWT signature (401)
- ✅ Expired JWT (401)
- ✅ Non-admin JWT role (401 or 403)
- ✅ Valid admin JWT allows access
- ✅ Demo tokens work in test environments
- ✅ Invalid API key (401)
- ✅ API key with insufficient scope (403)
- ✅ API key with admin scopes (`deploy:*`, `jobs:admin`, `jobs:*`, `*`)
- ✅ Expired API key (401)
- ✅ Credential redaction in audit logs
- ✅ Deployment routes reject unauthenticated access
- ✅ Deployment routes accept valid admin JWT

## Configuration

### Environment Variables
```bash
JWT_SECRET=<your-secret-key>  # Used to sign/verify admin JWTs
```

### API Key Scopes for Admin Access
```bash
# Full access
scope: ['*']

# Deploy operations only
scope: ['deploy:*']

# DLQ operations only
scope: ['jobs:admin'] or ['jobs:*']
```

## Breaking Changes
None — existing endpoints remain unchanged. Only adds auth enforcement to previously unprotected admin operations.

## Documentation
- `docs/api-keys.md` — Admin scope definitions and JWT role requirements
- Inline comments in `adminAuthGuard.ts` and route files

## Deployment Notes
- Ensure `JWT_SECRET` environment variable is set before deploying
- Generate admin API keys with appropriate scopes for service accounts
- Audit logs now record all admin operations with actor ID and resource details

## References
- RFC 7231: HTTP Semantics (401, 403)
- RFC 6585: HTTP Status Codes (429 per issue #259)
- OWASP: Authentication Cheat Sheet
