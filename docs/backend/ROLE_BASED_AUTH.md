# Role-Based Authorization — Technical Reference

> **Branch:** `feature/backend-06-role-based-authorization`  
> **Scope:** `Talenttrust/Talenttrust-Backend`

---

## Overview

The authorization system enforces role-scoped permissions across all Talenttrust API endpoints. It is implemented as a three-layer stack:

```
HTTP Request
    │
    ▼
requireAuth          ← verifies JWT with jsonwebtoken, attaches req.user
    │
    ▼
requireRole          ← coarse-grained: is the user's role in the allowed set?
    OR
requirePermission    ← fine-grained: does the matrix allow this action? ownOnly?
    │
    ▼
Route Handler
```

---

## Roles

| Role         | Description                                              |
|--------------|----------------------------------------------------------|
| `admin`      | Full platform access. No ownership restrictions.         |
| `client`     | Posts jobs, manages contracts, makes payments.           |
| `freelancer` | Browses jobs, submits proposals, fulfils contracts.      |

Role values are validated against a readonly `ALL_ROLES` allowlist on every request. Unknown strings — including plausible forgeries like `"superadmin"` or `"ADMIN"` — are always rejected with HTTP 401. The `exp` claim is enforced by `jsonwebtoken` automatically.

---

## Permission Matrix

Permissions are declared as a readonly constant array (`PERMISSION_MATRIX`) in `src/types/roles.ts`. Each entry is:

```ts
{
  role:       Role;       // "admin" | "client" | "freelancer"
  resource:   Resource;  // "jobs" | "proposals" | "contracts" | ...
  action:     Action;    // "create" | "read" | "update" | "delete" | "list"
  ownOnly?:   boolean;   // if true, user.id must equal the record's owner id
}
```

### Quick-reference (non-admin roles)

| Resource    | Action   | client          | freelancer      |
|-------------|----------|-----------------|-----------------|
| jobs        | create   | ✅              | ❌              |
| jobs        | read     | ✅              | ✅              |
| jobs        | update   | ✅ (own only)   | ❌              |
| jobs        | delete   | ✅ (own only)   | ❌              |
| jobs        | list     | ✅              | ✅              |
| proposals   | create   | ❌              | ✅              |
| proposals   | read     | ✅ (own only)   | ✅ (own only)   |
| proposals   | update   | ❌              | ✅ (own only)   |
| proposals   | delete   | ❌              | ✅ (own only)   |
| contracts   | create   | ✅              | ❌              |
| contracts   | read     | ✅ (own only)   | ✅ (own only)   |
| payments    | create   | ✅              | ❌              |
| payments    | read     | ✅ (own only)   | ✅ (own only)   |
| reviews     | create   | ✅              | ✅              |
| reviews     | update   | ✅ (own only)   | ✅ (own only)   |
| reports     | *        | ❌              | ❌              |
| users       | *        | ❌              | ❌              |
| settings    | read     | ✅ (own only)   | ✅ (own only)   |
| settings    | update   | ✅ (own only)   | ✅ (own only)   |

Admin has unrestricted access to every resource and action (no `ownOnly` entries).

---

## Middleware API

### `requireAuth`

```ts
import { requireAuth } from "./middleware/authorization";

router.get("/jobs", requireAuth, handler);
```

Validates `Authorization: Bearer <token>` using `jwt.verify()` against `JWT_SECRET` (from `process.env`). Reads `sub`, `email`, and `role` directly from the decoded payload. On success, attaches `req.user: AuthenticatedUser`. Responds 401 on any failure, including expired tokens (distinguished by the message `"Token has expired."`).

**Required JWT payload:**
```json
{
  "sub":   "<userId>",
  "email": "<userEmail>",
  "role":  "admin" | "client" | "freelancer",
  "exp":   <unix timestamp>
}
```

**Environment variable required:** `JWT_SECRET` — the HMAC secret used to sign and verify all tokens.

---

### `requireRole(...roles)`

```ts
import { requireRole } from "./middleware/authorization";

// Admin only
router.get("/admin/reports", requireAuth, requireRole("admin"), handler);

// Admin or client
router.get("/contracts", requireAuth, requireRole("admin", "client"), handler);
```

Coarse-grained check. Responds 403 when `req.user.role` is not in the allowed list.  
Must come after `requireAuth`.

---

### `requirePermission(resource, action, [resolver])`

```ts
import { requirePermission } from "./middleware/authorization";

// No ownership check needed (all matching permissions are unrestricted for the role)
router.get("/jobs", requireAuth, requirePermission("jobs", "list"), handler);

// Ownership check — resolver fetches the record's owner id from the DB
router.patch(
  "/jobs/:id",
  requireAuth,
  requirePermission("jobs", "update", (req) => jobService.getOwnerId(req.params.id)),
  handler,
);
```

Fine-grained check against `PERMISSION_MATRIX`.

| Resolver return value | Outcome                                          |
|-----------------------|--------------------------------------------------|
| `string` (owner id)   | Ownership comparison runs; grant or 403          |
| `null`                | Record not found → **404** (hides existence)     |
| throws                | Server error → **500**                           |
| omitted               | ownOnly permissions are always denied            |

Responds 403 on denial. Must come after `requireAuth`.

---

## Security Notes

### Threat Model

| Threat                          | Mitigation                                                                      |
|---------------------------------|---------------------------------------------------------------------------------|
| Token forgery / manipulation    | Tokens verified cryptographically by `jwt.verify()` with `JWT_SECRET` (HS256); any tampered payload breaks the HMAC signature and is rejected before claims are read. |
| Token replay after expiry       | `jwt.verify()` enforces the `exp` claim automatically; expired tokens are rejected with a distinct 401 message. |
| Privilege escalation via role   | Role values are compared against a readonly constant allowlist after decode — not a DB query that could be manipulated. |
| Horizontal privilege escalation | `ownOnly` evaluated against a **DB-sourced** owner id, never against request input. |
| Resource existence leakage      | When the resolver returns `null` the middleware returns 404 (not 403), preventing attackers from enumerating which records exist. |
| Internal error leakage          | Catch blocks return the minimum safe error string; stack traces and internal ids are never surfaced. |
| 401 vs 403 confusion            | 401 = "who are you?", 403 = "I know who you are, but no". Both are applied correctly throughout. |

### What is NOT handled here

- Rate limiting (should be applied at the gateway or a separate middleware).
- Input validation / sanitisation (use a schema validator like `zod` before the auth middleware).
- Audit logging (instrument the route handlers or a separate middleware after auth passes).

---

## File Map

```
src/
├── lib/
│   └── types.ts                          ← ALL_ROLES, PERMISSION_MATRIX, AuthenticatedUser
├── lib/
│   ├── authorization.ts                  ← Pure engine: isAuthorized(), isValidRole()
│   ├── data.ts                           ← PERMISSION_MATRIX
│   ├── types.ts                          ← ALL_ROLES, AuthenticatedRequest, User
├── middleware/
│   ├── authorization.ts                  ← requireAuth, requireRole, requirePermission
│   └── __tests__/
│       └── authorization.test.ts         ← Integration tests (supertest + real jwt.sign tokens)
└── routes/
    └── index.ts                          ← Reference wiring for all protected routes
```

---

## Running Tests

```bash
npm install
npm test                  # all tests
npm run test:coverage     # with HTML coverage report
npm run test:ci           # CI mode: serial, 95% threshold enforced, fails on threshold miss
```

Coverage thresholds (enforced in `jest.config.ts`):

| Metric     | Threshold |
|------------|-----------|
| Branches   | 95%       |
| Functions  | 95%       |
| Lines      | 95%       |
| Statements | 95%       |