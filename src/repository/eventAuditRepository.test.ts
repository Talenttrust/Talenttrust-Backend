import { InMemoryEventAuditRepository, EventAuditService } from './eventAuditRepository';

describe('EventAuditService idempotency payload hashing', () => {
  const event = {
    contractId: 'contract_123',
    eventId: 'event_456',
    sequence: 1,
    timestamp: Date.now(),
    payload: { nested: { b: 2, a: 1 }, token: 'secret' },
  };

  it('accepts first-write event ingestion and stores the payload hash', async () => {
    const repository = new InMemoryEventAuditRepository();
    const service = new EventAuditService(repository);

    const result = await service.processEvent(event, 'talent_contract');
    const audit = await repository.findByDeduplicationKey('contract_123:event_456:1');

    expect(result.status).toBe('accepted');
    expect(audit?.payloadHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('returns the cached duplicate result when a reused key has the same canonical payload', async () => {
    const repository = new InMemoryEventAuditRepository();
    const service = new EventAuditService(repository);

    await service.processEvent(event, 'talent_contract');
    const duplicate = await service.processEvent(
      {
        ...event,
        payload: { token: 'secret', nested: { a: 1, b: 2 } },
      },
      'talent_contract',
    );

    expect(duplicate).toMatchObject({
      deduplicationKey: 'contract_123:event_456:1',
      status: 'duplicate',
    });
  });

  it('rejects conflicting payloads under the same key with a safe 409 result', async () => {
    const repository = new InMemoryEventAuditRepository();
    const logger = { warn: jest.fn() };
    const service = new EventAuditService(repository, logger);

    await service.processEvent(event, 'talent_contract');
    const conflict = await service.processEvent(
      {
        ...event,
        payload: { nested: { a: 1, b: 3 }, token: 'changed' },
      },
      'talent_contract',
    );

    expect(conflict).toMatchObject({
      deduplicationKey: 'contract_123:event_456:1',
      status: 'rejected',
      statusCode: 409,
      code: 'IDEMPOTENCY_PAYLOAD_CONFLICT',
    });
    expect(conflict.reason).not.toContain('changed');
    expect(logger.warn).toHaveBeenCalledWith(
      'Rejected conflicting event idempotency replay',
      expect.objectContaining({
        deduplicationKey: 'contract_123:event_456:1',
        receivedPayload: '[REDACTED_PAYLOAD]',
      }),
    );
  });
});
