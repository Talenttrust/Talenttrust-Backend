import { DeduplicationManager } from '../../src/utils/deduplication';
import { ContractEvent } from '../../src/events/types';

describe('DeduplicationManager', () => {
  const mockEvent: ContractEvent = {
    contractId: 'contract_123',
    eventId: 'event_456',
    sequence: 1,
    timestamp: Date.now(),
    payload: { data: 'test' }
  };

  describe('computeDeduplicationKey', () => {
    it('should compute a stable deduplication key', () => {
      const key = DeduplicationManager.computeDeduplicationKey(mockEvent);
      expect(key).toBe('contract_123:event_456:1');
    });

    it('should produce the same key for identical events', () => {
      const event1 = { ...mockEvent };
      const event2 = { ...mockEvent };
      
      const key1 = DeduplicationManager.computeDeduplicationKey(event1);
      const key2 = DeduplicationManager.computeDeduplicationKey(event2);
      
      expect(key1).toBe(key2);
    });

    it('should produce different keys for different sequences', () => {
      const event1 = { ...mockEvent, sequence: 1 };
      const event2 = { ...mockEvent, sequence: 2 };
      
      const key1 = DeduplicationManager.computeDeduplicationKey(event1);
      const key2 = DeduplicationManager.computeDeduplicationKey(event2);
      
      expect(key1).not.toBe(key2);
    });
  });

  describe('computePayloadHash', () => {
    it('should compute a consistent hash for the same payload', () => {
      const payload = { data: 'test', number: 42 };
      const hash1 = DeduplicationManager.computePayloadHash(payload);
      const hash2 = DeduplicationManager.computePayloadHash(payload);
      
      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hash format
    });

    it('should produce different hashes for different payloads', () => {
      const payload1 = { data: 'test1' };
      const payload2 = { data: 'test2' };
      
      const hash1 = DeduplicationManager.computePayloadHash(payload1);
      const hash2 = DeduplicationManager.computePayloadHash(payload2);
      
      expect(hash1).not.toBe(hash2);
    });

    it('should handle payloads with different key orders consistently', () => {
      const payload1 = { b: 2, a: 1 };
      const payload2 = { a: 1, b: 2 };
      
      const hash1 = DeduplicationManager.computePayloadHash(payload1);
      const hash2 = DeduplicationManager.computePayloadHash(payload2);
      
      expect(hash1).toBe(hash2);
    });
  });

  describe('validatePayloadIntegrity', () => {
    it('should validate payload integrity correctly', () => {
      const expectedHash = DeduplicationManager.computePayloadHash(mockEvent.payload);
      
      const isValid = DeduplicationManager.validatePayloadIntegrity(mockEvent, expectedHash);
      expect(isValid).toBe(true);
    });

    it('should reject tampered payloads', () => {
      const wrongHash = 'wrong_hash_value';
      
      const isValid = DeduplicationManager.validatePayloadIntegrity(mockEvent, wrongHash);
      expect(isValid).toBe(false);
    });
  });

  describe('parseDeduplicationKey', () => {
    it('should parse deduplication key correctly', () => {
      const key = 'contract_123:event_456:1';
      const parsed = DeduplicationManager.parseDeduplicationKey(key);
      
      expect(parsed).toEqual({
        contractId: 'contract_123',
        eventId: 'event_456',
        sequence: 1
      });
    });

    it('should handle complex contract and event IDs', () => {
      const key = 'complex-contract_abc-123:event_xyz-789:42';
      const parsed = DeduplicationManager.parseDeduplicationKey(key);
      
      expect(parsed).toEqual({
        contractId: 'complex-contract_abc-123',
        eventId: 'event_xyz-789',
        sequence: 42
      });
    });
  });

  describe('areEventsDuplicates', () => {
    it('should identify duplicate events correctly', () => {
      const event1 = { ...mockEvent };
      const event2 = { ...mockEvent };
      
      expect(DeduplicationManager.areEventsDuplicates(event1, event2)).toBe(true);
    });

    it('should identify non-duplicate events correctly', () => {
      const event1 = { ...mockEvent, sequence: 1 };
      const event2 = { ...mockEvent, sequence: 2 };
      
      expect(DeduplicationManager.areEventsDuplicates(event1, event2)).toBe(false);
    });
  });
});
