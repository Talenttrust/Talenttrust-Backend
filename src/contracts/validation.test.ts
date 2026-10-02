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

  describe('on-chain attribution (network/ledger)', () => {
    it('passes through valid network and ledger', () => {
      const result = validateContractEventPayload(
        createValidPayload({ network: 'soroban', ledger: 100 }),
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.event.network).toBe('soroban');
        expect(result.event.ledger).toBe(100);
      }
    });

    it('omits the fields when absent (off-chain event)', () => {
      const result = validateContractEventPayload(createValidPayload());

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.event.network).toBeUndefined();
        expect(result.event.ledger).toBeUndefined();
      }
    });

    it('trims network values', () => {
      const result = validateContractEventPayload(
        createValidPayload({ network: '  soroban  ' }),
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.event.network).toBe('soroban');
      }
    });

    it('rejects an invalid ledger (fail-closed, never downgraded to off-chain)', () => {
      for (const ledger of [-1, 1.5, '100', NaN]) {
        const result = validateContractEventPayload(createValidPayload({ ledger }));
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe('ledger must be a non-negative integer');
        }
      }
    });

    it('rejects an invalid network (fail-closed)', () => {
      for (const network of ['', '   ', 42]) {
        const result = validateContractEventPayload(createValidPayload({ network }));
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe('network must be a non-empty string');
        }
      }
    });
  });

  describe('boundary and duplicate handling', () => {
    it('accepts sequence 0 as the lower boundary', () => {
      const result = validateContractEventPayload(createValidPayload({ sequence: 0 }));

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.event.sequence).toBe(0);
      }
    });

    it('accepts ledger 0 as the lower boundary', () => {
      const result = validateContractEventPayload(
        createValidPayload({ network: 'soroban', ledger: 0 }),
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.event.ledger).toBe(0);
      }
    });

    it('rejects non-integer sequence values', () => {
      for (const sequence of [1.5, '1', NaN, Infinity, -Infinity]) {
        const result = validateContractEventPayload(createValidPayload({ sequence }));
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe('sequence must be a non-negative integer');
        }
      }
    });

    it('rejects missing or empty event id', () => {
      for (const eventId of [undefined, '', '   ', 42]) {
        const result = validateContractEventPayload(createValidPayload({ eventId }));
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe('eventId is required');
        }
      }
    });

    it('rejects missing or non-object payload', () => {
      for (const payload of [undefined, null, 'bad', 42, []]) {
        const result = validateContractEventPayload(createValidPayload({ payload }));
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe('payload must be an object');
        }
      }
    });

    it('rejects an invalid timestamp boundary', () => {
      for (const timestamp of ['', 'not-a-date', '2026-13-45T00:00:00.000Z', 42]) {
        const result = validateContractEventPayload(createValidPayload({ timestamp }));
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe('timestamp must be a valid ISO string');
        }
      }
    });

    it('rejects unknown types fail-closed', () => {
      for (const type of ['unknown', '', 42, null]) {
        const result = validateContractEventPayload(createValidPayload({ type }));
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe('type is invalid');
        }
      }
    });

    it('rejects duplicate event ids in a single batch', () => {
      const first = validateContractEventPayload(createValidPayload());
      const second = validateContractEventPayload(createValidPayload());

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (first.ok && second.ok) {
        expect(first.event.eventId).toBe(second.event.eventId);
      }
    });

    it('rejects duplicate sequences within the same contract', () => {
      const a = validateContractEventPayload(createValidPayload({ sequence: 7 }));
      const b = validateContractEventPayload(
        createValidPayload({ eventId: 'event-2', sequence: 7 }),
      );

      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
      if (a.ok && b.ok) {
        expect(a.event.sequence).toBe(b.event.sequence);
        expect(a.event.contractId).toBe(b.event.contractId);
      }
    });
  });
});
