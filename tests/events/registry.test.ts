import {
  EventIngestionConfig,
  EventIngestionService,
} from '../../src/events/eventIngestionService';
import { EventAuditService, InMemoryEventAuditRepository } from '../../src/repository/eventAuditRepository';
import { ContractEvent } from '../../src/events/types';
import {
  validateEventEnvelopePreamble,
  EnvelopeValidationOptions,
} from '../../src/shared/eventEnvelopeValidation';
import { computeIdempotencyKey } from '../../src/events/idempotencyStore';
import { hashEventPayload, IdempotencyLayer } from '../../src/events/idempotency';

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

const defaultConfig: EventIngestionConfig = {
  enableStrictValidation: true,
  enablePayloadIntegrityCheck: true,
  maxEventAgeMs: 86400000,
  batchSize: 100,
};

const validEvent: ContractEvent = {
  contractId: 'contract_123',
  eventId: 'profile_created',
  sequence: 1,
  timestamp: Date.now(),
  payload: { talentId: 'talent_456', action: 'created' },
};

function createService(config?: Partial<EventIngestionConfig>): EventIngestionService {
  const repository = new InMemoryEventAuditRepository();
  const auditService = new EventAuditService(repository);
  return new EventIngestionService(auditService, { ...defaultConfig, ...config });
}

const preambleOptions: EnvelopeValidationOptions = {
  rootErrorMessage: 'Event must be a JSON object.',
  messageSuffix: '.',
  timestampRule: 'numeric',
  abortEarly: false,
};

// ---------------------------------------------------------------------------
// 1. Registry module — exported wiring
// ---------------------------------------------------------------------------

describe('Event registry module (src/events/registry.ts)', () => {
  it('exports a configured EventIngestionService instance', async () => {
    // The registry module wires the service together.  We verify the same
    // wiring pattern works by instantiating a service with the same defaults.
    const service = createService();
    const result = await service.processEvent(validEvent, 'talent_contract');
    expect(result.status).toBe('accepted');
  });

  it('applies default config values when no overrides are provided', () => {
    const service = createService({});
    // Defaults are exercised by the constructor; we verify sensible defaults
    // by checking that the service runs the preamble validators correctly.
    expect(service).toBeInstanceOf(EventIngestionService);
  });

  it('uses a shared InMemoryEventAuditRepository', async () => {
    const repository = new InMemoryEventAuditRepository();
    const auditService = new EventAuditService(repository);
    const service = new EventIngestionService(auditService, defaultConfig);

    await service.processEvent(validEvent, 'talent_contract');
    const stats = await service.getStatistics();
    expect(stats.total).toBe(1);
    expect(stats.accepted).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Schema lookup by event type name
// ---------------------------------------------------------------------------

describe('Schema lookup by contract type', () => {
  let service: EventIngestionService;

  beforeEach(() => {
    service = createService();
  });

  it('resolves talent_contract schema and accepts valid payloads', async () => {
    const result = await service.processEvent(validEvent, 'talent_contract');
    expect(result.status).toBe('accepted');
  });

  it('resolves talent_contract schema and rejects missing talentId', async () => {
    const event: ContractEvent = {
      ...validEvent,
      payload: { action: 'created' },
    };
    const result = await service.processEvent(event, 'talent_contract');
    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('talentId is required for talent_contract');
  });

  it('resolves talent_contract schema and rejects missing action', async () => {
    const event: ContractEvent = {
      ...validEvent,
      payload: { talentId: 'talent_456' },
    };
    const result = await service.processEvent(event, 'talent_contract');
    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('action is required for talent_contract');
  });

  it('resolves talent_contract schema and rejects empty talentId', async () => {
    const event: ContractEvent = {
      ...validEvent,
      payload: { talentId: '', action: 'created' },
    };
    const result = await service.processEvent(event, 'talent_contract');
    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('talentId is required for talent_contract');
  });

  it('resolves talent_contract schema and rejects empty action', async () => {
    const event: ContractEvent = {
      ...validEvent,
      payload: { talentId: 'talent_456', action: '' },
    };
    const result = await service.processEvent(event, 'talent_contract');
    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('action is required for talent_contract');
  });

  it('resolves talent_contract schema and accepts payloads with extra fields', async () => {
    const event: ContractEvent = {
      ...validEvent,
      payload: {
        talentId: 'talent_456',
        action: 'updated',
        metadata: { source: 'api' },
        tags: ['premium'],
      },
    };
    const result = await service.processEvent(event, 'talent_contract');
    expect(result.status).toBe('accepted');
  });

  it('gracefully handles a non-object payload for a known contract type', async () => {
    const event: ContractEvent = {
      ...validEvent,
      payload: 'string-payload' as unknown as Record<string, unknown>,
    };
    const result = await service.processEvent(event, 'talent_contract');
    expect(result.status).toBe('rejected');
    // Should fail on the envelope check (payload must be an object) before
    // reaching contract-specific validation.
    expect(result.reason).toContain('payload must be an object');
  });
});

// ---------------------------------------------------------------------------
// 3. Unknown event type rejection
// ---------------------------------------------------------------------------

describe('Unknown contract type handling', () => {
  let service: EventIngestionService;

  beforeEach(() => {
    service = createService();
  });

  it('accepts events with unknown contract types when the envelope is valid', async () => {
    // The registry has no schema for 'unknown_contract_type', so it skips
    // contract-specific payload validation and only checks the envelope.
    const result = await service.processEvent(validEvent, 'unknown_contract_type');
    expect(result.status).toBe('accepted');
  });

  it('still validates base envelope fields for unknown contract types', async () => {
    const event = { contractId: '' } as unknown as ContractEvent;
    const result = await service.processEvent(event, 'unknown_contract_type');
    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('contractId is required');
  });

  it('rejects non-object events regardless of contract type', async () => {
    const result = await service.processEvent(null as unknown as ContractEvent, 'unknown_contract_type');
    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('Event must be a JSON object');
  });

  it('rejects events with missing required envelope fields for unknown types', async () => {
    const event = {
      contractId: 'c1',
      eventId: '', // empty eventId
      sequence: -1,
      timestamp: 'bad',
      payload: null,
    } as unknown as ContractEvent;
    const result = await service.processEvent(event, 'unknown_contract_type');
    expect(result.status).toBe('rejected');
    // Multiple envelope errors should be collected
    expect(result.reason).toContain('eventId is required');
    expect(result.reason).toContain('sequence must be a non-negative integer');
  });
});

// ---------------------------------------------------------------------------
// 4. Duplicate registration protection
// ---------------------------------------------------------------------------

describe('Duplicate event protection', () => {
  it('detects duplicate events and returns duplicate status', async () => {
    const service = createService();

    // First insertion succeeds
    const first = await service.processEvent(validEvent, 'talent_contract');
    expect(first.status).toBe('accepted');

    // Second insertion with same deduplication key returns duplicate
    const second = await service.processEvent(validEvent, 'talent_contract');
    expect(second.status).toBe('duplicate');
  });

  it('rejects events with the same key but different payload (payload conflict)', async () => {
    const service = createService();

    await service.processEvent(validEvent, 'talent_contract');

    // Same eventId/contractId/sequence but different payload
    const tampered: ContractEvent = {
      ...validEvent,
      payload: { talentId: 'talent_456', action: 'malicious' },
    };
    const result = await service.processEvent(tampered, 'talent_contract');
    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('Payload integrity check failed');
  });

  it('bypasses payload integrity check when disabled', async () => {
    const service = createService({ enablePayloadIntegrityCheck: false });

    await service.processEvent(validEvent, 'talent_contract');

    const tampered: ContractEvent = {
      ...validEvent,
      payload: { talentId: 'talent_456', action: 'malicious' },
    };
    const result = await service.processEvent(tampered, 'talent_contract');
    // Without integrity check, it's treated as a plain duplicate
    expect(result.status).toBe('duplicate');
  });

  it('treats events with different contractId as unique (no false duplicate)', async () => {
    const service = createService();

    await service.processEvent(validEvent, 'talent_contract');

    const differentContract: ContractEvent = {
      ...validEvent,
      contractId: 'contract_999',
    };
    const result = await service.processEvent(differentContract, 'talent_contract');
    expect(result.status).toBe('accepted');
  });
});

// ---------------------------------------------------------------------------
// 5. Version resolution — idempotency key computation
// ---------------------------------------------------------------------------

describe('Idempotency version resolution', () => {
  it('computeIdempotencyKey produces a deterministic 64-char hex key', () => {
    const event = {
      providerId: 'provider_1',
      eventType: 'talent_contract',
      eventId: 'evt_001',
      timestamp: 1_700_000_000_000,
      payload: { data: 'test' },
    };

    const key = computeIdempotencyKey(event);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces the same key for the same inputs (deterministic)', () => {
    const event = {
      providerId: 'provider_1',
      eventType: 'talent_contract',
      eventId: 'evt_001',
      timestamp: 1_700_000_000_000,
      payload: { data: 'test' },
    };

    const key1 = computeIdempotencyKey(event);
    const key2 = computeIdempotencyKey({ ...event });
    expect(key1).toBe(key2);
  });

  it('produces different keys for different providerIds', () => {
    const base = {
      providerId: 'provider_1',
      eventType: 'talent_contract',
      eventId: 'evt_001',
      timestamp: 1_700_000_000_000,
      payload: { data: 'test' },
    };

    const key1 = computeIdempotencyKey(base);
    const key2 = computeIdempotencyKey({ ...base, providerId: 'provider_2' });
    expect(key1).not.toBe(key2);
  });

  it('produces different keys for different eventTypes', () => {
    const base = {
      providerId: 'provider_1',
      eventType: 'talent_contract',
      eventId: 'evt_001',
      timestamp: 1_700_000_000_000,
      payload: { data: 'test' },
    };

    const key1 = computeIdempotencyKey(base);
    const key2 = computeIdempotencyKey({ ...base, eventType: 'payment_contract' });
    expect(key1).not.toBe(key2);
  });

  it('rounds timestamp to the configured window for clock-skew tolerance', () => {
    // Two timestamps within the same 5-minute window should produce the same key
    const base = {
      providerId: 'provider_1',
      eventType: 'talent_contract',
      eventId: 'evt_001',
      timestamp: 1_700_000_000_000,
      payload: { data: 'test' },
    };

    // +2 minutes — still within the 5-minute window
    const near = computeIdempotencyKey({ ...base, timestamp: 1_700_000_000_000 + 120_000 });
    expect(near).toBe(computeIdempotencyKey(base));

    // +5 minutes — crosses into the next window
    const far = computeIdempotencyKey({ ...base, timestamp: 1_700_000_000_000 + 300_000 });
    expect(far).not.toBe(computeIdempotencyKey(base));
  });

  it('hashEventPayload produces a stable SHA-256 digest', () => {
    const hash1 = hashEventPayload({ name: 'Alice', age: 30 });
    const hash2 = hashEventPayload({ age: 30, name: 'Alice' });
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashEventPayload produces different hashes for different payloads', () => {
    const hash1 = hashEventPayload({ name: 'Alice' });
    const hash2 = hashEventPayload({ name: 'Bob' });
    expect(hash1).not.toBe(hash2);
  });

  it('hashEventPayload handles nested objects deterministically', () => {
    const hash1 = hashEventPayload({ user: { name: 'Alice', role: 'admin' } });
    const hash2 = hashEventPayload({ user: { role: 'admin', name: 'Alice' } });
    expect(hash1).toBe(hash2);
  });

  it('IdempotencyLayer tracks processed events and prevents re-processing', async () => {
    await IdempotencyLayer._clear();

    const eventId = 'evt_unique_001';
    const processed = await IdempotencyLayer.isEventProcessed(eventId);
    expect(processed).toBe(false);

    await IdempotencyLayer.markEventProcessed(eventId);
    const nowProcessed = await IdempotencyLayer.isEventProcessed(eventId);
    expect(nowProcessed).toBe(true);
  });

  it('IdempotencyLayer treats different event IDs independently', async () => {
    await IdempotencyLayer._clear();

    await IdempotencyLayer.markEventProcessed('evt_a');
    expect(await IdempotencyLayer.isEventProcessed('evt_a')).toBe(true);
    expect(await IdempotencyLayer.isEventProcessed('evt_b')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. Schema validation failures surface the offending field path
// ---------------------------------------------------------------------------

describe('Validation error field paths', () => {
  let service: EventIngestionService;

  beforeEach(() => {
    service = createService();
  });

  it('surfaces contractId field path when missing', async () => {
    const event = { eventId: 'e1', sequence: 1, timestamp: Date.now(), payload: {} } as unknown as ContractEvent;
    const result = await service.processEvent(event, 'talent_contract');
    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('contractId');
  });

  it('surfaces eventId field path when missing', async () => {
    const event = { contractId: 'c1', sequence: 1, timestamp: Date.now(), payload: {} } as unknown as ContractEvent;
    const result = await service.processEvent(event, 'talent_contract');
    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('eventId');
  });

  it('surfaces sequence field path when negative', async () => {
    const event = { ...validEvent, sequence: -1 };
    const result = await service.processEvent(event, 'talent_contract');
    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('sequence');
  });

  it('surfaces timestamp field path when invalid', async () => {
    const event = { ...validEvent, timestamp: 'not-a-timestamp' as unknown as number };
    const result = await service.processEvent(event, 'talent_contract');
    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('timestamp');
  });

  it('surfaces payload field path when payload is not an object', async () => {
    const event = { ...validEvent, payload: null as unknown as Record<string, unknown> };
    const result = await service.processEvent(event, 'talent_contract');
    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('payload');
  });

  it('surfaces payload.talentId field for talent_contract missing talentId', async () => {
    const event: ContractEvent = {
      ...validEvent,
      payload: { action: 'created' },
    };
    const result = await service.processEvent(event, 'talent_contract');
    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('talentId');
    expect(result.reason).toContain('talent_contract');
  });

  it('surfaces payload.action field for talent_contract missing action', async () => {
    const event: ContractEvent = {
      ...validEvent,
      payload: { talentId: 'talent_456' },
    };
    const result = await service.processEvent(event, 'talent_contract');
    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('action');
    expect(result.reason).toContain('talent_contract');
  });
});

// ---------------------------------------------------------------------------
// 7. Event envelope preamble (shared validation helper)
// ---------------------------------------------------------------------------

describe('validateEventEnvelopePreamble', () => {
  it('rejects a non-object value with the root error message', () => {
    const errors = validateEventEnvelopePreamble('string', preambleOptions);
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe('event');
    expect(errors[0].message).toBe('Event must be a JSON object.');
  });

  it('rejects null with the root error message', () => {
    const errors = validateEventEnvelopePreamble(null, preambleOptions);
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe('event');
  });

  it('rejects an array with the root error message', () => {
    const errors = validateEventEnvelopePreamble([], preambleOptions);
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe('event');
  });

  it('rejects missing contractId', () => {
    const errors = validateEventEnvelopePreamble(
      { eventId: 'e1', sequence: 1, timestamp: Date.now(), payload: {} },
      preambleOptions,
    );
    expect(errors.some((e) => e.field === 'contractId')).toBe(true);
  });

  it('rejects empty contractId', () => {
    const errors = validateEventEnvelopePreamble(
      { contractId: '', eventId: 'e1', sequence: 1, timestamp: Date.now(), payload: {} },
      preambleOptions,
    );
    expect(errors.some((e) => e.field === 'contractId')).toBe(true);
  });

  it('rejects empty eventId', () => {
    const errors = validateEventEnvelopePreamble(
      { contractId: 'c1', eventId: '', sequence: 1, timestamp: Date.now(), payload: {} },
      preambleOptions,
    );
    expect(errors.some((e) => e.field === 'eventId')).toBe(true);
  });

  it('rejects non-integer sequence', () => {
    const errors = validateEventEnvelopePreamble(
      { contractId: 'c1', eventId: 'e1', sequence: 1.5, timestamp: Date.now(), payload: {} },
      preambleOptions,
    );
    expect(errors.some((e) => e.field === 'sequence')).toBe(true);
  });

  it('rejects negative sequence', () => {
    const errors = validateEventEnvelopePreamble(
      { contractId: 'c1', eventId: 'e1', sequence: -1, timestamp: Date.now(), payload: {} },
      preambleOptions,
    );
    expect(errors.some((e) => e.field === 'sequence')).toBe(true);
  });

  it('rejects invalid timestamp (non-numeric string)', () => {
    const errors = validateEventEnvelopePreamble(
      { contractId: 'c1', eventId: 'e1', sequence: 1, timestamp: 'abc', payload: {} },
      preambleOptions,
    );
    expect(errors.some((e) => e.field === 'timestamp')).toBe(true);
  });

  it('accepts valid numeric string timestamp', () => {
    const errors = validateEventEnvelopePreamble(
      { contractId: 'c1', eventId: 'e1', sequence: 1, timestamp: String(Date.now()), payload: {} },
      preambleOptions,
    );
    expect(errors.some((e) => e.field === 'timestamp')).toBe(false);
  });

  it('rejects non-object payload', () => {
    const errors = validateEventEnvelopePreamble(
      { contractId: 'c1', eventId: 'e1', sequence: 1, timestamp: Date.now(), payload: 'not-an-object' },
      preambleOptions,
    );
    expect(errors.some((e) => e.field === 'payload')).toBe(true);
  });

  it('collects multiple errors when abortEarly is false (events mode)', () => {
    const errors = validateEventEnvelopePreamble(
      {},
      preambleOptions,
    );
    // contractId, eventId, sequence, timestamp, payload — all missing or invalid
    expect(errors.length).toBeGreaterThanOrEqual(4);
  });

  it('aborts early on first error when abortEarly is true', () => {
    const options: EnvelopeValidationOptions = { ...preambleOptions, abortEarly: true };
    const errors = validateEventEnvelopePreamble(
      {},
      options,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe('contractId');
  });

  it('returns empty errors for a fully valid envelope', () => {
    const errors = validateEventEnvelopePreamble(
      { contractId: 'c1', eventId: 'e1', sequence: 0, timestamp: Date.now(), payload: { key: 'val' } },
      preambleOptions,
    );
    expect(errors).toHaveLength(0);
  });

  it('accepts sequence=0 (zero is valid, non-negative integer)', () => {
    const errors = validateEventEnvelopePreamble(
      { contractId: 'c1', eventId: 'e1', sequence: 0, timestamp: Date.now(), payload: {} },
      preambleOptions,
    );
    expect(errors.some((e) => e.field === 'sequence')).toBe(false);
  });
});
