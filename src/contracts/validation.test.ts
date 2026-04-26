import { validateContractEventPayload, validateContractEventPayloadLenient } from './validation';

function createValidPayload(overrides: Record<string, unknown> = {}) {
  return {
    contractId: 'contract-1',
    eventId: 'event-1',
    sequence: 1,
    timestamp: new Date().toISOString(),
    type: 'CONTRACT_CREATED',
    payload: { amount: 100 },
    ...overrides,
  };
}

describe('validateContractEventPayload', () => {
  it('accepts a valid payload', () => {
    const result = validateContractEventPayload(createValidPayload());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.contractId).toBe('contract-1');
      expect(result.event.type).toBe('CONTRACT_CREATED');
      expect(result.event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
  });

  it('rejects non-object payloads', () => {
    const result = validateContractEventPayload('nope');

    expect(result).toEqual({ ok: false, reason: 'Payload must be a JSON object' });
  });

  it('rejects null payloads', () => {
    const result = validateContractEventPayload(null);

    expect(result).toEqual({ ok: false, reason: 'Payload must be a JSON object' });
  });

  it('rejects array payloads', () => {
    const result = validateContractEventPayload([]);

    expect(result).toEqual({ ok: false, reason: 'Payload must be a JSON object' });
  });

  it('rejects missing contract id', () => {
    const result = validateContractEventPayload(createValidPayload({ contractId: '' }));

    expect(result).toEqual({ ok: false, reason: 'contractId is required' });
  });

  it('rejects whitespace-only contract id', () => {
    const result = validateContractEventPayload(createValidPayload({ contractId: '   ' }));

    expect(result).toEqual({ ok: false, reason: 'contractId is required' });
  });

  it('rejects missing event id', () => {
    const result = validateContractEventPayload(createValidPayload({ eventId: '' }));

    expect(result).toEqual({ ok: false, reason: 'eventId is required' });
  });

  it('rejects invalid sequence (negative)', () => {
    const result = validateContractEventPayload(createValidPayload({ sequence: -1 }));

    expect(result).toEqual({ ok: false, reason: 'sequence must be a non-negative integer' });
  });

  it('rejects invalid sequence (decimal)', () => {
    const result = validateContractEventPayload(createValidPayload({ sequence: 1.5 }));

    expect(result).toEqual({ ok: false, reason: 'sequence must be a non-negative integer' });
  });

  it('rejects invalid timestamp', () => {
    const result = validateContractEventPayload(createValidPayload({ timestamp: 'invalid-date' }));

    expect(result).toEqual({ ok: false, reason: 'timestamp must be a valid ISO string' });
  });

  it('rejects unsupported type', () => {
    const result = validateContractEventPayload(createValidPayload({ type: 'SOMETHING_ELSE' }));

    expect(result).toEqual({ ok: false, reason: 'type is invalid' });
  });

  it('rejects non-object event payload', () => {
    const result = validateContractEventPayload(createValidPayload({ payload: 'bad' }));

    expect(result).toEqual({ ok: false, reason: 'payload must be an object' });
  });

  it('rejects null event payload', () => {
    const result = validateContractEventPayload(createValidPayload({ payload: null }));

    expect(result).toEqual({ ok: false, reason: 'payload must be an object' });
  });

  it('rejects array event payload', () => {
    const result = validateContractEventPayload(createValidPayload({ payload: [] }));

    expect(result).toEqual({ ok: false, reason: 'payload must be an object' });
  });

  it('rejects contractId with invalid characters', () => {
    const result = validateContractEventPayload(createValidPayload({ contractId: 'contract@1' }));

    expect(result).toEqual({ ok: false, reason: 'contractId contains invalid characters' });
  });

  it('rejects eventId with invalid characters', () => {
    const result = validateContractEventPayload(createValidPayload({ eventId: 'event@1' }));

    expect(result).toEqual({ ok: false, reason: 'eventId contains invalid characters' });
  });

  it('rejects contractId that is too long', () => {
    const longId = 'a'.repeat(256);
    const result = validateContractEventPayload(createValidPayload({ contractId: longId }));

    expect(result).toEqual({ ok: false, reason: 'contractId too long (max 255 characters)' });
  });

  it('rejects eventId that is too long', () => {
    const longId = 'a'.repeat(256);
    const result = validateContractEventPayload(createValidPayload({ eventId: longId }));

    expect(result).toEqual({ ok: false, reason: 'eventId too long (max 255 characters)' });
  });

  it('rejects timestamp too far in future', () => {
    const futureTime = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minutes ahead
    const result = validateContractEventPayload(createValidPayload({ timestamp: futureTime }));

    expect(result).toEqual({ ok: false, reason: 'timestamp is too far in the future' });
  });

  it('rejects timestamp too old', () => {
    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25 hours ago
    const result = validateContractEventPayload(createValidPayload({ timestamp: oldTime }));

    expect(result).toEqual({ ok: false, reason: 'timestamp is too old' });
  });

  it('rejects payload too large', () => {
    const largePayload = { data: 'x'.repeat(11 * 1024) }; // > 10KB
    const result = validateContractEventPayload(createValidPayload({ payload: largePayload }));

    expect(result).toEqual({ ok: false, reason: 'payload too large (max 10KB)' });
  });

  it('accepts valid contractId with hyphens and underscores', () => {
    const result = validateContractEventPayload(createValidPayload({ contractId: 'contract-1_test' }));

    expect(result.ok).toBe(true);
  });

  it('accepts valid eventId with hyphens and underscores', () => {
    const result = validateContractEventPayload(createValidPayload({ eventId: 'event-1_test' }));

    expect(result.ok).toBe(true);
  });

  it('trims whitespace from contractId and eventId', () => {
    const result = validateContractEventPayload(createValidPayload({ 
      contractId: '  contract-1  ', 
      eventId: '  event-1  ' 
    }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.contractId).toBe('contract-1');
      expect(result.event.eventId).toBe('event-1');
    }
  });

  it('normalizes timestamp to ISO format', () => {
    const timestamp = '2026-03-24T00:00:00+00:00';
    const result = validateContractEventPayload(createValidPayload({ timestamp }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
  });

  it('accepts all valid event types', () => {
    const validTypes = ['CONTRACT_CREATED', 'CONTRACT_FUNDED', 'CONTRACT_COMPLETED', 'CONTRACT_CANCELLED'];
    
    validTypes.forEach(type => {
      const result = validateContractEventPayload(createValidPayload({ type }));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.event.type).toBe(type);
      }
    });
  });
});

describe('validateContractEventPayloadLenient', () => {
  it('accepts valid payload without strict validations', () => {
    const result = validateContractEventPayloadLenient(createValidPayload());

    expect(result.ok).toBe(true);
  });

  it('accepts contractId with invalid characters in lenient mode', () => {
    const result = validateContractEventPayloadLenient(createValidPayload({ contractId: 'contract@1' }));

    expect(result.ok).toBe(true);
  });

  it('accepts eventId with invalid characters in lenient mode', () => {
    const result = validateContractEventPayloadLenient(createValidPayload({ eventId: 'event@1' }));

    expect(result.ok).toBe(true);
  });

  it('accepts timestamp far in future in lenient mode', () => {
    const futureTime = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const result = validateContractEventPayloadLenient(createValidPayload({ timestamp: futureTime }));

    expect(result.ok).toBe(true);
  });

  it('accepts timestamp too old in lenient mode', () => {
    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const result = validateContractEventPayloadLenient(createValidPayload({ timestamp: oldTime }));

    expect(result.ok).toBe(true);
  });

  it('accepts large payload in lenient mode', () => {
    const largePayload = { data: 'x'.repeat(11 * 1024) };
    const result = validateContractEventPayloadLenient(createValidPayload({ payload: largePayload }));

    expect(result.ok).toBe(true);
  });

  it('still rejects basic validation errors in lenient mode', () => {
    const result = validateContractEventPayloadLenient('nope');

    expect(result).toEqual({ ok: false, reason: 'Payload must be a JSON object' });
  });

  it('still rejects missing required fields in lenient mode', () => {
    const result = validateContractEventPayloadLenient(createValidPayload({ contractId: '' }));

    expect(result).toEqual({ ok: false, reason: 'contractId is required' });
  });
});