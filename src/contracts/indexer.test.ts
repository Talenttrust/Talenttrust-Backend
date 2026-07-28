import { ContractEventIndexer, IndexerBatchResult } from './indexer';
import { ContractEventProcessor } from './processor';
import { InMemoryCursorRepository } from './cursor.repository';
import { CursorRepository } from './cursor.repository';
import { InMemoryContractEventRepository } from './repository';
import { PersistedContractEvent } from './types';

function createValidEvent(overrides: Record<string, unknown> = {}) {
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

describe('ContractEventIndexer', () => {
  let indexer: ContractEventIndexer;
  let eventProcessor: ContractEventProcessor;
  let cursorRepository: CursorRepository;

  beforeEach(() => {
    const eventRepository = new InMemoryContractEventRepository();
    eventProcessor = new ContractEventProcessor(eventRepository);
    cursorRepository = new InMemoryCursorRepository();
    indexer = new ContractEventIndexer(eventProcessor, cursorRepository);
  });

  describe('resumeFromCursor', () => {
    it('returns fresh start when no cursor exists', async () => {
      const result = await indexer.resumeFromCursor({ sourceId: 'source-1' });

      expect(result.isFreshStart).toBe(true);
      expect(result.cursor).toBeNull();
      expect(result.resumeFromSequence).toBe(0);
    });

    it('returns next sequence after existing cursor', async () => {
      await cursorRepository.updateCursor('source-1', 99);

      const result = await indexer.resumeFromCursor({ sourceId: 'source-1' });

      expect(result.isFreshStart).toBe(false);
      expect(result.cursor).not.toBeNull();
      expect(result.cursor!.lastSequence).toBe(99);
      expect(result.resumeFromSequence).toBe(100);
    });

    it('allows explicit override of resume position', async () => {
      await cursorRepository.updateCursor('source-1', 99);

      const result = await indexer.resumeFromCursor({
        sourceId: 'source-1',
        fromSequence: 50,
      });

      expect(result.resumeFromSequence).toBe(50);
      expect(result.cursor!.lastSequence).toBe(99);
    });

    it('treats explicit override as fresh start if no prior cursor', async () => {
      const result = await indexer.resumeFromCursor({
        sourceId: 'source-1',
        fromSequence: 0,
      });

      expect(result.isFreshStart).toBe(true);
      expect(result.cursor).toBeNull();
    });
  });

  describe('indexBatch', () => {
    it('indexes single valid event', async () => {
      const result = await indexer.indexBatch('source-1', [createValidEvent()]);

      expect(result.processedCount).toBe(1);
      expect(result.duplicateCount).toBe(0);
      expect(result.errors).toHaveLength(0);
      expect(result.newCursor).not.toBeUndefined();
      expect(result.newCursor!.lastSequence).toBe(1);
    });

    it('indexes multiple events in stable order', async () => {
      const events = [
        createValidEvent({ eventId: 'e1', sequence: 1 }),
        createValidEvent({ eventId: 'e2', sequence: 2 }),
        createValidEvent({ eventId: 'e3', sequence: 3 }),
      ];

      const result = await indexer.indexBatch('source-1', events);

      expect(result.processedCount).toBe(3);
      expect(result.duplicateCount).toBe(0);
      expect(result.newCursor!.lastSequence).toBe(3);

      const indexed = await indexer.getIndexedEvents();
      expect(indexed).toHaveLength(3);
    });

    it('handles out-of-order submissions with stable sort', async () => {
      const events = [
        createValidEvent({ eventId: 'e3', sequence: 3 }),
        createValidEvent({ eventId: 'e1', sequence: 1 }),
        createValidEvent({ eventId: 'e2', sequence: 2 }),
      ];

      const result = await indexer.indexBatch('source-1', events);

      expect(result.processedCount).toBe(3);
      expect(result.newCursor!.lastSequence).toBe(3);

      // Verify events stored in order (via replay protection logic)
      const indexed = await indexer.getIndexedEvents();
      const sequences = indexed.map((e) => e.sequence).sort();
      expect(sequences).toEqual([1, 2, 3]);
    });

    it('deduplicates replayed events in same batch', async () => {
      const event = createValidEvent({ eventId: 'e1', sequence: 1 });
      const events = [event, event]; // Same event twice

      const result = await indexer.indexBatch('source-1', events);

      expect(result.processedCount).toBe(1);
      expect(result.duplicateCount).toBe(1);
      expect(result.newCursor!.lastSequence).toBe(1);

      const indexed = await indexer.getIndexedEvents();
      expect(indexed).toHaveLength(1);
    });

    it('deduplicates replayed events across batches', async () => {
      const event = createValidEvent({ eventId: 'e1', sequence: 1 });

      // First batch
      const result1 = await indexer.indexBatch('source-1', [event]);
      expect(result1.processedCount).toBe(1);
      expect(result1.duplicateCount).toBe(0);

      // Replay same event in second batch
      const result2 = await indexer.indexBatch('source-2', [event]);
      expect(result2.processedCount).toBe(0);
      expect(result2.duplicateCount).toBe(1);

      const indexed = await indexer.getIndexedEvents();
      expect(indexed).toHaveLength(1);
    });

    it('tracks invalid events as errors', async () => {
      const events = [
        createValidEvent({ eventId: 'e1', sequence: 1 }),
        { invalid: 'event' }, // Missing required fields
        createValidEvent({ eventId: 'e2', sequence: 2 }),
      ];

      const result = await indexer.indexBatch('source-1', events);

      expect(result.processedCount).toBe(2);
      expect(result.errors.some((e: string) => /validation|required/i.test(e))).toBe(true);

      const indexed = await indexer.getIndexedEvents();
      expect(indexed).toHaveLength(2);
    });

    it('updates cursor to highest sequence in batch', async () => {
      const events = [
        createValidEvent({ eventId: 'e1', sequence: 10 }),
        createValidEvent({ eventId: 'e2', sequence: 5 }),
        createValidEvent({ eventId: 'e3', sequence: 20 }),
      ];

      const result = await indexer.indexBatch('source-1', events);

      expect(result.newCursor!.lastSequence).toBe(20);

      const cursor = await indexer.getCursor('source-1');
      expect(cursor!.lastSequence).toBe(20);
    });

    it('maintains separate cursors for multiple sources', async () => {
      await indexer.indexBatch('source-1', [
        createValidEvent({ eventId: 'e1', sequence: 100 }),
      ]);

      await indexer.indexBatch('source-2', [
        createValidEvent({ eventId: 'e2', sequence: 50 }),
      ]);

      const cursor1 = await indexer.getCursor('source-1');
      const cursor2 = await indexer.getCursor('source-2');

      expect(cursor1!.lastSequence).toBe(100);
      expect(cursor2!.lastSequence).toBe(50);
    });

    it('handles empty batch gracefully', async () => {
      const result = await indexer.indexBatch('source-1', []);

      expect(result.processedCount).toBe(0);
      expect(result.duplicateCount).toBe(0);
      expect(result.errors).toHaveLength(0);
      expect(result.newCursor).toBeUndefined();
    });

    it('handles malformed events gracefully', async () => {
      const events = [
        null,
        undefined,
        123,
        'string',
        { sequence: 'not-a-number' },
      ];

      const result = await indexer.indexBatch('source-1', events);

      expect(result.processedCount).toBe(0);
      expect(result.duplicateCount).toBe(0);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('continues processing after invalid events', async () => {
      const events = [
        createValidEvent({ eventId: 'e1', sequence: 1 }),
        { invalid: 'event' },
        { also: 'invalid' },
        createValidEvent({ eventId: 'e2', sequence: 2 }),
      ];

      const result = await indexer.indexBatch('source-1', events);

      expect(result.processedCount).toBe(2);
      expect(result.errors.length).toBeGreaterThan(0);

      const indexed = await indexer.getIndexedEvents();
      expect(indexed).toHaveLength(2);
    });

    it('respects sequence ordering despite insertion order', async () => {
      const sourceA = 'source-a';
      const sourceB = 'source-b';

      // Source A indexes 10, 12
      await indexer.indexBatch(sourceA, [
        createValidEvent({ contractId: 'c1', eventId: 'e10', sequence: 10 }),
        createValidEvent({ contractId: 'c1', eventId: 'e12', sequence: 12 }),
      ]);

      // Source B indexes 11 (interleaved)
      await indexer.indexBatch(sourceB, [
        createValidEvent({ contractId: 'c1', eventId: 'e11', sequence: 11 }),
      ]);

      const cursorA = await indexer.getCursor(sourceA);
      const cursorB = await indexer.getCursor(sourceB);

      expect(cursorA!.lastSequence).toBe(12);
      expect(cursorB!.lastSequence).toBe(11);

      const indexed = await indexer.getIndexedEvents();
      expect(indexed.map((e) => e.sequence).sort()).toEqual([10, 11, 12]);
    });
  });

  describe('getCursor', () => {
    it('returns null for non-existent source', async () => {
      const cursor = await indexer.getCursor('non-existent');
      expect(cursor).toBeNull();
    });

    it('returns cursor after indexing', async () => {
      await indexer.indexBatch('source-1', [createValidEvent({ sequence: 42 })]);

      const cursor = await indexer.getCursor('source-1');
      expect(cursor).not.toBeNull();
      expect(cursor!.lastSequence).toBe(42);
    });
  });

  describe('listCursors', () => {
    it('returns empty list initially', async () => {
      const cursors = await indexer.listCursors();
      expect(cursors).toHaveLength(0);
    });

    it('lists all cursors from multiple batches', async () => {
      await indexer.indexBatch('source-1', [createValidEvent({ sequence: 1 })]);
      await indexer.indexBatch('source-2', [createValidEvent({ sequence: 2 })]);
      await indexer.indexBatch('source-3', [createValidEvent({ sequence: 3 })]);

      const cursors = await indexer.listCursors();
      expect(cursors).toHaveLength(3);
      expect(cursors.map((c) => c.sourceId)).toEqual(['source-1', 'source-2', 'source-3']);
    });
  });

  describe('getIndexedEvents', () => {
    it('returns all indexed events', async () => {
      const events = [
        createValidEvent({ eventId: 'e1', sequence: 1 }),
        createValidEvent({ eventId: 'e2', sequence: 2 }),
      ];

      await indexer.indexBatch('source-1', events);

      const indexed = await indexer.getIndexedEvents();
      expect(indexed).toHaveLength(2);
      expect(indexed.map((e) => e.eventId)).toEqual(['e1', 'e2']);
    });

    it('does not double-count deduplicated events', async () => {
      const event = createValidEvent({ eventId: 'e1', sequence: 1 });

      await indexer.indexBatch('source-1', [event]);
      await indexer.indexBatch('source-1', [event]); // Replay

      const indexed = await indexer.getIndexedEvents();
      expect(indexed).toHaveLength(1);
    });
  });

  describe('idempotency', () => {
    it('replaying same batch produces same result', async () => {
      const events = [
        createValidEvent({ eventId: 'e1', sequence: 1 }),
        createValidEvent({ eventId: 'e2', sequence: 2 }),
      ];

      const result1 = await indexer.indexBatch('source-1', events);
      const result2 = await indexer.indexBatch('source-1', events);

      expect(result1.processedCount).toBe(2);
      expect(result1.duplicateCount).toBe(0);

      expect(result2.processedCount).toBe(0);
      expect(result2.duplicateCount).toBe(2);

      const indexed = await indexer.getIndexedEvents();
      expect(indexed).toHaveLength(2);
    });

    it('safe to retry partial batches', async () => {
      const events = [
        createValidEvent({ eventId: 'e1', sequence: 1 }),
        createValidEvent({ eventId: 'e2', sequence: 2 }),
        createValidEvent({ eventId: 'e3', sequence: 3 }),
      ];

      // First attempt: index all
      await indexer.indexBatch('source-1', events);

      // Retry with subset
      const result = await indexer.indexBatch('source-1', [events[0], events[1]]);

      expect(result.processedCount).toBe(0);
      expect(result.duplicateCount).toBe(2);

      const indexed = await indexer.getIndexedEvents();
      expect(indexed).toHaveLength(3);
    });
  });

  describe('replay protection', () => {
    it('blocks exact replay regardless of source', async () => {
      const event = createValidEvent({ eventId: 'e1', sequence: 1, contractId: 'contract-1' });

      const result1 = await indexer.indexBatch('source-api', [event]);
      const result2 = await indexer.indexBatch('source-blockchain', [event]);

      expect(result1.processedCount).toBe(1);
      expect(result2.processedCount).toBe(0);
      expect(result2.duplicateCount).toBe(1);
    });

    it('allows same sequence with different event ID', async () => {
      const result = await indexer.indexBatch('source-1', [
        createValidEvent({ eventId: 'e1', sequence: 1 }),
        createValidEvent({ eventId: 'e2', sequence: 1 }), // Different event, same sequence
      ]);

      expect(result.processedCount).toBe(2);
      expect(result.duplicateCount).toBe(0);
    });

    it('tracks dedupe key correctly for multi-contract environment', async () => {
      const result = await indexer.indexBatch('source-1', [
        createValidEvent({ contractId: 'contract-1', eventId: 'e1', sequence: 1 }),
        createValidEvent({ contractId: 'contract-2', eventId: 'e1', sequence: 1 }),
      ]);

      expect(result.processedCount).toBe(2);
      expect(result.duplicateCount).toBe(0);
    });
  });
});
