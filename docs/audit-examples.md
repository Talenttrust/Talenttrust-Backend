# Audit API Request Examples

This document provides copy-paste examples for all audit endpoints. Each example includes both curl commands and HTTP request formats, along with realistic request/response payloads.

**Prerequisites:**
- Valid JWT token with `admin` or `auditor` role
- Base URL: `http://localhost:3001/api/v1`
- Replace `{TOKEN}` with your actual JWT token

**Reference:** [Audit API Contract](./audit.md)

---

## Table of Contents

1. [Query Audit Entries (GET /api/v1/audit)](#query-audit-entries)
2. [Get Audit Entry by ID (GET /api/v1/audit/:id)](#get-audit-entry-by-id)
3. [Verify Hash Chain Integrity (GET /api/v1/audit/integrity)](#verify-hash-chain-integrity)
4. [Export Audit Log (GET /api/v1/audit/export)](#export-audit-log)
5. [Write Audit Entry (POST /api/v1/audit)](#write-audit-entry)

---

## Query Audit Entries

Retrieve paginated audit entries with optional filtering by action, severity, actor, resource, and time range.

### Example 1: List All Audit Entries (No Filters)

**Request:**

```bash
curl -X GET \
  'http://localhost:3001/api/v1/audit' \
  -H 'Authorization: Bearer {TOKEN}' \
  -H 'Content-Type: application/json'
```

**HTTP Request:**

```http
GET /api/v1/audit HTTP/1.1
Host: localhost:3001
Authorization: Bearer {TOKEN}
Content-Type: application/json
```

**Response (200 OK):**

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
      "resourceId": "contract-abc-123",
      "metadata": {
        "method": "POST",
        "path": "/api/v1/contracts",
        "statusCode": 201
      },
      "ipAddress": "192.168.1.100",
      "correlationId": "req-correlation-001",
      "hash": "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a7b8c9d0e1f",
      "previousHash": "GENESIS"
    },
    {
      "id": "550e8400-e29b-41d4-a716-446655440001",
      "timestamp": "2026-07-24T10:05:00.000Z",
      "action": "CONTRACT_UPDATED",
      "severity": "INFO",
      "actor": "user-002",
      "resource": "contract",
      "resourceId": "contract-abc-123",
      "metadata": {
        "method": "PATCH",
        "path": "/api/v1/contracts/contract-abc-123",
        "statusCode": 200
      },
      "ipAddress": "192.168.1.101",
      "correlationId": "req-correlation-002",
      "hash": "f1e2d3c4b5a6z7y8x9w0v1u2t3s4r5q6p7o8n9m0l1k2j3i4h5g6f7e8d9c0b",
      "previousHash": "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a7b8c9d0e1f"
    }
  ],
  "count": 2,
  "limit": 100,
  "offset": 0
}
```

### Example 2: Filter by Action

**Request:**

```bash
curl -X GET \
  'http://localhost:3001/api/v1/audit?action=CONTRACT_CREATED&limit=10&offset=0' \
  -H 'Authorization: Bearer {TOKEN}' \
  -H 'Content-Type: application/json'
```

**HTTP Request:**

```http
GET /api/v1/audit?action=CONTRACT_CREATED&limit=10&offset=0 HTTP/1.1
Host: localhost:3001
Authorization: Bearer {TOKEN}
Content-Type: application/json
```

**Response (200 OK):**

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
      "resourceId": "contract-abc-123",
      "metadata": {
        "method": "POST",
        "path": "/api/v1/contracts",
        "statusCode": 201
      },
      "ipAddress": "192.168.1.100",
      "correlationId": "req-correlation-001",
      "hash": "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a7b8c9d0e1f",
      "previousHash": "GENESIS"
    }
  ],
  "count": 1,
  "limit": 10,
  "offset": 0
}
```

**Valid action values:** `CONTRACT_CREATED`, `CONTRACT_UPDATED`, `CONTRACT_CANCELLED`, `CONTRACT_COMPLETED`, `PAYMENT_INITIATED`, `PAYMENT_RELEASED`, `PAYMENT_DISPUTED`, `REPUTATION_UPDATED`, `USER_CREATED`, `USER_UPDATED`, `USER_DELETED`, `AUTH_LOGIN`, `AUTH_LOGOUT`, `AUTH_FAILED`, `ADMIN_ACTION`, `ENDPOINT_ACCESS`, `ENDPOINT_MUTATION`

### Example 3: Filter by Severity

**Request:**

```bash
curl -X GET \
  'http://localhost:3001/api/v1/audit?severity=CRITICAL&limit=20' \
  -H 'Authorization: Bearer {TOKEN}' \
  -H 'Content-Type: application/json'
```

**HTTP Request:**

```http
GET /api/v1/audit?severity=CRITICAL&limit=20 HTTP/1.1
Host: localhost:3001
Authorization: Bearer {TOKEN}
Content-Type: application/json
```

**Response (200 OK):**

```json
{
  "entries": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440010",
      "timestamp": "2026-07-24T11:00:00.000Z",
      "action": "PAYMENT_INITIATED",
      "severity": "CRITICAL",
      "actor": "user-003",
      "resource": "payment",
      "resourceId": "payment-xyz-789",
      "metadata": {
        "method": "POST",
        "path": "/api/v1/payments",
        "statusCode": 201,
        "amount": 5000
      },
      "ipAddress": "192.168.1.102",
      "correlationId": "req-correlation-payment-001",
      "hash": "p1q2r3s4t5u6v7w8x9y0z1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6p7q8r9s0t",
      "previousHash": "f1e2d3c4b5a6z7y8x9w0v1u2t3s4r5q6p7o8n9m0l1k2j3i4h5g6f7e8d9c0b"
    }
  ],
  "count": 1,
  "limit": 20,
  "offset": 0
}
```

**Valid severity values:** `INFO`, `WARNING`, `CRITICAL`

### Example 4: Filter by Time Range

**Request:**

```bash
curl -X GET \
  'http://localhost:3001/api/v1/audit?from=2026-07-24T09:00:00Z&to=2026-07-24T12:00:00Z&limit=50' \
  -H 'Authorization: Bearer {TOKEN}' \
  -H 'Content-Type: application/json'
```

**HTTP Request:**

```http
GET /api/v1/audit?from=2026-07-24T09:00:00Z&to=2026-07-24T12:00:00Z&limit=50 HTTP/1.1
Host: localhost:3001
Authorization: Bearer {TOKEN}
Content-Type: application/json
```

**Response (200 OK):**

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
      "resourceId": "contract-abc-123",
      "metadata": {
        "method": "POST",
        "path": "/api/v1/contracts",
        "statusCode": 201
      },
      "ipAddress": "192.168.1.100",
      "correlationId": "req-correlation-001",
      "hash": "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a7b8c9d0e1f",
      "previousHash": "GENESIS"
    }
  ],
  "count": 1,
  "limit": 50,
  "offset": 0
}
```

### Example 5: Filter by Actor and Resource

**Request:**

```bash
curl -X GET \
  'http://localhost:3001/api/v1/audit?actor=alice&resource=contract&limit=15' \
  -H 'Authorization: Bearer {TOKEN}' \
  -H 'Content-Type: application/json'
```

**HTTP Request:**

```http
GET /api/v1/audit?actor=alice&resource=contract&limit=15 HTTP/1.1
Host: localhost:3001
Authorization: Bearer {TOKEN}
Content-Type: application/json
```

**Response (200 OK):**

```json
{
  "entries": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "timestamp": "2026-07-24T10:00:00.000Z",
      "action": "CONTRACT_CREATED",
      "severity": "INFO",
      "actor": "alice",
      "resource": "contract",
      "resourceId": "contract-abc-123",
      "metadata": {
        "method": "POST",
        "path": "/api/v1/contracts",
        "statusCode": 201
      },
      "ipAddress": "192.168.1.100",
      "correlationId": "req-correlation-001",
      "hash": "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a7b8c9d0e1f",
      "previousHash": "GENESIS"
    }
  ],
  "count": 1,
  "limit": 15,
  "offset": 0
}
```

### Example 6: Pagination with Offset

**Request (Get Second Page of Results):**

```bash
curl -X GET \
  'http://localhost:3001/api/v1/audit?limit=10&offset=10' \
  -H 'Authorization: Bearer {TOKEN}' \
  -H 'Content-Type: application/json'
```

**HTTP Request:**

```http
GET /api/v1/audit?limit=10&offset=10 HTTP/1.1
Host: localhost:3001
Authorization: Bearer {TOKEN}
Content-Type: application/json
```

**Response (200 OK):**

```json
{
  "entries": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440011",
      "timestamp": "2026-07-24T10:50:00.000Z",
      "action": "USER_CREATED",
      "severity": "INFO",
      "actor": "admin",
      "resource": "user",
      "resourceId": "user-new-456",
      "metadata": {
        "method": "POST",
        "path": "/api/v1/users",
        "statusCode": 201
      },
      "ipAddress": "192.168.1.103",
      "correlationId": "req-correlation-003",
      "hash": "u1v2w3x4y5z6a7b8c9d0e1f2g3h4i5j6k7l8m9n0o1p2q3r4s5t6u7v8w9x0y",
      "previousHash": "p1q2r3s4t5u6v7w8x9y0z1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6p7q8r9s0t"
    }
  ],
  "count": 1,
  "limit": 10,
  "offset": 10
}
```

### Error Examples for Query Endpoint

**Invalid Action (400 Bad Request):**

```bash
curl -X GET \
  'http://localhost:3001/api/v1/audit?action=INVALID_ACTION' \
  -H 'Authorization: Bearer {TOKEN}' \
  -H 'Content-Type: application/json'
```

**Response:**

```json
{
  "error": "Invalid action: INVALID_ACTION"
}
```

**Invalid Severity (400 Bad Request):**

```bash
curl -X GET \
  'http://localhost:3001/api/v1/audit?severity=INVALID' \
  -H 'Authorization: Bearer {TOKEN}' \
  -H 'Content-Type: application/json'
```

**Response:**

```json
{
  "error": "Invalid severity: INVALID"
}
```

**Missing Authorization (401 Unauthorized):**

```bash
curl -X GET 'http://localhost:3001/api/v1/audit'
```

**Response:**

```json
{
  "error": "Missing or malformed Authorization header."
}
```

**Insufficient Permissions (403 Forbidden):**

```bash
curl -X GET \
  'http://localhost:3001/api/v1/audit' \
  -H 'Authorization: Bearer {CLIENT_TOKEN}' \
  -H 'Content-Type: application/json'
```

**Response (when token has `client` role instead of `admin`/`auditor`):**

```json
{
  "error": "You do not have permission to access this resource."
}
```

---

## Get Audit Entry by ID

Retrieve a single audit entry by its UUID.

### Example: Retrieve Entry by ID

**Request:**

```bash
curl -X GET \
  'http://localhost:3001/api/v1/audit/550e8400-e29b-41d4-a716-446655440000' \
  -H 'Authorization: Bearer {TOKEN}' \
  -H 'Content-Type: application/json'
```

**HTTP Request:**

```http
GET /api/v1/audit/550e8400-e29b-41d4-a716-446655440000 HTTP/1.1
Host: localhost:3001
Authorization: Bearer {TOKEN}
Content-Type: application/json
```

**Response (200 OK):**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "timestamp": "2026-07-24T10:00:00.000Z",
  "action": "CONTRACT_CREATED",
  "severity": "INFO",
  "actor": "user-001",
  "resource": "contract",
  "resourceId": "contract-abc-123",
  "metadata": {
    "method": "POST",
    "path": "/api/v1/contracts",
    "statusCode": 201
  },
  "ipAddress": "192.168.1.100",
  "correlationId": "req-correlation-001",
  "hash": "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a7b8c9d0e1f",
  "previousHash": "GENESIS"
}
```

### Error Example: Entry Not Found

**Request:**

```bash
curl -X GET \
  'http://localhost:3001/api/v1/audit/00000000-0000-0000-0000-000000000000' \
  -H 'Authorization: Bearer {TOKEN}' \
  -H 'Content-Type: application/json'
```

**Response (404 Not Found):**

```json
{
  "error": "Audit entry not found"
}
```

---

## Verify Hash Chain Integrity

Verify that the audit log's tamper-evident hash chain is intact. This walks the entire chain and checks linkage.

### Example: Check Integrity (Valid Chain)

**Request:**

```bash
curl -X GET \
  'http://localhost:3001/api/v1/audit/integrity' \
  -H 'Authorization: Bearer {TOKEN}' \
  -H 'Content-Type: application/json'
```

**HTTP Request:**

```http
GET /api/v1/audit/integrity HTTP/1.1
Host: localhost:3001
Authorization: Bearer {TOKEN}
Content-Type: application/json
```

**Response (200 OK - Chain Valid):**

```json
{
  "valid": true,
  "totalEntries": 1523,
  "checkedAt": "2026-07-24T12:00:00.000Z"
}
```

### Example: Check Integrity (Corrupted Chain)

**Response (409 Conflict - Chain Corrupted):**

```json
{
  "valid": false,
  "totalEntries": 1523,
  "firstCorruptedIndex": 42,
  "firstCorruptedId": "550e8400-e29b-41d4-a716-446655440042",
  "checkedAt": "2026-07-24T12:00:00.000Z"
}
```

When the response is `409`, examine `firstCorruptedIndex` and `firstCorruptedId` to locate the corruption point in the chain.

**Note:** This endpoint uses a stricter rate limit (`auditIntegrity` tier: 5 requests/minute) compared to the general audit endpoint (`audit` tier: 100 requests/minute).

---

## Export Audit Log

Stream the audit log as NDJSON (Newline-Delimited JSON) for compliance downloads. Supports the same filters as the query endpoint.

**Rate Limit:** 5 requests per hour per user+IP

### Example 1: Export All Entries as NDJSON

**Request:**

```bash
curl -X GET \
  'http://localhost:3001/api/v1/audit/export' \
  -H 'Authorization: Bearer {TOKEN}' \
  -H 'Accept: application/x-ndjson' \
  --output audit-log-full.ndjson
```

**HTTP Request:**

```http
GET /api/v1/audit/export HTTP/1.1
Host: localhost:3001
Authorization: Bearer {TOKEN}
Accept: application/x-ndjson
```

**Response Headers (200 OK):**

```
Content-Type: application/x-ndjson; charset=utf-8
Content-Disposition: attachment; filename="audit-log-2026-07-24T10-00-00.000Z.ndjson"
X-Audit-Export-Records: 1523
```

**Response Body (NDJSON format - one entry per line):**

```
{"id":"550e8400-e29b-41d4-a716-446655440000","timestamp":"2026-07-24T10:00:00.000Z","action":"CONTRACT_CREATED","severity":"INFO","actor":"user-001","resource":"contract","resourceId":"contract-abc-123","metadata":{"method":"POST","path":"/api/v1/contracts","statusCode":201},"ipAddress":"192.168.1.100","correlationId":"req-correlation-001","hash":"a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a7b8c9d0e1f","previousHash":"GENESIS"}
{"id":"550e8400-e29b-41d4-a716-446655440001","timestamp":"2026-07-24T10:05:00.000Z","action":"CONTRACT_UPDATED","severity":"INFO","actor":"user-002","resource":"contract","resourceId":"contract-abc-123","metadata":{"method":"PATCH","path":"/api/v1/contracts/contract-abc-123","statusCode":200},"ipAddress":"192.168.1.101","correlationId":"req-correlation-002","hash":"f1e2d3c4b5a6z7y8x9w0v1u2t3s4r5q6p7o8n9m0l1k2j3i4h5g6f7e8d9c0b","previousHash":"a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a7b8c9d0e1f"}
```

### Example 2: Export Filtered by Action and Time Range

**Request:**

```bash
curl -X GET \
  'http://localhost:3001/api/v1/audit/export?action=PAYMENT_INITIATED&from=2026-07-24T00:00:00Z&to=2026-07-25T00:00:00Z' \
  -H 'Authorization: Bearer {TOKEN}' \
  -H 'Accept: application/x-ndjson' \
  --output audit-log-payments-july24.ndjson
```

**HTTP Request:**

```http
GET /api/v1/audit/export?action=PAYMENT_INITIATED&from=2026-07-24T00:00:00Z&to=2026-07-25T00:00:00Z HTTP/1.1
Host: localhost:3001
Authorization: Bearer {TOKEN}
Accept: application/x-ndjson
```

**Response Headers (200 OK):**

```
Content-Type: application/x-ndjson; charset=utf-8
Content-Disposition: attachment; filename="audit-log-2026-07-24T10-00-00.000Z.ndjson"
X-Audit-Export-Records: 42
```

**Response Body (42 NDJSON entries):**

```
{"id":"550e8400-e29b-41d4-a716-446655440010","timestamp":"2026-07-24T11:00:00.000Z","action":"PAYMENT_INITIATED","severity":"CRITICAL","actor":"user-003","resource":"payment","resourceId":"payment-xyz-789",...}
```

### Example 3: Export with Limit (Preview/Bounded Export)

**Request (Get only first 100 records):**

```bash
curl -X GET \
  'http://localhost:3001/api/v1/audit/export?limit=100' \
  -H 'Authorization: Bearer {TOKEN}' \
  -H 'Accept: application/x-ndjson' \
  --output audit-log-preview.ndjson
```

**HTTP Request:**

```http
GET /api/v1/audit/export?limit=100 HTTP/1.1
Host: localhost:3001
Authorization: Bearer {TOKEN}
Accept: application/x-ndjson
```

**Response Headers (200 OK):**

```
Content-Type: application/x-ndjson; charset=utf-8
Content-Disposition: attachment; filename="audit-log-2026-07-24T10-00-00.000Z.ndjson"
X-Audit-Export-Records: 100
```

**Processing with jq (Extract specific fields from NDJSON):**

```bash
# Extract only id, timestamp, and action from exported file
jq -r '.id, .timestamp, .action' audit-log-full.ndjson

# Filter for CRITICAL severity entries
jq 'select(.severity == "CRITICAL")' audit-log-full.ndjson

# Group by action and count
jq -s 'group_by(.action) | map({action: .[0].action, count: length})' audit-log-full.ndjson
```

### Error Example: Rate Limit Exceeded

**Request (6th export attempt within an hour):**

```bash
curl -X GET \
  'http://localhost:3001/api/v1/audit/export' \
  -H 'Authorization: Bearer {TOKEN}' \
  --output audit-log-attempt6.ndjson
```

**Response (429 Too Many Requests):**

```json
{
  "error": {
    "code": "rate_limited"
  }
}
```

---

## Write Audit Entry

Log a new audit entry with idempotency support using the `Idempotency-Key` header.

### Example: Create Audit Entry

**Request:**

```bash
curl -X POST \
  'http://localhost:3001/api/v1/audit' \
  -H 'Authorization: Bearer {TOKEN}' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: idem-key-12345' \
  -d '{
    "action": "PAYMENT_RELEASED",
    "severity": "CRITICAL",
    "actor": "admin-001",
    "resource": "payment",
    "resourceId": "payment-xyz-789",
    "metadata": {
      "method": "POST",
      "path": "/api/v1/payments/release",
      "statusCode": 200,
      "amount": 5000
    },
    "ipAddress": "192.168.1.105",
    "correlationId": "req-payment-release-001"
  }'
```

**HTTP Request:**

```http
POST /api/v1/audit HTTP/1.1
Host: localhost:3001
Authorization: Bearer {TOKEN}
Content-Type: application/json
Idempotency-Key: idem-key-12345

{
  "action": "PAYMENT_RELEASED",
  "severity": "CRITICAL",
  "actor": "admin-001",
  "resource": "payment",
  "resourceId": "payment-xyz-789",
  "metadata": {
    "method": "POST",
    "path": "/api/v1/payments/release",
    "statusCode": 200,
    "amount": 5000
  },
  "ipAddress": "192.168.1.105",
  "correlationId": "req-payment-release-001"
}
```

**Response (201 Created):**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440100",
  "timestamp": "2026-07-24T14:30:00.000Z",
  "action": "PAYMENT_RELEASED",
  "severity": "CRITICAL",
  "actor": "admin-001",
  "resource": "payment",
  "resourceId": "payment-xyz-789",
  "metadata": {
    "method": "POST",
    "path": "/api/v1/payments/release",
    "statusCode": 200,
    "amount": 5000
  },
  "ipAddress": "192.168.1.105",
  "correlationId": "req-payment-release-001",
  "hash": "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a7b8c9d0e1f",
  "previousHash": "f1e2d3c4b5a6z7y8x9w0v1u2t3s4r5q6p7o8n9m0l1k2j3i4h5g6f7e8d9c0b"
}
```

### Example: Idempotent Request (Same Key)

**Request (Same idempotency key as previous request):**

```bash
curl -X POST \
  'http://localhost:3001/api/v1/audit' \
  -H 'Authorization: Bearer {TOKEN}' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: idem-key-12345' \
  -d '{
    "action": "PAYMENT_RELEASED",
    "severity": "CRITICAL",
    "actor": "admin-001",
    "resource": "payment",
    "resourceId": "payment-xyz-789",
    "metadata": {
      "method": "POST",
      "path": "/api/v1/payments/release",
      "statusCode": 200,
      "amount": 5000
    },
    "ipAddress": "192.168.1.105",
    "correlationId": "req-payment-release-001"
  }'
```

**Response (200 OK - Returns cached response):**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440100",
  "timestamp": "2026-07-24T14:30:00.000Z",
  "action": "PAYMENT_RELEASED",
  "severity": "CRITICAL",
  "actor": "admin-001",
  "resource": "payment",
  "resourceId": "payment-xyz-789",
  "metadata": {
    "method": "POST",
    "path": "/api/v1/payments/release",
    "statusCode": 200,
    "amount": 5000
  },
  "ipAddress": "192.168.1.105",
  "correlationId": "req-payment-release-001",
  "hash": "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a7b8c9d0e1f",
  "previousHash": "f1e2d3c4b5a6z7y8x9w0v1u2t3s4r5q6p7o8n9m0l1k2j3i4h5g6f7e8d9c0b"
}
```

### Error Example: Missing Required Fields

**Request (Missing `resource` field):**

```bash
curl -X POST \
  'http://localhost:3001/api/v1/audit' \
  -H 'Authorization: Bearer {TOKEN}' \
  -H 'Content-Type: application/json' \
  -d '{
    "action": "PAYMENT_RELEASED",
    "severity": "CRITICAL",
    "actor": "admin-001",
    "resourceId": "payment-xyz-789"
  }'
```

**Response (400 Bad Request):**

```json
{
  "error": "Missing required fields: action, severity, actor, resource, resourceId"
}
```

---

## Common Headers Reference

### Authorization Header

All audit endpoints require a valid JWT token. The token must have either `admin` or `auditor` role.

```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyLWlkIiwiZW1haWwiOiJ1c2VyQGV4YW1wbGUuY29tIiwicm9sZSI6ImFkbWluIiwiaWF0IjoxNjkwMDAwMDAwLCJleHAiOjE2OTAwMDM2MDB9.signature...
```

### Optional Tracing Headers

```
X-Request-Id: 550e8400-e29b-41d4-a716-446655440000
X-Correlation-Id: trace-12345-abc
```

These headers enable request tracing and are echoed back in the response (where applicable).

---

## Practical Use Cases

### Use Case 1: Audit Compliance Report

Generate a monthly compliance report of all CRITICAL payment events:

```bash
curl -X GET \
  'http://localhost:3001/api/v1/audit/export?severity=CRITICAL&action=PAYMENT_INITIATED&from=2026-07-01T00:00:00Z&to=2026-07-31T23:59:59Z' \
  -H 'Authorization: Bearer {TOKEN}' \
  --output compliance-report-july-2026.ndjson

# Count total critical payment events
wc -l compliance-report-july-2026.ndjson
```

### Use Case 2: Verify Audit Chain Before Archival

Check chain integrity before archiving audit logs:

```bash
curl -s -X GET \
  'http://localhost:3001/api/v1/audit/integrity' \
  -H 'Authorization: Bearer {TOKEN}' | jq '.valid'
```

### Use Case 3: Investigate Recent User Activity

Query all actions by a specific user in the last 24 hours:

```bash
curl -X GET \
  "http://localhost:3001/api/v1/audit?actor=alice&from=$(date -u -d '1 day ago' +%Y-%m-%dT%H:%M:%SZ)" \
  -H 'Authorization: Bearer {TOKEN}' | jq '.entries[] | {timestamp, action, resource}'
```

### Use Case 4: Process Export with Tools

Convert NDJSON export to CSV using jq and standard tools:

```bash
# Export to NDJSON
curl -X GET \
  'http://localhost:3001/api/v1/audit/export' \
  -H 'Authorization: Bearer {TOKEN}' \
  --output audit-export.ndjson

# Convert to CSV (simple version)
echo "id,timestamp,action,severity,actor" > audit-export.csv
jq -r '[.id, .timestamp, .action, .severity, .actor] | @csv' audit-export.ndjson >> audit-export.csv
```

---

## See Also

- [Audit API Contract](./audit.md) — Complete endpoint documentation
- [Authentication & Authorization](../src/middleware/authorization.ts) — JWT validation and role-based access control
- [Rate Limiting Configuration](../src/config/rateLimit.ts) — Rate limit tiers and thresholds
