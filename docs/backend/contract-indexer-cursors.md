# Contract Event Indexing with Cursor Checkpoints

## Overview

The contract event indexer provides stable ordering guarantees, replay protection, and checkpoint-based resumption for contract event processing. It enables safe, fault-tolerant ingestion from multiple sources with deterministic deduplication semantics.

## Key Features

### 1. Stable Ordering
- Events are indexed in deterministic order by sequence number within each contract
- Out-of-order submissions are automatically reordered
- Original submission order is preserved as a tiebreaker for events with equal sequence

### 2. Replay Protection
- Deterministic deduplication key: `contractId:eventId:sequence`
- Identical events submitted multiple times are processed exactly once
- Safe across multiple indexing sources (API, blockchain, webhooks, etc.)
- Idempotent - replaying any batch produces the same result

### 3. Cursor Checkpoints
- Tracks the highest successfully indexed sequence per source
- Enables resumption from last known position on restart
- Supports manual checkpoint override for recovery scenarios
- Metadata can be attached (e.g., block hash, checkpoint name)

### 4. Security & Reliability
- Separate cursor tracking per source allows concurrent indexing
- Atomic cursor updates prevent partial state inconsistencies
- Graceful error handling - invalid events skip but don't block processing
- Clear distinction between valid, duplicate, and invalid outcomes

## Architecture

### Components

#### `IndexerCursor` Types
```typescript
interface IndexerCursor {
  sourceId: string;           // Unique identifier for indexing source
  lastSequence: number;       // Highest indexed sequence
  updatedAt: string;          // Timestamp of last update
  metadata?: Record<...>;     // Optional metadata (block hash, etc.)
}
```

#### `CursorRepository` Interface
Persists cursor checkpoints. Implementations:
- `InMemoryCursorRepository` - For testing and local development
- `SQLiteCursorRepository` - Production persistent storage (future)
- `RedisCursorRepository` - High-performance caching layer (future)

#### `ContractEventIndexer` Class
Orchestrates event processing with four main operations:

1. **`resumeFromCursor(request)`** - Get resume position
2. **`indexBatch(sourceId, events)`** - Process events with stable ordering
3. **`getCursor(sourceId)`** - Query current checkpoint
4. **`listCursors()`** - Audit all checkpoints

### Processing Pipeline

```
Inbound Batch
    ↓
Sort by Sequence (stable)
    ↓
For each event:
  ├─ Validate payload schema
  ├─ Check deduplication key
  ├─ If duplicate: increment counter (idempotent)
  ├─ If new: persist to repository
  └─ Track highest sequence
    ↓
Update Cursor with max sequence
    ↓
Return {processedCount, duplicateCount, errors, newCursor}
```

## Usage Examples

### 1. Fresh Start - Index Events from Block

```typescript
const indexer = new ContractEventIndexer(
  eventProcessor,
  cursorRepository,
);

const events = await sorobanRpc.getContractEvents({
  startLedger: 0,
  type: 'contract',
});

const result = await indexer.indexBatch('block-100000', events);
console.log(`Indexed: ${result.processedCount}, Duplicates: ${result.duplicateCount}`);
// Indexed: 42, Duplicates: 0
```

### 2. Resume from Checkpoint

```typescript
// On service restart or recovery
const resume = await indexer.resumeFromCursor({
  sourceId: 'block-100000',
});

if (!resume.isFreshStart) {
  console.log(`Resuming from sequence ${resume.resumeFromSequence}`);
  console.log(`Last checkpoint: ${resume.cursor.updatedAt}`);
}

const nextBatch = await sorobanRpc.getContractEvents({
  startLedger: resumeFromSequence,
  count: 100,
});

const result = await indexer.indexBatch('block-100001', nextBatch);
```

### 3. Replay Safety - Safe API Retry

```typescript
// Client retries same batch due to network error
const events = [...] // Same events

const result1 = await indexer.indexBatch('api-source', events);
console.log(`First attempt - Indexed: ${result1.processedCount}`);
// First attempt - Indexed: 5

// Later, client retries
const result2 = await indexer.indexBatch('api-source', events);
console.log(`Retry - Duplicates: ${result2.duplicateCount}`);
// Retry - Duplicates: 5
// Zero new events, zero data corruption
```

### 4. Multiple Concurrent Sources

```typescript
// Blockchain source
const blockchainResult = await indexer.indexBatch(
  'soroban-rpc',
  blockchainEvents,
);

// Webhook source (interleaved)
const webhookResult = await indexer.indexBatch(
  'webhook-receiver',
  webhookEvents,
);

// Query checkpoint status
const cursors = await indexer.listCursors();
cursors.forEach((c) => {
  console.log(`${c.sourceId}: seq=${c.lastSequence} at ${c.updatedAt}`);
});
```

## Data Flow

### Event Ingestion

```
External Event Source (Block, API, Webhook)
         ↓
   Validation
    (Schema check, field normalization)
         ↓
   Deduplication Check
    (eventKey = contractId:eventId:sequence lookup)
         ↓
    ├─ Found (duplicate) → Return 'duplicate' status, skip persist
    ├─ Error → Return 'invalid' status, don't persist
    └─ Not found (new) → Persist event, track for cursor
         ↓
   Cursor Update
    (Atomic update with highest sequence in batch)
         ↓
   Return Result
    {processedCount, duplicateCount, errors, newCursor}
```

## Guarantees & Semantics

### Ordering Guarantee
- **Within a contract**: Events with sequence N are always processed before sequence N+1
- **Deterministic**: Multiple runs of same input produce identical state

### Deduplication Guarantee
- **Idempotent**: Replaying identical batch yields same number of duplicates
- **Cross-source**: Events indexed from API can never be re-indexed from blockchain
- **Key-based**: Dedup uses `contractId:eventId:sequence` - structure is explicit in code

### Cursor Guarantee
- **Monotonic**: Cursor always points to a sequence that was successfully indexed (or attempted with errors)
- **Recoverable**: Resume from cursor point + 1 safely resumes without duplicates or gaps
- **Per-source**: Multiple sources track independently without interference

### Error Handling
- **Graceful degradation**: Single invalid event doesn't block batch processing
- **Error tracking**: Failed events reported in result; caller decides escalation
- **Atomic cursor**: Cursor only updates if batch completes (even with errors)

## Security Considerations

### Replay Attack Prevention

The deterministic deduplication key prevents replay attacks:

```typescript
// Even if network causes duplicate submissions:
payload1 = {contractId: "c1", eventId: "e1", sequence: 1, ...}
payload1_retry = {...same payload...}

// Both produce same key:
key = "c1:e1:1"

// Second processed as duplicate (idempotent):
result.status === 'duplicate';
result.eventKey === "c1:e1:1";
```

### Ordering Exploitation Prevention

Sequence numbers prevent out-of-order attacks:

```typescript
// Events MUST be processed in sequence order:
event_seq_10 = {...}
event_seq_12 = {...}
event_seq_11 = {...}  // Out of order

// Even submitted as [10, 12, 11], internally sorted to [10, 11, 12]
// Cannot create causality violations
```

### Source Isolation

Separate cursors per source prevent false duplicate conclusions:

```typescript
// Blockchain source sees sequence 100
await indexer.indexBatch('blockchain', [...seq_1_to_100])
// cursor blockchain.lastSequence = 100

// API source is behind
await indexer.indexBatch('api', [...seq_1_to_50])
// cursor api.lastSequence = 50

// Events 51-100 from API are NOT duplicates when eventually received
// (Different sourceId means independent checkpoint)
```

However, event-level deduplication (by eventKey) DOES prevent cross-source duplicates.

## Testing Strategy

### Unit Tests
- ✓ Cursor CRUD operations
- ✓ Event sorting and stable ordering
- ✓ Deduplication across batches
- ✓ Invalid event handling
- ✓ Idempotent replay
- ✓ Cursor checkpoint updates
- ✓ Multi-source isolation

### Integration Tests (Future)
- ✓ End-to-end from blockchain to database
- ✓ Concurrent sources under load
- ✓ Cursor recovery on restart
- ✓ SQLite/Redis backend implementations

### Property-Based Tests (Future)
- ✓ Replaying any events produces same state
- ✓ Cursor always ≥ any indexed event sequence
- ✓ No events lost or duplicated under replay

## Production Hardening (Future Work)

### Phase 1: Persistent Storage
- Implement `SQLiteCursorRepository` using existing database
- Replace in-memory with durable on-disk checkpoint tracking
- Add cursor versionining for migration support

### Phase 2: Observability
- Emit metrics: events_indexed_total, events_duplicate_total, cursor_lag_seconds
- Add structured logging for each batch result
- Track checkpoint update latency

### Phase 3: Advanced Features
- Cursor TTL (auto-expire stale checkpoints)
- Cursor versioning (support multi-version snapshots)
- Bulk cursor reset/migration for schema changes
- Historical event queries by cursor range

## Migration Guide

### From Simple JSON File Storage
```typescript
// Old: store events only
const events = fs.readJSON('events.json');

// New: add cursor tracking
const indexer = new ContractEventIndexer(processor, cursorRepository);
const result = await indexer.indexBatch('import-source', events);

// Cursor can now resume from last sequence
```

### From Unordered In-Memory
```typescript
// Old: events stored in insertion order
const events = this.events; // [seq 10, seq 5, seq 12]

// New: stable ordering applied internally
await indexer.indexBatch('source', events);
// Internally sorted to [seq 5, seq 10, seq 12]
```

## References

- [Contract Event Processing](./contract-event-processing.md) - Event validation and dedupe
- [Database Architecture](./database.md) - Persistence layer
- [Error Handling](./error-handling.md) - Error categorization

## Appendix: FAQ

**Q: Why include sequence number in dedup key instead of just contractId:eventId?**
A: Blocks can reorg, causing same event to be emitted at different heights. Sequence ties event to specific state transition, making key truly unique to that occurrence.

**Q: Can I safely skip events detected as "invalid"?**
A: No - invalid events should trigger alerts. They indicate either broken client logic or upstream data corruption.

**Q: What if cursor timestamp is stale?**
A: Timestamp is informational only. Resume logic uses sequence number. Stale timestamp may indicate network partition or processing bottleneck - monitor with alerting.

**Q: How does this handle contract state rollbacks?**
A: Cursors are per-source and immutable once set. If blockchain reorgs, the source should track heights/hashes separately. Event dedup prevents duplicate processing even if reorg requires re-ingesting.
