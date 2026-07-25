# API Keys Subsystem Operations Runbook

This document is the operator- and on-call-facing runbook for the TalentTrust
**API key** subsystem — creation, hashing, validation, rotation, revocation,
and the management HTTP surface. It covers configuration, common failure
modes, alert symptom triage, and step-by-step recovery procedures.

> **Audience:** Operators, DevOps, SRE, on-call engineers.
>
> **Related docs:**
> - [docs/api-keys.md](./api-keys.md) — API key feature reference: scopes, request/response shapes, management API
> - [docs/runbook-auth.md](./runbook-auth.md) — Auth subsystem runbook (JWT, RBAC); API keys are one of three auth mechanisms it summarizes
> - [docs/backend/RATE_LIMITING.md](./backend/RATE_LIMITING.md) — Rate limiting tiers and configuration
> - [docs/deploy.md](./deploy.md) — Blue/green deploy; `adminAuthGuard` gates deploy endpoints via admin-scoped API keys
> - [docs/backend/logging-security.md](./backend/logging-security.md) / [docs/backend/REDACTION-QUICK-REFERENCE.md](./backend/REDACTION-QUICK-REFERENCE.md) — `X-API-Key` header redaction in logs

---

## 1. Subsystem Architecture

### 1.1 Components

```
                     ┌───────────────────────────────┐
                     │   Incoming Request            │
                     │   X-API-Key: <64-hex-key>      │
                     └───────────────┬───────────────┘
                                     │
                     ┌───────────────▼───────────────┐
                     │  authenticateApiKey /          │
                     │  authenticateEither /          │
                     │  adminAuthGuard                │
                     │  (src/auth/apiKeyMiddleware.ts,│
                     │   src/middleware/               │
                     │   adminAuthGuard.ts)           │
                     └───────────────┬───────────────┘
                                     │
                     ┌───────────────▼───────────────┐
                     │  validateApiKey()              │
                     │  (src/auth/apiKeys.ts)         │
                     │  1. SHA-256 selector lookup     │
                     │  2. PBKDF2 verify (salted)      │
                     │  3. legacy O(n) fallback        │
                     └───────────────┬───────────────┘
                                     │
                     ┌───────────────▼───────────────┐
                     │  requireApiKeyScope(res, act)   │
                     │  → 403 if scope missing         │
                     └───────────────┬───────────────┘
                                     │
                              Route handler
```

The management endpoints (create/list/get/rotate/deactivate a key) are a
**separate path** — they are protected by JWT/legacy-bearer auth
(`authenticateMiddleware` + `requirePermission('api-keys', <action>)`), not by
an API key, since their job is to manage the keys themselves.

```
POST/GET /api/v1/api-keys, GET/POST/DELETE /api/v1/api-keys/:id
                                     │
                     ┌───────────────▼───────────────┐
                     │  authenticateMiddleware        │
                     │  (src/auth/authenticate.ts)     │
                     └───────────────┬───────────────┘
                                     │
                     ┌───────────────▼───────────────┐
                     │  requirePermission('api-keys',  │
                     │    create|read|update|delete)  │
                     │  (src/auth/roles.ts matrix)     │
                     └───────────────┬───────────────┘
                                     │
                     ┌───────────────▼───────────────┐
                     │  apiKeyController               │
                     │  (src/controllers/               │
                     │   apiKeyController.ts)          │
                     │  + per-key ownership check      │
                     │    (created_by === caller)       │
                     └───────────────┬───────────────┘
                                     │
                     ┌───────────────▼───────────────┐
                     │  DatabaseService                │
                     │  (src/database/index.ts)        │
                     │  api_keys table                 │
                     └───────────────────────────────┘
```

### 1.2 Code layout reference

| Module | Responsibility |
|--------|-----------------|
| `src/auth/apiKeys.ts` | Key generation, PBKDF2 hashing, `key_selector` computation, `createApiKey`, `validateApiKey`, `rotateApiKey`, `deactivateApiKey` |
| `src/auth/apiKeyMiddleware.ts` | `authenticateApiKey` (401 on missing/invalid key), `requireApiKeyScope` (403 on insufficient scope), `authenticateEither` (JWT-first, API-key fallback) |
| `src/middleware/adminAuthGuard.ts` | Admin-surface guard: JWT with `admin`/`superadmin` role **or** API key with an admin scope (`deploy:*`, `*`, `jobs:admin`, `jobs:*`) |
| `src/controllers/apiKeyController.ts` | HTTP handlers for create/list/get/rotate/deactivate; scope-format validation; ownership enforcement |
| `src/routes/apiKeys.routes.ts` | Route wiring: `authenticateMiddleware` + `requirePermission('api-keys', ...)` per endpoint |
| `src/database/index.ts` | `DatabaseService` persistence: `createApiKey`, `getApiKeyById`, `getApiKeyBySelector`, `listApiKeysPage`, `updateApiKey`, `rotateApiKey`, `deactivateApiKey`, `backfillKeySelectors` |
| `src/database/schema.ts` | `ApiKey` interface (the `api_keys` table shape) |
| `src/auth/roles.ts` | Legacy RBAC matrix (`ACCESS_CONTROL_MATRIX`); every role except `auditor`/`guest` has full CRUD on the `api-keys` resource — ownership narrows this further, see §1.3 |
| `src/utils/redact.ts` | `x-api-key` is in `SENSITIVE_HEADER_NAMES` — always redacted in structured logs |

### 1.3 Mounting and route registration

`apiKeysRouter` **is** mounted in `src/app.ts`:

```ts
import apiKeysRouter from './routes/apiKeys.routes';
app.use('/api/v1', apiKeysRouter);
```

giving the endpoints `POST/GET /api/v1/api-keys` and
`GET/POST/DELETE /api/v1/api-keys/:id[/rotate]`. This confirms the management
API is live in the running app — check `src/app.ts` directly if this ever
appears not to be the case after a refactor, since route wiring is easy to
silently drop during merges.

Access to an individual key is gated by **ownership**, not role: every
non-`auditor`/`guest` role has full `create`/`read`/`update`/`delete`
permission on the `api-keys` resource in `ACCESS_CONTROL_MATRIX`, so
`GET /:id`, `POST /:id/rotate`, and `DELETE /:id` additionally check that
`existingKey.created_by === req.user.userId`, returning `403 Access denied`
on mismatch. `GET /api/v1/api-keys` only lists **active** keys created by the
caller — other users' keys, and the caller's own deactivated keys, never
appear. A deactivated key resolves as `404 API key not found` on `GET /:id`,
`POST /:id/rotate`, and `DELETE /:id`, not as a "deactivated" status, because
`getApiKeyById` filters to `is_active` rows.

### 1.4 Key format and storage

| Property | Value |
|----------|-------|
| Plain-text key | 32 random bytes, hex-encoded → 64 hex characters |
| Hash algorithm | PBKDF2, SHA-256, 10,000 iterations, 64-byte output |
| Stored `key_hash` | `"<salt>:<hash>"` — 32 hex chars (16-byte salt) + `:` + 128 hex chars (64-byte hash) |
| `key_selector` | `SHA-256(plain_key)` hex digest — deterministic, non-reversible index for O(1) lookup |
| Comparison | `crypto.timingSafeEqual` on the PBKDF2 output (constant-time) |
| Plain key visibility | Returned **only once**, in the create/rotate HTTP response body; never persisted or re-derivable |

---

## 2. Configuration

### 2.1 Environment variables actually consumed by this subsystem

The API key subsystem itself has **no dedicated required environment
variables** — key material is generated at runtime with `crypto.randomBytes`
and stored per-request in the `api_keys` table. The only env-driven behavior
that touches API keys:

| Variable | Consumed by | Effect |
|----------|-------------|--------|
| `RL_AUTH_MAX`, `RL_AUTH_WINDOW_MS`, `RL_AUTH_ABUSE_THRESHOLD` (and related `RL_*`) | `src/config/rateLimit.ts`, `src/auth/rateLimitKey.ts` | The `auth` rate-limit tier keys its per-client bucket off `X-API-Key` when present (falls back to client IP); this governs `/api/v1/auth/*` endpoints, **not** the `api-keys` management routes (see §4.5) |
| `JWT_SECRET` | `src/middleware/adminAuthGuard.ts`, `src/auth/authenticate.ts` | Required for the JWT branch of `adminAuthGuard`/`requireAuth`; irrelevant to the API-key branch |

> **⚠️ Known discrepancy — `ADMIN_API_KEY` / `ADMIN_API_KEY_SCOPES` are dead
> config.** `src/config/env.schema.ts` defines and validates
> `ADMIN_API_KEY` (optional string) and `ADMIN_API_KEY_SCOPES` (comma-separated
> list, defaulting to `['deploy:*', '*', 'jobs:admin', 'jobs:*']`), and
> `.env.example` documents `ADMIN_API_KEY`, `ADMIN_API_KEY_HASH`, and
> `ROTATE_ADMIN_API_KEY` as if they seed or rotate an admin key at boot.
> **No code path reads any of these three variables** — `adminAuthGuard`
> authenticates admin API keys exclusively by looking them up in the
> `api_keys` table via `validateApiKey()` and checking `scope` against
> `REQUIRED_ADMIN_SCOPES`. Setting `ADMIN_API_KEY` in the environment has
> **no effect**; it does not create or authorize a key. To provision an admin
> key, create one through the management endpoint (§6.2) with an admin scope
> (`*`, `deploy:*`, `jobs:admin`, or `jobs:*`) — do not rely on env vars.

### 2.2 Scope format

Scopes are strings matched against `resource:action`:

| Pattern | Meaning | Validated in |
|---------|---------|--------------|
| `resource:action` | Exact match (e.g. `contracts:read`) | `apiKeyController.createApiKeyController` (creation-time format check), `requireApiKeyScope` (request-time match) |
| `resource:*` | All actions on a resource | same |
| `*:action` | One action on any resource | same |
| `*` | Full access — admin keys only | same |

Creation-time validation (`src/controllers/apiKeyController.ts`) rejects
malformed scope strings with `400 Invalid scope format` before the key is
ever generated. Request-time validation (`requireApiKeyScope` in
`src/auth/apiKeyMiddleware.ts`) checks the authenticated key's `scope` array
against the route's required `resource:action` and returns `403` on mismatch.

### 2.3 Admin scope allowlist

`src/middleware/adminAuthGuard.ts` defines:

```ts
const REQUIRED_ADMIN_SCOPES = new Set(['deploy:*', '*', 'jobs:admin', 'jobs:*']);
```

An API key must carry at least one of these exact scope strings to pass
`adminAuthGuard` (used for deploy switch/rollback/status and DLQ list/replay
endpoints — see [docs/deploy.md](./deploy.md)). `contracts:*` or other
non-admin wildcards will **not** satisfy this guard even though they satisfy
`requireApiKeyScope` elsewhere.

### 2.4 Pagination configuration

`GET /api/v1/api-keys` is cursor-paginated via `listApiKeysPage`
(`src/database/index.ts`):

| Parameter | Behavior |
|-----------|----------|
| `limit` | Optional, 1–`MAX_PAGE_LIMIT` (100, from `src/utils/pagination.ts`). Out-of-range or non-numeric values are **clamped**, not rejected — a request for `limit=99999` silently returns 100 rows. Omitted/non-positive falls back to `DEFAULT_PAGE_LIMIT`. |
| `cursor` | Opaque, from the previous page's `nextCursor`. A malformed or tampered cursor is rejected with `400` by `decodeCursor` (`src/contracts/cursor.repository.ts`) — this is checked in the controller **before** hitting the database. |

Ordering is stable (`created_at DESC`, `id DESC` tiebreak) so concurrent
inserts never shift already-issued cursors.

---

## 3. Observability

### 3.1 Key log events

| Log message / pattern | Level | Source | Meaning |
|-----------------------|-------|--------|---------|
| `"Error creating API key:"` | `error` (console) | `apiKeyController.createApiKeyController` | Unhandled exception during key creation (usually a DB failure) |
| `"Error listing API keys:"` | `error` (console) | `apiKeyController.listApiKeysController` | Unhandled exception during list/pagination |
| `"Error rotating API key:"` | `error` (console) | `apiKeyController.rotateApiKeyController` | Unhandled exception during rotation |
| `"Error deactivating API key:"` | `error` (console) | `apiKeyController.deactivateApiKeyController` | Unhandled exception during deactivation |
| `"Error getting API key:"` | `error` (console) | `apiKeyController.getApiKeyController` | Unhandled exception during key lookup |
| `"API key validation error:"` | `error` (console) | `src/auth/apiKeyMiddleware.ts` (`authenticateApiKey`) | `validateApiKey` threw — DB error or crypto failure on the consuming path; results in `500`, not `401` |

`validateApiKey` itself (`src/auth/apiKeys.ts`) does **not** log on a simple
invalid-key or malformed-hash result — those are silent `null` returns by
design, to avoid leaking timing/format information. Only unexpected
exceptions surface as the `"API key validation error:"` log line above.

### 3.2 HTTP response codes

| Code | Where | Typical cause |
|------|-------|----------------|
| **201** | `POST /api/v1/api-keys` | Key created |
| **200** | list/get/rotate/deactivate success | — |
| **400** | `createApiKeyController` | Missing `name`, non-array/empty `scope`, or malformed scope string |
| **400** | `listApiKeysController` | Malformed or tampered `cursor` |
| **401** | Consuming path (`authenticateApiKey`) | Missing `X-API-Key` header, or key fails validation (invalid, expired-and-just-deactivated, malformed stored hash) |
| **401** | Management path (all controllers) | `req.user` not set — caller not authenticated via JWT/legacy bearer |
| **403** | Consuming path (`requireApiKeyScope`) | Authenticated key's `scope` does not satisfy the required `resource:action` |
| **403** | Management path (get/rotate/deactivate) | `existingKey.created_by !== req.user.userId` — caller does not own the key |
| **403** | `adminAuthGuard` | Valid API key, but scope not in `REQUIRED_ADMIN_SCOPES`; or valid non-admin JWT |
| **404** | Management path (get/rotate/deactivate) | Key ID not found, **or** key exists but `is_active = false` (deactivated keys are excluded from lookups, so this looks identical to "never existed") |
| **500** | Any controller | Unhandled exception (see §3.1 log lines) |

### 3.3 Metrics to watch

- **API key `401` rate on consumer routes** — sustained spikes may indicate a
  client using a rotated/deactivated key, or a credential-stuffing attempt
  against `X-API-Key`.
- **API key `403` rate** — scope misconfiguration after a key rotation, or a
  legitimate key being used against a route it was never scoped for.
- **`"API key validation error:"` log rate** — any non-zero rate warrants
  investigation; it means `validateApiKey` is throwing, which should not
  happen under normal operation (see §4.4).
- **Keys with `key_selector` unset** — `DatabaseService.backfillKeySelectors()`
  counts these; a persistently non-zero count across restarts means legacy
  keys exist that have not been used (and thus not lazily backfilled) since
  the selector index was introduced.
- **`last_used_at` staleness** — keys with no activity for an extended period
  are rotation/deactivation candidates (see §6.4).
- **Keys approaching `expires_at`** — see query in §5.3.

---

## 4. Common Failure Modes

### 4.1 Valid-looking API key returns 401 on a consumer route

**Symptoms:**
```
curl -H "X-API-Key: <key>" http://localhost:3001/api/v1/contracts
→ 401 { "error": "Invalid API key" }
```

**Root causes, in order of likelihood:**

1. **Key was rotated.** `POST /:id/rotate` invalidates the old key
   immediately — `rotateApiKey` overwrites `key_hash`/`key_selector` in place,
   there is no grace period.
2. **Key was deactivated.** `DELETE /:id` sets `is_active = false`;
   `validateApiKey`'s selector lookup (`getApiKeyBySelector`) and legacy
   fallback both filter to `is_active` rows, so a deactivated key's hash will
   simply not match anything.
3. **Key expired.** If `expires_at` is in the past, `validateApiKey` still
   authenticates the request once (to reach the expiry check), then
   **deactivates the key and returns `null`** — so the *triggering* request
   and all subsequent ones return `401`, but the key also flips to inactive
   as a side effect of that single failed attempt.
4. **Copy/paste error.** Leading/trailing whitespace or truncation in the
   `X-API-Key` header value — the key is a 64-character hex string; anything
   else cannot match a stored selector.
5. **Stored `key_hash` is malformed** (see §4.4) — the key can never validate
   regardless of correctness.

**Recovery:**
```bash
# 1. Confirm key state directly (adjust for your DB backend / storage file)
#    is_active, expires_at, last_used_at tell you rotated/deactivated/expired
#    at a glance.
sqlite3 talenttrust.db \
  "SELECT id, name, is_active, expires_at, last_used_at FROM api_keys WHERE id = '<key-id>';"

# 2. If rotated or deactivated intentionally, issue a new key
curl -X POST http://localhost:3001/api/v1/api-keys \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <owner-token>" \
  -d '{"name":"replacement-key","scope":["contracts:read"]}'

# 3. Test the new key
curl -H "X-API-Key: <new-key>" http://localhost:3001/api/v1/health
```

### 4.2 API key is valid but route returns 403

**Symptoms:**
```
curl -H "X-API-Key: <key>" http://localhost:3001/api/v1/contracts
→ 403 { "error": "Forbidden: insufficient API key scope", "required": "contracts:read", "provided": ["users:read"] }
```

**Root cause:** the key's `scope` array does not contain an entry matching
`requireApiKeyScope`'s exact match, `resource:*`, `*:action`, or `*` rules
(`src/auth/apiKeyMiddleware.ts`). The response body already tells you the
required scope and what the key actually carries — no guessing needed.

**Recovery:** either rotate/recreate the key with a scope that covers the
route, or correct the client's understanding of what scope it needs. Rotation
generates a **new key with the same scope** — scope is not something you can
edit in place via the current API; deactivate and recreate if the scope
itself must change.

### 4.3 Admin endpoint (deploy/DLQ) rejects an API key that works elsewhere

**Symptoms:**
```
curl -H "X-API-Key: <key>" http://localhost:3001/api/v1/admin/deploy/status
→ 403 { "error": "API key does not have admin scope." }
```

**Root cause:** `adminAuthGuard` (`src/middleware/adminAuthGuard.ts`) requires
one of exactly `deploy:*`, `*`, `jobs:admin`, `jobs:*` (§2.3). A key scoped
`contracts:*` or even a broad-looking `admin:*` does **not** satisfy this —
only the four literal strings in `REQUIRED_ADMIN_SCOPES` count.

**Recovery:** create or rotate a key with one of the exact admin scopes.
Do **not** attempt to fix this via `ADMIN_API_KEY`/`ADMIN_API_KEY_SCOPES` env
vars — they are unused (§2.1).

### 4.4 `"API key validation error:"` appears in logs / consumer routes return 500

**Symptoms:** Consumer routes intermittently return `500` instead of `401`;
console shows `API key validation error: <Error>`.

**Root causes:**

1. **Database/storage I/O failure** — `validateApiKey` calls
   `database.getApiKeyBySelector`, `(database as any).loadDatabase()` (legacy
   fallback scan), and `database.updateApiKey` (last-used timestamp,
   selector backfill). Any of these can throw on storage-layer failure.
2. **Concurrent write contention** during selector backfill — a legacy key's
   `updateApiKey(dbKey.id, { key_selector: selector })` call can fail if the
   underlying store is locked or unreachable at that moment.

**Recovery:**
```bash
# 1. Check storage health directly
sqlite3 talenttrust.db "SELECT 1;"   # or your configured backend

# 2. Check for lock contention / disk issues in DB logs

# 3. Once storage is healthy, retry — validateApiKey has no retry logic of
#    its own, so a transient DB blip self-resolves on the client's next request
```

### 4.5 API key management endpoints have no dedicated rate limit

**Observation:** `src/routes/apiKeys.routes.ts` applies no rate-limiter
middleware to any of its five routes. The `auth` rate-limit tier
(`src/config/rateLimit.ts`) keys off `X-API-Key` for the **login/register/
refresh/logout** endpoints under `/api/v1/auth/*` — it does not apply to
`/api/v1/api-keys*`. In practice this means an authenticated caller (or
anyone who compromises a session/JWT) can call `POST /api/v1/api-keys`
repeatedly with no throttling beyond whatever global limits (if any) sit in
front of the app.

**If this becomes an operational issue** (key-creation storms, DB growth,
abuse): bind one of the existing tiers (e.g. `sensitive` or `strict` from
`rateLimitConfig`) to `apiKeysRouter` in `src/app.ts`/`apiKeys.routes.ts`, the
same way other write-heavy routers are protected. This is a gap to be aware
of, not a bug — no route currently claims to rate-limit key management.

### 4.6 Legacy keys (no `key_selector`) cause slow validation

**Symptoms:** Elevated latency on API-key-authenticated routes, specifically
under load, with otherwise-healthy database and CPU.

**Root cause:** `validateApiKey`'s indexed path
(`database.getApiKeyBySelector`) is O(1), but if a key predates the
`key_selector` field, it falls through to an **O(n) scan of all active
legacy keys**, PBKDF2-verifying each candidate in sequence until one matches
or the list is exhausted. Every legacy key adds one PBKDF2 call (10k
iterations) to the worst-case path for *every other* legacy key's requests,
until each is individually backfilled by a successful validation.

**Recovery:**
```bash
# Count keys still missing a selector (informational; does not fix them —
# selectors can only be backfilled by validating with the plain-text key)
node -e "
const { database } = require('./dist/database');
database.backfillKeySelectors().then(n => console.log('Legacy keys pending backfill:', n));
"
```
If the count is non-trivial and those keys are still in active use, the
selector backfills automatically the next time each key successfully
authenticates — no operator action forces it. If a legacy key is unused,
consider deactivating it (§6.4) rather than leaving it in the O(n) fallback
pool indefinitely.

### 4.7 Stored `key_hash` is corrupted (malformed `salt:hash`)

**Symptoms:** A specific key never validates, even with the correct
plain-text value, and no `500`/exception is raised (fails closed, silently).

**Root cause:** `isValidSaltHashFormat` (`src/auth/apiKeys.ts`) requires the
stored `key_hash` to be exactly `"<32-hex-salt>:<128-hex-hash>"` — non-empty,
exactly one colon, both parts present, both hex, both the exact expected
length. Malformed input (bad migration, manual DB edit, truncated write) is
rejected **before** PBKDF2 runs, returning `null` with no distinguishing
error — this is deliberate to avoid crashing the auth hot path or leaking
format details.

**Recovery:**
```sql
-- Identify affected rows
SELECT id, name, LENGTH(key_hash), SUBSTR(key_hash, 1, 20) AS preview
FROM api_keys
WHERE key_hash NOT REGEXP '^[a-f0-9]{32}:[a-f0-9]{128}$';
```
```bash
# Rotate each affected key (generates a fresh, well-formed hash)
curl -X POST http://localhost:3001/api/v1/api-keys/<id>/rotate \
  -H "Authorization: Bearer <owner-token>"

# Or deactivate if no longer needed
curl -X DELETE http://localhost:3001/api/v1/api-keys/<id> \
  -H "Authorization: Bearer <owner-token>"
```

---

## 5. Health Checks & Alerts

### 5.1 Startup / pre-flight checks

| Check | How to verify | Severity |
|-------|----------------|----------|
| Storage accessible | `sqlite3 talenttrust.db "SELECT 1"` (or configured backend) | **Critical** |
| No corrupt `key_hash` rows | `SELECT COUNT(*) FROM api_keys WHERE key_hash NOT REGEXP '^[a-f0-9]{32}:[a-f0-9]{128}$'` | **High** |
| `apiKeysRouter` mounted | `grep "apiKeysRouter" src/app.ts` — confirm the `app.use('/api/v1', apiKeysRouter)` line is present (§1.3) | **High** |
| Test suite green | `npm test -- --testPathPattern=apiKey` | **Medium** |

### 5.2 Runtime alerts

| Alert | Condition | Severity | Response |
|-------|-----------|----------|----------|
| **API key 401 spike (consumer routes)** | `rate(http_requests_total{status_code="401", route=~".*"}) > baseline * 3` on API-key-protected routes for 5 min | **High** | See §4.1 |
| **API key validation errors** | Console `error` log contains `"API key validation error"` | **Critical** | See §4.4 — indicates storage-layer failure on the auth hot path |
| **API key 403 spike** | Sustained `403` on `requireApiKeyScope`-protected or `adminAuthGuard`-protected routes | **Medium** | See §4.2 / §4.3 |
| **Legacy key backlog** | `backfillKeySelectors()` count stays non-zero across multiple deploys | **Low** | See §4.6 |
| **Keys approaching expiry** | Query in §5.3 returns rows | **Low** | Rotate or renew before expiry to avoid client-side surprise `401`s |
| **Unbounded key-creation rate** | High-frequency `POST /api/v1/api-keys` from a single caller | **Medium** | See §4.5 — no dedicated rate limit exists today; investigate the caller and consider adding one |

### 5.3 Dashboard queries

```sql
-- Active keys approaching expiry (next 7 days)
SELECT name, expires_at
FROM api_keys
WHERE is_active = 1
  AND expires_at IS NOT NULL
  AND expires_at < datetime('now', '+7 days')
ORDER BY expires_at;

-- Keys unused for 90+ days (rotation/deactivation candidates)
SELECT id, name, created_by, last_used_at
FROM api_keys
WHERE is_active = 1
  AND (last_used_at IS NULL OR last_used_at < datetime('now', '-90 days'))
ORDER BY last_used_at;

-- Keys still missing key_selector (legacy, O(n)-fallback pool)
SELECT COUNT(*) AS legacy_unindexed
FROM api_keys
WHERE key_selector IS NULL AND is_active = 1;

-- Malformed key_hash rows
SELECT id, name, LENGTH(key_hash) AS len
FROM api_keys
WHERE key_hash NOT REGEXP '^[a-f0-9]{32}:[a-f0-9]{128}$';
```

---

## 6. Recovery Procedures

### 6.1 Deactivate a compromised API key

```bash
# Via management endpoint (caller must own the key)
curl -X DELETE http://localhost:3001/api/v1/api-keys/<key-id> \
  -H "Authorization: Bearer <owner-token>"

# Or directly against storage if the owner is unavailable/compromised
sqlite3 talenttrust.db "UPDATE api_keys SET is_active = 0 WHERE id = '<key-id>';"
```
Then audit all other keys created by the same user, since a compromised
credential often means the same actor's other keys are suspect too:
```sql
SELECT id, name, scope, created_at, last_used_at
FROM api_keys WHERE created_by = '<user-id>';
```

### 6.2 Provision a new admin-scoped API key

Since `ADMIN_API_KEY`/`ADMIN_API_KEY_SCOPES` env vars are not wired up
(§2.1), admin keys must be created through the management API like any other
key, using one of the scopes in `REQUIRED_ADMIN_SCOPES` (§2.3):

```bash
curl -X POST http://localhost:3001/api/v1/api-keys \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <admin-user-token>" \
  -d '{"name":"ops-admin-key","scope":["deploy:*"]}'
```
Capture the `apiKey` field from the response immediately — it is not
retrievable afterward. Verify:
```bash
curl -H "X-API-Key: <new-key>" http://localhost:3001/api/v1/admin/deploy/status
# Expected: 200
```

### 6.3 Rotate a key (planned, e.g. periodic hygiene)

```bash
curl -X POST http://localhost:3001/api/v1/api-keys/<key-id>/rotate \
  -H "Authorization: Bearer <owner-token>"
```
The response's `apiKey` field is the new plain-text key; the old one is
invalid **immediately** — there is no overlap window in the current
implementation (`rotateApiKey` overwrites `key_hash`/`key_selector` in
place). Update the consuming service's configuration with the new key before
the old one is used again, and monitor for a burst of `401`s from any client
still holding the old value.

### 6.4 Deactivate stale/unused keys

Use the §5.3 "unused for 90+ days" query to find candidates, confirm with the
key owner if possible, then:
```bash
curl -X DELETE http://localhost:3001/api/v1/api-keys/<key-id> \
  -H "Authorization: Bearer <owner-token>"
```

### 6.5 Recover from corrupted `key_hash` rows

See §4.7 — identify with the regex query in §5.3, then rotate (preferred, if
the owner can coordinate a config update) or deactivate each affected key.
There is no in-place repair: a malformed `key_hash` cannot be corrected
without the original plain-text key, which the server never stores.

### 6.6 Add rate limiting to the management routes (if abuse is observed)

Bind an existing tier from `rateLimitConfig` (`src/config/rateLimit.ts`) to
`apiKeysRouter`, mirroring how other write-heavy routers are protected
elsewhere in `src/app.ts`. `sensitive` (300 req/min default) or `strict` (180
req/min default) are the closest existing fits for a write-capable
management surface; add the limiter middleware ahead of
`authenticateMiddleware` in `src/routes/apiKeys.routes.ts` for each route, or
as a router-level `router.use(...)` at the top of the file. This is a
capability gap today (§4.5), not a supported runtime toggle — it requires a
code change.

---

## 7. End-to-End Smoke Test

Run after any api-keys-related change or recovery procedure.

```bash
export ADMIN_TOKEN=$(node -e "
const jwt = require('jsonwebtoken');
console.log(jwt.sign({sub:'smoke-test',email:'smoke@tt.com',role:'admin'}, process.env.JWT_SECRET, {algorithm:'HS256',expiresIn:'1h'}));
")

# 1. Create a key
CREATE_RESP=$(curl -s -X POST http://localhost:3001/api/v1/api-keys \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"name":"smoke-test-key","scope":["contracts:read"]}')
TEST_KEY=$(echo "$CREATE_RESP" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).apiKey))")
KEY_ID=$(echo "$CREATE_RESP" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).info.id))")
# Expected: 201, apiKey present

# 2. Use the key on an in-scope route
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "X-API-Key: $TEST_KEY" \
  http://localhost:3001/api/v1/contracts
# Expected: 200 (or 404 if no contracts exist — not 401/403)

# 3. Use the key on an out-of-scope route
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "X-API-Key: $TEST_KEY" \
  http://localhost:3001/api/v1/admin/deploy/status
# Expected: 403 (scope is contracts:read, not an admin scope)

# 4. List keys (management path)
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  "http://localhost:3001/api/v1/api-keys?limit=20"
# Expected: 200

# 5. Rotate the key
ROTATE_RESP=$(curl -s -X POST "http://localhost:3001/api/v1/api-keys/$KEY_ID/rotate" \
  -H "Authorization: Bearer $ADMIN_TOKEN")
NEW_KEY=$(echo "$ROTATE_RESP" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).apiKey))")

# 6. Old key should now be rejected
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "X-API-Key: $TEST_KEY" \
  http://localhost:3001/api/v1/contracts
# Expected: 401

# 7. New key should work
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "X-API-Key: $NEW_KEY" \
  http://localhost:3001/api/v1/contracts
# Expected: 200 (or 404)

# 8. Deactivate
curl -s -o /dev/null -w "%{http_code}\n" -X DELETE \
  "http://localhost:3001/api/v1/api-keys/$KEY_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# Expected: 200

# 9. Deactivated key rejected everywhere
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "X-API-Key: $NEW_KEY" \
  http://localhost:3001/api/v1/contracts
# Expected: 401

# 10. Deactivated key's own management endpoints now 404 (not "deactivated" status)
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  "http://localhost:3001/api/v1/api-keys/$KEY_ID"
# Expected: 404
```

### 7.1 All-clear criteria

- [ ] Key creation returns `201` with a plain-text `apiKey`
- [ ] New key authenticates an in-scope consumer route (`200`)
- [ ] New key is rejected with `403` on an out-of-scope route
- [ ] List endpoint returns `200` with pagination metadata
- [ ] Rotation returns a new key and immediately invalidates the old one (`401` on reuse)
- [ ] Deactivation returns `200` and the key stops authenticating (`401`)
- [ ] A deactivated key's own management endpoints return `404`, not a "deactivated" body

---

## 8. Troubleshooting Quick Reference

| Symptom | Check | Section |
|---------|-------|---------|
| Key returns 401 on consumer route | Rotated? Deactivated? Expired? `SELECT is_active, expires_at FROM api_keys WHERE id=...` | §4.1 |
| | Copy/paste error — key must be exactly 64 hex chars | §4.1 |
| Key returns 403 on consumer route | Response body's `required`/`provided` scope mismatch | §4.2 |
| Admin route rejects a key that works elsewhere | Scope must be exactly one of `deploy:*`, `*`, `jobs:admin`, `jobs:*` | §4.3, §2.3 |
| Tried to fix admin auth via `ADMIN_API_KEY` env var | It's unused — create a key via the management API instead | §2.1, §6.2 |
| Consumer routes return 500 | Console: `"API key validation error:"` → storage/DB issue | §4.4 |
| Elevated latency on API-key routes under load | Count of keys missing `key_selector` (legacy O(n) fallback) | §4.6 |
| Key never validates despite correct plain text | `key_hash` format — regex check in §5.3 | §4.7 |
| Suspected key-creation abuse | No dedicated rate limit exists on `/api/v1/api-keys*` today | §4.5, §6.6 |
| Management endpoint 403 for the "wrong" reason | It's ownership (`created_by`), not role — every non-`auditor`/`guest` role has full CRUD in the matrix | §1.3 |
| Management endpoint 404 but you're sure the key exists | It may be deactivated — lookups filter to `is_active` rows | §1.3, §4.1 |

---

**Last Updated:** 2026-07-25
**Version:** 1.0
**Maintainer:** TalentTrust Backend Team
