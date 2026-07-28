/**
 * @module repository/eventAuditRepository.test
 * @description Unit tests for event audit repository with correlation ID support.
 *
 * Tests:
 * - Event processing with correlation ID
 * - Event rejection with correlation ID
 * - Audit records store correlation ID
 * - Duplicate detection with correlation ID propagation
 */

import { EventAuditService, InMemoryEventAuditRepository } from './eventAuditRepository';
import { EventProcessingAudit } from '../events/types';

describe('EventAuditService with correlation ID support', () => {
  let service: EventAuditService;
  let repository: InMemoryEventAuditRepository;

  beforeEach(() => {
    repository = new InMemoryEventAuditRepository();
    service = new EventAuditService(repository);
  });

  describe('processEvent with correlation ID', () => {
    /**
     * Should accept and store correlation ID when provided.
     */
    it('should store correlation ID in audit record', async () => {
      const event = {
        contractId: 'contract-123',
        eventId: 'event-456',
        sequence: 1,
        payload: { action: 'test' },
      };

      const result = await service.processEvent(event, 'test-type', 'corr-id-789');

      expect(result.status).toBe('accepted');
      expect(result.deduplicationKey).toBeTruthy();

      const audit = await repository.findByDeduplicationKey(result.deduplicationKey);
      expect(audit).toBeTruthy();
      expect(audit?.correlationId).toBe('corr-id-789');
    });

    /**
     * Should handle events without correlation ID.
     */
    it('should process events without correlation ID', async () => {
      const event = {
        contractId: 'contract-123',
        eventId: 'event-456',
        sequence: 1,
        payload: { action: 'test' },
      };

      const result = await service.processEvent(event, 'test-type');

      expect(result.status).toBe('accepted');
      const audit = await repository.findByDeduplicationKey(result.deduplicationKey);
      expect(audit?.correlationId).toBeUndefined();
    });

    /**
     * Should include correlation ID in rejected events.
     */
    it('should store correlation ID in rejected event audit', async () => {
      const event = {
        contractId: 'contract-123',
        eventId: 'event-789',
        sequence: 2,
        payload: { invalid: true },
      };

      const result = await service.rejectEvent(event, 'Invalid payload', 'corr-id-rejected');

      expect(result.status).toBe('rejected');
      const audit = await repository.findByDeduplicationKey(result.deduplicationKey);
      expect(audit?.correlationId).toBe('corr-id-rejected');
      expect(audit?.reason).toBe('Invalid payload');
    });

    /**
     * Should detect duplicates regardless of correlation ID.
     */
    it('should detect duplicate events even with different correlation IDs', async () => {
      const event = {
        contractId: 'contract-123',
        eventId: 'event-abc',
        sequence: 1,
        payload: { data: 'same' },
      };

      // First event with correlation ID
      const result1 = await service.processEvent(event, 'test-type', 'corr-id-1');
      expect(result1.status).toBe('accepted');

      // Duplicate event with different correlation ID
      const result2 = await service.processEvent(event, 'test-type', 'corr-id-2');
      expect(result2.status).toBe('duplicate');
      expect(result2.deduplicationKey).toBe(result1.deduplicationKey);
    });

    /**
     * Should preserve correlation ID in all audit records for retrieval.
     */
    it('should retrieve audit records with correlation ID', async () => {
      const event1 = {
        contractId: 'contract-123',
        eventId: 'event-1',
        sequence: 1,
        payload: { id: 1 },
      };

      const event2 = {
        contractId: 'contract-123',
        eventId: 'event-2',
        sequence: 2,
        payload: { id: 2 },
      };

      const correlationId = 'trace-multi-event';
      await service.processEvent(event1, 'test-type', correlationId);
      await service.processEvent(event2, 'test-type', correlationId);

      const audits = await repository.findByContractId('contract-123');

      expect(audits).toHaveLength(2);
      expect(audits.every(a => a.correlationId === correlationId)).toBe(true);
    });

    /**
     * Should handle events with undefined vs no correlation ID parameter.
     */
    it('should handle undefined correlation ID parameter', async () => {
      const event = {
        contractId: 'contract-456',
        eventId: 'event-def',
        sequence: 1,
        payload: { test: true },
      };

      const result = await service.processEvent(
        event,
        'test-type',
        undefined
      );

      expect(result.status).toBe('accepted');
      const audit = await repository.findByDeduplicationKey(result.deduplicationKey);
      expect(audit?.correlationId).toBeUndefined();
    });
  });

  describe('rejectEvent with correlation ID', () => {
    /**
     * Should store correlation ID in rejection audit record.
     */
    it('should store correlation ID in rejection record', async () => {
      const event = {
        contractId: 'contract-789',
        eventId: 'event-rejected',
        sequence: 1,
        payload: { invalid: 'data' },
      };

      const result = await service.rejectEvent(
        event,
        'Validation failed',
        'corr-reject-123'
      );

      expect(result.status).toBe('rejected');
      const audit = await repository.findByDeduplicationKey(result.deduplicationKey);
      expect(audit?.correlationId).toBe('corr-reject-123');
    });

    /**
     * Should allow rejection without correlation ID.
     */
    it('should reject events without correlation ID', async () => {
      const event = {
        contractId: 'contract-999',
        eventId: 'event-reject-no-corr',
        sequence: 1,
        payload: { invalid: true },
      };

      const result = await service.rejectEvent(event, 'Bad data');

      expect(result.status).toBe('rejected');
      const audit = await repository.findByDeduplicationKey(result.deduplicationKey);
      expect(audit?.correlationId).toBeUndefined();
    });
  });

  describe('End-to-end correlation ID tracking', () => {
    /**
     * Should track correlation ID through complete lifecycle.
     */
    it('should track correlation ID from event acceptance through retrieval', async () => {
      const correlationId = 'e2e-trace-123';
      const contractId = 'contract-e2e';

      // Process multiple events with same correlation ID
      const events = [
        { contractId, eventId: 'e1', sequence: 1, payload: { data: 1 } },
        { contractId, eventId: 'e2', sequence: 2, payload: { data: 2 } },
        { contractId, eventId: 'e3', sequence: 3, payload: { data: 3 } },
      ];

      for (const event of events) {
        const result = await service.processEvent(event, 'test-type', correlationId);
        expect(result.status).toBe('accepted');
      }

      // Retrieve and verify correlation ID is preserved
      const history = await service.getEventHistory(contractId);
      expect(history).toHaveLength(3);
      expect(history.every(h => h.correlationId === correlationId)).toBe(true);
    });

    /**
     * Should preserve different correlation IDs for different request batches.
     */
    it('should preserve different correlation IDs per request', async () => {
      const contractId = 'contract-multi-corr';

      // Batch 1
      const event1 = { contractId, eventId: 'e1', sequence: 1, payload: { b: 1 } };
      await service.processEvent(event1, 'test-type', 'corr-batch-1');

      // Batch 2
      const event2 = { contractId, eventId: 'e2', sequence: 2, payload: { b: 2 } };
      await service.processEvent(event2, 'test-type', 'corr-batch-2');

      const history = await service.getEventHistory(contractId);
      expect(history).toHaveLength(2);

      const audit1 = history.find(h => h.eventId === 'e1');
      const audit2 = history.find(h => h.eventId === 'e2');

      expect(audit1?.correlationId).toBe('corr-batch-1');
      expect(audit2?.correlationId).toBe('corr-batch-2');
    });
  });

  describe('Statistics with correlation ID', () => {
    /**
     * Should track statistics correctly with correlation ID support.
     * Note: When processEvent detects a duplicate, it returns status='duplicate'
     * but does NOT create a new audit record. So duplicates count is 0 even if
     * we get duplicate results.
     */
    it('should maintain accurate statistics with correlation IDs', async () => {
      const event = {
        contractId: 'contract-stats',
        eventId: 'event-stat-1',
        sequence: 1,
        payload: { data: 'test' },
      };

      const event2 = {
        contractId: 'contract-stats',
        eventId: 'event-stat-2',
        sequence: 2,
        payload: { data: 'test-2' },
      };

      const event3 = {
        contractId: 'contract-stats',
        eventId: 'event-stat-3',
        sequence: 3,
        payload: { data: 'test-3' },
      };

      await service.processEvent(event, 'test-type', 'corr-stat-1');
      await service.processEvent(event, 'test-type', 'corr-stat-2'); // Duplicate result, no new record
      await service.processEvent(event2, 'test-type', 'corr-stat-3'); // Accepted
      await service.rejectEvent(event3, 'Rejected', 'corr-stat-4'); // Rejected

      const stats = await service.getStatistics();

      expect(stats.total).toBe(3);
      expect(stats.accepted).toBe(2);
      expect(stats.duplicates).toBe(0); // No duplicate audit records created
      expect(stats.rejected).toBe(1);
    });
  });
});
