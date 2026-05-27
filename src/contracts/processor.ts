import { buildEventKey } from './dedupe';
import { ContractEventRepository } from './repository';
import { IngestResult, PersistedContractEvent } from './types';
import { validateContractEventPayload } from './validation';

/**
 * @notice Coordinates validation, dedupe, and persistence for inbound events.
 */
export class ContractEventProcessor {
  constructor(private readonly repository: ContractEventRepository) {}

  async ingest(payload: unknown): Promise<IngestResult> {
    const validation = validateContractEventPayload(payload);
    if (!validation.ok) {
      return {
        status: 'invalid',
        reason: validation.reason,
      };
    }

    const eventKey = buildEventKey(validation.event);
    if (await this.repository.hasEventKey(eventKey)) {
      return {
        status: 'duplicate',
        eventKey,
      };
    }

    const persistedEvent: PersistedContractEvent = {
      ...validation.event,
      eventKey,
      receivedAt: new Date().toISOString(),
    };

    await this.repository.saveEvent(persistedEvent);

    return {
      status: 'accepted',
      eventKey,
    };
  }

  async listEvents(): Promise<PersistedContractEvent[]> {
    return this.repository.listEvents();
  }
}