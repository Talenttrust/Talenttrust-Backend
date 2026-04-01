# Authentication & Authorization – Backend Documentation

## Overview

TalentTrust Backend uses **Role-Based Access Control (RBAC)** to protect API
endpoints. Every protected request must include a valid bearer token that
encodes a user identity and role. The system then checks the role against an
**Access Control Matrix** before granting access.

## Architecture

```
┌──────────┐     ┌────────────────────┐     ┌──────────────────┐     ┌─────────┐
│  Client   │────▶│ authenticateMiddleware │────▶│ requirePermission │────▶│ Handler │
└──────────┘     └────────────────────┘     └──────────────────┘     └─────────┘
                        │ 401                        │ 403
                        ▼                            ▼
                   Reject request              Reject request
```

### Modules

| Module | File | Purpose |
|--------|------|---------|
| Roles | `src/auth/roles.ts` | Defines roles, resources, actions, and the ACL matrix |
| Authorize | `src/auth/authorize.ts` | Pure `isAllowed(role, resource, action)` function |
| Authenticate | `src/auth/authenticate.ts` | Token decode/create helpers + Express middleware |
| Middleware | `src/auth/middleware.ts` | `requirePermission(resource, action)` factory |
| Barrel | `src/auth/index.ts` | Public re-exports |

## Roles

| Role | Description |
|------|-------------|
| `admin` | Full platform access |
| `freelancer` | Create/view own contracts and disputes, read users/reputation |
| `client` | Create/read/update contracts, create/read disputes |
| `guest` | Read-only access to public endpoints (health) |

## Access Control Matrix

| Resource \ Role | admin | freelancer | client | guest |
|-----------------|-------|------------|--------|-------|
| **contracts** | CRUD | CR | CRU | — |
| **users** | CRUD | R | R | — |
| **reputation** | RU | R | R | — |
| **disputes** | CRUD | CR | CR | — |
| **health** | R | R | R | R |

> **Deny-by-default**: Any role/resource/action combination not explicitly
> listed is denied.

## Authentication Flow

1. Client sends `Authorization: Bearer <token>` header.
2. `authenticateMiddleware` extracts the token after `Bearer `.
3. Token is base64-decoded and parsed as JSON: `{ userId, role }`.
4. Role is validated against `VALID_ROLES`.
5. On success, `req.user` is populated; on failure, 401 is returned.

### Token Format (test/dev)

```
Base64( JSON.stringify({ userId: "u1", role: "freelancer" }) )
```

> **Production note**: Replace with JWT / OAuth2 with cryptographic signature
> verification.

## Authorization Flow

1. `requirePermission(resource, action)` reads `req.user.role`.
2. Calls `isAllowed(role, resource, action)` against the matrix.
3. Returns 403 if denied; calls `next()` if allowed.

## Security Notes

- **Deny-by-default** — unknown roles, resources, or actions are always denied.
- **No privilege escalation** — the matrix is a compile-time constant; it
  cannot be mutated at runtime.
- **Input validation** — empty strings and unexpected types are rejected.
- **Separation of concerns** — authentication (identity) and authorization
  (permission) are separate middleware layers.
- **Threat scenario coverage** — tests validate: missing headers, malformed
  tokens, unknown roles, privilege escalation attempts, and every cell of the
  access control matrix.

## Testing

```bash
# Run all tests
npm test

# Run with coverage
npx jest --coverage
```

### Test Suites

| Suite | File | Type | Cases |
|-------|------|------|-------|
| Roles structure | `src/auth/__tests__/roles.test.ts` | Unit | Matrix integrity checks |
| Authorization logic | `src/auth/__tests__/authorize.test.ts` | Unit | Exhaustive positive/negative matrix |
| Authentication | `src/auth/__tests__/authenticate.test.ts` | Unit | Token handling + middleware |
| Permission middleware | `src/auth/__tests__/middleware.test.ts` | Unit | 401/403/next() paths |
| API integration | `src/__tests__/integration.test.ts` | Integration | Full HTTP request/response |
