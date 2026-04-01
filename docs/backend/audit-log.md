# Audit Log — Technical Reference

## Overview

The TalentTrust audit log provides **immutable, tamper-evident recording** of all sensitive state changes in the platform. Every contract lifecycle event, payment, user management action, and authentication event is persisted as a frozen, hash-chained entry.

---

## Architecture

```
src/audit/
├── types.ts       — Core interfaces and type definitions
├── store.ts       — Append-only, hash-chained in-memory store
├── service.ts     — Application-level facade with convenience wrappers
├── middleware.ts  — Express middleware (attaches audit helper to res.locals)
└── router.ts      — REST endpoints for querying the log
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

| Action                | Severity  | Description                        |
|-----------------------|-----------|------------------------------------|
| `CONTRACT_CREATED`    | INFO      | New contract created               |
| `CONTRACT_UPDATED`    | INFO      | Contract fields modified           |
| `CONTRACT_CANCELLED`  | INFO      | Contract cancelled                 |
| `CONTRACT_COMPLETED`  | INFO      | Contract marked complete           |
| `PAYMENT_INITIATED`   | CRITICAL  | Payment escrow initiated           |
| `PAYMENT_RELEASED`    | CRITICAL  | Escrow funds released              |
| `PAYMENT_DISPUTED`    | CRITICAL  | Payment dispute raised             |
| `REPUTATION_UPDATED`  | INFO      | Reputation score changed           |
| `USER_CREATED`        | INFO      | New user registered                |
| `USER_UPDATED`        | INFO      | User profile updated               |
| `USER_DELETED`        | WARNING   | User account deleted               |
| `AUTH_LOGIN`          | INFO      | Successful authentication          |
| `AUTH_LOGOUT`         | INFO      | User logged out                    |
| `AUTH_FAILED`         | WARNING   | Failed authentication attempt      |
| `ADMIN_ACTION`        | CRITICAL  | Administrative operation performed |

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

> **Security**: These endpoints must be protected by authentication and restricted to `admin`/`auditor` roles in production.

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

- [ ] Replace in-memory store with a write-once database (PostgreSQL with no `UPDATE`/`DELETE` grants, or an append-only table with row-level security)
- [ ] Gate `/api/v1/audit` endpoints behind JWT authentication + `auditor` role check
- [ ] Rate-limit the `/integrity` endpoint (it scans the full log)
- [ ] Run `verifyIntegrity()` on a scheduled job and alert on failure
- [ ] Ensure `app.set('trust proxy', true)` is set when behind a load balancer so `req.ip` is accurate
- [ ] Sanitise `x-correlation-id` header values if they are user-controlled
- [ ] Encrypt the audit log at rest

---

## Testing

```bash
npm test                          # run all tests
npm test -- --coverage            # with coverage report
```

The test suite (`src/audit/audit.test.ts`) covers:

- Unit tests for `AuditStore` (append, query, getById, verifyIntegrity, immutability)
- Unit tests for `AuditService` (all convenience wrappers, error propagation)
- Unit tests for `auditMiddleware`
- Integration tests for all REST endpoints via `supertest`
- Security threat scenario tests (tampering, deletion, mutation, injection)

Coverage targets: ≥ 95% for all audit modules.
