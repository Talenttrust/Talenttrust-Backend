/**
 * @notice Canonical contract event accepted by the ingestion pipeline.
 * @dev This shape is intentionally strict to keep dedupe semantics deterministic.
 */
export interface ContractEvent {
  contractId: string;
  eventId: string;
  sequence: number;
  timestamp: string;
  type:
    | 'CONTRACT_CREATED'
    | 'CONTRACT_FUNDED'
    | 'CONTRACT_COMPLETED'
    | 'CONTRACT_CANCELLED';
  payload: Record<string, unknown>;
}

/**
 * @notice Persisted representation of an ingested event.
 * @dev `eventKey` is the dedupe key and `receivedAt` is server ingestion time.
 */
export interface PersistedContractEvent extends ContractEvent {
  eventKey: string;
  receivedAt: string;
}

export type IngestStatus = 'accepted' | 'duplicate' | 'invalid';

/**
 * @notice Result contract returned from event ingestion.
 */
export interface IngestResult {
  status: IngestStatus;
  eventKey?: string;
  reason?: string;
}