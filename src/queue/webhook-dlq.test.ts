/**
 * @file queue/webhook-dlq.test.ts
 * @description Tests for webhook DLQ persistence functionality
 */

import { WebhookDLQStorage, getWebhookDLQStorage, clearWebhookDLQInstance } from '../queue/webhook-dlq';

const TEST_DB_PATH = ':memory:';

describe('WebhookDLQStorage', () => {
  let storage: WebhookDLQStorage;

  beforeEach(() => {
    clearWebhookDLQInstance();
    storage = getWebhookDLQStorage(TEST_DB_PATH);
  });

  afterEach(() => {
    clearWebhookDLQInstance();
  });

  describe('addEntry', () => {
    it('should add a DLQ entry and return its ID', async () => {
      const id = await storage.addEntry(
        'webhook-123',
        'https://example.com/webhook',
        { event: 'test', data: { foo: 'bar' } },
        5,
        'Connection timeout'
      );

      expect(id).toBeDefined();
      expect(typeof id).toBe('string');
    });

    it('should throw DUPLICATE_ENTRY for duplicate dedupe keys', async () => {
      const body = { event: 'test', data: { foo: 'bar' } };
      
      await storage.addEntry('webhook-123', 'https://example.com/webhook', body, 5, 'Error 1');
      
      await expect(
        storage.addEntry('webhook-123', 'https://example.com/webhook', body, 5, 'Error 2')
      ).rejects.toThrow('DUPLICATE_ENTRY');
    });
  });

  describe('getEntry', () => {
    it('should retrieve an entry by ID', async () => {
      const id = await storage.addEntry(
        'webhook-123',
        'https://example.com/webhook',
        { event: 'test' },
        5,
        'Error'
      );

      const entry = storage.getEntry(id);

      expect(entry).toBeDefined();
      expect(entry?.webhookId).toBe('webhook-123');
      expect(entry?.url).toBe('https://example.com/webhook');
    });

    it('should return null for non-existent ID', () => {
      const entry = storage.getEntry('non-existent-id');
      expect(entry).toBeNull();
    });
  });

  describe('listEntries', () => {
    it('should list all entries with pagination', async () => {
      for (let i = 0; i < 5; i++) {
        await storage.addEntry(
          `webhook-${i}`,
          'https://example.com/webhook',
          { index: i },
          5,
          'Error'
        );
      }

      const entries = storage.listEntries({ limit: 2, offset: 0 });
      expect(entries).toHaveLength(2);
    });
  });

  describe('checkDedupe', () => {
    it('should return true for duplicate entries', async () => {
      const body = { event: 'test' };
      
      await storage.addEntry('webhook-123', 'https://example.com', body, 5, 'Error');
      
      const result = storage.checkDedupe('webhook-123', body);
      expect(result.exists).toBe(true);
    });

    it('should return false for unique entries', () => {
      const result = storage.checkDedupe('webhook-new', { event: 'new' });
      expect(result.exists).toBe(false);
    });
  });

  describe('markReplayed', () => {
    it('should mark an entry as replayed', async () => {
      const id = await storage.addEntry(
        'webhook-123',
        'https://example.com',
        { event: 'test' },
        5,
        'Error'
      );

      const result = storage.markReplayed(id);
      expect(result).toBe(true);

      const entry = storage.getEntry(id);
      expect(entry?.replayedAt).toBeDefined();
    });
  });

  describe('getStats', () => {
    it('should return correct statistics', async () => {
      await storage.addEntry('webhook-1', 'https://a.com', { e: 1 }, 5, 'e');
      await storage.addEntry('webhook-2', 'https://b.com', { e: 2 }, 5, 'e');

      const id = await storage.addEntry('webhook-3', 'https://c.com', { e: 3 }, 5, 'e');
      storage.markReplayed(id);

      const stats = await storage.getStats();
      expect(stats.total).toBe(3);
      expect(stats.pending).toBe(2);
      expect(stats.replayed).toBe(1);
    });
  });
});