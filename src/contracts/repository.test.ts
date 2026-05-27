import { InMemoryContractEventRepository } from './repository';
import { PersistedContractEvent } from './types';

function createPersistedEvent(overrides: Partial<PersistedContractEvent> = {}): PersistedContractEvent {
  return {
    contractId: 'contract-1',
    eventId: 'event-1',
    sequence: 1,
    timestamp: '2026-03-24T00:00:00.000Z',
    type: 'CONTRACT_CREATED',
    payload: { amount: 100 },
    eventKey: 'contract-1:event-1:1',
    receivedAt: '2026-03-24T00:00:00.000Z',
    ...overrides,
  };
}

describe('InMemoryContractEventRepository', () => {
  it('stores and retrieves events', async () => {
    const repository = new InMemoryContractEventRepository();
    const event = createPersistedEvent();

    await repository.saveEvent(event);

    await expect(repository.hasEventKey(event.eventKey)).resolves.toBe(true);
    await expect(repository.listEvents()).resolves.toEqual([event]);
  });

  it('overwrites existing event when same key is saved', async () => {
    const repository = new InMemoryContractEventRepository();

    await repository.saveEvent(createPersistedEvent({ payload: { version: 1 } }));
    await repository.saveEvent(createPersistedEvent({ payload: { version: 2 } }));

    const events = await repository.listEvents();
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({ version: 2 });
  });
});