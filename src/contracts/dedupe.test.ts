import { buildEventKey } from './dedupe';
import { ContractEvent } from './types';

describe('buildEventKey', () => {
  it('builds a deterministic key from identity fields', () => {
    const event: ContractEvent = {
      contractId: 'contract-1',
      eventId: 'event-10',
      sequence: 42,
      timestamp: '2026-03-24T00:00:00.000Z',
      type: 'CONTRACT_FUNDED',
      payload: { amount: 100 },
    };

    expect(buildEventKey(event)).toBe('contract-1:event-10:42');
  });
});