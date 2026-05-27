import { InMemoryEventAuditRepository, EventAuditService } from '../../src/repository/eventAuditRepository';
import { EventProcessingAudit } from '../../src/events/types';

describe('InMemoryEventAuditRepository', () => {
  let repository: InMemoryEventAuditRepository;
  let sampleAudit: EventProcessingAudit;

  beforeEach(() => {
    repository = new InMemoryEventAuditRepository();
    sampleAudit = {
      id: 'audit_123',
      deduplicationKey: 'contract_123:event_456:1',
      contractId: 'contract_123',
      eventId: 'event_456',
      sequence: 1,
      status: 'accepted',
      payloadHash: 'hash123',
      processedAt: new Date(),
      createdAt: new Date()
    };
  });

  describe('save', () => {
    it('should save an audit record', async () => {
      const result = await repository.save(sampleAudit);
      expect(result).toBe(sampleAudit);
    });

    it('should overwrite existing audit with same deduplication key', async () => {
      await repository.save(sampleAudit);
      
      const updatedAudit = { ...sampleAudit, status: 'rejected' as const };
      const result = await repository.save(updatedAudit);
      
      expect(result.status).toBe('rejected');
    });
  });

  describe('findByDeduplicationKey', () => {
    it('should find audit by deduplication key', async () => {
      await repository.save(sampleAudit);
      
      const result = await repository.findByDeduplicationKey('contract_123:event_456:1');
      expect(result).toBe(sampleAudit);
    });

    it('should return null for non-existent key', async () => {
      const result = await repository.findByDeduplicationKey('non_existent:key');
      expect(result).toBeNull();
    });
  });

  describe('findByContractId', () => {
    beforeEach(async () => {
      // Setup multiple audits for testing
      await repository.save(sampleAudit);
      await repository.save({
        ...sampleAudit,
        id: 'audit_456',
        deduplicationKey: 'contract_123:event_789:2',
        eventId: 'event_789',
        sequence: 2
      });
      await repository.save({
        ...sampleAudit,
        id: 'audit_789',
        deduplicationKey: 'contract_456:event_123:1',
        contractId: 'contract_456',
        eventId: 'event_123'
      });
    });

    it('should find all audits for a contract', async () => {
      const results = await repository.findByContractId('contract_123');
      expect(results).toHaveLength(2);
      expect(results.every(r => r.contractId === 'contract_123')).toBe(true);
    });

    it('should respect limit parameter', async () => {
      const results = await repository.findByContractId('contract_123', 1);
      expect(results).toHaveLength(1);
    });

    it('should return empty array for non-existent contract', async () => {
      const results = await repository.findByContractId('non_existent');
      expect(results).toHaveLength(0);
    });

    it('should return results sorted by creation date (newest first)', async () => {
      const now = new Date();
      const older = new Date(now.getTime() - 1000);
      
      await repository.save({
        ...sampleAudit,
        id: 'audit_older',
        deduplicationKey: 'contract_123:event_older:3',
        eventId: 'event_older',
        createdAt: older
      });
      
      const results = await repository.findByContractId('contract_123');
      expect(results[0].createdAt.getTime()).toBeGreaterThanOrEqual(results[1].createdAt.getTime());
    });
  });

  describe('findByStatus', () => {
    beforeEach(async () => {
      await repository.save(sampleAudit); // accepted
      await repository.save({
        ...sampleAudit,
        id: 'audit_rejected',
        deduplicationKey: 'contract_123:event_rejected:2',
        eventId: 'event_rejected',
        status: 'rejected'
      });
      await repository.save({
        ...sampleAudit,
        id: 'audit_duplicate',
        deduplicationKey: 'contract_123:event_duplicate:3',
        eventId: 'event_duplicate',
        status: 'duplicate'
      });
    });

    it('should find audits by status', async () => {
      const results = await repository.findByStatus('accepted');
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('accepted');
    });

    it('should respect limit parameter', async () => {
      const results = await repository.findByStatus('accepted', 0);
      expect(results).toHaveLength(0);
    });

    it('should return empty array for non-existent status', async () => {
      const results = await repository.findByStatus('non_existent' as any);
      expect(results).toHaveLength(0);
    });
  });

  describe('getEventStatistics', () => {
    beforeEach(async () => {
      await repository.save(sampleAudit); // accepted
      await repository.save({
        ...sampleAudit,
        id: 'audit_rejected',
        deduplicationKey: 'contract_123:event_rejected:2',
        eventId: 'event_rejected',
        status: 'rejected'
      });
      await repository.save({
        ...sampleAudit,
        id: 'audit_duplicate',
        deduplicationKey: 'contract_123:event_duplicate:3',
        eventId: 'event_duplicate',
        status: 'duplicate'
      });
    });

    it('should return correct statistics', async () => {
      const stats = await repository.getEventStatistics();
      expect(stats).toEqual({
        total: 3,
        accepted: 1,
        rejected: 1,
        duplicates: 1
      });
    });

    it('should return zeros for empty repository', async () => {
      const emptyRepo = new InMemoryEventAuditRepository();
      const stats = await emptyRepo.getEventStatistics();
      expect(stats).toEqual({
        total: 0,
        accepted: 0,
        rejected: 0,
        duplicates: 0
      });
    });
  });
});

describe('EventAuditService', () => {
  let service: EventAuditService;
  let repository: InMemoryEventAuditRepository;

  beforeEach(() => {
    repository = new InMemoryEventAuditRepository();
    service = new EventAuditService(repository);
  });

  describe('processEvent', () => {
    const mockEvent = {
      contractId: 'contract_123',
      eventId: 'event_456',
      sequence: 1,
      timestamp: Date.now(),
      payload: { data: 'test' }
    };

    it('should process a new event successfully', async () => {
      const result = await service.processEvent(mockEvent, 'talent_contract');
      
      expect(result.status).toBe('accepted');
      expect(result.deduplicationKey).toBe('contract_123:event_456:1');
      expect(result.processedAt).toBeInstanceOf(Date);
    });

    it('should detect duplicate events', async () => {
      await service.processEvent(mockEvent, 'talent_contract');
      
      const duplicateResult = await service.processEvent(mockEvent, 'talent_contract');
      expect(duplicateResult.status).toBe('duplicate');
      expect(duplicateResult.reason).toContain('already processed');
    });

    it('should store audit record for processed event', async () => {
      await service.processEvent(mockEvent, 'talent_contract');
      
      const audit = await repository.findByDeduplicationKey('contract_123:event_456:1');
      expect(audit).toBeTruthy();
      expect(audit!.status).toBe('accepted');
      expect(audit!.contractId).toBe('contract_123');
    });
  });

  describe('rejectEvent', () => {
    const mockEvent = {
      contractId: 'contract_123',
      eventId: 'event_456',
      sequence: 1,
      timestamp: Date.now(),
      payload: { data: 'test' }
    };

    it('should reject an event with specified reason', async () => {
      const reason = 'Invalid payload structure';
      const result = await service.rejectEvent(mockEvent, reason);
      
      expect(result.status).toBe('rejected');
      expect(result.reason).toBe(reason);
      expect(result.deduplicationKey).toBe('contract_123:event_456:1');
    });

    it('should store audit record for rejected event', async () => {
      const reason = 'Validation failed';
      await service.rejectEvent(mockEvent, reason);
      
      const audit = await repository.findByDeduplicationKey('contract_123:event_456:1');
      expect(audit).toBeTruthy();
      expect(audit!.status).toBe('rejected');
      expect(audit!.reason).toBe(reason);
    });
  });

  describe('getEventHistory', () => {
    const mockEvent = {
      contractId: 'contract_123',
      eventId: 'event_456',
      sequence: 1,
      timestamp: Date.now(),
      payload: { data: 'test' }
    };

    it('should return event history for a contract', async () => {
      await service.processEvent(mockEvent, 'talent_contract');
      
      const history = await service.getEventHistory('contract_123');
      expect(history).toHaveLength(1);
      expect(history[0].contractId).toBe('contract_123');
    });

    it('should return empty history for non-existent contract', async () => {
      const history = await service.getEventHistory('non_existent');
      expect(history).toHaveLength(0);
    });
  });

  describe('getStatistics', () => {
    it('should return statistics from repository', async () => {
      const mockEvent = {
        contractId: 'contract_123',
        eventId: 'event_456',
        sequence: 1,
        timestamp: Date.now(),
        payload: { data: 'test' }
      };

      await service.processEvent(mockEvent, 'talent_contract');
      await service.rejectEvent(mockEvent, 'test rejection');
      
      const stats = await service.getStatistics();
      expect(stats.total).toBeGreaterThan(0);
      expect(typeof stats.accepted).toBe('number');
      expect(typeof stats.rejected).toBe('number');
      expect(typeof stats.duplicates).toBe('number');
    });
  });
});
