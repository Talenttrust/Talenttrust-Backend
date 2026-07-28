# Contract Event Indexer Cursor Model and Replay Protection

The Contract Event Indexer (`src/contracts/indexer.ts`) is responsible for ingesting, deduplicating, and persisting contract events. To ensure resilience and correctness, it uses a cursor-based checkpointing system backed by `src/contracts/cursor.repository.ts` and replay-safe deduplication logic in `src/contracts/dedupe.ts`.

## Cursor Model

The indexer keeps track of its progress using a cursor. The cursor is opaque to external consumers and is typically encoded as `base64url`.

The cursor object has the following shape:
```json
{
  "sourceId": "string",
  "lastSequence": 12345,
  "updatedAt": "2023-10-01T12:00:00Z"
}
```

- **`sourceId`**: Identifies the stream or source of events (e.g., the specific Soroban contract or horizon endpoint).
- **`lastSequence`**: The highest sequence number (or ledger) successfully processed and persisted.
- **`updatedAt`**: Timestamp of the last time this cursor was updated.

*Note: Cursor data such as `sourceId` should not contain or expose any sensitive internal identifiers in public API responses.*

## Ingestion Outcomes & Metrics

When a batch of events is processed, the indexer updates several metrics based on the outcome of each event:

- **`processedCount`**: The number of new, valid events successfully persisted. Maps to the `accepted` outcome.
- **`duplicateCount`**: The number of events that were skipped because they had already been processed. Maps to the `duplicate` outcome.
- **`errors`**: The number of events that failed processing due to validation failures or unexpected persistence issues. Maps to `invalid` or `error` outcomes.

## Replay Protection & Deduplication

The indexer provides an **at-least-once → effectively-once** guarantee.

1. **At-Least-Once Delivery**: Events may be delivered multiple times by the upstream source (e.g., upon resume after a crash or network retry).
2. **Effectively-Once Guarantee**: `src/contracts/dedupe.ts` computes a stable, deterministic identity key for each event (usually `contractId:eventId:sequence`). Before processing an event, the indexer checks if this key already exists. If it does, the event is treated as an idempotent duplicate and is skipped (`duplicateCount` is incremented).

This deduplication ensures that replaying a batch of events will never result in double-writing or duplicate state transitions.

## Resume-After-Crash Walkthrough

In the event of a process crash or restart, the indexer recovers safely using the cursor:

1. **Crash Occurs**: The indexer process dies unexpectedly. The last committed cursor remains in the `cursor.repository.ts`.
2. **Restart & Load Cursor**: Upon restart, the indexer reads the last saved cursor (`lastSequence`) from the repository.
3. **Fetch Events**: The indexer requests the event stream starting from `lastSequence` (or `lastSequence + 1`).
4. **Process & Deduplicate**: The upstream source might resend events that were partially processed right before the crash. The deduplicator (`src/contracts/dedupe.ts`) sees the deterministic identity keys of these events, recognizes them as already processed, and safely skips them.
5. **Advance Cursor**: As new events are processed, the cursor is advanced and safely checkpointed.

This model guarantees that no events are missed and no events are applied twice, even across catastrophic failures.
