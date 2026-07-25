# Webhook Subscription Registry

TalentTrust-Backend supports per-consumer API endpoints subscription for webhook events. Consumers can register endpoints to receive real-time notifications when events occur.

## Database Schema

Webhook subscriptions are persisted in the `webhook_subscriptions` table:

- `id` (UUID): Primary key.
- `consumer_id` (UUID, nullable): Identifier of the consumer owning the subscription.
- `url` (TEXT): Delivery target URL. Must be a valid HTTP/HTTPS URL and satisfy SSRF security restrictions.
- `event_type` (TEXT): Webhook event type subscription (e.g. `contract.created`).
- `secret` (TEXT, nullable): Secret token used for signing payloads.
- `active` (BOOLEAN): Defaults to `true`. Delivery is skipped for inactive subscriptions.
- `created_at`, `updated_at`: Timestamps.

---

## API Endpoints

All CRUD operations are under the `/api/v1/webhook-subscriptions` namespace. Authenticated admins can interact with these routes.

### Create Subscription
`POST /api/v1/webhook-subscriptions`
- **Request Body**:
  ```json
  {
    "consumerId": "73d4a2ef-9882-4144-a690-349f25712e02",
    "url": "https://yourdomain.com/webhooks",
    "eventType": "contract.created",
    "secret": "your_secure_signing_secret"
  }
  ```
- **Response**: `201 Created`

### List Subscriptions
`GET /api/v1/webhook-subscriptions`
- **Query Params**:
  - `consumerId` (UUID, optional)
  - `eventType` (string, optional)
  - `active` (boolean, optional - `true` or `false`)
- **Response**: `200 OK`

### Retrieve Subscription
`GET /api/v1/webhook-subscriptions/:id`
- **Response**: `200 OK`

### Update Subscription
`PATCH /api/v1/webhook-subscriptions/:id`
- **Request Body**: (Allows updating partial fields)
  ```json
  {
    "active": false,
    "url": "https://newdomain.com/webhooks"
  }
  ```
- **Response**: `200 OK`

### Delete Subscription
`DELETE /api/v1/webhook-subscriptions/:id`
- **Response**: `200 OK`

---

## Payload Signature Verification

When a secret is configured on the subscription, outgoing POST requests will include signature headers:

- `X-Signature`: Hex-encoded SHA256 HMAC of the stringified request payload (`sha256=<signature>`) signed using the subscription's `secret`.
- `X-Timestamp`: Epoch timestamp (in milliseconds) when the payload signature was created.

Verification is implemented in `src/utils/webhook-signing.util.ts`.
