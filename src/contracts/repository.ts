import { PersistedContractEvent } from './types';

/**
 * @notice Persistence interface for contract events.
 * @dev Concrete implementations can swap in durable storage without changing semantics.
 */
export interface ContractEventRepository {
  hasEventKey(eventKey: string): Promise<boolean>;
  saveEvent(event: PersistedContractEvent): Promise<void>;
  listEvents(): Promise<PersistedContractEvent[]>;
}

/**
 * @notice In-memory repository used for deterministic tests and local development.
 */
export class InMemoryContractEventRepository implements ContractEventRepository {
  private readonly eventsByKey = new Map<string, PersistedContractEvent>();

  async hasEventKey(eventKey: string): Promise<boolean> {
    return this.eventsByKey.has(eventKey);
  }

  async saveEvent(event: PersistedContractEvent): Promise<void> {
    this.eventsByKey.set(event.eventKey, event);
  }

  async listEvents(): Promise<PersistedContractEvent[]> {
    return Array.from(this.eventsByKey.values());
  }
}