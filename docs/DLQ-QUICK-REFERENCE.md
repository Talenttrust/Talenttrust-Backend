# DLQ Metrics Quick Reference

## Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `webhook_dlq_depth` | Gauge | `provider` | Current number of items in the DLQ |
| `webhook_dlq_oldest_age_seconds` | Gauge | `provider` | Age in seconds of the oldest entry |

## Environment Variables

```bash
DLQ_METRICS_INTERVAL_MS=30000  # Sampling interval (default: 30 seconds)
```

## Alert Thresholds

```yaml
# Warning: Backlog growing
webhook_dlq_depth > 100 for 5m

# Warning: Entries stale
webhook_dlq_oldest_age_seconds > 3600

# Critical: Backlog critical
webhook_dlq_depth > 1000 for 10m
```

## API Usage

### Initialize DLQ Metrics

```typescript
import { initializeJobs } from './api/jobs';

// Start DLQ metrics sampling on app startup
initializeJobs();
```

### Push to DLQ

```typescript
import { getDlqStore } from './api/jobs';

const dlqStore = getDlqStore();
dlqStore?.push({
  providerId: 'acme',
  deliveryId: 'evt-001',
  targetUrl: 'https://hooks.acme.com/inbound',
  payload: { event: 'contract.signed' },
  timestamp: Date.now(),
});
```

### Drain DLQ (Manual Retry)

```typescript
const dlqStore = getDlqStore();
const entries = dlqStore?.drain('acme', 10); // Drain up to 10 entries

for (const entry of entries ?? []) {
  // Retry delivery
  await webhookService.deliver({
    providerId: entry.providerId,
    deliveryId: entry.deliveryId,
    targetUrl: entry.targetUrl,
    payload: entry.payload,
  });
}
```

## Prometheus Scrape Config

```yaml
scrape_configs:
  - job_name: 'talenttrust-webhooks'
    static_configs:
      - targets: ['localhost:3001']
    scrape_interval: 15s
    metrics_path: /metrics
```

## Testing

```bash
# Run all tests
npm test

# Run with coverage
npm run test:ci

# Run only DLQ tests
npm test -- webhookDelivery.test.ts
```

## Troubleshooting

### Gauges not updating?

1. Check logs for `[api/jobs] DLQ metrics sampling started`
2. Verify `initializeJobs()` is called in `src/index.ts`
3. Lower `DLQ_METRICS_INTERVAL_MS` for faster updates

### Gauges not resetting to zero?

1. Wait for next sampling interval (default 30s)
2. Manually call `updateDlqMetrics(dlqStore)` to force update
3. Check DLQ store's `drain()` implementation

### High cardinality warning?

1. Verify provider IDs pass through `sanitizeProvider()`
2. Consider aggregating by provider tier instead of individual IDs

## Security Checklist

- ✅ No secrets in metric labels
- ✅ Provider IDs sanitized (truncated to 32 chars, special chars replaced)
- ✅ `/metrics` endpoint protected (internal network or auth)
- ✅ DLQ payloads encrypted at rest (if persisted)

## File Locations

```
src/
├── dlqStore.ts              # DLQ storage interface + in-memory impl
├── webhookMetrics.ts        # Prometheus gauges + sampling logic
├── api/
│   └── jobs.ts              # Background job initialization
└── webhookDelivery.test.ts  # Integration tests

docs/
├── WEBHOOK-DLQ.md           # Full documentation
└── DLQ-QUICK-REFERENCE.md   # This file
```

## Production Upgrade Path

### Redis-Backed DLQ

```typescript
import { createClient } from 'redis';

class RedisDlqStore implements DlqStore {
  private client = createClient();

  async push(entry: DlqEntry): Promise<void> {
    await this.client.lPush(`dlq:${entry.providerId}`, JSON.stringify(entry));
  }

  getDepthByProvider(): Map<string, number> {
    // Use LLEN for each provider key
  }

  getOldestAgeByProvider(): Map<string, number> {
    // Use LINDEX -1 to get oldest entry
  }
}
```

### Database-Backed DLQ

```typescript
class DatabaseDlqStore implements DlqStore {
  async push(entry: DlqEntry): Promise<void> {
    await db.dlqEntries.create(entry);
  }

  getDepthByProvider(): Map<string, number> {
    // SELECT provider_id, COUNT(*) FROM dlq_entries GROUP BY provider_id
  }

  getOldestAgeByProvider(): Map<string, number> {
    // SELECT provider_id, MIN(timestamp) FROM dlq_entries GROUP BY provider_id
  }
}
```
