import { ContractEventProcessor, ProcessorConfig } from './processor';
import { ContractEventRepository, InMemoryContractEventRepository, IngestAuditLog } from './repository';
import { PersistedContractEvent } from './types';

function createValidPayload(overrides: Record<string, unknown> = {}) {
  return {
    contractId: 'contract-1',
    eventId: 'event-1',
    sequence: 1,
    timestamp: new Date().toISOString(),
    type: 'CONTRACT_CREATED',
    payload: { amount: 100 },
    ...overrides,
  };
}

describe('ContractEventProcessor', () => {
  let repository: InMemoryContractEventRepository;
  let processor: ContractEventProcessor;

  beforeEach(() => {
    repository = new InMemoryContractEventRepository();
    processor = new ContractEventProcessor(repository);
  });

  it('accepts and persists valid events', async () => {
    const result = await processor.ingest(createValidPayload());

    expect(result.status).toBe('accepted');
    expect(result.eventKey).toBe('contract-1:event-1:1');
    await expect(processor.listEvents()).resolves.toHaveLength(1);
  });

  it('returns duplicate for replayed events', async () => {
    const payload = createValidPayload();

    await processor.ingest(payload);
    const duplicate = await processor.ingest(payload);

    expect(duplicate).toEqual({ status: 'duplicate', eventKey: 'contract-1:event-1:1' });
    await expect(processor.listEvents()).resolves.toHaveLength(1);
  });

  it('rejects invalid payloads', async () => {
    const result = await processor.ingest({});

    expect(result.status).toBe('invalid');
    expect(result.reason).toBeDefined();
    await expect(processor.listEvents()).resolves.toHaveLength(0);
  });

  it('propagates persistence failures', async () => {
    const repository: ContractEventRepository = {
      hasEventKey: async () => false,
      saveEvent: async () => {
        throw new Error('storage error');
      },
      listEvents: async () => [],
      getEvent: async () => null,
      saveAuditLog: async () => {},
      getAuditLog: async () => null,
      listAuditLogs: async () => [],
      getAuditLogsByContractId: async () => [],
    };
    const processor = new ContractEventProcessor(repository);

    await expect(processor.ingest(createValidPayload())).rejects.toThrow('storage error');
  });

  it('validates idempotency correctly', async () => {
    const payload = createValidPayload();
    
    const idempotencyResult = await processor.validateIdempotency(payload);
    
    expect(idempotencyResult.originalResult.status).toBe('accepted');
    expect(idempotencyResult.reingestResult.status).toBe('duplicate');
    expect(idempotencyResult.isIdempotent).toBe(true);
  });

  it('detects non-idempotent behavior for invalid events', async () => {
    const invalidPayload = { invalid: 'payload' };
    
    const idempotencyResult = await processor.validateIdempotency(invalidPayload);
    
    expect(idempotencyResult.originalResult.status).toBe('invalid');
    expect(idempotencyResult.reingestResult.status).toBe('invalid');
    expect(idempotencyResult.isIdempotent).toBe(true); // Same result = idempotent
  });

  it('retrieves events by event key', async () => {
    const payload = createValidPayload();
    await processor.ingest(payload);
    
    const event = await processor.getEvent('contract-1:event-1:1');
    
    expect(event).toBeDefined();
    expect(event!.contractId).toBe('contract-1');
    expect(event!.eventId).toBe('event-1');
    expect(event!.sequence).toBe(1);
  });

  it('returns null for non-existent events', async () => {
    const event = await processor.getEvent('non-existent:event:key');
    
    expect(event).toBeNull();
  });

  it('throws error for invalid event key format', async () => {
    await expect(processor.getEvent('invalid-key')).rejects.toThrow('Invalid event key format');
  });

  it('retrieves audit logs', async () => {
    const payload = createValidPayload();
    await processor.ingest(payload);
    
    const auditLog = await processor.getAuditLog('contract-1:event-1:1');
    
    expect(auditLog).toBeDefined();
    expect(auditLog!.eventKey).toBe('contract-1:event-1:1');
    expect(auditLog!.status).toBe('accepted');
  });

  it('lists audit logs with limit', async () => {
    const payloads = [
      createValidPayload({ eventId: 'event-1', sequence: 1 }),
      createValidPayload({ eventId: 'event-2', sequence: 1 }),
      createValidPayload({ eventId: 'event-3', sequence: 1 }),
    ];
    
    for (const payload of payloads) {
      await processor.ingest(payload);
    }
    
    const auditLogs = await processor.listAuditLogs(2);
    
    expect(auditLogs).toHaveLength(2);
  });

  it('retrieves audit logs by contract ID', async () => {
    const payloads = [
      createValidPayload({ contractId: 'contract-1', eventId: 'event-1', sequence: 1 }),
      createValidPayload({ contractId: 'contract-1', eventId: 'event-2', sequence: 1 }),
      createValidPayload({ contractId: 'contract-2', eventId: 'event-1', sequence: 1 }),
    ];
    
    for (const payload of payloads) {
      await processor.ingest(payload);
    }
    
    const contract1Logs = await processor.getAuditLogsByContractId('contract-1');
    
    expect(contract1Logs).toHaveLength(2);
    expect(contract1Logs.every(log => log.eventKey.startsWith('contract-1:'))).toBe(true);
  });

  it('throws error for empty contract ID', async () => {
    await expect(processor.getAuditLogsByContractId('')).rejects.toThrow('Contract ID is required');
  });

  it('throws error for whitespace-only contract ID', async () => {
    await expect(processor.getAuditLogsByContractId('   ')).rejects.toThrow('Contract ID is required');
  });
});

describe('ContractEventProcessor with audit logging', () => {
  let repository: InMemoryContractEventRepository;
  let processor: ContractEventProcessor;

  beforeEach(() => {
    repository = new InMemoryContractEventRepository();
    processor = new ContractEventProcessor(repository, { enableAuditLogging: true });
  });

  it('creates audit log for accepted events', async () => {
    const payload = createValidPayload();
    await processor.ingest(payload);
    
    const auditLog = await processor.getAuditLog('contract-1:event-1:1');
    
    expect(auditLog).toBeDefined();
    expect(auditLog!.status).toBe('accepted');
    expect(auditLog!.processingTimeMs).toBeGreaterThan(0);
  });

  it('creates audit log for duplicate events', async () => {
    const payload = createValidPayload();
    await processor.ingest(payload);
    await processor.ingest(payload);
    
    const auditLog = await processor.getAuditLog('contract-1:event-1:1');
    
    expect(auditLog).toBeDefined();
    expect(auditLog!.status).toBe('accepted'); // First event was accepted
  });

  it('creates audit log for invalid events', async () => {
    const invalidPayload = { invalid: 'payload' };
    await processor.ingest(invalidPayload);
    
    const auditLogs = await processor.listAuditLogs();
    const invalidLog = auditLogs.find(log => log.status === 'invalid');
    
    expect(invalidLog).toBeDefined();
    expect(invalidLog!.reason).toBeDefined();
  });

  it('includes payload hash when enabled', async () => {
    const processorWithHashing = new ContractEventProcessor(repository, { 
      enableAuditLogging: true, 
      enablePayloadHashing: true 
    });
    
    const payload = createValidPayload();
    await processorWithHashing.ingest(payload);
    
    const auditLog = await processorWithHashing.getAuditLog('contract-1:event-1:1');
    
    expect(auditLog).toBeDefined();
    expect(auditLog!.payloadHash).toBeDefined();
    expect(auditLog!.payloadHash).toMatch(/^[a-f0-9]+$/);
  });

  it('does not include payload hash when disabled', async () => {
    const processorWithoutHashing = new ContractEventProcessor(repository, { 
      enableAuditLogging: true, 
      enablePayloadHashing: false 
    });
    
    const payload = createValidPayload();
    await processorWithoutHashing.ingest(payload);
    
    const auditLog = await processorWithoutHashing.getAuditLog('contract-1:event-1:1');
    
    expect(auditLog).toBeDefined();
    expect(auditLog!.payloadHash).toBeUndefined();
  });
});

describe('ContractEventProcessor without audit logging', () => {
  let repository: InMemoryContractEventRepository;
  let processor: ContractEventProcessor;

  beforeEach(() => {
    repository = new InMemoryContractEventRepository();
    processor = new ContractEventProcessor(repository, { enableAuditLogging: false });
  });

  it('does not create audit logs when disabled', async () => {
    const payload = createValidPayload();
    await processor.ingest(payload);
    
    const auditLog = await processor.getAuditLog('contract-1:event-1:1');
    
    expect(auditLog).toBeNull();
  });

  it('still processes events correctly without audit logging', async () => {
    const payload = createValidPayload();
    const result = await processor.ingest(payload);
    
    expect(result.status).toBe('accepted');
    expect(result.eventKey).toBe('contract-1:event-1:1');
  });
});

describe('ContractEventProcessor error handling', () => {
  let repository: InMemoryContractEventRepository;
  let processor: ContractEventProcessor;

  beforeEach(() => {
    repository = new InMemoryContractEventRepository();
    processor = new ContractEventProcessor(repository, { enableAuditLogging: true });
  });

  it('handles repository save failures gracefully', async () => {
    const failingRepository: ContractEventRepository = {
      hasEventKey: async () => false,
      saveEvent: async () => {
        throw new Error('Database connection failed');
      },
      listEvents: async () => [],
      getEvent: async () => null,
      saveAuditLog: async () => {},
      getAuditLog: async () => null,
      listAuditLogs: async () => [],
      getAuditLogsByContractId: async () => [],
    };
    
    const failingProcessor = new ContractEventProcessor(failingRepository, { enableAuditLogging: true });
    
    await expect(failingProcessor.ingest(createValidPayload())).rejects.toThrow('Database connection failed');
  });

  it('handles audit log failures without affecting main flow', async () => {
    const repositoryWithAuditFailure: ContractEventRepository = {
      hasEventKey: async () => false,
      saveEvent: async () => {},
      listEvents: async () => [],
      getEvent: async () => null,
      saveAuditLog: async () => {
        throw new Error('Audit log failed');
      },
      getAuditLog: async () => null,
      listAuditLogs: async () => [],
      getAuditLogsByContractId: async () => [],
    };
    
    const processorWithAuditFailure = new ContractEventProcessor(repositoryWithAuditFailure, { enableAuditLogging: true });
    
    const result = await processorWithAuditFailure.ingest(createValidPayload());
    
    expect(result.status).toBe('accepted');
  });
});

describe('InMemoryContractEventRepository', () => {
  let repository: InMemoryContractEventRepository;

  beforeEach(() => {
    repository = new InMemoryContractEventRepository();
  });

  it('stores and retrieves events correctly', async () => {
    const event: PersistedContractEvent = {
      contractId: 'contract-1',
      eventId: 'event-1',
      sequence: 1,
      timestamp: new Date().toISOString(),
      type: 'CONTRACT_CREATED',
      payload: { amount: 100 },
      eventKey: 'contract-1:event-1:1',
      receivedAt: new Date().toISOString(),
    };

    await repository.saveEvent(event);
    const retrievedEvent = await repository.getEvent('contract-1:event-1:1');

    expect(retrievedEvent).toEqual(event);
  });

  it('returns correct statistics', async () => {
    const event: PersistedContractEvent = {
      contractId: 'contract-1',
      eventId: 'event-1',
      sequence: 1,
      timestamp: new Date().toISOString(),
      type: 'CONTRACT_CREATED',
      payload: { amount: 100 },
      eventKey: 'contract-1:event-1:1',
      receivedAt: new Date().toISOString(),
    };

    await repository.saveEvent(event);
    await repository.saveAuditLog({
      eventKey: 'contract-1:event-1:1',
      status: 'accepted',
      receivedAt: new Date().toISOString(),
    });

    const stats = repository.getStats();

    expect(stats.totalEvents).toBe(1);
    expect(stats.totalAuditLogs).toBe(1);
    expect(stats.uniqueContracts).toBe(1);
    expect(stats.acceptedEvents).toBe(1);
  });

  it('clears all data correctly', async () => {
    const event: PersistedContractEvent = {
      contractId: 'contract-1',
      eventId: 'event-1',
      sequence: 1,
      timestamp: new Date().toISOString(),
      type: 'CONTRACT_CREATED',
      payload: { amount: 100 },
      eventKey: 'contract-1:event-1:1',
      receivedAt: new Date().toISOString(),
    };

    await repository.saveEvent(event);
    await repository.saveAuditLog({
      eventKey: 'contract-1:event-1:1',
      status: 'accepted',
      receivedAt: new Date().toISOString(),
    });

    repository.clear();

    const stats = repository.getStats();
    expect(stats.totalEvents).toBe(0);
    expect(stats.totalAuditLogs).toBe(0);
  });
});