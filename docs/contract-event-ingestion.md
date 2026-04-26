# Contract Event Ingestion Pipeline

## Overview

The contract event ingestion pipeline provides a secure, idempotent, and auditable system for processing contract events with strict schema validation and deduplication guarantees.

## Architecture

The pipeline consists of several key components:

- **Validation Layer**: Strict schema validation with security constraints
- **Deduplication Engine**: Stable dedupe key generation and duplicate detection
- **Repository Layer**: Persistent storage with audit trail capabilities
- **Processing Engine**: Idempotent event processing with comprehensive error handling

## Event Schema

### ContractEvent Interface

```typescript
interface ContractEvent {
  contractId: string;      // Alphanumeric with hyphens/underscores, max 255 chars
  eventId: string;         // Alphanumeric with hyphens/underscores, max 255 chars
  sequence: number;        // Non-negative integer
  timestamp: string;       // ISO datetime string
  type: EventTypes;        // One of: CONTRACT_CREATED, CONTRACT_FUNDED, CONTRACT_COMPLETED, CONTRACT_CANCELLED
  payload: Record<string, unknown>; // Event-specific data, max 10KB
}
```

### Event Types

- `CONTRACT_CREATED`: A new contract has been created
- `CONTRACT_FUNDED`: A contract has received funding
- `CONTRACT_COMPLETED`: A contract has been successfully completed
- `CONTRACT_CANCELLED`: A contract has been cancelled

### Validation Rules

#### Strict Validation (Production)

1. **Field Validation**
   - `contractId`: Required, alphanumeric with hyphens/underscores only, max 255 characters
   - `eventId`: Required, alphanumeric with hyphens/underscores only, max 255 characters
   - `sequence`: Required, non-negative integer
   - `timestamp`: Required, valid ISO datetime string
   - `type`: Required, one of the supported event types
   - `payload`: Required, must be an object

2. **Security Constraints**
   - **Timestamp Range**: Must be within ±24 hours of current time (±5 minutes for future events)
   - **Payload Size**: Maximum 10KB
   - **Character Validation**: Only alphanumeric characters, hyphens, and underscores allowed in IDs

3. **Normalization**
   - `contractId` and `eventId` are trimmed of whitespace
   - `timestamp` is normalized to ISO format
   - All fields are validated for type correctness

#### Lenient Validation (Development/Testing)

Relaxes security constraints but maintains basic field validation:
- Allows any characters in IDs
- No timestamp range validation
- No payload size limits
- Maintains basic type and structure validation

## Idempotency Guarantees

### Deduplication Key

The deduplication key follows the format: `contractId:eventId:sequence`

**Example**: `my-contract-1:payment-event:42`

This ensures:
- **Uniqueness**: Each event within a contract has a unique sequence
- **Determinism**: Same event always generates the same key
- **Ordering**: Sequence numbers maintain event order within a contract

### Idempotency Behavior

1. **First Ingestion**: Event is validated, stored, and marked as `accepted`
2. **Duplicate Ingestion**: Same event key returns `duplicate` status without reprocessing
3. **Invalid Events**: Malformed events return `invalid` status with error reason
4. **Audit Trail**: All ingestion attempts are logged for auditability

### Hashed Keys (Optional)

For enhanced security, the system can generate SHA-256 hashes of deduplication keys:
- Prevents key enumeration attacks
- Maintains deterministic behavior
- Useful for public-facing APIs

## Repository Interface

### ContractEventRepository

```typescript
interface ContractEventRepository {
  hasEventKey(eventKey: string): Promise<boolean>;
  saveEvent(event: PersistedContractEvent): Promise<void>;
  listEvents(): Promise<PersistedContractEvent[]>;
  getEvent(eventKey: string): Promise<PersistedContractEvent | null>;
  saveAuditLog(log: IngestAuditLog): Promise<void>;
  getAuditLog(eventKey: string): Promise<IngestAuditLog | null>;
  listAuditLogs(limit?: number): Promise<IngestAuditLog[]>;
  getAuditLogsByContractId(contractId: string): Promise<IngestAuditLog[]>;
}
```

### Audit Trail

Every ingestion attempt creates an audit log:

```typescript
interface IngestAuditLog {
  eventKey: string;           // Deduplication key
  status: IngestStatus;       // accepted, duplicate, or invalid
  reason?: string;             // Rejection reason (if applicable)
  receivedAt: string;         // Server ingestion timestamp
  payloadHash?: string;       // Optional payload hash for integrity
  processingTimeMs?: number;  // Processing time in milliseconds
}
```

## Configuration Options

### ProcessorConfig

```typescript
interface ProcessorConfig {
  enableAuditLogging?: boolean;     // Enable/disable audit trail (default: false)
  enablePayloadHashing?: boolean;    // Hash payloads in audit logs (default: false)
  maxProcessingTime?: number;        // Maximum processing time in ms (default: unlimited)
}
```

## Usage Examples

### Basic Event Ingestion

```typescript
import { ContractEventProcessor } from './contracts/processor';
import { InMemoryContractEventRepository } from './contracts/repository';

const repository = new InMemoryContractEventRepository();
const processor = new ContractEventProcessor(repository, {
  enableAuditLogging: true,
  enablePayloadHashing: true
});

const event = {
  contractId: 'contract-123',
  eventId: 'payment-received',
  sequence: 1,
  timestamp: new Date().toISOString(),
  type: 'CONTRACT_FUNDED',
  payload: { amount: 1000, currency: 'USD' }
};

const result = await processor.ingest(event);
console.log(result); // { status: 'accepted', eventKey: 'contract-123:payment-received:1' }
```

### Idempotency Validation

```typescript
const idempotencyResult = await processor.validateIdempotency(event);
console.log(idempotencyResult.isIdempotent); // true
```

### Audit Log Retrieval

```typescript
const auditLog = await processor.getAuditLog('contract-123:payment-received:1');
console.log(auditLog);
// {
//   eventKey: 'contract-123:payment-received:1',
//   status: 'accepted',
//   receivedAt: '2026-04-26T14:18:00.000Z',
//   payloadHash: 'a1b2c3d4...',
//   processingTimeMs: 15
// }
```

### Contract-Specific Audit Trail

```typescript
const contractLogs = await processor.getAuditLogsByContractId('contract-123');
console.log(`Contract has ${contractLogs.length} events`);
```

## Error Handling

### Validation Errors

```typescript
const invalidEvent = { invalid: 'data' };
const result = await processor.ingest(invalidEvent);
// result: { status: 'invalid', reason: 'Payload must be a JSON object' }
```

### Persistence Errors

Persistence failures are propagated to allow for proper error handling:

```typescript
try {
  await processor.ingest(event);
} catch (error) {
  console.error('Failed to process event:', error.message);
  // Implement retry logic or fallback handling
}
```

## Security Considerations

### Input Validation

- All inputs are strictly validated before processing
- Timestamp validation prevents replay attacks with old/future timestamps
- Payload size limits prevent denial of service attacks
- Character validation prevents injection attacks

### Audit Trail

- Comprehensive logging of all ingestion attempts
- Optional payload hashing for integrity verification
- Processing time tracking for performance monitoring
- Status tracking for debugging and monitoring

### Idempotency

- Guaranteed exactly-once processing semantics
- Duplicate detection prevents data corruption
- Consistent behavior across retries and replays

## Performance Considerations

### Repository Design

- In-memory repository for development and testing
- Interface-based design for production database implementations
- Efficient indexing by contract ID for audit queries
- Batch operations support for high-throughput scenarios

### Processing Optimization

- Early validation to fail fast on invalid inputs
- Efficient deduplication key generation
- Minimal memory footprint for audit logs
- Configurable processing time limits

## Testing

The pipeline includes comprehensive test coverage:

- **Unit Tests**: Individual component testing
- **Integration Tests**: End-to-end pipeline testing
- **Idempotency Tests**: Verification of exactly-once semantics
- **Error Handling Tests**: Validation of error scenarios
- **Performance Tests**: Load and stress testing

### Running Tests

```bash
# Run all tests with coverage
npm run test:ci

# Run specific test files
npm test -- src/contracts/validation.test.ts
npm test -- src/contracts/processor.test.ts
```

## Migration Guide

### From Simple Event Processing

1. **Replace Basic Validation**: Use `validateContractEventPayload()` instead of manual checks
2. **Add Deduplication**: Implement `ContractEventRepository` interface
3. **Enable Audit Logging**: Configure `enableAuditLogging: true`
4. **Update Error Handling**: Handle `IngestResult` status codes properly

### Production Deployment

1. **Use Strict Validation**: Default to strict validation in production
2. **Enable Audit Logging**: Set `enableAuditLogging: true`
3. **Configure Persistence**: Implement database-backed repository
4. **Monitor Performance**: Track processing times and error rates
5. **Set Up Alerts**: Monitor for unusual patterns in audit logs

## Troubleshooting

### Common Issues

1. **Duplicate Events**: Check sequence numbers and event key generation
2. **Validation Failures**: Verify event schema and timestamp format
3. **Performance Issues**: Monitor processing times and repository performance
4. **Audit Log Gaps**: Ensure audit logging is enabled and repository is functioning

### Debugging Tools

- Repository statistics: `repository.getStats()`
- Event retrieval: `processor.getEvent(eventKey)`
- Audit log inspection: `processor.getAuditLog(eventKey)`
- Idempotency validation: `processor.validateIdempotency(payload)`

## Best Practices

1. **Always use strict validation in production**
2. **Enable audit logging for compliance and debugging**
3. **Monitor processing times and error rates**
4. **Implement proper error handling and retry logic**
5. **Use sequence numbers that are strictly increasing**
6. **Validate timestamps are within acceptable ranges**
7. **Keep payloads under the size limits**
8. **Test idempotency guarantees thoroughly**
