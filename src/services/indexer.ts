export enum EventType {
  EscrowCreated = 'escrow:created',
  EscrowCompleted = 'escrow:completed',
  DisputeInitiated = 'dispute:initiated',
  DisputeResolved = 'dispute:resolved',
}

export interface SmartContractEvent {
  contractId: string;
  eventType: EventType;
  idempotencyKey?: string;
  payload: any;
  timestamp: string;
}

/**
 * Service to index smart contract events
 */
export class EventIndexerService {
  private indexedEvents: Map<string, SmartContractEvent> = new Map();

  constructor() {
    this.indexedEvents = new Map();
  }

  /**
   * Process and index a smart contract event
   */
  public async processEvent(event: SmartContractEvent): Promise<{ status: string; eventId: string }> {
    // Pipeline logic: 
    // 1. Validation (ensure contractId, type exists)
    // 2. Logic to handle specific event types (e.g., escrow or dispute updates)
    // 3. Persist (in-memory for now)
    
    if (!event.contractId || !event.eventType) {
      throw new Error('Invalid event data');
    }

    // Pipeline processing:
    switch (event.eventType) {
      case EventType.EscrowCreated:
        console.log(`[Indexer] New escrow created for contract: ${event.contractId}`);
        break;
      case EventType.DisputeInitiated:
        console.log(`[Indexer] Dispute initiated for contract: ${event.contractId}`);
        break;
      case EventType.DisputeResolved:
        console.log(`[Indexer] Dispute resolved for contract: ${event.contractId}`);
        break;
      default:
        console.log(`[Indexer] Processing generic event: ${event.eventType}`);
    }

    const eventId = `ev-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    this.indexedEvents.set(eventId, event);
    
    return { status: 'indexed', eventId };
  }

  /**
   * Fetch indexed events (for demonstration)
   */
  public getEvents() {
    return Array.from(this.indexedEvents.values());
  }

  /**
   * Fetch specific event by contract ID
   */
  public getEventsByContractId(contractId: string) {
    return Array.from(this.indexedEvents.values()).filter(e => e.contractId === contractId);
  }
}

export const indexerService = new EventIndexerService();
