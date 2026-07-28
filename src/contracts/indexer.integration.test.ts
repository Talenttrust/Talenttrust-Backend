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
    
    // Assert cursor is updated to max sequence
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

    // First index
    const result1 = await indexer.indexBatch(sourceId, events);
    expect(result1.processedCount).toBe(2);

    // Replay identical batch
    const result2 = await indexer.indexBatch(sourceId, events);
    
    expect(result2.processedCount).toBe(0);
    expect(result2.duplicateCount).toBe(2);
    expect(result2.errors).toHaveLength(0);

    // Cursor should remain stable
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

    // Valid events are processed
    expect(result.processedCount).toBe(2);
    expect(result.duplicateCount).toBe(0);
    
    // Malformed are captured
    expect(result.errors.length).toBe(2);
    
    // Cursor updates to highest valid sequence
    expect(result.newCursor).toBeDefined();
    expect(result.newCursor!.lastSequence).toBe(12);
  });

  describe('Edge Cases', () => {
    it('handles empty batch correctly', async () => {
      const result = await indexer.indexBatch(sourceId, []);

      expect(result.processedCount).toBe(0);
      expect(result.duplicateCount).toBe(0);
      expect(result.errors).toHaveLength(0);
      expect(result.newCursor).toBeUndefined();
    });

    it('handles all-duplicate batch correctly', async () => {
      const event = createValidEvent({ eventId: 'e1', sequence: 1 });
      await indexer.indexBatch(sourceId, [event]);

      // All duplicates
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
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.newCursor!.lastSequence).toBe(12);
    });
  });
});
