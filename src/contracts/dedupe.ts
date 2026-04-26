import { ContractEvent } from './types';

/**
 * @notice Builds the canonical dedupe key used across ingestion and persistence.
 * @dev Format: contractId:eventId:sequence
 */
export function buildEventKey(event: ContractEvent): string {
  return `${event.contractId}:${event.eventId}:${event.sequence}`;
}

/**
 * @notice Builds a stable hash-based dedupe key for enhanced security.
 * @dev Uses simple string hashing as fallback when crypto is unavailable.
 */
export function buildHashedEventKey(event: ContractEvent): string {
  const keyString = buildEventKey(event);
  // Simple hash function as fallback
  let hash = 0;
  for (let i = 0; i < keyString.length; i++) {
    const char = keyString.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(16);
}

/**
 * @notice Validates the format of an event key.
 * @dev Ensures the key follows the expected contractId:eventId:sequence format.
 */
export function validateEventKeyFormat(eventKey: string): boolean {
  const parts = eventKey.split(':');
  if (parts.length !== 3) return false;
  
  const [contractId, eventId, sequenceStr] = parts;
  
  // Validate contractId and eventId are non-empty alphanumeric strings
  const idPattern = /^[a-zA-Z0-9_-]+$/;
  if (!idPattern.test(contractId) || !idPattern.test(eventId)) return false;
  
  // Validate sequence is a non-negative integer
  const sequence = parseInt(sequenceStr, 10);
  if (isNaN(sequence) || sequence < 0) return false;
  
  return true;
}

/**
 * @notice Extracts components from an event key.
 * @dev Returns null if the key format is invalid.
 */
export function parseEventKey(eventKey: string): { contractId: string; eventId: string; sequence: number } | null {
  if (!validateEventKeyFormat(eventKey)) return null;
  
  const [contractId, eventId, sequenceStr] = eventKey.split(':');
  return {
    contractId,
    eventId,
    sequence: parseInt(sequenceStr, 10),
  };
}