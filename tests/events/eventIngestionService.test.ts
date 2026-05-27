import { EventIngestionService, EventIngestionConfig } from '../../src/events/eventIngestionService';
import { InMemoryEventAuditRepository, EventAuditService } from '../../src/repository/eventAuditRepository';
import { ContractEvent } from '../../src/events/types';

describe('EventIngestionService', () => {
  let repository: InMemoryEventAuditRepository;
  let auditService: EventAuditService;
  let service: EventIngestionService;
  let config: EventIngestionConfig;

  const mockEvent: ContractEvent = {
    contractId: 'contract_123',
    eventId: 'event_456',
    sequence: 1,
    timestamp: Date.now(),
    payload: { data: 'test' }
  };

  beforeEach(() => {
    repository = new InMemoryEventAuditRepository();
    auditService = new EventAuditService(repository);
    config = {
      enableStrictValidation: true,
      enablePayloadIntegrityCheck: true,
      maxEventAgeMs: 86400000, // 24 hours
      batchSize: 10
    };
    service = new EventIngestionService(auditService, config);
  });

  describe('processEvent', () => {
    it('should process a valid event successfully', async () => {
      const result = await service.processEvent(mockEvent, 'talent_contract');
      
      expect(result.status).toBe('accepted');
      expect(result.deduplicationKey).toBe('contract_123:event_456:1');
      expect(result.processedAt).toBeInstanceOf(Date);
    });

    it('should reject duplicate events', async () => {
      await service.processEvent(mockEvent, 'talent_contract');
      
      const duplicateResult = await service.processEvent(mockEvent, 'talent_contract');
      expect(duplicateResult.status).toBe('duplicate');
      expect(duplicateResult.reason).toContain('already processed');
    });

    it('should reject events with invalid structure', async () => {
      const invalidEvent = { ...mockEvent, contractId: '' };
      
      const result = await service.processEvent(invalidEvent, 'talent_contract');
      expect(result.status).toBe('rejected');
      expect(result.reason).toContain('Validation failed');
    });

    it('should reject events that are too old', async () => {
      const oldEvent = {
        ...mockEvent,
        timestamp: Date.now() - (config.maxEventAgeMs + 1000)
      };
      
      const result = await service.processEvent(oldEvent, 'talent_contract');
      expect(result.status).toBe('rejected');
      expect(result.reason).toContain('Event too old');
    });

    it('should reject events with invalid contract-specific payload', async () => {
      const invalidPayloadEvent = {
        ...mockEvent,
        payload: { invalidField: 'test' }
      };
      
      const result = await service.processEvent(invalidPayloadEvent, 'talent_contract');
      expect(result.status).toBe('rejected');
      expect(result.reason).toContain('Contract validation failed');
    });

    it('should process events without strict validation when disabled', async () => {
      const relaxedConfig = { ...config, enableStrictValidation: false };
      const relaxedService = new EventIngestionService(auditService, relaxedConfig);
      
      const invalidPayloadEvent = {
        ...mockEvent,
        payload: { anyField: 'test' }
      };
      
      const result = await relaxedService.processEvent(invalidPayloadEvent, 'talent_contract');
      expect(result.status).toBe('accepted');
    });

    it('should handle processing errors gracefully', async () => {
      // Mock a repository error
      jest.spyOn(repository, 'findByDeduplicationKey').mockRejectedValue(new Error('Database error'));
      
      const result = await service.processEvent(mockEvent, 'talent_contract');
      expect(result.status).toBe('rejected');
      expect(result.reason).toContain('Processing error');
    });
  });

  describe('processBatch', () => {
    it('should process a batch of events successfully', async () => {
      const events = [
        mockEvent,
        { ...mockEvent, eventId: 'event_789', sequence: 2 },
        { ...mockEvent, eventId: 'event_101', sequence: 3 }
      ];
      
      const results = await service.processBatch(events, 'talent_contract');
      
      expect(results).toHaveLength(3);
      expect(results.every(r => r.status === 'accepted')).toBe(true);
    });

    it('should handle mixed valid and invalid events in batch', async () => {
      const events = [
        mockEvent,
        { ...mockEvent, contractId: '', eventId: 'invalid_event' }, // Invalid
        { ...mockEvent, eventId: 'valid_event', sequence: 2 }
      ];
      
      const results = await service.processBatch(events, 'talent_contract');
      
      expect(results).toHaveLength(3);
      expect(results[0].status).toBe('accepted');
      expect(results[1].status).toBe('rejected');
      expect(results[2].status).toBe('accepted');
    });

    it('should respect batch size configuration', async () => {
      const smallBatchConfig = { ...config, batchSize: 2 };
      const smallBatchService = new EventIngestionService(auditService, smallBatchConfig);
      
      const events = Array.from({ length: 5 }, (_, i) => ({
        ...mockEvent,
        eventId: `event_${i}`,
        sequence: i + 1
      }));
      
      const results = await smallBatchService.processBatch(events, 'talent_contract');
      
      expect(results).toHaveLength(5);
      expect(results.every(r => r.status === 'accepted')).toBe(true);
    });
  });

  describe('validateEvent', () => {
    it('should validate a correct event', () => {
      const result = service.validateEvent(mockEvent, 'talent_contract');
      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject invalid event structure', () => {
      const invalidEvent = { ...mockEvent, contractId: '' };
      const result = service.validateEvent(invalidEvent, 'talent_contract');
      
      expect(result.isValid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should reject events that are too old', () => {
      const oldEvent = {
        ...mockEvent,
        timestamp: Date.now() - (config.maxEventAgeMs + 1000)
      };
      
      const result = service.validateEvent(oldEvent, 'talent_contract');
      expect(result.isValid).toBe(false);
      expect(result.errors[0].field).toBe('timestamp');
    });

    it('should skip contract validation when disabled', () => {
      const relaxedConfig = { ...config, enableStrictValidation: false };
      const relaxedService = new EventIngestionService(auditService, relaxedConfig);
      
      const invalidPayloadEvent = {
        ...mockEvent,
        payload: { anyField: 'test' }
      };
      
      const result = relaxedService.validateEvent(invalidPayloadEvent, 'talent_contract');
      expect(result.isValid).toBe(true);
    });
  });

  describe('getStatistics', () => {
    it('should return processing statistics', async () => {
      await service.processEvent(mockEvent, 'talent_contract');
      
      const stats = await service.getStatistics();
      
      expect(typeof stats.total).toBe('number');
      expect(typeof stats.accepted).toBe('number');
      expect(typeof stats.rejected).toBe('number');
      expect(typeof stats.duplicates).toBe('number');
      expect(stats.total).toBeGreaterThan(0);
    });
  });

  describe('getContractHistory', () => {
    it('should return contract event history', async () => {
      await service.processEvent(mockEvent, 'talent_contract');
      
      const history = await service.getContractHistory('contract_123');
      
      expect(history).toHaveLength(1);
      expect(history[0].contractId).toBe('contract_123');
    });

    it('should return empty history for non-existent contract', async () => {
      const history = await service.getContractHistory('non_existent');
      expect(history).toHaveLength(0);
    });
  });

  describe('payload integrity checks', () => {
    it('should validate payload integrity when enabled', async () => {
      // Process original event
      await service.processEvent(mockEvent, 'talent_contract');
      
      // Try to process same event with tampered payload
      const tamperedEvent = {
        ...mockEvent,
        payload: { data: 'tampered' }
      };
      
      const result = await service.processEvent(tamperedEvent, 'talent_contract');
      expect(result.status).toBe('rejected');
      expect(result.reason).toContain('Payload integrity check failed');
    });

    it('should skip payload integrity check when disabled', async () => {
      const relaxedConfig = { ...config, enablePayloadIntegrityCheck: false };
      const relaxedService = new EventIngestionService(auditService, relaxedConfig);
      
      await relaxedService.processEvent(mockEvent, 'talent_contract');
      
      const tamperedEvent = {
        ...mockEvent,
        payload: { data: 'tampered' }
      };
      
      const result = await relaxedService.processEvent(tamperedEvent, 'talent_contract');
      expect(result.status).toBe('duplicate'); // Should be detected as duplicate, not integrity failure
    });
  });
});
