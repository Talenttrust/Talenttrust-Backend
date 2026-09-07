import { ContractEventIndexer } from './indexer';
import { ContractEventProcessor } from './processor';
import { InMemoryCursorRepository } from './cursor.repository';
import { InMemoryContractEventRepository } from './repository';

function createValidEvent(overrides: Record<string, unknown> = {}) {
  return {
    contractId: 'contract-integration-1',
    eventId: `event-${Math.random().toString(36).substring(7)}`,
    sequence: 1,
    timestamp: new Date().toISOString(),
    type: 'CONTRACT_CREATED',
    payload: { status: 'active' },
    ...overrides,
  };
}

describe('ContractEventIndexer Integration (Replay & Cursor Pagination)', () => {
  let indexer: ContractEventIndexer;
  let eventProcessor: ContractEventProcessor;
  let cursorRepository: InMemoryCursorRepository;
  let eventRepository: InMemoryContractEventRepository;
  const sourceId = 'integration-source-1';

  beforeEach(() => {
    eventRepository = new InMemoryContractEventRepository();
    eventProcessor = new ContractEventProcessor(eventRepository);
    cursorRepository = new InMemoryCursorRepository();
    indexer = new ContractEventIndexer(eventProcessor, cursorRepository);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('indexes a batch, updates cursor, and reports correct counts', async () => {
    const events = [
      createValidEvent({ eventId: 'e1', sequence: 10 }),
      createValidEvent({ eventId: 'e2', sequence: 11 }),
      createValidEvent({ eventId: 'e3', sequence: 12 }),
    ];

    const result = await indexer.indexBatch(sourceId, events);

    expect(result.processedCount).toBe(3);
    expect(result.duplicateCount).toBe(0);
    expect(result.errors).toHaveLength(0);
    
    expect(result.newCursor).toBeDefined();
    expect(result.newCursor!.lastSequence).toBe(12);

    const storedCursor = await cursorRepository.getCursor(sourceId);
    expect(storedCursor).toBeDefined();
    expect(storedCursor!.lastSequence).toBe(12);
  });

  it('re-indexing the identical batch yields 0 processed, tracking duplicates', async () => {
    const events = [
      createValidEvent({ eventId: 'e1', sequence: 10 }),
      createValidEvent({ eventId: 'e2', sequence: 11 }),
    ];

    const result1 = await indexer.indexBatch(sourceId, events);
    expect(result1.processedCount).toBe(2);

    const result2 = await indexer.indexBatch(sourceId, events);
    
    expect(result2.processedCount).toBe(0);
    expect(result2.duplicateCount).toBe(2);
    expect(result2.errors).toHaveLength(0);

    expect(result2.newCursor).toBeDefined();
    expect(result2.newCursor!.lastSequence).toBe(11);
  });

  it('indexing a partially-overlapping next batch processes only new events', async () => {
    const batch1 = [
      createValidEvent({ eventId: 'e1', sequence: 10 }),
      createValidEvent({ eventId: 'e2', sequence: 11 }),
    ];

    await indexer.indexBatch(sourceId, batch1);

    const batch2 = [
      createValidEvent({ eventId: 'e2', sequence: 11 }), // duplicate
      createValidEvent({ eventId: 'e3', sequence: 12 }), // new
      createValidEvent({ eventId: 'e4', sequence: 13 }), // new
    ];

    const result = await indexer.indexBatch(sourceId, batch2);

    expect(result.processedCount).toBe(2);
    expect(result.duplicateCount).toBe(1);
    expect(result.errors).toHaveLength(0);
    
    expect(result.newCursor).toBeDefined();
    expect(result.newCursor!.lastSequence).toBe(13);
  });

  it('handles malformed events gracefully, surfacing them in errors without aborting', async () => {
    const events = [
      createValidEvent({ eventId: 'e1', sequence: 10 }),
      { invalid: 'schema missing fields' }, // malformed
      null, // extremely malformed
      createValidEvent({ eventId: 'e2', sequence: 12 }),
    ];

    const result = await indexer.indexBatch(sourceId, events);

    expect(result.processedCount).toBe(2);
    expect(result.duplicateCount).toBe(0);
    expect(result.errors.length).toBe(2);
    
    expect(result.newCursor).toBeDefined();
    expect(result.newCursor!.lastSequence).toBe(12);
  });

  describe('Edge Cases', () => {
    it('handles empty batch correctly', async () => {
      const result = await indexer.indexBatch(sourceId, []);

      expect(result.processedCount).toBe(0);
      expect(result.duplicateCount).toBe(0);
      expect(result.errors).toHaveLength(0);
      expect(result.newCursor).toNull();
    });

    it('handles all-duplicate batch correctly', async () => {
      const event = createValidEvent({ eventId: 'e1', sequence: 1 });
      await indexer.indexBatch(sourceId, [event]);

      const result = await indexer.indexBatch(sourceId, [event, event]);

      expect(result.processedCount).toBe(0);
      expect(result.duplicateCount).toBe(2);
      expect(result.errors).toHaveLength(0);
      expect(result.newCursor!.lastSequence).toBe(1);
    });

    it('processes valid events successfully if one event fails processing syntactically', async () => {
      const batch = [
        createValidEvent({ eventId: 'e1', sequence: 10 }),
        { contractId: 'c1', type: 'INVALID_TYPE' }, // Missing required valid fields to pass ingestion
        createValidEvent({ eventId: 'e2', sequence: 12 }),
      ];

      const result = await indexer.indexBatch(sourceId, batch);

      expect(result.processedCount).toBe(2);
      expect(result.errors.length).toBe(GreaterThan(0));
      expect(result.newCursor!.lastSequence).toBe(12);
    });
  });

  describe('Checkpoint Persistence per Contract Network', () => {
    const networkSourceId = 'testnet:contract-integration-1:events';
    const otherNetworkSourceId = 'mainnet:contract-integration-1:events';

    it('creates a first checkpoint for a new network/contract/ledger', async () => {
      const events = [createValidEvent({ eventId: 'first', sequence: 5 })];

      const result = await indexer.indexBatch(networkSourceId, events);

      expect(result.newCursor).toBeDefined();
      expect(result.newCursor!.network).toBe('testnet');
      expect(result.newCursor!.contract).toBe('contract-integration-1');
      expect(result.newCursor!.ledger).toBe('events');
      expect(result.newCursor!.lastSequence).toBe(5);

      const stored = await cursorRepository.getCursor(networkSourceId);
      expect(stored).not.toBeNull();
      expect(stored!.lastSequence).toBe(5);
    });

    it('advances after a restart with an already committed event (idempotent resume)', async () => {
      const events = [
        createValidEvent({ eventId: 'e1', sequence: 10 }),
        createValidEvent({ eventId: 'e2', sequence: 11 }),
      ];
      await indexer.indexBatch(networkSourceId, events);

      const restartedIndexer = new ContractEventIndexer(eventProcessor, cursorRepository);

      const replay = [events[1], createValidEvent({ eventId: 'e3', sequence: 12 })];
      const result = await restartedIndexer.indexBatch(networkSourceId, replay);

      expect(result.processedCount).toBe(1);
      expect(result.duplicateCount).toBe(1);
      expect(result.newCursor!.lastSequence).toBe(12);
    });

    it('does not advance the checkpoint when a projection write fails', async () => {
      const events = [createValidEvent({ eventId: 'fail', sequence: 7 })];

      jest.spyOn(eventRepository, 'saveEvent').mockRejectedOnce(new Error('simulated write failure'));

      const result = await indexer.indexBatch(networkSourceId, events);

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].reason).toContain('simulated write failure');
      expect(result.newCursor).toNull();

      const stored = await cursorRepository.getCursor(networkSourceId);
      expect(stored).toNull();
    });

    it('tracks checkpoints for two networks independently', async () => {
      await indexer.indexBatch(networkSourceId, [createValidEvent({ eventId: 'a1', sequence: 1 })]);
      await indexer.indexBatch(otherNetworkSourceId, [createValidEvent({ eventId: 'b1', sequence: 1 })]);

      await indexer.indexBatch(networkSourceId, [createValidEvent({ eventId: 'a2', sequence: 2 })]);
      await indexer.indexBatch(otherNetworkSourceId, [createValidEvent({ eventId: 'b2', sequence: 2 })]);

      const cursorA = await cursorRepository.getCursor(networkSourceId);
      const cursorB = await cursorRepository.getCursor(otherNetworkSourceId);

      expect(cursorA!.lastSequence).toBe(2);
      expect(cursorB!.lastSequence).toBe(2);

      await indexer.indexBatch(networkSourceId, [createValidEvent({ eventId: 'a3', sequence: 3 })]);

      const afterA = await cursorRepository.getCursor(networkSourceId);
      const afterB = await cursorRepository.getCursor(otherNetworkSourceId);

      expect(afterA!.lastSequence).toBe(3);
      expect(afterB!.lastSequence).toBe(2);
    });

    it('does not regress when checkpoint is ahead of the available ledger', async () => {
      await cursorRepository.updateCursor(networkSourceId, 20);

      const events = [createValidEvent({ eventId: 'e1', sequence: 1 })];
      const result = await indexer.indexBatch(networkSourceId, events);

      expect(result.processedCount).toBe(1);
      expect(result.newCursor!.lastSequence).toBe(20);
      expect(result.newCursor!.network).toBe('testnet');
    });
  });
});
