# Event Ingestion Idempotency Documentation

## Overview

The Talenttrust backend implements an idempotent contract event ingestion pipeline
that guarantees safe event processing with strict schema validation,
deduplication, payload integrity checks, and auditability.

## Architecture

### Core Components

1. **Event Validation Layer** - Validates event structure and contract-specific schemas.
2. **Deduplication Manager** - Computes stable deduplication keys and canonical payload hashes.
3. **Audit Repository** - Persists processing outcomes for auditability.
4. **Ingestion Service** - Orchestrates the pipeline with idempotency guarantees.

## Idempotency Mechanism

### Deduplication Key Format

The system uses a stable deduplication key format: `contractId:eventId:sequence`.

Example: `talent_contract_123:profile_created:1`

This ensures that:

- Events from the same contract are uniquely identified.
- Event replay scenarios are handled safely.
- Sequence ordering is preserved within contracts.

### Payload Integrity Verification

Each idempotency key is bound to a stable SHA-256 hash of the event payload. The
hash is computed from canonical JSON: object keys are sorted recursively while
array order is preserved.

When the same deduplication key is received again:

- If the canonical payload hash matches, the event is treated as a duplicate
  no-op and the cached duplicate result is returned.
- If the canonical payload hash differs, the event is rejected with a safe
  `409 Conflict` result using `IDEMPOTENCY_PAYLOAD_CONFLICT`.

Hash comparison uses `crypto.timingSafeEqual`. Conflict logs include only the
deduplication key and hash metadata; payload bodies are replaced by the redaction
marker from `src/events/redact.ts`, and secret-like fields are redacted before
logging.

## Event Schemas

### Base Event Structure

```typescript
interface ContractEvent {
  contractId: string;
  eventId: string;
  sequence: number;
  timestamp: number;
  payload: object;
  signature?: string;
}
```

### Contract-Specific Payload Schemas

#### Talent Contract Events

```typescript
interface TalentEventPayload {
  talentId: string;
  action: 'created' | 'updated' | 'verified' | 'terminated';
  metadata?: object;
}
```

#### Payment Contract Events

```typescript
interface PaymentEventPayload {
  paymentId: string;
  amount: number;
  currency: string;
  status: 'pending' | 'completed' | 'failed';
  timestamp: number;
}
```

#### Review Contract Events

```typescript
interface ReviewEventPayload {
  reviewId: string;
  reviewerId: string;
  rating: number;
  comment?: string;
  createdAt: number;
}
```

## API Endpoints

### Event Ingestion

**POST** `/api/v1/events`

Processes a batch of events with full idempotency guarantees.

**Request Body:**

```json
{
  "events": ["ContractEvent[]"],
  "contractType": "talent_contract | payment_contract | review_contract"
}
```

**Response:**

```json
{
  "processed": 3,
  "results": [{
    "deduplicationKey": "contract_123:event_456:1",
    "status": "accepted | rejected | duplicate",
    "reason": "Optional error description",
    "processedAt": "2023-01-01T00:00:00.000Z"
  }],
  "summary": {
    "accepted": 2,
    "rejected": 0,
    "duplicates": 1
  }
}
```

### Event Validation (Dry Run)

**POST** `/api/v1/events/validate`

Validates events without processing them.

### Processing Statistics

**GET** `/api/v1/stats`

Returns processing statistics.

### Contract History

**GET** `/api/v1/contracts/{contractId}/history`

Retrieves processing history for a specific contract.

## Configuration

```bash
ENABLE_STRICT_VALIDATION=true
ENABLE_PAYLOAD_INTEGRITY_CHECK=true
MAX_EVENT_AGE_MS=86400000
EVENT_BATCH_SIZE=100
```

## Error Handling

Events are rejected for missing required fields, invalid data types,
contract-specific schema violations, excessive age, and idempotency payload hash
conflicts.

## Security Considerations

1. **Input Validation**: All inputs are strictly validated before processing.
2. **Payload Integrity**: Duplicate keys must match the original canonical payload hash.
3. **Audit Trail**: Processing history is maintained for all accepted and rejected events.
4. **Secret Redaction**: Payload bodies and secret-like metadata are redacted from logs.
5. **Authentication and Signature Verification**: These checks must happen before side effects.
6. **Secret Storage**: Secrets stay in `.env` files or deployment secret stores, not idempotency records.

## Testing

Run tests with:

```bash
npm run test:ci
npm run test:watch
```
