# Reputation Webhook API

## Overview

The Reputation Webhook API provides outbound webhook notifications for notable reputation events. Subscribers receive real-time callbacks when reputation ratings are created, enabling external systems to react to reputation changes without polling.

## Event Types

### `reputation.rating.created`

Emitted when a new reputation rating is successfully created.

#### Event Schema

```typescript
{
  eventType: "reputation.rating.created";
  eventId: string;        // UUID v4
  timestamp: string;      // ISO 8601
  data: {
    targetId: string;     // User being rated
    reviewerId: string;  // User who submitted the rating
    rating: number;       // Rating value (1-5)
    contextId: string;    // Contract/context reference
    entryId: string;      // Reputation entry ID
    newScore: number;     // Aggregated score after this rating
    totalRatings: number; // Total ratings after this rating
    weightedScore: number;// Weighted score after this rating
    scoreAlgorithm: string;// Score algorithm version
    comment?: string;      // Optional review comment
  };
  signature: string;      // HMAC-SHA256 signature
  timestamp: number;      // Signature timestamp (ms)
}
```

#### Example Payload

```json
{
  "eventType": "reputation.rating.created",
  "eventId": "550e8400-e29b-41d4-a716-446655440000",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "data": {
    "targetId": "user-123",
    "reviewerId": "user-456",
    "rating": 5,
    "contextId": "contract-789",
    "entryId": "entry-101",
    "newScore": 4.8,
    "totalRatings": 10,
    "weightedScore": 4.9,
    "scoreAlgorithm": "exp-decay-v1",
    "comment": "Great work!"
  },
  "signature": "a1b2c3d4e5f6...",
  "timestamp": 1705318200000
}
```

## Webhook Delivery

### HTTP Headers

All webhook deliveries include the following headers:

| Header | Description |
|--------|-------------|
| `Content-Type` | `application/json` |
| `X-Signature` | HMAC-SHA256 signature prefixed with `sha256=` |
| `X-Timestamp` | Signature timestamp in milliseconds |
| `X-Event-Type` | Event type identifier |
| `X-Event-ID` | Unique event ID (UUID) |

### Signature Verification

Webhook signatures are generated using HMAC-SHA256. To verify a webhook:

1. Extract the signature from the `X-Signature` header (remove `sha256=` prefix)
2. Extract the timestamp from the `X-Timestamp` header
3. Construct the canonical string: `{timestamp}.{payload}`
4. Compute HMAC-SHA256 using your shared secret
5. Compare with the received signature using constant-time comparison

**Example (Node.js):**

```javascript
const crypto = require('crypto');

function verifyWebhook(payload, signature, timestamp, secret) {
  const canonicalString = `${timestamp}.${JSON.stringify(payload)}`;
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(canonicalString);
  const expectedSignature = hmac.digest('hex');
  
  // Remove sha256= prefix if present
  const receivedSignature = signature.replace(/^sha256=/i, '');
  
  // Constant-time comparison
  return crypto.timingSafeEqual(
    Buffer.from(expectedSignature, 'hex'),
    Buffer.from(receivedSignature, 'hex')
  );
}
```

### Payload Size Limit

Webhook payloads are bounded to **100 KB**. Payloads exceeding this limit are rejected before delivery.

## Retry and Backoff

### Retry Policy

Webhook delivery uses exponential backoff with jitter for transient failures:

- **Max Attempts**: 5 (configurable via `WEBHOOK_RETRY_MAX_ATTEMPTS`)
- **Initial Delay**: 1 second (configurable via `WEBHOOK_RETRY_INITIAL_DELAY_MS`)
- **Max Delay**: 30 seconds (configurable via `WEBHOOK_RETRY_MAX_DELAY_MS`)
- **Multiplier**: 2 (configurable via `WEBHOOK_RETRY_MULTIPLIER`)
- **Jitter Factor**: 0.1 (configurable via `WEBHOOK_RETRY_JITTER_FACTOR`)

### Retryable Failures

The following conditions trigger automatic retry:

- HTTP 5xx errors
- Network errors: `ECONNRESET`, `ETIMEDOUT`, `ECONNABORTED`, `ENOTFOUND`, `EAI_AGAIN`, `ECONNREFUSED`

### Non-Retryable Failures

The following conditions immediately fail without retry:

- HTTP 4xx errors (client errors)
- Circuit breaker open
- Payload size exceeded

## Dead-Letter Queue (DLQ)

When a webhook delivery fails after all retry attempts, the event is enqueued to the Dead-Letter Queue for manual inspection or delayed retry.

### DLQ Entry Structure

```typescript
{
  providerId: string;    // Provider identifier
  deliveryId: string;    // Unique delivery ID
  targetUrl: string;     // Failed webhook URL
  payload: unknown;      // Original event payload
  timestamp: number;     // Enqueue timestamp (ms)
}
```

### DLQ Monitoring

Monitor DLQ depth and age using Prometheus metrics:

- `reputation_webhook_dlq_enqueued_total`: Total events enqueued to DLQ
- Custom provider-specific depth metrics available via `getDlqDepth()`
- Custom provider-specific age metrics available via `getDlqOldestAge()`

### DLQ Drainage

To replay failed events:

```typescript
const service = getReputationWebhookService();
const drained = service.drainDlq('reputation-webhook', 10);
// Process drained entries manually
```

## Circuit Breaker

Each webhook provider has a per-provider circuit breaker to prevent cascading failures:

- **Failure Threshold**: 5 failures (configurable via `WEBHOOK_CB_FAILURE_THRESHOLD`)
- **Success Threshold**: 1 success (configurable via `WEBHOOK_CB_SUCCESS_THRESHOLD`)
- **Timeout**: 60 seconds (configurable via `WEBHOOK_CB_TIMEOUT_MS`)

When the circuit is open, deliveries fail immediately without HTTP calls.

## Subscription Management

### Adding a Subscription

```typescript
const service = getReputationWebhookService();

const subscription = {
  subscriberId: 'my-app-123',
  webhookUrl: 'https://my-app.com/webhook',
  secret: 'shared-secret-key',
  eventTypes: ['reputation.rating.created'],
  targetFilter: 'user-123', // Optional: filter by target user
};

const subscriptionId = service.addSubscription(subscription);
```

### Removing a Subscription

```typescript
service.removeSubscription('my-app-123');
```

### Listing Subscriptions

```typescript
const subscriptions = service.getSubscriptions();
```

## Metrics

The following Prometheus metrics are emitted:

| Metric Name | Type | Labels | Description |
|-------------|------|--------|-------------|
| `reputation_webhook_events_emitted_total` | Counter | `event_type` | Total events emitted |
| `reputation_webhook_deliveries_total` | Counter | `subscription_id`, `event_type` | Total delivery attempts |
| `reputation_webhook_deliveries_success_total` | Counter | `subscription_id`, `event_type` | Successful deliveries |
| `reputation_webhook_deliveries_failure_total` | Counter | `subscription_id`, `event_type`, `reason` | Failed deliveries |
| `reputation_webhook_dlq_enqueued_total` | Counter | `subscription_id`, `event_type` | Events enqueued to DLQ |

## Security Considerations

### Secret Management

- Webhook secrets must be securely stored and rotated regularly
- Never include secrets in logs or API responses
- Use strong, randomly generated secrets (at least 32 characters)

### Signature Validation

- Always verify webhook signatures before processing payloads
- Use constant-time comparison to prevent timing attacks
- Reject webhooks with expired timestamps (5-minute window)

### URL Validation

- Webhook URLs are validated for SSRF protection
- Only HTTPS URLs are allowed in production
- Internal/private network URLs are blocked

## Testing

### Local Testing

Use tools like ngrok or localtunnel to test webhooks locally:

```bash
ngrok http 3000
```

Then configure your subscription with the ngrok URL.

### Verification

Test signature verification using the example payload and your secret:

```bash
curl -X POST https://your-app.com/webhook \
  -H "Content-Type: application/json" \
  -H "X-Signature: sha256=<computed-signature>" \
  -H "X-Timestamp: $(date +%s)000" \
  -d @payload.json
```

## Configuration

Environment variables for webhook behavior:

| Variable | Default | Description |
|----------|---------|-------------|
| `WEBHOOK_RETRY_MAX_ATTEMPTS` | 5 | Maximum retry attempts |
| `WEBHOOK_RETRY_INITIAL_DELAY_MS` | 1000 | Initial retry delay |
| `WEBHOOK_RETRY_MAX_DELAY_MS` | 30000 | Maximum retry delay |
| `WEBHOOK_RETRY_MULTIPLIER` | 2 | Exponential backoff multiplier |
| `WEBHOOK_RETRY_JITTER_FACTOR` | 0.1 | Jitter factor (0-1) |
| `WEBHOOK_CB_FAILURE_THRESHOLD` | 5 | Circuit breaker failure threshold |
| `WEBHOOK_CB_SUCCESS_THRESHOLD` | 1 | Circuit breaker success threshold |
| `WEBHOOK_CB_TIMEOUT_MS` | 60000 | Circuit breaker timeout |

## Error Handling

### Delivery Failures

Webhook delivery failures are logged but do not block reputation rating creation. The service uses fire-and-forget semantics:

- Successful delivery: Metrics updated, no error
- Retryable failure: Automatic retry with backoff
- Non-retryable failure: Enqueued to DLQ
- Circuit open: Immediate failure without HTTP call

### Monitoring Alerts

Configure alerts for:

- High DLQ depth (>100 entries)
- Old DLQ entries (>1 hour)
- High delivery failure rate (>5%)
- Circuit breaker open state

## Integration Example

```typescript
import { getReputationWebhookService } from './modules/reputation/webhook/reputation-webhook.service';

// Initialize during app startup
const service = initializeReputationWebhookService({
  registry: prometheusRegistry,
  retryConfig: {
    maxAttempts: 5,
    initialDelayMs: 1000,
  },
});

// Add subscription
service.addSubscription({
  subscriberId: 'analytics-service',
  webhookUrl: 'https://analytics.example.com/webhook',
  secret: process.env.WEBHOOK_SECRET!,
  eventTypes: ['reputation.rating.created'],
});

// Events are automatically emitted when ratings are created
// via ReputationService.createRating()
```

## Support

For issues or questions about the Reputation Webhook API, please refer to the main project documentation or open an issue in the repository.
