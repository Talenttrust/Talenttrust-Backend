import { validateContractEventPayload } from './validation';

function createValidPayload(overrides: Record<string, unknown> = {}) {
  return {
    contractId: 'contract-1',
    eventId: 'event-1',
    sequence: 1,
    timestamp: '2026-03-24T00:00:00.000Z',
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
    }
  });

  it('rejects non-object payloads', () => {
    const result = validateContractEventPayload('nope');

    expect(result).toEqual({ ok: false, reason: 'Payload must be a JSON object' });
  });

  it('rejects missing contract id', () => {
    const result = validateContractEventPayload(createValidPayload({ contractId: '' }));

    expect(result).toEqual({ ok: false, reason: 'contractId is required' });
  });

  it('rejects invalid sequence', () => {
    const result = validateContractEventPayload(createValidPayload({ sequence: -1 }));

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
});