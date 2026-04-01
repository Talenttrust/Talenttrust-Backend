import { ContractEvent } from './types';

/**
 * @notice Builds the canonical dedupe key used across ingestion and persistence.
 */
export function buildEventKey(event: ContractEvent): string {
  return `${event.contractId}:${event.eventId}:${event.sequence}`;
}