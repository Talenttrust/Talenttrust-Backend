# API Key Authentication

This document describes the API key authentication system implemented for TalentTrust Backend.

## Overview

API keys provide a secure way for internal services and external integrations to access the TalentTrust API without requiring user authentication. API keys are separate from JWT user authentication and can be used for service-to-service communication.

> **Route mounting note:** The management endpoints described below
> (`POST/GET /api/v1/api-keys`, `GET/POST/DELETE /api/v1/api-keys/:id`, `.../rotate`)
> are implemented in [`src/routes/apiKeys.routes.ts`](../src/routes/apiKeys.routes.ts)
> but are **not currently registered** in [`src/app.ts`](../src/app.ts) or
> [`src/index.ts`](../src/index.ts). If you are running this backend as-is, mount
> the router before relying on these endpoints, e.g.:
> ```ts
> import apiKeysRouter from './routes/apiKeys.routes';
> app.use('/api/v1', apiKeysRouter);
> ```
> This does not affect *consuming* an existing API key — `authenticateApiKey` /
> `requireApiKeyScope` / `authenticateEither` are ordinary middleware you can
> attach to any route regardless of whether the management router is mounted.

## Admin Scopes

API keys used for admin-only surfaces (DLQ inspection, deploy operations) require one of the following scopes:

| Scope | Permits |
|-------|---------|
| `deploy:*` | All deployment operations (switch, rollback, status) |
| `*` | Full access (admin keys only) |
| `jobs:admin` | DLQ list, replay, and metrics |
| `jobs:*` | All job-related admin operations |

## Protected Endpoints

The following endpoints require either a JWT with `admin` role or an API key with one of the admin scopes above:

- `GET /api/v1/jobs/dlq` — List failed jobs in the DLQ
- `POST /api/v1/jobs/dlq/reprocess` — Replay a failed job
- `GET /api/v1/admin/deploy/status` — Get deployment state
- `POST /api/v1/admin/deploy/switch-green` — Promote green to active
- `POST /api/v1/admin/deploy/rollback` — Roll back to blue

## Features

- **Secure Generation**: Cryptographically generated 32-byte hex keys
- **Hashed Storage**: Keys are hashed at rest using PBKDF2 with salt
- **Scoping**: Fine-grained permissions using resource:action format
- **Constant-Time Comparison**: `crypto.timingSafeEqual` prevents timing attacks on key verification
- **Rotation**: Safe key rotation without changing the key ID
- **Expiration**: Optional expiration dates for temporary access
- **Audit Trail**: Last usage tracking for security monitoring
- **Deactivation**: Secure deactivation of compromised or unused keys

## API Key Format

API keys are 64-character hex strings:
```
0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

## Usage

API keys should be sent in the `X-API-Key` header:
```http
GET /api/v1/contracts
X-API-Key: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

## Scope Format

API keys use a flexible scoping system with the following formats:

### Exact Match
```
contracts:read    # Can read contracts only
users:create       # Can create users only
```

### Wildcard Actions
```
contracts:*        # Can perform any action on contracts
*:read            # Can read any resource
```

### Full Wildcard
```
*                 # Can access everything (admin keys only)
```

## API Endpoints

### Authenticating to the management endpoints

The `/api/v1/api-keys*` management endpoints below are protected by
**user** authentication, not by an API key. They currently use the bearer-token
scheme implemented in [`src/auth/authenticate.ts`](../src/auth/authenticate.ts)
(`authenticateMiddleware`) plus the role-based access-control matrix in
[`src/auth/roles.ts`](../src/auth/roles.ts) (`requirePermission('api-keys', <action>)`)
— this is the same lightweight scheme documented in the root
[README's Authentication section](../README.md#authentication) (e.g. the
`demo-admin-token` / `demo-user-token` bearer values), **not** the production
JWT stack described in [AUTH.md](../AUTH.md). A token is a base64-encoded
JSON object of the shape `{ "userId": "u1", "role": "freelancer" }`, sent as
`Authorization: Bearer <base64-token>`.

Per the current access-control matrix, every role except `auditor` and
`guest` (`admin`, `freelancer`, `client`) is granted full `create`/`read`/
`update`/`delete` permission on the `api-keys` resource — so, in practice,
access is narrowed by **per-key ownership**, not by role: `GET /:id`,
`POST /:id/rotate`, and `DELETE /:id` all return `403 Access denied` unless
the authenticated caller's `userId` matches the key's `created_by`, and
`GET /api/v1/api-keys` only ever lists **active** keys created by the caller
(other users' keys, and the caller's own deactivated keys, are never
returned). A deactivated key also stops resolving on `GET /:id`,
`POST /:id/rotate`, and `DELETE /:id` — those return `404 API key not found`
rather than a "deactivated" status, because lookups are filtered to
`is_active` keys.

### Create API Key
```http
POST /api/v1/api-keys
Authorization: Bearer <user-token>
Content-Type: application/json

{
  "name": "Internal Service Key",
  "scope": ["contracts:read", "contracts:create"],
  "expiresAt": "2024-12-31T23:59:59Z"
}
```
**Response:**
```json
{
  "message": "API key created successfully",
  "apiKey": "abc123...",
  "info": {
    "id": "key-id",
    "name": "Internal Service Key",
    "scope": ["contracts:read", "contracts:create"],
    "createdBy": "user-id",
    "createdAt": "2024-01-01T00:00:00Z",
    "expiresAt": "2024-12-31T23:59:59Z",
    "isActive": true
  }
}
```

### List API Keys
```http
GET /api/v1/api-keys
Authorization: Bearer <user-token>
```
**Response:**
```json
{
  "apiKeys": [
    {
      "id": "key-id",
      "name": "Internal Service Key",
      "scope": ["contracts:read", "contracts:create"],
      "createdAt": "2024-01-01T00:00:00Z",
      "updatedAt": "2024-01-01T00:00:00Z",
      "expiresAt": "2024-12-31T23:59:59Z",
      "lastUsedAt": "2024-01-15T10:30:00Z",
      "isActive": true
    }
  ],
  "total": 1
}
```

### Get API Key Details
```http
GET /api/v1/api-keys/:id
Authorization: Bearer <user-token>
```

### Rotate API Key
```http
POST /api/v1/api-keys/:id/rotate
Authorization: Bearer <user-token>
```
**Response:**
```json
{
  "message": "API key rotated successfully",
  "apiKey": "def456...",
  "info": {
    "id": "key-id",
    "name": "Internal Service Key",
    "scope": ["contracts:read", "contracts:create"],
    "createdBy": "user-id",
    "createdAt": "2024-01-01T00:00:00Z",
    "updatedAt": "2024-01-15T10:30:00Z",
    "expiresAt": "2024-12-31T23:59:59Z",
    "isActive": true
  }
}
```

### Deactivate API Key
```http
DELETE /api/v1/api-keys/:id
Authorization: Bearer <user-token>
```
**Response:**
```json
{
  "message": "API key deactivated successfully"
}
```

## Security Considerations

### Key Storage
- API keys are hashed using PBKDF2 with 10,000 iterations
- Each key has a unique 16-byte salt
- Hashes are stored in the format `salt:hash`
- A deterministic `key_selector` (SHA-256 of the plain key) is stored alongside the hash for O(1) indexed lookup; the selector alone cannot reveal the original key due to SHA-256 preimage resistance

### Key Rotation
- Rotation generates a new key while keeping the same ID
- Old keys become invalid immediately upon rotation
- No downtime during rotation process

### Expiration
- Optional expiration dates for temporary access
- Expired keys are automatically rejected
- Expired keys are deactivated on first access attempt

## Audit Trail
- Last usage timestamp is updated on successful authentication
- Helps identify unused or suspicious keys
- Useful for security monitoring and compliance

## Best Practices

### Key Management
1. **Use descriptive names** - Clearly identify the purpose of each key
2. **Apply minimal scope** - Grant only necessary permissions
3. **Set expiration dates** - Use temporary keys when possible
4. **Rotate regularly** - Establish a rotation schedule for production keys
5. **Monitor usage** - Review last usage timestamps regularly

### Security
1. **Never expose keys** - API keys are only shown once during creation
2. **Use environment variables** - Store keys securely in production
3. **Implement rate limiting** - Protect against key abuse
4. **Monitor for anomalies** - Set up alerts for unusual usage patterns

### Integration
1. **Handle 401 errors** - Gracefully handle invalid/expired keys
2. **Implement retry logic** - Handle temporary network issues
3. **Log usage** - Track which services use which keys
4. **Use appropriate scope** - Request only necessary permissions

## Lifecycle Overview

1. **Creation** – A client calls the `POST /api/v1/api-keys` endpoint. The server generates a cryptographically random 32‑byte key, hashes it with a unique salt using PBKDF2, stores the `salt:hash` pair, and returns the **plain‑text key** **once** in the response. The plain key must be stored securely by the client; it is never persisted by the server.
2. **Usage** – Clients include the key in the `X‑API‑Key` header on each request. The middleware extracts the header, verifies the key against the stored hash, updates `last_used_at`, and enforces any required scopes via `requireApiKeyScope`.
3. **Expiration** – If an `expires_at` timestamp is set, the middleware rejects the key after that date, deactivates it on first use after expiry, and returns a 401 error.
4. **Revocation** – A key can be deactivated at any time via `DELETE /api/v1/api-keys/:id`. The `is_active` flag is cleared, causing subsequent requests to be rejected with a 401.
5. **Rotation** – To rotate a key, call `POST /api/v1/api-keys/:id/rotate`. A new plain‑text key is returned and the stored hash is replaced. The old key becomes immediately invalid. Update the consuming service's configuration with the new key, verify functionality, and optionally keep the old key for a short rollback window before fully deactivating it.

## Scope Reference Table

| Scope Pattern | Meaning |
|---------------|---------|
| `resource:action` | Grants exactly the specified action on the given resource (e.g., `contracts:read`). |
| `resource:*` | Grants all actions on the specified resource (e.g., `contracts:*`). |
| `*:action` | Grants the action on **any** resource (e.g., `*:read`). |
| `*` | Grants full access; should only be used for admin keys. |

> **Note:** Scopes are validated in `src/auth/apiKeyMiddleware.ts` and must match one of the above patterns.

## Rotation Process Checklist

- [ ] Call the rotate endpoint and capture the new plain‑text key.
- [ ] Update the service configuration (env var, secret store) with the new key.
- [ ] Deploy the updated configuration.
- [ ] Verify that requests succeed with the new key.
- [ ] Monitor logs for any authentication failures.
- [ ] (Optional) Keep the old key active for a brief period to allow rollback, then deactivate it.

## Error Responses

### Consuming an API key (`authenticateApiKey` / `requireApiKeyScope`)

```json
{ "error": "Missing X-API-Key header" }
```
```json
{ "error": "Invalid API key" }
```
```json
{ "error": "Forbidden: insufficient API key scope", "required": "contracts:read", "provided": ["users:read"] }
```

### Managing keys (`/api/v1/api-keys*` controllers)

```json
{ "error": "Invalid request body", "required": { "name": "string", "scope": "string[]" } }
```
```json
{ "error": "Invalid scope format", "invalidScopes": ["bad scope"], "validFormats": ["resource:action", "resource:*", "*:action", "*"] }
```
```json
{ "error": "API key not found" }
```
```json
{ "error": "Access denied" }
```
The last one is returned by `GET /:id`, `POST /:id/rotate`, and
`DELETE /:id` when the authenticated caller did not create the key —
ownership, not role, gates access to an individual key (see
["Authenticating to the management endpoints"](#authenticating-to-the-management-endpoints)
above).

## Implementation Details

### Hashing Algorithm
- **Algorithm**: PBKDF2
- **Iterations**: 10,000
- **Salt Length**: 16 bytes (32 hex chars)
- **Key Length**: 64 bytes (128 hex chars)
- **Hash Format**: `salt:hash`

### Stored Credential Validation

The stored `key_hash` field must be a well-formed `salt:hash` string before PBKDF2 verification. This validation runs **before** calling the crypto functions to fail closed on malformed input (e.g., from botched migrations) rather than risking exceptions on the authentication hot path.

**Validation rules:**
| Check | Requirement |
|-------|-------------|
| Non-empty | The stored value must not be empty |
| Separator | Must contain exactly one colon (`:`) |
| Parts | Must split into exactly 2 parts (no extra colons) |
| Salt length | Must be exactly 32 hex characters (16 bytes) |
| Hash length | Must be exactly 128 hex characters (64 bytes) |

**On invalid format:**
- Returns `null` (rejects the key)
- Does NOT throw exceptions
- Does NOT log the stored hash or salt (surfaces generic "invalid key" result)
- Preserves existing expiry and `last_used_at` behavior

**Security notes:**
- Timing-safe comparison (`timingSafeEqual`) is preserved for valid keys
- The validation runs before PBKDF2 to prevent potential denial-of-service from malformed input
- No information about the stored format is leaked in error responses

### Indexed Key Lookup (O(1))

Every API key has an additional indexed field `key_selector` — a SHA-256 digest of the plain key that acts as a deterministic, non-reversible lookup key:

```
key_selector = SHA-256(plain_api_key)
```

**Validation flow:**

1. **Selector computation** — On each request, compute `SHA-256(api_key)` to derive the selector.
2. **Indexed lookup** — Query the storage layer by `key_selector` to find the candidate row in O(1) instead of scanning all stored keys.
3. **Salted verification** — The candidate's stored `salt:hash` is verified with PBKDF2 (the same slow salted hash as before). This ensures the selector alone is insufficient to authenticate; an attacker who compromises the selector column still cannot derive the original key or bypass the salted hash.
4. **Post-validation** — `last_used_at` is updated, expiry is checked (and the key deactivated if expired), and the `ApiKeyInfo` shape is returned.

**Security properties:**
| Property | Mechanism |
|----------|-----------|
| Selector preimage resistance | SHA-256 is one-way; `key_selector` cannot be reversed to the original key |
| Authenticator binding | PBKDF2 salted hash is still required — both selector match AND hash verification must pass |
| Timing safety | `timingSafeEqual` on the PBKDF2 comparison; selector lookups use the same constant-time index query |
| No downgrade | Existing O(n) fallback for legacy keys (those without `key_selector`) applies at most 1 PBKDF2 call per request, and the selector is backfilled automatically on first use |

**Legacy migration:** Keys created before this feature lack the `key_selector` field. On first successful validation they receive a backfilled selector, so subsequent requests hit the O(1) path.

### Database Schema
```typescript
interface ApiKey {
  id: string;
  name: string;
  key_hash: string;        // salt:hash format
  key_selector?: string;   // SHA-256 of the plain key (O(1) lookup index)
  scope: string[];
  created_by: string;
  created_at: Date;
  updated_at: Date;
  expires_at?: Date;
  last_used_at?: Date;
  is_active: boolean;
}
```

### Middleware Integration
```typescript
import { authenticateApiKey, requireApiKeyScope } from './auth/apiKeyMiddleware';

// API key authentication only
app.get('/api/internal', authenticateApiKey, handler);

// API key with scope validation
app.get('/api/contracts',
  authenticateApiKey,
  requireApiKeyScope('contracts', 'read'),
  handler
);

// Either JWT or API key
app.get('/api/mixed',
  authenticateEither,
  handler
);
```

### JWT-or-key fallback (`authenticateEither`)

`authenticateEither` lets a single route accept **either** a human user (JWT)
or a service integration (API key), which is useful for endpoints called both
by the frontend and by internal/external automation. Its precedence is
header-driven, not a "try both and see":

1. If the request carries an `Authorization: Bearer <token>` header, it is
   routed to the existing bearer/JWT middleware (`authenticateMiddleware`) —
   API key headers are ignored in this case, even if also present.
2. Otherwise, if the request carries an `X-API-Key` header, it is routed to
   `authenticateApiKey`.
3. If neither header is present, the request is rejected with `401` and the
   message `"Authentication required. Provide either Authorization: Bearer <token> or X-API-Key header"`.

Downstream handlers should not assume which path was taken — inspect
`req.user` (JWT) vs. `req.apiKey` (API key) to know which principal
authenticated the request. `requireApiKeyScope` only applies scope checks
when `req.apiKey` is set; pair `authenticateEither` with role/permission
checks (e.g. `requireRole`) if you also need to gate the JWT path.

## Migration Guide

### From JWT to API Keys
1. Identify service‑to‑service communication.
2. Create API keys with appropriate scopes.
3. Update clients to use `X-API-Key` header.
4. Remove JWT authentication from service accounts.
5. Monitor and test the new authentication flow.

### Key Rotation Process
1. Generate new key using rotation endpoint.
2. Update service configuration with new key.
3. Test new key functionality.
4. Deploy updated configuration.
5. Monitor for any authentication failures.
6. Keep old key temporarily for rollback.

## Troubleshooting

### Common Issues
- **Key not working** – Verify the key is copied correctly (no extra spaces), check expiration, ensure the key is still active, and verify required scope matches.
- **Scope errors** – Check exact scope format, ensure wildcards are used correctly, and verify the key has necessary permissions.
- **Performance issues** – Key validation is O(1) via the indexed `key_selector` field; the slow PBKDF2 hash runs at most once per request. If you still see latency, check that all active keys have a `key_selector` (legacy keys fall back to an O(n) scan). Run the backfill or let lazy backfilling complete.

### Debug Information
Enable debug logging to trace authentication flow:
```typescript
// In development
console.log('API Key validation:', { keyId, scope, timestamp });
```

## Support

For questions or issues with API key authentication:
1. Check this documentation first.
2. Review the implementation examples.
3. Check the test files for usage patterns.
4. Review error messages for specific issues.
5. Contact the development team with detailed error information.

[Authentication Details](../README.md#authentication)
