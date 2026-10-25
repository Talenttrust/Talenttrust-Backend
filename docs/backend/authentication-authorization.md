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
| Authorize | `src/auth/authorize.ts` | Pure `isAllowed(role, resource, action)` function + `evaluateAuthorization` decision API |
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

## Compatibility Contract

`isAllowed(role, resource, action)` is a stable public entry point. Its
contract, locked in by `src/auth/__tests__/authorize.test.ts`, is:

1. **Total** — it always returns a `boolean` and never throws, even for
   `null`/`undefined`, non-string values, or inherited object keys such as
   `__proto__` and `constructor`.
2. **Deny-by-default** — `true` is returned only for an exact, own grant in
   `ACCESS_CONTROL_MATRIX`; every other triplet resolves to `false`.
3. **Pure / deterministic** — no state is read or written, so repeated,
   retried, and concurrent calls with the same arguments return the same value.

> Prototype members are never treated as roles, resources, or grants: all
> matrix lookups use own-property checks, so injections like
> `isAllowed('admin', 'constructor', 'read')` are denied rather than throwing.

## Decision API & Observability

`evaluateAuthorization(role, resource, action)` returns
`{ allowed, reason }`, where `reason` is one of:

| Reason | Meaning | Logged as anomaly |
|--------|---------|-------------------|
| `allowed` | Explicit grant | — |
| `role_not_registered` | Role is not a matrix key | yes |
| `resource_not_registered` | Resource unknown to **every** role | yes |
| `resource_not_permitted` | Known resource not granted to this role | no |
| `action_not_recognized` | Action is not a known platform action | yes |
| `action_not_permitted` | Known action not granted for this role/resource | no |
| `invalid_input` | Malformed input or corrupted matrix cell | yes |

Anomalous denials emit a structured `warn` record
(`authorization_deny_unresolved_role`, `authorization_deny_unresolved_resource`,
`authorization_deny_unrecognized_action`, `authorization_deny_invalid_input`)
carrying the `reason` plus non-sensitive role/resource/action descriptors.
Ordinary permission denials are not logged, so audit noise stays low.

## Security Notes

- **Deny-by-default** — unknown roles, resources, or actions are always denied.
- **No privilege escalation** — the matrix is a compile-time constant; it
  cannot be mutated at runtime.
- **Input validation** — empty strings and unexpected types are rejected.
- **No sensitive data in logs** — anomaly records never expand caller payloads
  or echo tokens/identities.
- **Separation of concerns** — authentication (identity) and authorization
  (permission) are separate middleware layers.
- **Threat scenario coverage** — tests validate: missing headers, malformed
  tokens, unknown roles, prototype-pollution keys, privilege escalation
  attempts, and every cell of the access control matrix.

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
