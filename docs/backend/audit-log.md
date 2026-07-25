# Audit Log — Technical Reference

## Overview

The TalentTrust audit log provides **immutable, tamper-evident recording** of all sensitive state changes in the platform. Every contract lifecycle event, payment, user management action, and authentication event is persisted as a frozen, hash-chained entry.

---

## Architecture

```
src/audit/
├── types.ts                       — Core interfaces and type definitions
├── repository.ts                  — Repository interface + backend selection
├── store.ts                       — In-memory repository implementation
├── sqliteRepository.ts            — Durable SQLite repository implementation
├── service.ts                     — Application-level facade with convenience wrappers
├── redact.ts                      — Deterministic redaction rules (headers, body, email)
├── middleware.ts                  — Express middleware (attaches audit helper to res.locals)
├── protectedEndpointMiddleware.ts — Auto-audit middleware for auth-protected routes
└── router.ts                      — REST endpoints for querying the log
```

### Hash Chain (Tamper-Evidence)

Each `AuditEntry` carries two hash fields:

| Field          | Description                                                        |
|----------------|--------------------------------------------------------------------|
| `previousHash` | SHA-256 hash of the preceding entry (`"GENESIS"` for the first)   |
| `hash`         | SHA-256 of all content fields + `previousHash`                    |

Any modification, deletion, or reordering of entries breaks the chain and is detected by `verifyIntegrity()`.

---

## AuditEntry Schema

```typescript
interface AuditEntry {
  id: string;            // UUID v4
  timestamp: string;     // ISO-8601 UTC
  action: AuditAction;   // e.g. 'CONTRACT_CREATED'
  severity: AuditSeverity; // 'INFO' | 'WARNING' | 'CRITICAL'
  actor: string;         // User ID, service name, or 'system'
  resource: string;      // Resource type (e.g. 'contract', 'payment')
  resourceId: string;    // Specific resource instance ID
  metadata: Record<string, unknown>; // Sanitised change details (no PII)
  ipAddress?: string;
  correlationId?: string;
  hash: string;          // SHA-256 hex (64 chars)
  previousHash: string;  // SHA-256 of previous entry, or 'GENESIS'
}
```

### Supported Actions

| Action                | Severity  | Description                                      |
|-----------------------|-----------|--------------------------------------------------|
| `CONTRACT_CREATED`    | INFO      | New contract created                             |
| `CONTRACT_UPDATED`    | INFO      | Contract fields modified                         |
| `CONTRACT_CANCELLED`  | INFO      | Contract cancelled                               |
| `CONTRACT_COMPLETED`  | INFO      | Contract marked complete                         |
| `PAYMENT_INITIATED`   | CRITICAL  | Payment escrow initiated                         |
| `PAYMENT_RELEASED`    | CRITICAL  | Escrow funds released                            |
| `PAYMENT_DISPUTED`    | CRITICAL  | Payment dispute raised                           |
| `REPUTATION_UPDATED`  | INFO      | Reputation score changed                         |
| `USER_CREATED`        | INFO      | New user registered                              |
| `USER_UPDATED`        | INFO      | User profile updated                             |
| `USER_DELETED`        | WARNING   | User account deleted                             |
| `AUTH_LOGIN`          | INFO      | Successful authentication                        |
| `AUTH_LOGOUT`         | INFO      | User logged out                                  |
| `AUTH_FAILED`         | WARNING   | Failed authentication or authorisation attempt   |
| `ADMIN_ACTION`        | CRITICAL  | Administrative operation performed               |
| `ENDPOINT_ACCESS`     | INFO      | Read-only access to a protected endpoint (GET)   |
| `ENDPOINT_MUTATION`   | INFO      | Write operation on a protected endpoint (POST/PUT/PATCH/DELETE) |

---

## Usage

### Logging from a route handler

```typescript
import { auditService } from './audit/service';

app.post('/api/v1/contracts', (req, res) => {
  const contract = createContract(req.body);

  auditService.logContractEvent(
    'CONTRACT_CREATED',
    req.user.id,
    contract.id,
    { clientId: contract.clientId },          // sanitised metadata only
    { ipAddress: req.ip, correlationId: req.headers['x-correlation-id'] as string },
  );

  res.status(201).json(contract);
});
```

### Using the middleware helper

```typescript
// auditMiddleware is already mounted globally in index.ts
app.post('/api/v1/payments/:id/release', (req, res) => {
  res.locals.audit.log({
    action: 'PAYMENT_RELEASED',
    severity: 'CRITICAL',
    actor: req.user.id,
    resource: 'payment',
    resourceId: req.params.id,
    metadata: { amount: payment.amount, currency: 'XLM' },
  });
  res.json({ released: true });
});
```

### Verifying chain integrity

```typescript
import { auditService } from './audit/service';

const report = auditService.verifyIntegrity();
if (!report.valid) {
  // SECURITY INCIDENT — escalate immediately
  console.error('Audit chain corrupted at index', report.firstCorruptedIndex);
}
```

---

## REST API

All endpoints are mounted at `/api/v1/audit`.

> **Security**: These endpoints are protected by JWT authentication and restricted to `admin`/`auditor` roles in the main application.

### `GET /api/v1/audit`

Query audit entries with optional filters.

**Query parameters:**

| Parameter    | Type   | Description                              |
|--------------|--------|------------------------------------------|
| `action`     | string | Filter by action type                    |
| `severity`   | string | `INFO`, `WARNING`, or `CRITICAL`         |
| `actor`      | string | Filter by actor ID                       |
| `resource`   | string | Filter by resource type                  |
| `resourceId` | string | Filter by resource instance ID           |
| `from`       | string | ISO-8601 start of time range (inclusive) |
| `to`         | string | ISO-8601 end of time range (inclusive)   |
| `limit`      | number | Max results (default: 100, max: 1000)    |
| `offset`     | number | Pagination offset (default: 0)           |

**Response:**
```json
{
  "entries": [ /* AuditEntry[] */ ],
  "count": 2,
  "limit": 100,
  "offset": 0
}
```

### `GET /api/v1/audit/integrity`

Verify the hash chain. Returns `200` if valid, `409` if corruption is detected.

**Response:**
```json
{
  "valid": true,
  "totalEntries": 42,
  "checkedAt": "2026-03-23T10:00:00.000Z"
}
```

### `GET /api/v1/audit/:id`

Retrieve a single entry by UUID. Returns `404` if not found.

### `GET /api/v1/audit/export`

Generate a file-backed newline-delimited JSON (`application/x-ndjson`) export and
stream it back as an attachment for compliance downloads.

Security and operational notes:

- Access is limited to `admin` and `auditor` roles.
- A dedicated export rate limit applies separately from standard API reads.
- The export file is created only inside a controlled local temp directory.
- No user-supplied path or URL is ever dereferenced, preventing path traversal and SSRF.
- Export filters match the query endpoint (`action`, `severity`, `actor`, `resource`, `resourceId`, `from`, `to`, `limit`, `offset`).
- Export requests support larger result sets than the interactive query endpoint, up to the configured export cap.

---

## Automatic Audit Logging for Protected Endpoints

`protectedEndpointAuditMiddleware` (in `src/audit/protectedEndpointMiddleware.ts`)
automatically emits a structured `AuditEntry` for **every request** that flows
through an auth-protected router — including authentication failures.

### How it works

The middleware registers a `res.on('finish')` hook so it writes the entry
**after** the complete middleware chain has executed. This means the final HTTP
status code and the `req.user` identity (set by `authenticateMiddleware`) are
both available when the entry is written.

### Mounting

```typescript
import { protectedEndpointAuditMiddleware } from './audit/protectedEndpointMiddleware';
import { authenticateMiddleware } from './auth/authenticate';

// Mount BEFORE auth so the finish hook is always registered
router.use(protectedEndpointAuditMiddleware);
router.use(authenticateMiddleware);
router.get('/contracts', handler);
```

### Action and severity mapping

| Condition                              | `action`            | `severity` |
|----------------------------------------|---------------------|------------|
| HTTP 401 (missing/invalid credentials) | `AUTH_FAILED`       | `WARNING`  |
| HTTP 403 (insufficient permissions)    | `AUTH_FAILED`       | `WARNING`  |
| GET or HEAD + 2xx/3xx                  | `ENDPOINT_ACCESS`   | `INFO`     |
| POST / PUT / PATCH / DELETE + 2xx      | `ENDPOINT_MUTATION` | `INFO`     |
| Any method + 4xx/5xx (non-auth)        | method-derived above| `WARNING`  |

### Traceability

The `requestId` placed in `res.locals.requestId` by `requestIdMiddleware` is
used as the `correlationId` on every entry, enabling end-to-end request tracing
across logs and the audit trail.

---

## Redaction Policy

All data written to the audit log passes through the deterministic redaction
rules defined in `src/audit/redact.ts`. The rules are pure functions — the same
input always produces the same output, with no side-effects.

### HTTP headers

Any header whose name (case-insensitive) matches the list below is replaced
entirely with `'[REDACTED]'` before being stored:

| Header name         | Reason                                       |
|---------------------|----------------------------------------------|
| `authorization`     | Bearer tokens / API credentials              |
| `cookie`            | Session identifiers                          |
| `set-cookie`        | Session identifiers set by the server        |
| `x-api-key`         | API key credentials                          |
| `x-auth-token`      | Alternative authentication tokens            |
| `x-access-token`    | OAuth / JWT access tokens                    |

All other headers are stored verbatim.

### Request body and query string fields

Any object key whose name (lowercased) contains one of the following substrings
has its **value** replaced with `'[REDACTED]'`. Redaction is applied recursively
to nested objects and array elements.

| Substring matched   | Example keys that are redacted               |
|---------------------|----------------------------------------------|
| `password`          | `password`, `userPassword`, `newPassword`    |
| `secret`            | `secret`, `clientSecret`, `sharedSecret`     |
| `token`             | `token`, `accessToken`, `refreshToken`       |
| `credential`        | `credential`, `apiCredential`                |
| `apikey`            | `apikey`, `apiKey`                           |
| `api_key`           | `api_key`                                    |
| `private`           | `privateKey`, `privateData`                  |

### Email address masking

String values that match the pattern `local@domain` are partially masked to
retain minimal identifiability for audit correlation while protecting PII:

```
alice@example.com  →  ali***@example.com
ab@host.io         →  ab***@host.io
```

Masking is applied during body and metadata traversal. Header values are always
either fully redacted or kept verbatim (never partially masked).

### Primitives

Numbers, booleans, and `null`/`undefined` pass through unmodified.

### Example: what the audit entry `metadata` looks like

**Raw request:**
```json
{
  "headers": { "authorization": "Bearer eyJ...", "content-type": "application/json" },
  "body": { "username": "alice@example.com", "password": "hunter2" }
}
```

**After redaction (stored in audit log):**
```json
{
  "method": "POST",
  "path": "/api/v1/users",
  "statusCode": 201,
  "requestId": "550e8400-e29b-41d4-a716-446655440000",
  "headers": { "authorization": "[REDACTED]", "content-type": "application/json" },
  "body": { "username": "ali***@example.com", "password": "[REDACTED]" },
  "query": null
}
```

---

## Security Considerations

### Threat Model

| Threat                          | Mitigation                                                      |
|---------------------------------|-----------------------------------------------------------------|
| Entry mutation after write      | `Object.freeze()` on every entry and its metadata              |
| Entry deletion                  | Append-only store; no delete API exists                         |
| Entry tampering                 | SHA-256 hash chain — any change breaks `verifyIntegrity()`      |
| Entry reordering / insertion    | `previousHash` linkage detects any structural change            |
| PII leakage in logs             | Callers are responsible for sanitising `metadata` before logging|
| Unauthorised log access         | REST endpoints must be gated by auth middleware (not included)  |
| DoS via large queries           | `limit` is clamped to 1000; `offset` is clamped to ≥ 0         |

### Production Hardening Checklist

- [x] Repository pattern implemented with pluggable backends (`memory`, `sqlite`)
- [x] Durable SQLite backend available via `AUDIT_STORAGE_BACKEND=sqlite`
- [ ] For production, use a write-once policy (no `UPDATE`/`DELETE` grants) and strict file/database access controls
- [x] Gate `/api/v1/audit` endpoints behind JWT authentication + `admin`/`auditor` role check
- [x] Rate-limit `/api/v1/audit/export` separately from standard API traffic
- [ ] Rate-limit the `/integrity` endpoint (it scans the full log)
- [ ] Run `verifyIntegrity()` on a scheduled job and alert on failure
- [ ] Ensure `app.set('trust proxy', true)` is set when behind a load balancer so `req.ip` is accurate
- [ ] Sanitise `x-correlation-id` header values if they are user-controlled
- [ ] Encrypt the audit log at rest

---

## Testing

```bash
npm test                              # run all tests
npm test -- --coverage                # with coverage report
npm test -- src/audit                 # just the audit module
```

The audit module's test suite is split across three files so each one pins a
single layer of the architecture:

| File | Pins | Notes |
| --- | --- | --- |
| `src/audit/audit.test.ts` | `AuditStore`, `auditMiddleware`, `auditRouter`, `protectedEndpointAuditMiddleware`, `redact` module | Broad integration + security threat-scenario coverage. |
| `src/audit/service.test.ts` | `AuditService` contract | Routing of `action`/`actor`/`ipAddress`/`correlationId` to the repository, the redaction responsibility (callers must pre-process via `redactBody()`), write-failure surfacing, and convenience-wrapper severity rules. Uses a pure in-memory mock repository — no SQLite dependency. |
| `src/audit/sqliteRepository.test.ts` | `SqliteAuditRepository` behaviour | Append → read round-trip with deeply nested metadata, every supported filter (`action`, `severity`, `actor`, `resource`, `resourceId`, `from`/`to`) and combinations thereof, pagination edge cases (`offset > count`, `limit = 0`), incremental `stream()`, transactional write-failure surfacing with no partial rows left behind, two-`:memory:`-DB isolation, and chain-integrity verification over a 100-entry chain. All tests run on a fresh in-memory SQLite connection (`':memory:'`) for determinism and DB isolation. |
| `src/audit/exportService.test.ts` | `AuditExportService`, `neutraliseCsvInjection` | NDJSON round-trip fidelity, RFC 4180 CSV quoting (commas, embedded quotes, newlines), CSV-injection neutralisation for leading `=`/`+`/`-`/`@` formula prefixes, empty-dataset and large-dataset (1 500-row) streaming, `AuditExportResult` contract fields, `cleanup()` removes temp directory, `streamNdjsonExport`/`streamCsvExport` pipe helpers. All tests use a fresh in-memory `AuditStore` — no live database dependency. |

Coverage targets: ≥ 95% for all audit modules.

---

## Export Security — CSV Injection

The CSV export applies a two-layer defence against **formula injection** (also called CSV injection):

1. **RFC 4180 quoting** — any cell value that contains a comma, double-quote, or newline is wrapped in double-quotes with internal quotes doubled (`""`).

2. **Formula-prefix neutralisation** — before quoting, the `neutraliseCsvInjection` helper checks whether the stringified value begins with a character that spreadsheet applications (Excel, LibreOffice Calc, Google Sheets) interpret as a formula trigger:

   | Trigger | Reason |
   |---------|--------|
   | `=`     | Standard formula prefix |
   | `+`     | Lotus 1-2-3 / alternative formula prefix |
   | `-`     | Negation evaluated as formula |
   | `@`     | Legacy Lotus and modern Excel macro prefix |
   | `\t`    | Tab character used in tab-separated injections |
   | `\r`    | Carriage-return that can break row parsing |

   Dangerous values are prefixed with a single-quote (`'`) so the cell is treated as plain text. This mitigation follows the [OWASP CSV Injection guidance](https://owasp.org/www-community/attacks/CSV_Injection).

> **Note**: The NDJSON export is not affected by CSV injection because JSON parsers do not evaluate formula syntax.
