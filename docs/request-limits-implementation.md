# Request Limits Implementation

## Queue Depth Management
To prevent memory exhaustion from unbounded waiter accumulation, we have introduced a **Hard Queue Cap**.

- **Policy**: When `queue.length >= maxQueueDepth`, the system rejects with `RateLimitQueueFullError`.
- **Error type**: `RateLimitQueueFullError` (`code: 'RATE_LIMIT_QUEUE_FULL'`) — an `Error` subclass carrying the `providerId` and the cap value. Callers should catch this error to route the request to the Dead Letter Queue (DLQ).
- **Config**: Set via `WEBHOOK_MAX_QUEUE_DEPTH` env var (default: `1000`), validated alongside `WEBHOOK_BUCKET_CAPACITY` and `WEBHOOK_REFILL_RATE_PER_SEC` in `loadWebhookTokenBucketConfig`. Must be a finite positive integer.
- **Monitoring**: Rejections are recorded via `recordQueueOverflow()` in `webhookMetrics.ts` (zero-label counter — no cardinality risk) to trigger alerts before service degradation occurs.
- **FIFO ordering**: Waiters already in the queue below the cap continue to drain in FIFO order. New acquisitions are accepted again once the queue drops below the cap.
