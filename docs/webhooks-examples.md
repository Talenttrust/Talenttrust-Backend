# Webhooks API Examples

Ready-to-run `curl` examples for `/api/v1/webhook-subscriptions` (default local server port `3001` from `src/server.ts`) and a signature verification example.

Set `WEBHOOK_ADMIN_TOKEN` on the server and export it in your shell before running these commands:

```bash
export WEBHOOK_ADMIN_TOKEN="your-admin-token"
```

## 1. Create a Subscription

```bash
curl -X POST http://localhost:3001/api/v1/webhook-subscriptions \
  -H "Authorization: Bearer $WEBHOOK_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://hooks.example.com/talenttrust",
    "events": ["contract.created", "milestone.released"],
    "filter": {
      "contractIds": [1]
    }
  }'
```

**Response (`201 Created`):**

```json
{
  "id": "87654321-4321-4321-4321-987654321def",
  "url": "https://hooks.example.com/talenttrust",
  "events": ["contract.created", "milestone.released"],
  "filter": {
    "contractIds": [1]
  },
  "active": true,
  "createdAt": "2026-07-26T10:00:00.000Z",
  "updatedAt": "2026-07-26T10:00:00.000Z",
  "secret": "whsec_..."
}
```

Save `secret` immediately — it is not returned by `GET` or `PATCH`.

## 2. List Subscriptions

```bash
curl http://localhost:3001/api/v1/webhook-subscriptions \
  -H "Authorization: Bearer $WEBHOOK_ADMIN_TOKEN"
```

**Response (`200 OK`):**

```json
{
  "data": [
    {
      "id": "87654321-4321-4321-4321-987654321def",
      "url": "https://hooks.example.com/talenttrust",
      "events": ["contract.created", "milestone.released"],
      "filter": {
        "contractIds": [1]
      },
      "active": true,
      "createdAt": "2026-07-26T10:00:00.000Z",
      "updatedAt": "2026-07-26T10:00:00.000Z"
    }
  ]
}
```

## 3. Get a Subscription

```bash
curl http://localhost:3001/api/v1/webhook-subscriptions/87654321-4321-4321-4321-987654321def \
  -H "Authorization: Bearer $WEBHOOK_ADMIN_TOKEN"
```

**Response (`200 OK`):**

```json
{
  "id": "87654321-4321-4321-4321-987654321def",
  "url": "https://hooks.example.com/talenttrust",
  "events": ["contract.created", "milestone.released"],
  "filter": {
    "contractIds": [1]
  },
  "active": true,
  "createdAt": "2026-07-26T10:00:00.000Z",
  "updatedAt": "2026-07-26T10:00:00.000Z"
}
```

## 4. Update a Subscription

Pause a subscription and clear its filter (`"filter": null`):

```bash
curl -X PATCH http://localhost:3001/api/v1/webhook-subscriptions/87654321-4321-4321-4321-987654321def \
  -H "Authorization: Bearer $WEBHOOK_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "active": false,
    "events": ["*"],
    "filter": null
  }'
```

**Response (`200 OK`):**

```json
{
  "id": "87654321-4321-4321-4321-987654321def",
  "url": "https://hooks.example.com/talenttrust",
  "events": ["*"],
  "active": false,
  "createdAt": "2026-07-26T10:00:00.000Z",
  "updatedAt": "2026-07-26T10:30:00.000Z"
}
```

## 5. Rotate Signing Secret

```bash
curl -X POST http://localhost:3001/api/v1/webhook-subscriptions/87654321-4321-4321-4321-987654321def/rotate-secret \
  -H "Authorization: Bearer $WEBHOOK_ADMIN_TOKEN"
```

**Response (`200 OK`):**

```json
{
  "id": "87654321-4321-4321-4321-987654321def",
  "url": "https://hooks.example.com/talenttrust",
  "events": ["*"],
  "active": false,
  "createdAt": "2026-07-26T10:00:00.000Z",
  "updatedAt": "2026-07-26T10:35:00.000Z",
  "secret": "whsec_new_secret..."
}
```

## 6. Inspect Delivery History

```bash
curl "http://localhost:3001/api/v1/webhook-subscriptions/87654321-4321-4321-4321-987654321def/deliveries?status=failed&limit=20" \
  -H "Authorization: Bearer $WEBHOOK_ADMIN_TOKEN"
```

**Response (`200 OK`):**

```json
{
  "data": [
    {
      "id": "11111111-2222-3333-4444-555555555555",
      "subscriptionId": "87654321-4321-4321-4321-987654321def",
      "eventId": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      "eventType": "contract.created",
      "status": "failed",
      "attempts": 6,
      "statusCode": 503,
      "lastError": "HTTP 503",
      "createdAt": "2026-07-26T10:05:00.000Z",
      "updatedAt": "2026-07-26T10:05:31.000Z"
    }
  ]
}
```

## 7. Delete a Subscription

```bash
curl -X DELETE http://localhost:3001/api/v1/webhook-subscriptions/87654321-4321-4321-4321-987654321def \
  -H "Authorization: Bearer $WEBHOOK_ADMIN_TOKEN"
```

**Response (`200 OK`):**

```json
{
  "id": "87654321-4321-4321-4321-987654321def",
  "deleted": true
}
```

## Error Response Example (`application/problem+json`)

Example `400` when a private IP or invalid URL is submitted:

```json
{
  "type": "https://talenttrust-backend.vercel.app/errors/invalid_url",
  "title": "invalid_url",
  "status": 400,
  "detail": "Webhook URL resolves to a private address",
  "error": "invalid_url",
  "message": "Webhook URL resolves to a private address",
  "requestId": "550e8400-e29b-41d4-a716-446655440000"
}
```

## Verifying Inbound Signatures (Node.js)

Pass the raw request body string (before JSON parsing) to `verifyWebhookSignature` from `src/webhooks.ts`:

```ts
import { verifyWebhookSignature } from './src/webhooks';

const isValid = verifyWebhookSignature(
  subscriptionSecret, // `secret` returned on create or rotate-secret
  req.headers,
  rawBody,
  300, // tolerance in seconds (default: 300)
);
```

## Related Documentation

- [Webhooks API Reference](webhooks.md)
- [Webhooks Request & Delivery Lifecycle](webhooks-flow.md)
- [Webhooks Operations Runbook](runbook-webhooks.md)
