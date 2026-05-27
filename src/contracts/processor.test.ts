import { ContractEventProcessor } from './processor';
import { ContractEventRepository } from './repository';
import { PersistedContractEvent } from './types';

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

class MemoryRepo implements ContractEventRepository {
  private readonly events: PersistedContractEvent[] = [];

  async hasEventKey(eventKey: string): Promise<boolean> {
    return this.events.some((event) => event.eventKey === eventKey);
  }

  async saveEvent(event: PersistedContractEvent): Promise<void> {
    this.events.push(event);
  }

  async listEvents(): Promise<PersistedContractEvent[]> {
    return this.events;
  }
}

describe('ContractEventProcessor', () => {
  it('accepts and persists valid events', async () => {
    const repository = new MemoryRepo();
    const processor = new ContractEventProcessor(repository);

    const result = await processor.ingest(createValidPayload());

    expect(result.status).toBe('accepted');
    expect(result.eventKey).toBe('contract-1:event-1:1');
    await expect(processor.listEvents()).resolves.toHaveLength(1);
  });

  it('returns duplicate for replayed events', async () => {
    const repository = new MemoryRepo();
    const processor = new ContractEventProcessor(repository);
    const payload = createValidPayload();

    await processor.ingest(payload);
    const duplicate = await processor.ingest(payload);

    expect(duplicate).toEqual({ status: 'duplicate', eventKey: 'contract-1:event-1:1' });
    await expect(processor.listEvents()).resolves.toHaveLength(1);
  });

  it('rejects invalid payloads', async () => {
    const repository = new MemoryRepo();
    const processor = new ContractEventProcessor(repository);

    const result = await processor.ingest({});

    expect(result.status).toBe('invalid');
    await expect(processor.listEvents()).resolves.toHaveLength(0);
  });

  it('propagates persistence failures', async () => {
    const repository: ContractEventRepository = {
      hasEventKey: async () => false,
      saveEvent: async () => {
        throw new Error('storage error');
      },
      listEvents: async () => [],
    };
    const processor = new ContractEventProcessor(repository);

    await expect(processor.ingest(createValidPayload())).rejects.toThrow('storage error');
  });
});