# Audit Subsystem Operations Runbook

This document is the operator- and on-call-facing runbook for the TalentTrust
audit subsystem. It covers configuration, common failure modes, alert symptom
triage, and step-by-step recovery procedures.

> **Audience:** Operators, DevOps, SRE, on-call engineers.
>
> **Related docs:**
> - [Audit API Contract & Tech Reference](./backend/audit-log.md) — full API reference, architecture, redaction policy, security considerations
> - [Event Audit Repository](../src/repository/eventAuditRepository.ts) — event processing audit trails
> - [Compliance Audit Logger](../src/retention/audit.ts) — retention/archival/deletion proof
> - [docs/configuration.md](./configuration.md) — retry-policy env-var overrides
> - [docs/deploy.md](./deploy.md) — blue/green deploy notes
> - [docs/observability.md](./observability.md) — metrics and alerting

---

## 1. Subsystem Architecture

The audit subsystem is composed of three independent logging paths:

### 1.1 Immutable Audit Log (primary)

```
Incoming Request
       │
       ▼
┌──────────────────┐
│  Middleware       │  protectedEndpointMiddleware auto-audits every request
│  (auto-audit)    │  on protected routes; emits ENDPOINT_ACCESS, ENDPOINT_MUTATION
└──────┬───────────┘
       │
       ▼
┌──────────────────┐
│  Audit Router     │  POST /api/v1/audit — manual audit entries
│  (REST API)      │  GET  /api/v1/audit — query / paginate
│                   │  GET  /api/v1/audit/integrity — hash chain verification
│                   │  GET  /api/v1/audit/export — NDJSON / CSV export
└──────┬───────────┘
       │
       ▼
┌──────────────────┐
│  Audit Service    │  Auditservice facade; convenience wrappers:
│  (facade)        │  logContractEvent, logPaymentEvent, logAuthEvent, logUserEvent
└──────┬───────────┘
       │
       ▼
┌──────────────────┐
│  Repository       │  AuditingRepository interface
│  (abstraction)   │  Backend: memory (AuditStore) or sqlite (SqliteAuditRepository)
└──────┬───────────┘
       │
       ▼
┌──────────────────┐
│  Storage         │  In-memory (SHA-256 hash chain)  OR  SQLite (persistent)
└──────────────────┘
```

| Component | File | Purpose |
|-----------|------|---------|
| Audit Router | `src/audit/router.ts` | REST handlers for query, integrity, export |
| Audit Service | `src/audit/service.ts` | Application-level facade with typed log methods |
| Audit Store | `src/audit/store.ts` | In-memory append-only store with SHA-256 hash chain |
| SQLite Repository | `src/audit/sqliteRepository.ts` | Durable SQLite backend with schema, indexes, streaming |
| Repository Factory | `src/audit/repository.ts` | Selects backend based on `AUDIT_STORAGE_BACKEND` |
| Redaction | `src/audit/redact.ts` | Deterministic redaction of sensitive headers/body keys |
| Export Service | `src/audit/exportService.ts` | NDJSON and CSV export with CSV-injection protection |
| Protected Endpoint Middleware | `src/audit/protectedEndpointMiddleware.ts` | Auto-audit for auth-protected routes |
| Audit Middleware | `src/audit/middleware.ts` | Attaches `res.locals.audit.log()` helper |

### 1.2 Event Processing Audit

Tracks event ingestion results for the contract event pipeline:

| Component | File | Purpose |
|-----------|------|---------|
| EventAuditService | `src/repository/eventAuditRepository.ts` | Deduplication, idempotency, correlation IDs |

### 1.3 Compliance Audit Logger

Cryptographic proof for retention/archival/deletion:

| Component | File | Purpose |
|-----------|------|---------|
| ComplianceAuditLogger | `src/retention/audit.ts` | HMAC-SHA256 signed compliance records |

---

## 2. Configuration

### 2.1 Required environment variables

| Variable | Default | Purpose | Validation |
|----------|---------|---------|------------|
| `AUDIT_STORAGE_BACKEND` | `memory` | `memory` or `sqlite` | Must be `memory` or `sqlite`; case-sensitive |
| `AUDIT_DB_PATH` | `talenttrust-audit.db` | SQLite file path | Writable path; use `:memory:` for tests |
| `COMPLIANCE_AUDIT_SECRET` | _(required)_ | HMAC secret for compliance audit proofs | Min 32 characters |

### 2.2 Rate limit configuration

Configured in `src/config/rateLimit.ts`:

| Tier | Max Requests | Window | Abuse Threshold | Endpoint |
|------|-------------|--------|-----------------|----------|
| `audit` | 300 | 60s | 5 | `GET /api/v1/audit`, `GET /:id` |
| `auditExport` | 5 | 3600s (1hr) | 3 | `GET /api/v1/audit/export` |
| `auditIntegrity` | 10 | 60s | 3 | `GET /api/v1/audit/integrity` |

Rate limit env-var overrides (see `src/config/rateLimit.ts`):
- `RL_AUDIT_MAX` — override `audit` tier max requests
- `RL_AUDIT_EXPORT_MAX` — override `auditExport` tier max requests
- `RL_AUDIT_INTEGRITY_MAX` — override `auditIntegrity` tier max requests

### 2.3 Route mounting

All audit routes are mounted at `/api/v1/audit` in `src/index.ts` (lines 49-56) with:
```typescript
router.use('/api/v1/audit', requireAuth, requireRole('admin', 'auditor'), rateLimiter, auditRouter);
```

### 2.4 Storage backend selection

The `createDefaultAuditRepository()` factory in `src/audit/repository.ts`:
- Reads `AUDIT_STORAGE_BACKEND` env var
- `memory` → `AuditStore` (in-memory hash chain, lost on restart)
- `sqlite` → `SqliteAuditRepository` (persistent, survives restart)

---

## 3. Observability

### 3.1 Key log events

| Log message / pattern | Level | Meaning |
|-----------------------|-------|---------|
| `[AuditService]` | `info` | Audit entry appended — normal operation |
| `[protectedEndpointAuditMiddleware]` | `error` | Audit middleware failed to record — write failure |
| `[AuditExportService]` | `error` | Export generation failed — disk or I/O error |
| `Integrity check failed at index` | `error` | Hash chain corrupted — potential tampering |
| `[FATAL] Configuration validation failed` | `fatal` | Missing or invalid `COMPLIANCE_AUDIT_SECRET` |
| `Rate limit exceeded for auditExport` | `warn` | Export rate limit hit — possible abuse |
| `CSV injection detected` | `warn` | Potentially malicious payload in export field |

### 3.2 HTTP response codes

| Code | Error body `code` | Typical cause |
|------|------------------|---------------|
| **200** | — | Query succeeded, chain valid |
| **400** | `Invalid action: <value>` | Unknown audit action in query filter |
| **400** | `Invalid severity: <value>` | Unknown severity in query filter |
| **400** | `Invalid from / to timestamp` | Malformed ISO-8601 date |
| **400** | `Invalid limit / offset` | Non-numeric or out-of-range pagination |
| **401** | `unauthorized` | Missing or invalid JWT |
| **403** | `forbidden` | Role is not `admin` or `auditor` |
| **404** | `Audit entry not found` | UUID does not match any entry |
| **409** | _(IntegrityReport)_ | Hash chain corrupted |
| **429** | `rate_limited` | Export rate limit exceeded |
| **500** | `internal_error` | Export service error, DB corruption, or storage failure |

### 3.3 Metrics to watch

- **Audit write rate** — sudden drops may indicate storage backend failure
- **Integrity check failures** — security incident if non-zero
- **Export rate limit hits** — may indicate abuse or need for tuning
- **Audit DB file size** — steady growth expected; plan archival at threshold
- **401/403 rate on audit endpoints** — unexpected patterns may indicate scanning

---

## 4. Common Failure Modes

### 4.1 Integrity check returns 409 (hash chain corrupted)

**Symptoms:**
```http
GET /api/v1/audit/integrity
→ 409 Conflict
{ "valid": false, "totalEntries": 1523, "firstCorruptedIndex": 42, "firstCorruptedId": "uuid-...", "checkedAt": "..." }
```

**Root causes (in order of likelihood):**
1. **Data tampering** — someone directly modified the audit store outside the API.
2. **Storage corruption** — SQLite database file corruption due to disk or filesystem error.
3. **Concurrent write race** — only possible with custom code bypassing the append-only API.
4. **Bug in hashing logic** — extremely rare; check for recent code changes to `store.ts` or `sqliteRepository.ts`.

**Recovery:**
```bash
# 1. IMMEDIATELY treat as security incident – investigate root cause
# 2. Preserve the current audit log (do not modify)
# 3. Restore from last known-good backup
# 4. Switch to memory backend temporarily if SQLite DB is compromised
export AUDIT_STORAGE_BACKEND=memory
# 5. Run forensics on corrupted entries
# 6. Rebuild integrity from backup
```

### 4.2 Audit write failures (500 on POST /api/v1/audit)

**Symptoms:**
```http
POST /api/v1/audit
→ 500 Internal Server Error
```

**Root causes:**
1. **SQLite DB corruption** — `append()` throws on integrity constraint violation.
2. **Disk full** — SQLite cannot write; free space and retry.
3. **Permission denied** — process lacks write permission on `AUDIT_DB_PATH` directory.
4. **Memory backend OOM** — excessive entries accumulated; switch to SQLite.

**Recovery:**
```bash
# 1. Check disk space
df -h

# 2. Check SQLite integrity
sqlite3 $AUDIT_DB_PATH "PRAGMA integrity_check;"

# 3. Check process permissions on db directory
ls -la $(dirname $AUDIT_DB_PATH)

# 4. If DB corrupted, restore from backup
# 5. If memory backend, switch to SQLite:
export AUDIT_STORAGE_BACKEND=sqlite
export AUDIT_DB_PATH=/var/lib/talenttrust/audit.db
```

### 4.3 Export endpoint returns 500

**Symptoms:**
```http
GET /api/v1/audit/export
→ 500 Internal Server Error
```

**Root causes:**
1. **Temp directory full** — export writes to `os.tmpdir()` before streaming.
2. **Permission denied** — process cannot write to temp directory.
3. **Too many entries** — export with no filters tries to dump entire log.

**Recovery:**
```bash
# 1. Check temp directory space
df -h /tmp

# 2. Clear old temp export files
rm -rf /tmp/audit-export-*

# 3. Retry with filters applied
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3001/api/v1/audit/export?from=2026-01-01T00:00:00Z&to=2026-06-30T23:59:59Z"

# 4. Verify exportRoot (if configured) is writable
ls -la $(node -e "console.log(require('os').tmpdir())")
```

### 4.4 Rate limited on export (429)

**Symptoms:**
```http
GET /api/v1/audit/export
→ 429 { "error": { "code": "rate_limited" } }
```

**Root causes:**
1. **Legitimate user exhausted the 5/hour limit** — wait for the window to reset.
2. **Automated script polling export** — review usage patterns.
3. **Rate limit too low for compliance needs** — tune via env vars.

**Recovery:**
```bash
# 1. Check current rate limit state (requires DB access)
# 2. Wait for 1-hour window to reset
# 3. If legitimate need, increase limit:
export RL_AUDIT_EXPORT_MAX=20
# 4. Restart process to pick up new limit
```

### 4.5 Missing COMPLIANCE_AUDIT_SECRET

**Symptoms:**
```
[FATAL] Configuration validation failed: COMPLIANCE_AUDIT_SECRET must be at least 32 characters
```

**Root causes:**
1. **Env var not set** — `COMPLIANCE_AUDIT_SECRET` is missing from environment.
2. **Env var too short** — must be ≥ 32 characters.

**Recovery:**
```bash
# 1. Generate a strong secret
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# → 64-character hex string

# 2. Set in environment
export COMPLIANCE_AUDIT_SECRET="<generated-64-char-hex>"

# 3. Restart process
```

### 4.6 All audit endpoints return 401

**Symptoms:**
```http
GET /api/v1/audit
→ 401 { "error": { "code": "unauthorized", "message": "Invalid token." } }
```

**Root causes:**
1. **JWT_SECRET not set or changed** — see [Auth Runbook](./runbook-auth.md#41-all-requests-return-401).
2. **Token expired** — access token TTL is 15 minutes.
3. **Role not `admin` or `auditor`** — audit endpoints require specific roles.

**Recovery:**
```bash
# 1. Verify JWT role claim
node -e "
const jwt = require('jsonwebtoken');
const tok = '<your-token>';
const dec = jwt.decode(tok);
console.log('Role:', dec?.role);
// Must be 'admin' or 'auditor'
"

# 2. Issue a test token with correct role
node -e "
const jwt = require('jsonwebtoken');
const tok = jwt.sign(
  { sub: 'test', email: 'admin@tt.com', role: 'admin' },
  process.env.JWT_SECRET,
  { algorithm: 'HS256', expiresIn: '1h' }
);
console.log(tok);
"

# 3. Retry with new token
```

### 4.7 Audit metadata contains unredacted sensitive data

**Symptoms:**
Sensitive headers (authorization, cookies) or body fields (passwords, tokens)
visible in raw audit entries.

**Root causes:**
1. **Redaction missed a new header or field** — check `src/audit/redact.ts` patterns.
2. **Direct API call bypassing middleware** — `POST /api/v1/audit` accepts raw payloads.
3. **New sensitive field not in redaction list** — update `SENSITIVE_KEYS` in `redact.ts`.

**Recovery:**
```bash
# 1. Update redaction patterns in src/audit/redact.ts
# 2. Re-deploy
# 3. Existing entries are NOT retroactively redacted; delete or archive if necessary
```

### 4.8 Event audit deduplication failure

**Symptoms:**
Duplicate events processed despite idempotency keys.

**Root causes:**
1. **DeduplicationManager state lost** — in-memory state on restart.
2. **Correlation ID mismatch** — same event submitted with different keys.
3. **Clock skew** — timestamp-based dedup windows misaligned.

**Recovery:**
```bash
# 1. Check DeduplicationManager logs
# 2. Verify correlation ID consistency in event payloads
# 3. Check system clock synchronization
date -u
# 4. For persistent dedup, implement backed storage for dedup state
```

---

## 5. Alerts

| Alert name | Condition | Severity | Action |
|------------|-----------|----------|--------|
| `audit_chain_corrupted` | `GET /integrity` returns 409 | **CRITICAL** | Security incident — investigate immediately; see [§4.1](#41-integrity-check-returns-409-hash-chain-corrupted) |
| `audit_write_errors` | `[AuditService]` or `[protectedEndpointAuditMiddleware]` error logs | **WARNING** | Investigate storage backend; see [§4.2](#42-audit-write-failures-500-on-post-apiv1audit) |
| `audit_export_rate_limited` | 429 on `/export` | **WARNING** | Check if legitimate user or abuse; tune rate limits |
| `audit_export_failure` | 500 on `/export` | **WARNING** | Check disk space and temp directory; see [§4.3](#43-export-endpoint-returns-500) |
| `audit_integrity_rate_limited` | 429 on `/integrity` | **INFO** | May indicate DoS attempt on expensive endpoint |
| `audit_db_size_growing` | SQLite file > threshold | **WARNING** | Plan data retention/archival |
| `audit_compliance_secret_missing` | `[FATAL]` compliance audit error | **CRITICAL** | Set `COMPLIANCE_AUDIT_SECRET` immediately |

---

## 6. Recovery Procedures

### 6.1 Switch storage backend (hot fix)

```bash
# 1. Stop the process
# 2. Set new backend
export AUDIT_STORAGE_BACKEND=sqlite
export AUDIT_DB_PATH=/var/lib/talenttrust/audit.db

# 3. Start the process
# 4. Verify: curl -H "Authorization: Bearer $TOKEN" /api/v1/audit/integrity
# 5. Note: Entries written to the old backend are NOT migrated automatically.
```

### 6.2 Restore audit log from backup

```bash
# 1. Stop the process
# 2. Replace the database file
cp /backup/audit-2026-07-25.db $AUDIT_DB_PATH

# 3. Verify integrity
sqlite3 $AUDIT_DB_PATH "PRAGMA integrity_check;"

# 4. Start the process
# 5. Verify hash chain via API
curl -H "Authorization: Bearer $TOKEN" /api/v1/audit/integrity
```

### 6.3 Clear memory backend (dev/test only)

```bash
# 1. Restart the process — the in-memory store is ephemeral
# 2. On restart, the audit log starts empty
```

---

## 7. Cross-References

| Resource | Path | Lines | Purpose |
|----------|------|-------|---------|
| Route mounting | `src/index.ts` | 49-56 | Mounts audit router with auth + rate limiting |
| Rate limit config | `src/config/rateLimit.ts` | 165-222 | Audit rate limit tiers |
| Env schema | `src/config/env.schema.ts` | 53-55, 288-310 | `COMPLIANCE_AUDIT_SECRET` validation |
| Router | `src/audit/router.ts` | 1-331 | REST endpoint handlers |
| Service | `src/audit/service.ts` | 1-208 | Application-level audit facade |
| Store | `src/audit/store.ts` | 1-292 | In-memory hash chain |
| SQLite repo | `src/audit/sqliteRepository.ts` | 1-392 | Persistent storage |
| Repository factory | `src/audit/repository.ts` | 1-43 | Backend selection |
| Redaction | `src/audit/redact.ts` | 1-202 | Sensitive data stripping |
| Protected endpoint middleware | `src/audit/protectedEndpointMiddleware.ts` | 1-178 | Auto-audit for routes |
| Export service | `src/audit/exportService.ts` | 1-352 | NDJSON/CSV export |
| Types | `src/audit/types.ts` | 1-151 | AuditEntry, AuditAction, etc. |
| Event audit | `src/repository/eventAuditRepository.ts` | 1-193 | Event processing audit |
| Retention audit | `src/retention/audit.ts` | 1-324 | Compliance proof logging |
| Audit API & tech reference | `docs/backend/audit-log.md` | 1-393 | Full REST API reference, Architecture & design |
