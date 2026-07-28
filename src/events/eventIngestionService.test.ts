import { EventAuditService } from '../repository/eventAuditRepository';
import { ContractEvent, EventIngestionResult as AuditEventIngestionResult } from './types';
import {
  EventIngestionConfig,
  EventIngestionService,
} from './eventIngestionService';

const defaultConfig: EventIngestionConfig = {
  enableStrictValidation: true,
  enablePayloadIntegrityCheck: true,
  maxEventAgeMs: 86400000,
  batchSize: 100,
};

const validEvent: ContractEvent = {
  contractId: 'contract_123',
  eventId: 'profile_created',
  sequence: 1,
  timestamp: Date.now(),
  payload: { talentId: 'talent_456', action: 'created' },
};

const acceptedResult: AuditEventIngestionResult = {
  deduplicationKey: 'contract_123:profile_created:1',
  status: 'accepted',
  processedAt: new Date(),
};

const duplicateResult: AuditEventIngestionResult = {
  deduplicationKey: 'contract_123:profile_created:1',
  status: 'duplicate',
  reason: 'Event with same deduplication key already processed',
  processedAt: new Date(),
};

const conflictingResult: AuditEventIngestionResult = {
  deduplicationKey: 'contract_123:profile_created:1',
  status: 'rejected',
  reason: 'Idempotency key was already used with a different event payload.',
  processedAt: new Date(),
  code: 'IDEMPOTENCY_PAYLOAD_CONFLICT',
};

function createMockAuditService(): jest.Mocked<EventAuditService> {
  return {
    processEvent: jest.fn(),
    rejectEvent: jest.fn(),
    getEventHistory: jest.fn(),
    getStatistics: jest.fn(),
  } as unknown as jest.Mocked<EventAuditService>;
}

describe('EventIngestionService', () => {
  let auditService: jest.Mocked<EventAuditService>;
  let service: EventIngestionService;

  beforeEach(() => {
    auditService = createMockAuditService();
    service = new EventIngestionService(auditService, defaultConfig);
  });

  describe('processEvent', () => {
    it('accepts a valid event on the happy path', async () => {
      auditService.processEvent.mockResolvedValue(acceptedResult);

      const result = await service.processEvent(validEvent, 'talent_contract');

      expect(result.status).toBe('accepted');
      expect(auditService.processEvent).toHaveBeenCalledTimes(1);
      expect(auditService.processEvent).toHaveBeenCalledWith(
        validEvent,
        'talent_contract',
        undefined,
      );
    });

    it('forwards the correlationId to the audit service', async () => {
      auditService.processEvent.mockResolvedValue(acceptedResult);

      await service.processEvent(validEvent, 'talent_contract', 'corr-123');

      expect(auditService.processEvent).toHaveBeenCalledWith(
        validEvent,
        'talent_contract',
        'corr-123',
      );
    });

    it('rejects an event missing required fields', async () => {
      const invalidEvent = { contractId: '', eventId: '', sequence: -1, timestamp: 'invalid', payload: 'not-an-object' } as unknown as ContractEvent;

      const result = await service.processEvent(invalidEvent, 'talent_contract');

      expect(result.status).toBe('rejected');
      expect(result.reason).toContain('contractId is required');
      expect(result.reason).toContain('eventId is required');
      expect(result.reason).toContain('sequence must be a non-negative integer');
      expect(result.reason).toContain('timestamp must be a valid epoch number');
      expect(auditService.processEvent).not.toHaveBeenCalled();
    });

    it('rejects a non-object event', async () => {
      const result = await service.processEvent(null as unknown as ContractEvent, 'talent_contract');

      expect(result.status).toBe('rejected');
      expect(result.reason).toContain('Event must be a JSON object');
      expect(auditService.processEvent).not.toHaveBeenCalled();
    });

    it('rejects an event with an excessively old timestamp', async () => {
      const oldEvent: ContractEvent = {
        ...validEvent,
        timestamp: Date.now() - 2 * 86400000,
      };

      const result = await service.processEvent(oldEvent, 'talent_contract');

      expect(result.status).toBe('rejected');
      expect(result.reason).toContain('Event too old');
      expect(auditService.processEvent).not.toHaveBeenCalled();
    });

    it('accepts a timestamp provided as a numeric string', async () => {
      auditService.processEvent.mockResolvedValue(acceptedResult);
      const stringTimestampEvent: ContractEvent = {
        ...validEvent,
        timestamp: String(Date.now()) as unknown as number,
      };

      const result = await service.processEvent(stringTimestampEvent, 'talent_contract');

      expect(result.status).toBe('accepted');
    });

    it('rejects an event with a non-object payload', async () => {
      const badPayloadEvent: ContractEvent = {
        ...validEvent,
        payload: 'string-payload' as unknown as Record<string, unknown>,
      };

      const result = await service.processEvent(badPayloadEvent, 'talent_contract');

      expect(result.status).toBe('rejected');
      expect(result.reason).toContain('payload must be an object');
      expect(auditService.processEvent).not.toHaveBeenCalled();
    });

    it('rejects a non-integer sequence number', async () => {
      const badSeqEvent: ContractEvent = {
        ...validEvent,
        sequence: 1.5,
      };

      const result = await service.processEvent(badSeqEvent, 'talent_contract');

      expect(result.status).toBe('rejected');
      expect(result.reason).toContain('sequence must be a non-negative integer');
    });

    it('returns duplicate status when audit service reports duplicate', async () => {
      auditService.processEvent.mockResolvedValue(duplicateResult);

      const result = await service.processEvent(validEvent, 'talent_contract');

      expect(result.status).toBe('duplicate');
      expect(result.reason).toBe(duplicateResult.reason);
    });

    it('returns payload integrity failure when payload hash conflicts', async () => {
      auditService.processEvent.mockResolvedValue(conflictingResult);

      const result = await service.processEvent(validEvent, 'talent_contract');

      expect(result.status).toBe('rejected');
      expect(result.reason).toContain('Payload integrity check failed');
    });

    it('returns the raw rejected status when payload integrity check is disabled', async () => {
      service = new EventIngestionService(auditService, {
        ...defaultConfig,
        enablePayloadIntegrityCheck: false,
      });
      auditService.processEvent.mockResolvedValue(conflictingResult);

      const result = await service.processEvent(validEvent, 'talent_contract');

      expect(result.status).toBe('rejected');
      expect(result.reason).toBe(conflictingResult.reason);
    });

    it('wraps unexpected audit service errors as a rejected result', async () => {
      auditService.processEvent.mockRejectedValue(new Error('DB connection lost'));

      const result = await service.processEvent(validEvent, 'talent_contract');

      expect(result.status).toBe('rejected');
      expect(result.reason).toContain('Processing error: DB connection lost');
    });

    it('wraps non-Error thrown values as a rejected result', async () => {
      auditService.processEvent.mockRejectedValue('string error');

      const result = await service.processEvent(validEvent, 'talent_contract');

      expect(result.status).toBe('rejected');
      expect(result.reason).toContain('Unknown processing error');
    });

    it('returns a correlationId-based deduplicationKey when audit returns one', async () => {
      const resultWithDedupKey: AuditEventIngestionResult = {
        ...acceptedResult,
        deduplicationKey: 'contract_123:profile_created:1',
      };
      auditService.processEvent.mockResolvedValue(resultWithDedupKey);

      const result = await service.processEvent(validEvent, 'talent_contract');

      expect(result.deduplicationKey).toBe('contract_123:profile_created:1');
    });
  });

  describe('processEvent — contract-specific validation (strict)', () => {
    it('rejects a talent_contract event missing talentId in payload', async () => {
      const missingTalentId: ContractEvent = {
        ...validEvent,
        payload: { action: 'created' },
      };

      const result = await service.processEvent(missingTalentId, 'talent_contract');

      expect(result.status).toBe('rejected');
      expect(result.reason).toContain('talentId is required for talent_contract');
      expect(auditService.processEvent).not.toHaveBeenCalled();
    });

    it('rejects a talent_contract event missing action in payload', async () => {
      const missingAction: ContractEvent = {
        ...validEvent,
        payload: { talentId: 'talent_456' },
      };

      const result = await service.processEvent(missingAction, 'talent_contract');

      expect(result.status).toBe('rejected');
      expect(result.reason).toContain('action is required for talent_contract');
      expect(auditService.processEvent).not.toHaveBeenCalled();
    });

    it('rejects a talent_contract event with empty action string', async () => {
      const emptyAction: ContractEvent = {
        ...validEvent,
        payload: { talentId: 'talent_456', action: '' },
      };

      const result = await service.processEvent(emptyAction, 'talent_contract');

      expect(result.status).toBe('rejected');
      expect(result.reason).toContain('action is required for talent_contract');
    });
  });

  describe('processEvent — unknown event type (no contract-specific validation)', () => {
    it('processes unknown contract types without contract-specific checks', async () => {
      auditService.processEvent.mockResolvedValue(acceptedResult);

      const result = await service.processEvent(validEvent, 'unknown_contract_type');

      expect(result.status).toBe('accepted');
      expect(auditService.processEvent).toHaveBeenCalledWith(
        validEvent,
        'unknown_contract_type',
        undefined,
      );
    });

    it('still validates base event fields for unknown contract types', async () => {
      const invalidEvent = { contractId: '' } as unknown as ContractEvent;

      const result = await service.processEvent(invalidEvent, 'unknown_contract_type');

      expect(result.status).toBe('rejected');
      expect(result.reason).toContain('contractId is required');
      expect(auditService.processEvent).not.toHaveBeenCalled();
    });
  });

  describe('processEvent — strict validation disabled', () => {
    it('skips contract-specific payload validation when strict validation is off', async () => {
      service = new EventIngestionService(auditService, {
        ...defaultConfig,
        enableStrictValidation: false,
      });
      auditService.processEvent.mockResolvedValue(acceptedResult);

      const missingFields: ContractEvent = {
        ...validEvent,
        payload: {},
      };

      const result = await service.processEvent(missingFields, 'talent_contract');

      expect(result.status).toBe('accepted');
      expect(auditService.processEvent).toHaveBeenCalledTimes(1);
    });
  });

  describe('processBatch', () => {
    it('processes all events and returns results in order', async () => {
      auditService.processEvent.mockResolvedValue(acceptedResult);

      const events = [validEvent, { ...validEvent, eventId: 'event_2', sequence: 2 }];
      const results = await service.processBatch(events, 'talent_contract');

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.status === 'accepted')).toBe(true);
      expect(auditService.processEvent).toHaveBeenCalledTimes(2);
    });

    it('processes events in batches of configurable size', async () => {
      service = new EventIngestionService(auditService, { ...defaultConfig, batchSize: 2 });
      auditService.processEvent.mockResolvedValue(acceptedResult);

      const events = Array.from({ length: 5 }, (_, i) => ({
        ...validEvent,
        eventId: `event_${i}`,
        sequence: i,
      }));

      const results = await service.processBatch(events, 'talent_contract');

      expect(results).toHaveLength(5);
      expect(auditService.processEvent).toHaveBeenCalledTimes(5);
    });

    it('handles a single event batch correctly', async () => {
      auditService.processEvent.mockResolvedValue(acceptedResult);

      const results = await service.processBatch([validEvent], 'talent_contract');

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('accepted');
    });

    it('forwards correlationId to each event in the batch', async () => {
      auditService.processEvent.mockResolvedValue(acceptedResult);

      await service.processBatch([validEvent, validEvent], 'talent_contract', 'batch-corr');

      expect(auditService.processEvent).toHaveBeenCalledWith(
        validEvent,
        'talent_contract',
        'batch-corr',
      );
      expect(auditService.processEvent).toHaveBeenCalledTimes(2);
    });
  });

  describe('getStatistics', () => {
    it('delegates to the audit service', async () => {
      auditService.getStatistics.mockResolvedValue({
        total: 10,
        accepted: 5,
        rejected: 3,
        duplicates: 2,
      });

      const stats = await service.getStatistics();

      expect(stats).toEqual({ total: 10, accepted: 5, rejected: 3, duplicates: 2 });
      expect(auditService.getStatistics).toHaveBeenCalledTimes(1);
    });
  });

  describe('getContractHistory', () => {
    it('delegates to the audit service with the given contractId', async () => {
      const history = [{ id: 'audit_1', contractId: 'contract_123' }];
      auditService.getEventHistory.mockResolvedValue(history as any);

      const result = await service.getContractHistory('contract_123');

      expect(result).toBe(history);
      expect(auditService.getEventHistory).toHaveBeenCalledWith('contract_123');
    });
  });
});