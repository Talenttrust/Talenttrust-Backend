# Webhooks API Examples

Ready-to-run cURL examples for all webhook endpoints in the TalentTrust Backend.

## Authentication

All endpoints require JWT authentication with the `admin` role:

```
Authorization: Bearer demo-admin-token
```

---

## 1. Create Webhook Subscription

**Endpoint**: `POST /api/v1/webhook-subscriptions`

**Request Body**:
```json
{
  "consumerId": "00000000-0000-0000-0000-000000000001",
  "url": "https://webhook.site/your-unique-id",
  "eventType": "contract.created",
  "secret": "my-shared-secret-key"
}
```

**cURL**:
```bash
curl -X POST http://localhost:3001/api/v1/webhook-subscriptions \
  -H "Authorization: Bearer demo-admin-token" \
  -H "Content-Type: application/json" \
  -d '{
    "consumerId": "00000000-0000-0000-0000-000000000001",
    "url": "https://webhook.site/your-unique-id",
    "eventType": "contract.created",
    "secret": "my-shared-secret-key"
  }'
```

**Response (201 Created)**:
```json
{
  "status": "success",
  "data": {
    "id": "87654321-4321-4321-4321-987654321def",
    "consumerId": "00000000-0000-0000-0000-000000000001",
    "url": "https://webhook.site/your-unique-id",
    "eventType": "contract.created",
    "active": true,
    "createdAt": "2026-07-26T10:00:00.000Z",
    "updatedAt": "2026-07-26T10:00:00.000Z"
  }
}
```

**Error (400 - Invalid URL)**:
```json
{
  "error": {
    "code": "invalid_url",
    "message": "Provided URL is invalid or resolved to a private/reserved address.",
    "requestId": "550e8400-e29b-41d4-a716-446655440000"
  }
}
```

---

## 2. List Webhook Subscriptions

**Endpoint**: `GET /api/v1/webhook-subscriptions`

**Query Params**:
- `consumerId` (optional) - Filter by consumer UUID
- `eventType` (optional) - Filter by event type
- `active` (optional) - Filter by active status (`true`/`false`)
- `cursor` (optional) - Pagination cursor
- `limit` (optional) - Results per page (default: 20, max: 100)

**cURL**:
```bash
curl -X GET "http://localhost:3001/api/v1/webhook-subscriptions?eventType=contract.created&limit=10" \
  -H "Authorization: Bearer demo-admin-token"
```

**Response (200 OK)**:
```json
{
  "status": "success",
  "data": {
    "data": [
      {
        "id": "87654321-4321-4321-4321-987654321def",
        "consumerId": "00000000-0000-0000-0000-000000000001",
        "url": "https://webhook.site/your-unique-id",
        "eventType": "contract.created",
        "active": true,
        "createdAt": "2026-07-26T10:00:00.000Z",
        "updatedAt": "2026-07-26T10:00:00.000Z"
      }
    ],
    "nextCursor": null,
    "hasNextPage": false,
    "limit": 10
  }
}
```

---

## 3. Get Single Webhook Subscription

**Endpoint**: `GET /api/v1/webhook-subscriptions/:id`

**cURL**:
```bash
curl -X GET http://localhost:3001/api/v1/webhook-subscriptions/87654321-4321-4321-4321-987654321def \
  -H "Authorization: Bearer demo-admin-token"
```

**Response (200 OK)**:
```json
{
  "status": "success",
  "data": {
    "id": "87654321-4321-4321-4321-987654321def",
    "consumerId": "00000000-0000-0000-0000-000000000001",
    "url": "https://webhook.site/your-unique-id",
    "eventType": "contract.created",
    "active": true,
    "createdAt": "2026-07-26T10:00:00.000Z",
    "updatedAt": "2026-07-26T10:00:00.000Z"
  }
}
```

**Error (404 Not Found)**:
```json
{
  "error": {
    "code": "not_found",
    "message": "Webhook subscription not found.",
    "requestId": "550e8400-e29b-41d4-a716-446655440000"
  }
}
```

---

## 4. Update Webhook Subscription

**Endpoint**: `PATCH /api/v1/webhook-subscriptions/:id`

**Request Body** (all fields optional):
```json
{
  "active": false,
  "eventType": "contract.updated"
}
```

**cURL**:
```bash
curl -X PATCH http://localhost:3001/api/v1/webhook-subscriptions/87654321-4321-4321-4321-987654321def \
  -H "Authorization: Bearer demo-admin-token" \
  -H "Content-Type: application/json" \
  -d '{
    "active": false,
    "eventType": "contract.updated"
  }'
```

**Response (200 OK)**:
```json
{
  "status": "success",
  "data": {
    "id": "87654321-4321-4321-4321-987654321def",
    "consumerId": "00000000-0000-0000-0000-000000000001",
    "url": "https://webhook.site/your-unique-id",
    "eventType": "contract.updated",
    "active": false,
    "createdAt": "2026-07-26T10:00:00.000Z",
    "updatedAt": "2026-07-26T10:30:00.000Z"
  }
}
```

---

## 5. Delete Webhook Subscription

**Endpoint**: `DELETE /api/v1/webhook-subscriptions/:id`

**cURL**:
```bash
curl -X DELETE http://localhost:3001/api/v1/webhook-subscriptions/87654321-4321-4321-4321-987654321def \
  -H "Authorization: Bearer demo-admin-token"
```

**Response (200 OK)**:
```json
{
  "status": "success",
  "data": {
    "id": "87654321-4321-4321-4321-987654321def",
    "deleted": true
  }
}
```

---

## 6. Admin: Replay All DLQ Entries

**Endpoint**: `POST /api/v1/admin/webhooks/dlq/replay-all`

**Request Body** (optional):
```json
{
  "concurrency": 10
}
```

**cURL**:
```bash
curl -X POST http://localhost:3001/api/v1/admin/webhooks/dlq/replay-all \
  -H "Authorization: Bearer demo-admin-token" \
  -H "Content-Type: application/json" \
  -d '{
    "concurrency": 10
  }'
```

**Response (200 OK)**:
```json
{
  "status": "success",
  "data": {
    "attempted": 42,
    "succeeded": 40,
    "failed": 2,
    "deduped": 0
  }
}
```

---

## Webhook Delivery Headers

When a `secret` is configured, delivered webhooks include:

| Header             | Description                            |
|--------------------|----------------------------------------|
| `X-Signature`      | HMAC-SHA256 signature (`sha256=<hex>`) |
| `X-Timestamp`      | Unix timestamp (milliseconds)          |
| `X-Correlation-Id` | Correlation ID for tracing             |

---

## Error Codes

| Code               | Status | Description                               |
|--------------------|--------|-------------------------------------------|
| `validation_error` | 400    | Request validation failed                 |
| `invalid_url`      | 400    | URL resolved to private/reserved address  |
| `unauthorized`     | 401    | Missing or invalid authentication         |
| `forbidden`        | 403    | Insufficient permissions (requires admin) |
| `not_found`        | 404    | Resource not found                        |
| `internal_error`   | 500    | Unexpected server error                   |

---

## Related Documentation

- [Webhooks API](webhooks.md)
- [Webhook Signature Verification](webhook-signature-verification.md)
- [Webhook DLQ](WEBHOOK-DLQ.md)
- [Webhook Subscriptions](WEBHOOK_SUBSCRIPTIONS.md)
- [Runbook](runbook-webhooks.md)
```

---