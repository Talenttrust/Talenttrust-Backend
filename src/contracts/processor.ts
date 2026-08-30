import { buildEventKey } from './dedupe';
import { ContractEventRepository } from './repository';
import { IngestResult, PersistedContractEvent } from './types';
import { validateContractEventPayload } from './validation';

interface Checkpoint {
  network: string;
  contract: string;
  ledger: string;
  sequence: number;
}

type CheckpointRepository = {
  getCheckpoint(network: string, contract: string): Promise<Checkpoint | null>;
  saveCheckpoint(checkpoint: Checkpoint): Promise<void>;
};

/**
 * @notice Coordinates validation, dedupe, and persistence for inbound events.
 */
export class ContractEventProcessor {
  constructor(private readonly repository: ContractEventRepository) {}

  private get checkpointRepository(): ContractEventRepository & CheckpointRepository {
    return this.repository as ContractEventRepository & CheckpointRepository;
  }

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

    // Advance the checkpoint for this contract network only after the event is successfully persisted.
    // We only move the checkpoint forward to avoid regressing on out-of-order or reorged payloads.
    const { network, contract, ledger, sequence } = validation.event;
    try {
      const currentCheckpoint = await this.checkpointRepository.getCheckpoint(network, contract);
      if (currentCheckpoint === null || sequence > currentCheckpoint.sequence) {
        await this.checkpointRepository.saveCheckpoint({
          network,
          contract,
          ledger,
          sequence,
        });
      }
    } catch (error) {
      // The event is already committed; a checkpoint lag will be repaired on resume via dedupe.
      // Log structured diagnostics without leaking secrets.
      console.error('Failed to advance event-indexer checkpoint', {
        network,
        contract,
        ledger,
        sequence,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return {
      status: 'accepted',
      eventKey,
    };
  }

  async getCheckpoint(network: string, contract: string): Promise<Checkpoint | null> {
    return this.checkpointRepository.getCheckpoint(network, contract);
  }

  async listEvents(): Promise<PersistedContractEvent[]> {
    return this.repository.listEvents();
  }
}
