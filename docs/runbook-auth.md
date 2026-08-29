# Auth Subsystem Operations Runbook

This document is the operator- and on-call-facing runbook for the TalentTrust
authentication and authorization subsystem. It covers configuration, common
failure modes, alert symptom triage, and step-by-step recovery procedures.

> **Audience:** Operators, DevOps, SRE, on-call engineers.
>
> **Related docs:**
> - [AUTH.md](../AUTH.md) — architecture, token lifecycle, RTR semantics
> - [docs/api-keys.md](./api-keys.md) — API key management, scopes, rotation
> - [docs/configuration.md](./configuration.md) — retry-policy env-var overrides
> - [docs/deploy.md](./deploy.md) — blue/green deploy & admin-auth notes
> - [docs/health.md](./health.md) — readiness/liveness probes
> - [docs/observability.md](./observability.md) — metrics and alerting

---

## 1. Subsystem Architecture

The auth subsystem is composed of three independent but complementary
authentication mechanisms and a shared RBAC authorization layer.

### 1.1 Authentication mechanisms

```
                   ┌──────────────────────────────────────┐
                   │         Incoming Request              │
                   └──────────────────┬───────────────────┘
                                      │
                    ┌─────────────────┼─────────────────┐
                    │                 │                 │
              ┌─────▼─────┐   ┌──────▼──────┐   ┌─────▼─────┐
              │  JWT      │   │  API Key    │   │  Legacy   │
              │  (prod)   │   │  (service)  │   │  Bearer   │
              │  HS256    │   │  PBKDF2     │   │  Base64   │
              └─────┬─────┘   └──────┬──────┘   └─────┬─────┘
                    │                 │                 │
                    └─────────────────┼─────────────────┘
                                      │
                          ┌───────────▼───────────┐
                          │   Authorization       │
                          │   RBAC / Scope Check  │
                          └───────────┬───────────┘
                                      │
                          ┌───────────▼───────────┐
                          │   Route Handler       │
                          └───────────────────────┘
```

| Mechanism | Source module | Header | Use case |
|-----------|--------------|--------|----------|
| JWT (HS256) | `src/middleware/authorization.ts` | `Authorization: Bearer <jwt>` | User sessions, frontend access |
| API Key | `src/auth/apiKeyMiddleware.ts` | `X-API-Key: <key>` | Service-to-service, internal automation |
| Legacy Bearer | `src/auth/authenticate.ts` | `Authorization: Bearer <base64>` | Demo/test only |

**Key middleware entry points:**

| Middleware | Module | Purpose |
|-----------|--------|---------|
| `requireAuth` | `src/middleware/authorization.ts` | Validates JWT; attaches `req.user` |
| `requireRole(...roles)` | `src/middleware/authorization.ts` | Coarse-grained role gate |
| `requirePermission(resource, action, getOwner?)` | `src/middleware/authorization.ts` | Fine-grained RBAC + ownership check |
| `adminAuthGuard` | `src/middleware/adminAuthGuard.ts` | Admin routes: JWT **or** API key with admin scope |
| `authenticateMiddleware` | `src/auth/authenticate.ts` | Legacy base64 token validation |
| `authenticateApiKey` | `src/auth/apiKeyMiddleware.ts` | API key validation; attaches `req.apiKey` |
| `requireApiKeyScope(resource, action)` | `src/auth/apiKeyMiddleware.ts` | API key scope enforcement |
| `authenticateEither` | `src/auth/apiKeyMiddleware.ts` | JWT-first fallback to API key |

### 1.2 Authorization model

Roles: **admin**, **auditor**, **client**, **freelancer**, **guest**.

> **⚠️ Important role discrepancy:** The `guest` role exists only in the legacy
> `src/auth/roles.ts` matrix (`VALID_ROLES`). The production authorization layer
> (`src/lib/authorization.ts` → `ALL_ROLES`) only recognizes `admin`, `auditor`,
> `client`, and `freelancer`. A JWT carrying `"role": "guest"` will be rejected
> with 401 by `requireAuth` (`isValidRole` returns false). The `guest` role
> only works with the legacy `/ auth/authenticate.ts` path.

Resources: `users`, `jobs`, `proposals`, `contracts`, `payments`, `reviews`,
`reports`, `settings`.

Actions: `create`, `read`, `update`, `delete`, `list`.

The authoritative RBAC matrix lives in `src/lib/authorization.ts`
(`PERMISSION_MATRIX`). It is **deny-by-default** — any (resource, action, role)
triplet not in the matrix is denied and logged as a `warn` record. A separate
legacy matrix exists at `src/auth/roles.ts` (`ACCESS_CONTROL_MATRIX`) used by
the `src/auth/middleware.ts` → `requirePermission` path.

Use the following table to determine which matrix governs a given route:

| Middleware import | Matrix used | File |
|---|---|---|
| `import { requirePermission } from '../auth/middleware'` | Legacy `ACCESS_CONTROL_MATRIX` | `src/auth/roles.ts` |
| `import { requirePermission } from '../middleware/authorization'` | Production `PERMISSION_MATRIX` | `src/lib/authorization.ts` |
| `import { requireAuth } from '../middleware/authorization'` | Production `isAuthorized` | `src/lib/authorization.ts` |

### 1.3 Token types and lifetimes

| Token | Algorithm | TTL | Storage |
|-------|-----------|-----|---------|
| Access Token (JWT) | HS256 | 15 min | Ephemeral (client memory) |
| Refresh Token (JWT) | HS256 | 7 days | `users.refresh_token_hash` (SHA-256 hash) |
| API Key | Random 32-byte hex | Configurable (optional expiry) | `api_keys.key_hash` (PBKDF2) + `key_selector` (SHA-256) |
| Legacy Bearer | Base64 (unsigned) | None | Ephemeral |

---

## 2. Configuration

### 2.1 Required environment variables

| Variable | Purpose | Validation |
|----------|---------|------------|
| `JWT_SECRET` | HMAC-SHA256 signing/verification key | Min 8 characters; **must** be set for JWT auth to work |
| `JWT_ALLOWED_ALGORITHMS` | **Hardcoded** to `["HS256"]` in `src/auth/jwtConfig.ts` | Do not override — pinned at build time |

### 2.2 JWT algorithm pinning

The `JWT_VERIFY_OPTIONS` object in `src/auth/jwtConfig.ts` is **frozen at
runtime** and restricts all `jwt.verify()` calls to `HS256` only. This is
binding on:

- `requireAuth` (`src/middleware/authorization.ts`)
- `adminAuthGuard` (`src/middleware/adminAuthGuard.ts`)

> **⚠️ Critical:** If `JWT_SECRET` is empty or not set, all JWT verification
> will fail with `401`. The fallback `getJwtSecret()` returns `""` when the env
> var is absent, causing every valid token to be rejected.

### 2.3 Session timeout

The access-token TTL is **15 minutes** (embedded in the JWT `exp` claim at
issuance). The refresh-token TTL is **7 days**. There are no additional
env-var overrides for session timeout — changes require a code update to
`src/services/auth.service.ts`.

> **Note:** `src/sessionTimeout.ts` is a client-side session timeout controller
> (for browser-based frontends). It schedules warning modals and auto-logout
> based on token expiry. It is not a server-side mechanism and does not affect
> the middleware auth path.

### 2.4 API key storage

API keys are stored in the `api_keys` table:

| Column | Format | Notes |
|--------|--------|-------|
| `key_hash` | `salt:hash` | PBKDF2 (SHA-256, 10k iterations), 32+128 hex chars |
| `key_selector` | SHA-256 hex | Deterministic lookup index, O(1) |
| `scope` | JSON array | e.g. `["contracts:*", "deploy:*"]` |
| `is_active` | boolean | Deactivated keys are never matched |

Validation of stored credentials validates format **before** calling PBKDF2 to
fail closed on malformed data.

---

## 3. Observability

### 3.1 Key log events

| Log message / pattern | Level | Meaning |
|-----------------------|-------|---------|
| `authorization_deny_unresolved_resource` | `warn` | Resource not in `PERMISSION_MATRIX` — possible misconfigured route or unsanitised input |
| `authorization_deny_unresolved_action` | `warn` | Action not in matrix |
| `authorization_deny_unresolved_role` | `warn` | Role not in matrix for that resource+action cell |
| `"invalid token"` / `"Token has expired"` | `warn` | Expected on expiry; spikes indicate clock-skew or widespread expired sessions |
| `"Invalid or expired JWT token."` | (response) | JWT rejected by `adminAuthGuard` |
| `"API key validation error:"` | `error` (console) | `validateApiKey` threw — database error or crypto failure |
| `isAuthorized denied:` | `info` (console) | Permission denied with structured context |

### 3.2 HTTP response codes

| Code | Error body `code` | Typical cause |
|------|------------------|---------------|
| **401** | `unauthorized` | Missing/malformed `Authorization` header, expired JWT, invalid signature, unrecognised role, missing claims |
| **401** | `unauthorized` (API key) | Missing `X-API-Key`, invalid key, expired key |
| **403** | `forbidden` | Role lacks permission, insufficient API key scope, non-admin calling admin endpoint |
| **404** | `not_found` | `requirePermission` ownOnly check: record doesn't exist (returned instead of 403 to avoid leaking existence) |
| **500** | `internal_error` | Authorization resolver threw, or `validateApiKey` rejected |

### 3.3 Metrics to watch

- **401 rate** — sustained increases may indicate:
  - Expired `JWT_SECRET` rotation (old tokens still in flight)
  - Clock skew between auth server and verifying servers
  - Brute-force attempts
- **403 rate** — spikes may indicate misconfigured RBAC or scope changes
- **`authorization_deny_unresolved_*` log rate** — newly added resources/actions without matrix entries
- **API key last-used timestamps** — keys unused for N days may be candidates for deactivation

---

## 4. Common Failure Modes

### 4.1 All requests return 401

**Symptoms:**
```
curl -H "Authorization: Bearer <valid-token>" http://localhost:3001/api/v1/contracts
→ 401 { "error": { "code": "unauthorized", "message": "Invalid token." } }
```

**Root causes (in order of likelihood):**

1. **`JWT_SECRET` is not set or differs from the issuer.**
   - Verify: `echo $JWT_SECRET`
   - Check that all instances (blue, green, and the issuer) share the same secret.

2. **Clock skew > token TTL.**
   - The access token TTL is only 15 minutes. If the server clock is off by
     more than that, every token appears expired.
   - Verify: `date -u` on all instances — compare with `ntpdate -q pool.ntp.org`.
   - The `exp` claim is enforced by `jsonwebtoken.verify()`; no separate check.

3. **Token signed with an algorithm other than HS256.**
   - `JWT_VERIFY_OPTIONS` pins to `["HS256"]` only. Tokens signed with HS384,
     HS512, RS256, or `alg: none` are rejected before signature verification.
   - Verify: decode the token header at [jwt.io](https://jwt.io) and confirm
     `"alg": "HS256"`.

4. **`jsonwebtoken` library rejects all tokens due to a bug/misconfiguration.**
   - Extremely rare; check that `JWT_VERIFY_OPTIONS` is not corrupted (it is
     frozen at import time, so this should be impossible at runtime).

**Recovery:**
```bash
# 1. Confirm JWT_SECRET is set and consistent
echo $JWT_SECRET

# 2. Check system clock
date -u
timedatectl status

# 3. Generate a test token and verify locally
node -e "
const jwt = require('jsonwebtoken');
const { JWT_VERIFY_OPTIONS } = require('./dist/auth/jwtConfig');
const tok = jwt.sign({ sub:'test', email:'test@tt.com', role:'admin' }, process.env.JWT_SECRET, { algorithm:'HS256', expiresIn:'1h' });
console.log('Token:', tok);
const dec = jwt.verify(tok, process.env.JWT_SECRET, JWT_VERIFY_OPTIONS);
console.log('Decoded:', dec);
"

# 4. Curl with the test token
curl -H "Authorization: Bearer $TOK" http://localhost:3001/api/v1/health
```

### 4.2 Admin endpoint returns 403 despite valid JWT

**Symptoms:**
```
curl -H "Authorization: Bearer <admin-jwt>" http://localhost:3001/api/v1/admin/deploy/status
→ 403 { "error": { "code": "forbidden", "message": "Admin role required." } }
```

**Root causes:**

1. **JWT `role` claim is not `"admin"`.** `adminAuthGuard` checks
   `ADMIN_ROLES = new Set(['admin', 'superadmin'])`.
   - Verify: decode the JWT and check the `role` field.

2. **Using demo tokens incorrectly.** The demo tokens `demo-admin-token` and
   `demo-user-token` are only recognized by `adminAuthGuard`, not by
   `requireAuth`.

**Recovery:**
```bash
# Decode and verify role
node -e "
const jwt = require('jsonwebtoken');
const tok = '<paste-admin-token>';
const dec = jwt.decode(tok);
console.log('Role:', dec?.role);
"
# Should output: Role: admin
```

### 4.3 API key returns 401

**Symptoms:**
```
curl -H "X-API-Key: <key>" http://localhost:3001/api/v1/contracts
→ 401 { "error": "Invalid API key" }
```

**Root causes:**

1. **Key was rotated or deactivated.**
   - Check `SELECT id, name, is_active, expires_at, last_used_at FROM api_keys WHERE id = '<key-id>';`

2. **Key expired.**
   - Expired keys are deactivated on first use after expiry. Check `expires_at`.

3. **Stored credential format is corrupt.**
   - `key_hash` must match `^[a-f0-9]{32}:[a-f0-9]{128}$`. Malformed entries
     are rejected before PBKDF2. Run:
     ```sql
     SELECT id, LENGTH(key_hash) AS len FROM api_keys WHERE key_hash NOT REGEXP '^[a-f0-9]{32}:[a-f0-9]{128}$';
     ```

4. **Key was created with the legacy path (no `key_selector`).**
   - The first validation will backfill the selector. If the database is
     read-only or write-locked, this can fail silently (error caught).
   - Check for I/O errors in the database logs.

5. **PBKDF2 timing variation on overloaded CPU.**
   - Under extreme load, `timingSafeEqual` may still pass, but the 10k
     iterations of PBKDF2 can add latency.

**Recovery:**
```bash
# 1. Create a fresh key via the management endpoint and test
curl -X POST http://localhost:3001/api/v1/api-keys \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <admin-token>" \
  -d '{"name":"recovery-key","scope":["*"]}'

# 2. Test with the new key
curl -H "X-API-Key: <new-key>" http://localhost:3001/api/v1/health

# 3. If the issue is widespread, verify the database
sqlite3 talenttrust.db "SELECT COUNT(*) AS total, SUM(CASE WHEN is_active THEN 1 ELSE 0 END) AS active FROM api_keys;"
```

### 4.4 Permission denied (403) for a role that should have access

**Symptoms:** A user with a known role (e.g., `freelancer`) receives 403 on a
route they previously accessed.

**Root causes:**

1. **New resource or action not in the matrix.**
   - Adding a new `Resource` or `Action` to `src/lib/types.ts` without updating
     `PERMISSION_MATRIX` causes a TypeScript compile error — but if the build
     was bypassed or the check was weakened, the runtime fallback is
     deny-by-default with a `warn` log.

2. **`requirePermission` ownership gate.**
   - For `ownOnly` cells, the `getResourceOwnerId` resolver is called. If it
     returns `null` (record deleted) → 404. If it returns a different user's ID
     → 403. If the resolver throws → 500.

3. **Dual-matrix inconsistency.**
   - The legacy matrix in `src/auth/roles.ts` and the production matrix in
     `src/lib/authorization.ts` are **separate**. Routes using the legacy
     `requirePermission` (from `src/auth/middleware.ts`) may grant different
     access than routes using the production `requirePermission` (from
     `src/middleware/authorization.ts`). Check which middleware the route uses.

**Recovery:**
```bash
# 1. Check which middleware the route uses
grep -r "<route-path>" src/routes/

# 2. Review the relevant matrix cell
# Production: src/lib/authorization.ts → PERMISSION_MATRIX
# Legacy:     src/auth/roles.ts → ACCESS_CONTROL_MATRIX

# 3. Emit a test query against the matrix
node -e "
const { isAuthorized } = require('./dist/lib/authorization');
console.log(isAuthorized({ user:{id:'u1',email:'u@t.com',role:'freelancer'}, resource:'contracts', action:'update', resourceOwnerId:'u1' }));
// → { granted: true, reason: 'Permission granted (owner).' }
"
```

### 4.5 Refresh token rotation failures (RTR)

**Symptoms:** Clients receive `401` with `invalid_refresh_token` when trying to
refresh their session.

**Root causes:**

1. **Token already used (replay).** Refresh tokens are single-use. If a client
   sends the same refresh token twice (network retry, buggy SDK), the second
   attempt fails because the hash was already cleared.

2. **Token expired.** Refresh tokens have a 7-day TTL embedded in the `exp`
   JWT claim.

3. **Database write failure during rotation.** The rotation flow does:
   `DELETE old hash → INSERT new hash`. If the database fails between these
   steps, the old token is nulled but the new one might not have been written.

4. **`JWT_SECRET` rotation.** If the secret was rotated while refresh tokens
   were in flight, the old tokens cannot be verified.

**Recovery:**
```bash
# Check user's refresh token state
sqlite3 talenttrust.db "SELECT id, email, refresh_token_hash IS NOT NULL AS has_refresh FROM users WHERE email = '<user-email>';"
# NULL → token was consumed or never issued; non-NULL → token still valid

# If widespread, check JWT_SECRET consistency
echo $JWT_SECRET
```

---

## 5. Health Checks & Alerts

### 5.1 Startup health checks

The following must be verified at instance startup. These are **not** runtime
Prometheus alerts but should be part of your deployment pre-flight checklist
or startup probe.

| Check | How to verify | Severity |
|-------|--------------|----------|
| `JWT_SECRET` is set | `echo $JWT_SECRET` — must be non-empty, ≥ 8 chars | **Critical** |
| Database accessible | `sqlite3 talenttrust.db "SELECT 1"` | **Critical** |
| `JWT_VERIFY_OPTIONS` frozen | Covered by test suite: `npm test -- --testPathPattern=jwtConfig` | **High** |
| No corrupt API key hashes | `SELECT COUNT(*) FROM api_keys WHERE key_hash NOT REGEXP '^[a-f0-9]{32}:[a-f0-9]{128}$'` | **High** |

### 5.2 Runtime alerts

| Alert | Condition | Severity | Response |
|-------|-----------|----------|----------|
| **Auth 401 spike** | `rate(http_requests_total{status_code="401"}) > baseline * 3` for 5 min | **Critical** | See §4.1 |
| **Auth 403 spike** | `rate(http_requests_total{status_code="403"}) > baseline * 5` for 5 min | **High** | See §4.4 |
| **API key validation errors** | Console `error` log contains "API key validation error" | **High** | See §4.3 |
| **Authorization matrix gaps** | Log contains `authorization_deny_unresolved_resource` | **Medium** | Check for recently added resources |
| **Expired API keys in use** | Service attempts auth with expired key (observed via logs or metrics) | **Low** | Rotate or deactivate key |
| **Database I/O errors on auth path** | `validateApiKey` throws due to DB failure | **Critical** | Check disk/database health |

### 5.3 Dashboard queries

```
# 401 rate by route (PromQL — adjust label names to match your metrics)
rate(http_requests_total{status_code="401"}[5m])

# Active API keys approaching expiry
sqlite3 talenttrust.db "
  SELECT name, expires_at
  FROM api_keys
  WHERE is_active = 1
    AND expires_at IS NOT NULL
    AND expires_at < datetime('now', '+7 days')
  ORDER BY expires_at;
"

# Users without refresh tokens (all logged out)
sqlite3 talenttrust.db "
  SELECT COUNT(*) AS logged_out_users
  FROM users WHERE refresh_token_hash IS NULL;
"
```

---

## 6. Recovery Procedures

### 6.1 Emergency JWT_SECRET rotation

If `JWT_SECRET` is compromised:

1. **Generate a new secret:**
   ```bash
   openssl rand -hex 32
   ```

2. **Update the secret on the issuer** (auth service that generates tokens).

3. **Update `JWT_SECRET` on all backend instances** (blue, green, and any
   other replicas) **simultaneously** or within the access-token TTL (15 min)
   window.

4. **Restart all instances** to pick up the new secret:
   ```bash
   npm run deploy:restart:blue
   npm run deploy:restart:green
   ```

5. **Force all users to re-authenticate.** Since refresh tokens are also
   signed with the same `JWT_SECRET`, all existing refresh tokens become
   invalid. Users will be logged out and must log in again.

> **Note on zero-downtime rotation:** The current codebase does **not** support
> dual-secret verification — `JWT_VERIFY_OPTIONS` takes a single `JWT_SECRET`
> and there is no key-rotation mechanism. A hypothetical zero-downtime strategy
> would require the issuer to sign tokens with both secrets during a transition
> window (7 days, matching the refresh-token TTL), and all verifying instances
> to accept either secret. This is not currently implemented.

### 6.2 Revoke all active sessions

**Method 1 — clear all refresh tokens (force re-login for everyone):**
```bash
sqlite3 talenttrust.db "UPDATE users SET refresh_token_hash = NULL;"
```
All active sessions end at their access-token expiry (max 15 min).

**Method 2 — rotate JWT_SECRET (see §6.1).**

**Method 3 — revoke a single user:**
```bash
sqlite3 talenttrust.db "UPDATE users SET refresh_token_hash = NULL WHERE email = '<user-email>';"
```

### 6.3 Deactivate a compromised API key

```bash
# Via management endpoint
curl -X DELETE http://localhost:3001/api/v1/api-keys/<key-id> \
  -H "Authorization: Bearer <admin-token>"

# Or directly in the database
sqlite3 talenttrust.db "UPDATE api_keys SET is_active = 0 WHERE id = '<key-id>';"
```

Then audit all keys created by the same user:
```bash
sqlite3 talenttrust.db "SELECT id, name, scope, created_at, last_used_at FROM api_keys WHERE created_by = '<user-id>';"
```

### 6.4 Fix a missing permission in the RBAC matrix

1. **Identify the route and resource:**
   ```bash
   grep -A 5 "requirePermission\|requireRole" src/routes/*.ts | grep -B 5 "403\|forbidden"
   ```

2. **Edit the matrix:**
   - Production: `src/lib/authorization.ts` → `PERMISSION_MATRIX`
   - Legacy: `src/auth/roles.ts` → `ACCESS_CONTROL_MATRIX`

3. **Build and verify:**
   ```bash
   npm run build        # TypeScript will flag any missing cells
   npm test             # Authorization tests should cover the change
   ```

4. **Deploy using the standard blue/green flow** (see [deploy.md](./deploy.md)).

### 6.5 Recover from database corruption in API key storage

If `key_hash` values are corrupt (malformed `salt:hash`):

1. **Identify affected keys:**
   ```sql
   SELECT id, name, LENGTH(key_hash), SUBSTR(key_hash, 1, 20) AS preview
   FROM api_keys
   WHERE key_hash NOT REGEXP '^[a-f0-9]{32}:[a-f0-9]{128}$';
   ```

2. **For each affected key, rotate it** (generates a new valid hash):
   ```bash
   curl -X POST http://localhost:3001/api/v1/api-keys/<id>/rotate \
     -H "Authorization: Bearer <admin-token>"
   ```

3. **Or deactivate if no longer needed:**
   ```bash
   curl -X DELETE http://localhost:3001/api/v1/api-keys/<id> \
     -H "Authorization: Bearer <admin-token>"
   ```

---

## 7. End-to-End Smoke Test

After any auth-related change or recovery procedure, run these checks to
verify the subsystem is healthy end-to-end.

### 7.1 Prerequisites

```bash
# Ensure you have a valid admin token
export ADMIN_TOKEN=$(node -e "
const jwt = require('jsonwebtoken');
const tok = jwt.sign(
  { sub:'smoke-test', email:'smoke@tt.com', role:'admin' },
  process.env.JWT_SECRET,
  { algorithm:'HS256', expiresIn:'1h' }
);
console.log(tok);
")
```

### 7.2 JWT auth smoke test

```bash
# 1. Health endpoint (unauthenticated)
curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/health
# Expected: 200

# 2. Protected route with valid JWT
curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:3001/api/v1/health
# Expected: 200

# 3. Protected route without JWT
curl -s -o /dev/null -w "%{http_code}" \
  http://localhost:3001/api/v1/contracts
# Expected: 401

# 4. Protected route with expired token
EXPIRED_TOKEN=$(node -e "
const jwt = require('jsonwebtoken');
console.log(jwt.sign({sub:'t',email:'t@t.com',role:'admin'}, process.env.JWT_SECRET, {algorithm:'HS256',expiresIn:-10}));
")
curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $EXPIRED_TOKEN" \
  http://localhost:3001/api/v1/health
# Expected: 401

# 5. Admin route with admin JWT
curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:3001/api/v1/admin/deploy/status
# Expected: 200 (or 404 if admin routes aren't mounted — check routing)

# 6. Malformed Bearer header
curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Basic dGVzdDp0ZXN0" \
  http://localhost:3001/api/v1/health
# Expected: 401
```

### 7.3 API key auth smoke test

```bash
# 1. Create a test API key (requires admin JWT)
CREATE_RESP=$(curl -s -X POST http://localhost:3001/api/v1/api-keys \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"name":"smoke-test-key","scope":["*"]}')
TEST_KEY=$(echo "$CREATE_RESP" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).apiKey))")

# 2. Use the API key
curl -s -o /dev/null -w "%{http_code}" \
  -H "X-API-Key: $TEST_KEY" \
  http://localhost:3001/api/v1/health
# Expected: 200

# 3. Missing API key
curl -s -o /dev/null -w "%{http_code}" \
  http://localhost:3001/api/v1/contracts
# Expected: 401

# 4. Clean up — deactivate the test key
KEY_ID=$(echo "$CREATE_RESP" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).info.id))")
curl -s -X DELETE "http://localhost:3001/api/v1/api-keys/$KEY_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# Expected: 200

# 5. Deactivated key should be rejected
curl -s -o /dev/null -w "%{http_code}" \
  -H "X-API-Key: $TEST_KEY" \
  http://localhost:3001/api/v1/health
# Expected: 401
```

### 7.4 RBAC smoke test

```bash
# Freelancer token — should be able to read contracts but not delete them
FREELANCER_TOKEN=$(node -e "
const jwt = require('jsonwebtoken');
console.log(jwt.sign({sub:'f1',email:'free@tt.com',role:'freelancer'}, process.env.JWT_SECRET, {algorithm:'HS256',expiresIn:'1h'}));
")

# Read contracts (should succeed: freelancer has 'read' on contracts)
curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $FREELANCER_TOKEN" \
  http://localhost:3001/api/v1/contracts
# Expected: 200 (or 404 if no contracts exist — NOT 403)
```

### 7.5 All-clear criteria

All the following must pass before declaring the auth subsystem healthy:

- [ ] Unauthenticated health check returns 200
- [ ] Valid JWT accesses protected route (200)
- [ ] Missing JWT returns 401
- [ ] Expired JWT returns 401
- [ ] Valid API key accesses protected route (200)
- [ ] Deactivated API key returns 401
- [ ] Non-admin JWT is rejected from admin-only routes (403)
- [ ] Malformed `Authorization` header returns 401

---

## 8. Troubleshooting Quick Reference

| Symptom | Check | Section |
|---------|-------|---------|
| All requests 401 | `echo $JWT_SECRET` → set? Consistent across instances? | §4.1 |
| | `date -u` → clock synced? | §4.1 |
| | Decode token → `alg: HS256`? | §4.1 |
| Admin endpoint 403 | Decode JWT → `role: admin`? | §4.2 |
| | API key → has `deploy:*` or `*` scope? | §4.2 |
| API key 401 | Key expired? `SELECT expires_at FROM api_keys` | §4.3 |
| | Key deactivated? `SELECT is_active FROM api_keys` | §4.3 |
| | Stored hash format valid? | §4.3 |
| Permission 403 | Which middleware? `grep "requirePermission" routes/*.ts` | §4.4 |
| | Which matrix? Production vs. legacy | §4.4 |
| | Ownership check failing? `resourceOwnerId` mismatch | §4.4 |
| Refresh fails | Token already used (replay)? | §4.5 |
| | `refresh_token_hash IS NULL`? | §4.5 |
| | `JWT_SECRET` rotated? | §4.5 |

---

## 9. Code Layout Reference

```
src/auth/
  authenticate.ts       — Legacy base64 bearer token middleware
  authenticate.test.ts  — Tests for legacy auth + JWT algorithm hardening
  authorize.ts          — Legacy `isAllowed` function (uses ACCESS_CONTROL_MATRIX)
  roles.ts              — Legacy matrix + role/resource/action types
  jwtConfig.ts          — Algorithm pinning, frozen verify options
  middleware.ts          — Legacy `requirePermission` factory
  apiKeys.ts            — API key gen, hash, verify, rotate, deactivate
  apiKeyMiddleware.ts   — API key auth middleware + scope enforcement
  apiKeyMiddleware.test.ts — Tests for API key middleware
  index.ts              — Re-exports

src/middleware/
  authorization.ts      — Production `requireAuth`, `requireRole`, `requirePermission`
  adminAuthGuard.ts     — Combined JWT+API-key admin auth guard

src/lib/
  authorization.ts      — Production `PERMISSION_MATRIX`, `isAuthorized`, `isValidRole`
  types.ts              — Role, Resource, Action, User, Permission types
  authHelpers.ts        — `extractBearerToken`, `sendUnauthorized`, `sendForbidden`

src/services/
  auth.service.ts       — Register, login, refresh, logout (JWT lifecycle)

src/routes/
  auth.routes.ts        — Auth HTTP endpoints
  apiKeys.routes.ts     — API key management HTTP endpoints

docs/
  AUTH.md               — Auth architecture, RTR, security properties
  api-keys.md           — API key lifecycle, scopes, management API
```

---

**Last Updated:** 2026-07-25  
**Version:** 1.0  
**Maintainer:** TalentTrust Backend Team
