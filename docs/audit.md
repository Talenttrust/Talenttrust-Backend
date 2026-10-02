# Audit API Contract

The audit API provides immutable, tamper-evident logging of all sensitive state changes in TalentTrust. Every entry is linked via a SHA-256 hash chain, enabling integrity verification.

**Cross-references:** [`src/audit/router.ts`](../src/audit/router.ts), [`src/audit/types.ts`](../src/audit/types.ts), [`src/audit/service.ts`](../src/audit/service.ts)

---

## Table of Contents

- [Audit Entry Object](#audit-entry-object)
- [Audit Actions](#audit-actions)
- [Endpoints](#endpoints)
  - [Query Audit Entries](#query-audit-entries)
  - [Get Audit Entry by ID](#get-audit-entry-by-id)
  - [Verify Hash Chain Integrity](#verify-hash-chain-integrity)
  - [Export Audit Log](#export-audit-log)
- [Error Codes](#error-codes)
- [Authentication & Authorization](#authentication--authorization)
- [Tamper-Evident Hash Chain](#tamper-evident-hash-chain)
- [Redaction Policy](#redaction-policy)

---

## Audit Entry Object

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "timestamp": "2026-07-24T10:00:00.000Z",
  "action": "CONTRACT_CREATED",
  "severity": "INFO",
  "actor": "550e8400-e29b-41d4-a716-446655440001",
  "resource": "contract",
  "resourceId": "550e8400-e29b-41d4-a716-446655440002",
  "metadata": {
    "method": "POST",
    "path": "/api/v1/contracts",
    "statusCode": 201
  },
  "ipAddress": "192.168.1.1",
  "correlationId": "req-abc123",
  "hash": "a1b2c3d4e5f6...64 hex chars",
  "previousHash": "GENESIS"
}
```

### Field Reference

| Field | Type | Required | Description | Source |
|-------|------|----------|-------------|--------|
| `id` | `string (UUID)` | Yes | Unique identifier (UUID v4) | [`types.ts:43`](../src/audit/types.ts#L43) |
| `timestamp` | `string` | Yes | ISO-8601 UTC timestamp | [`types.ts:45`](../src/audit/types.ts#L45) |
| `action` | `string` | Yes | Sensitive action type (see [Audit Actions](#audit-actions)) | [`types.ts:47`](../src/audit/types.ts#L47) |
| `severity` | `string` | Yes | `INFO`, `WARNING`, or `CRITICAL` | [`types.ts:49`](../src/audit/types.ts#L49) |
| `actor` | `string` | Yes | User ID, service name, or `system` | [`types.ts:51`](../src/audit/types.ts#L51) |
| `resource` | `string` | Yes | Resource type (e.g. `contract`, `user`, `payment`) | [`types.ts:53`](../src/audit/types.ts#L53) |
| `resourceId` | `string` | Yes | Specific resource instance ID | [`types.ts:55`](../src/audit/types.ts#L55) |
| `metadata` | `object` | Yes | Structured metadata (no raw PII) | [`types.ts:60`](../src/audit/types.ts#L60) |
| `ipAddress` | `string` | No | Request origin IP | [`types.ts:62`](../src/audit/types.ts#L62) |
| `correlationId` | `string` | No | Cross-service tracing ID | [`types.ts:64`](../src/audit/types.ts#L64) |
| `hash` | `string` | Yes | SHA-256 hex digest (64 chars) | [`types.ts:69`](../src/audit/types.ts#L69) |
| `previousHash` | `string` | Yes | Hash of preceding entry, or `GENESIS` for the first | [`types.ts:71`](../src/audit/types.ts#L71) |

---

## Audit Actions

Defined in [`src/audit/types.ts:13-32`](../src/audit/types.ts#L13-L32):

| Action | Category | Typical Severity |
|--------|----------|-----------------|
| `CONTRACT_CREATED` | Contract lifecycle | INFO |
| `CONTRACT_UPDATED` | Contract lifecycle | INFO |
| `CONTRACT_CANCELLED` | Contract lifecycle | INFO |
| `CONTRACT_COMPLETED` | Contract lifecycle | INFO |
| `PAYMENT_INITIATED` | Payment | CRITICAL |
| `PAYMENT_RELEASED` | Payment | CRITICAL |
| `PAYMENT_DISPUTED` | Payment | CRITICAL |
| `REPUTATION_UPDATED` | Reputation | INFO |
| `USER_CREATED` | User management | INFO |
| `USER_UPDATED` | User management | INFO |
| `USER_DELETED` | User management | WARNING |
| `AUTH_LOGIN` | Authentication | INFO |
| `AUTH_LOGOUT` | Authentication | INFO |
| `AUTH_FAILED` | Authentication | WARNING |
| `ADMIN_ACTION` | Admin/system | INFO or WARNING or CRITICAL |
| `ENDPOINT_ACCESS` | Endpoint access | INFO |
| `ENDPOINT_MUTATION` | Endpoint access | INFO |
| `DEPLOYMENT_PROMOTED` | Deployment | INFO |
| `DEPLOYMENT_ROLLED_BACK` | Deployment | WARNING |

> **Note:** `DEPLOYMENT_PROMOTED` and `DEPLOYMENT_ROLLED_BACK` are defined in the type system but are not included in the query filter's `VALID_ACTIONS` set ([`router.ts:30-38`](../src/audit/router.ts#L30-L38)). They cannot be used as `action` query parameter values.

---

## Endpoints

All routes are mounted at `/api/v1/audit` ([`src/index.ts:35-41`](../src/index.ts#L35-L41)).

### Query Audit Entries

```
GET /api/v1/audit
```

Returns a paginated list of audit entries matching the provided filters.

**Handler:** [`src/audit/router.ts:149-158`](../src/audit/router.ts#L149-L158)

#### Headers

| Header | Required | Description |
|--------|----------|-------------|
| `Authorization` | Yes | `Bearer <JWT>` |

#### Query Parameters (all optional)

| Param | Type | Default | Max | Description |
|-------|------|---------|-----|-------------|
| `action` | `string` | — | — | Filter by action type (see [Audit Actions](#audit-actions)) |
| `severity` | `string` | — | — | `INFO`, `WARNING`, or `CRITICAL` |
| `actor` | `string` | — | — | Exact match on actor |
| `resource` | `string` | — | — | Exact match on resource type |
| `resourceId` | `string` | — | — | Exact match on resource ID |
| `from` | `string` | — | — | ISO-8601 start of time range (inclusive) |
| `to` | `string` | — | — | ISO-8601 end of time range (inclusive) |
| `limit` | `integer` | `100` | `1000` | Max results per page (clamped) |
| `offset` | `integer` | `0` | — | Zero-based pagination offset |

#### Request Example

```
GET /api/v1/audit?action=CONTRACT_CREATED&severity=INFO&limit=2&offset=0
```

#### Response (200 OK)

```json
{
  "entries": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "timestamp": "2026-07-24T10:00:00.000Z",
      "action": "CONTRACT_CREATED",
      "severity": "INFO",
      "actor": "user-001",
      "resource": "contract",
      "resourceId": "contract-abc",
      "metadata": { "method": "POST", "path": "/api/v1/contracts", "statusCode": 201 },
      "ipAddress": "192.168.1.1",
      "correlationId": "req-abc123",
      "hash": "a1b2c3d4e5f6...64-char-hex",
      "previousHash": "f0e1d2c3b4a5...64-char-hex"
    }
  ],
  "count": 1,
  "limit": 2,
  "offset": 0
}
```

#### Errors

| Status | Message | Trigger |
|--------|---------|---------|
| `400` | `Invalid action: <value>` | Unknown `action` query param |
| `400` | `Invalid severity: <value>` | Unknown `severity` query param |
| `400` | `Invalid from timestamp` | Malformed `from` date |
| `400` | `Invalid to timestamp` | Malformed `to` date |
| `400` | `Invalid limit` | Non-numeric, negative, or zero `limit` |
| `400` | `Invalid offset` | Non-numeric or negative `offset` |
| `401` | JWT validation error | Missing or invalid token |
| `403` | `You do not have permission to access this resource.` | Role is not `admin` or `auditor` |

---

### Get Audit Entry by ID

```
GET /api/v1/audit/:id
```

Retrieves a single audit entry by its UUID.

**Handler:** [`src/audit/router.ts:253-260`](../src/audit/router.ts#L253-L260)

#### Headers

| Header | Required | Description |
|--------|----------|-------------|
| `Authorization` | Yes | `Bearer <JWT>` |

#### URL Parameters

| Param | Type | Description |
|-------|------|-------------|
| `id` | `string (UUID)` | Audit entry UUID |

#### Request Example

```
GET /api/v1/audit/550e8400-e29b-41d4-a716-446655440000
```

#### Response (200 OK)

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "timestamp": "2026-07-24T10:00:00.000Z",
  "action": "CONTRACT_CREATED",
  "severity": "INFO",
  "actor": "user-001",
  "resource": "contract",
  "resourceId": "contract-abc",
  "metadata": { "method": "POST", "path": "/api/v1/contracts", "statusCode": 201 },
  "ipAddress": "192.168.1.1",
  "correlationId": "req-abc123",
  "hash": "a1b2c3d4e5f6...64-char-hex",
  "previousHash": "f0e1d2c3b4a5...64-char-hex"
}
```

#### Errors

| Status | Message | Trigger |
|--------|---------|---------|
| `404` | `Audit entry not found` | UUID does not match any entry |
| `401` | JWT validation error | Missing or invalid token |
| `403` | Permission error | Role is not `admin` or `auditor` |

---

### Verify Hash Chain Integrity

```
GET /api/v1/audit/integrity
```

Verifies the tamper-evident hash chain across all stored audit entries.

**Handler:** [`src/audit/router.ts:243-247`](../src/audit/router.ts#L243-L247)

#### Headers

| Header | Required | Description |
|--------|----------|-------------|
| `Authorization` | Yes | `Bearer <JWT>` |

#### Request Example

```
GET /api/v1/audit/integrity
```

#### Response — Chain Valid (200 OK)

```json
{
  "valid": true,
  "totalEntries": 1523,
  "checkedAt": "2026-07-24T12:00:00.000Z"
}
```

#### Response — Chain Corrupted (409 Conflict)

```json
{
  "valid": false,
  "totalEntries": 1523,
  "firstCorruptedIndex": 42,
  "firstCorruptedId": "550e8400-e29b-41d4-a716-446655440000",
  "checkedAt": "2026-07-24T12:00:00.000Z"
}
```

#### Errors

| Status | Message | Trigger |
|--------|---------|---------|
| `401` | JWT validation error | Missing or invalid token |
| `403` | Permission error | Role is not `admin` or `auditor` |

---

### Export Audit Log

```
GET /api/v1/audit/export
```

Streams an NDJSON file export for compliance downloads. Each line is one redacted `AuditEntry` in JSON.

**Handler:** [`src/audit/router.ts:164-236`](../src/audit/router.ts#L164-L236)

**Rate limit:** 5 requests per hour per user+IP ([`src/index.ts:26-33`](../src/index.ts#L26-L33))

#### Headers

| Header | Required | Description |
|--------|----------|-------------|
| `Authorization` | Yes | `Bearer <JWT>` |

#### Query Parameters

Same as [Query Audit Entries](#query-audit-entries), except:

| Difference | Value |
|------------|-------|
| `limit` max | `50,000` (not 1,000) |
| `offset` | Parsed but ignored for full export |

#### Request Example

```
GET /api/v1/audit/export?action=CONTRACT_CREATED&from=2026-01-01T00:00:00Z
```

#### Response (200 OK)

- **Content-Type:** `application/x-ndjson; charset=utf-8`
- **Content-Disposition:** `attachment; filename="audit-log-2026-07-24T10-00-00.000Z.ndjson"`
- **X-Audit-Export-Records:** `42`
- **Body:** Newline-delimited JSON (one `AuditEntry` per line)

```
{"id":"550e8400-...","timestamp":"2026-07-24T10:00:00.000Z","action":"CONTRACT_CREATED",...}
{"id":"550e8401-...","timestamp":"2026-07-24T10:01:00.000Z","action":"CONTRACT_UPDATED",...}
```

> **Note:** The export itself creates an `ADMIN_ACTION` / `CRITICAL` severity audit entry logging the export operation ([`router.ts:194-219`](../src/audit/router.ts#L194-L219)).

#### Errors

| Status | Message | Trigger |
|--------|---------|---------|
| `400` | `Invalid <field>` | Invalid filter parameter |
| `429` | `rate_limited` | Export rate limit exceeded (5/hour) |
| `401` | JWT validation error | Missing or invalid token |
| `403` | Permission error | Role is not `admin` or `auditor` |
| `500` | Export service error | Internal export failure |

---

## Error Codes

### Validation Errors (400)

All validation errors use the shape `{ "error": "<message>" }` ([`router.ts:137`](../src/audit/router.ts#L137)):

| Message | Source | Trigger |
|---------|--------|---------|
| `Invalid action: <value>` | [`router.ts:93`](../src/audit/router.ts#L93) | Unknown action query param |
| `Invalid severity: <value>` | [`router.ts:97`](../src/audit/router.ts#L97) | Unknown severity query param |
| `Invalid from timestamp` | [`router.ts:52`](../src/audit/router.ts#L52) | Malformed `from` date |
| `Invalid to timestamp` | [`router.ts:52`](../src/audit/router.ts#L52) | Malformed `to` date |
| `Invalid limit` | [`router.ts:79`](../src/audit/router.ts#L79) | Non-numeric, negative, or zero |
| `Invalid offset` | [`router.ts:65`](../src/audit/router.ts#L65) | Non-numeric or negative |

### Authentication Errors (401)

| Message | Source |
|---------|--------|
| `Missing or malformed Authorization header.` | [`authorization.ts:102`](../src/middleware/authorization.ts#L102) |
| `Token is missing required claims.` | [`authorization.ts:115`](../src/middleware/authorization.ts#L115) |
| `Token carries an unrecognised role.` | [`authorization.ts:122`](../src/middleware/authorization.ts#L122) |
| `Token has expired.` | [`authorization.ts:134`](../src/middleware/authorization.ts#L134) |
| `Invalid token.` | [`authorization.ts:138`](../src/middleware/authorization.ts#L138) |

### Authorization Errors (403)

| Message | Source |
|---------|--------|
| `You do not have permission to access this resource.` | [`authorization.ts:168`](../src/middleware/authorization.ts#L168) |

### Not Found (404)

| Message | Source |
|---------|--------|
| `Audit entry not found` | [`router.ts:256`](../src/audit/router.ts#L256) |

### Integrity Failure (409)

Returns the full `IntegrityReport` with `valid: false` ([`router.ts:245`](../src/audit/router.ts#L245)).

### Rate Limited (429)

```json
{ "error": { "code": "rate_limited" } }
```

Triggered when the export rate limit (5/hour) is exceeded.

---

## Authentication & Authorization

All audit endpoints require:

1. **JWT Bearer token** — validated by `requireAuth` middleware ([`src/middleware/authorization.ts:94-140`](../src/middleware/authorization.ts#L94-L140))
2. **Role check** — `requireRole('admin', 'auditor')` ([`src/middleware/authorization.ts:156-174`](../src/middleware/authorization.ts#L156-L174))

### Permission Matrix

| Endpoint | `admin` | `auditor` | `client` | `freelancer` |
|----------|---------|-----------|----------|-------------|
| `GET /api/v1/audit` | ALLOW | ALLOW | DENY | DENY |
| `GET /api/v1/audit/:id` | ALLOW | ALLOW | DENY | DENY |
| `GET /api/v1/audit/integrity` | ALLOW | ALLOW | DENY | DENY |
| `GET /api/v1/audit/export` | ALLOW | ALLOW | DENY | DENY |

### JWT Payload

```json
{
  "sub": "user-id",
  "email": "user@example.com",
  "role": "admin",
  "iat": 1690000000,
  "exp": 1690003600
}
```

Algorithm: HS256.

---

## Tamper-Evident Hash Chain

Each audit entry carries a SHA-256 hash of its content fields concatenated with the previous entry's hash ([`src/audit/store.ts:29-46`](../src/audit/store.ts#L29-L46)).

### Hash Computation

```
hash = SHA-256(JSON({ id, timestamp, action, severity, actor, resource,
                       resourceId, metadata, ipAddress, correlationId,
                       previousHash }))
```

### Chain Properties

- **First entry:** `previousHash` is the sentinel value `GENESIS` ([`store.ts:22`](../src/audit/store.ts#L22))
- **Subsequent entries:** `previousHash` equals the `hash` of the preceding entry
- **Verification:** Walk the chain from entry 0, recomputing each hash and checking linkage

### Integrity Check Behavior

| Result | HTTP Status | Response Fields |
|--------|-------------|-----------------|
| Valid | `200` | `valid: true`, `totalEntries`, `checkedAt` |
| Corrupted | `409` | `valid: false`, `totalEntries`, `firstCorruptedIndex`, `firstCorruptedId`, `checkedAt` |

Source: [`src/audit/store.ts:163-200`](../src/audit/store.ts#L163-L200), [`src/audit/sqliteRepository.ts:133-177`](../src/audit/sqliteRepository.ts#L133-L177)

---

## Redaction Policy

The export service and `protectedEndpointMiddleware` automatically redact sensitive data before storing it in the audit log ([`src/audit/redact.ts`](../src/audit/redact.ts)).

### Redacted Headers (fully replaced with `[REDACTED]`)

`authorization`, `cookie`, `set-cookie`, `x-api-key`, `x-auth-token`, `x-access-token`

### Redacted Metadata Keys (recursive replacement)

Any key containing: `password`, `secret`, `token`, `credential`, `apikey`, `api_key`, `private`

### Email Masking

Pattern: `local@domain` → first 3 chars + `***@domain`

Example: `alice@example.com` → `ali***@example.com`

---

## Storage Backend

Configured via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `AUDIT_STORAGE_BACKEND` | `memory` | `memory` or `sqlite` |
| `AUDIT_DB_PATH` | `talenttrust-audit.db` | SQLite file path (or `:memory:` in test) |

Source: [`src/audit/repository.ts:19-38`](../src/audit/repository.ts#L19-L38)
