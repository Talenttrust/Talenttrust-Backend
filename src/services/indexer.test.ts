import { EventIndexerService, EventType, SmartContractEvent } from './indexer';

describe('EventIndexerService', () => {
  let indexer: EventIndexerService;

  beforeEach(() => {
    indexer = new EventIndexerService();
  });

  const sampleEvent: SmartContractEvent = {
    contractId: '0x123',
    eventType: EventType.EscrowCreated,
    payload: { amount: 100 },
    timestamp: new Date().toISOString()
  };

  it('should process and index an event', async () => {
    const result = await indexer.processEvent(sampleEvent);
    expect(result.status).toBe('indexed');
    expect(indexer.getEvents()).toHaveLength(1);
    expect(indexer.getEvents()[0]).toMatchObject(sampleEvent);
  });

  it('should filter events by contractId', async () => {
    await indexer.processEvent(sampleEvent);
    await indexer.processEvent({
      ...sampleEvent,
      contractId: '0x456',
      eventType: EventType.DisputeInitiated
    });

    const result = indexer.getEventsByContractId('0x123');
    expect(result).toHaveLength(1);
    expect(result[0].contractId).toBe('0x123');
  });

  it('should throw error for invalid event data', async () => {
    const invalidEvent = { ...sampleEvent, eventType: undefined } as any;
    await expect(indexer.processEvent(invalidEvent)).rejects.toThrow('Invalid event data');
  });

  it('should correctly process different event types', async () => {
    const consoleSpy = jest.spyOn(console, 'log');
    
    await indexer.processEvent({
      ...sampleEvent,
      eventType: EventType.DisputeInitiated
    });
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[Indexer] Dispute initiated'));

    await indexer.processEvent({
      ...sampleEvent,
      eventType: EventType.DisputeResolved
    });
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[Indexer] Dispute resolved'));

    consoleSpy.mockRestore();
  });
});
