import { createHash, timingSafeEqual } from 'crypto';
import { ContractEvent, JsonValue } from '../events/types';

export class DeduplicationManager {
  /**
   * Computes a stable deduplication key for a contract event
   * Format: contractId:eventId:sequence
   * @param event The contract event to compute key for
   * @returns Stable deduplication key string
   */
  static computeDeduplicationKey(event: ContractEvent): string {
    const keyComponents = [
      event.contractId,
      event.eventId,
      event.sequence.toString()
    ];
    
    return keyComponents.join(':');
  }

  /**
   * Computes a hash of the event payload for integrity verification
   * @param payload The event payload
   * @returns SHA-256 hash of the payload
   */
  static computePayloadHash(payload: JsonValue): string {
    return createHash('sha256').update(canonicalize(payload)).digest('hex');
  }

  /**
   * Validates that an event's payload hasn't been tampered with
   * @param event The contract event
   * @param expectedHash The expected payload hash
   * @returns True if payload matches expected hash
   */
  static validatePayloadIntegrity(event: ContractEvent, expectedHash: string): boolean {
    const actualHash = this.computePayloadHash(event.payload);
    return this.comparePayloadHashes(actualHash, expectedHash);
  }

  /**
   * Compares two payload hashes without data-dependent string comparison timing.
   * @param actualHash The hash computed from the received payload
   * @param expectedHash The hash stored for the idempotency key
   * @returns True when both hashes are identical SHA-256 digests
   */
  static comparePayloadHashes(actualHash: string, expectedHash: string): boolean {
    const actualBuffer = Buffer.from(actualHash, 'hex');
    const expectedBuffer = Buffer.from(expectedHash, 'hex');

    if (actualBuffer.length !== expectedBuffer.length) {
      timingSafeEqual(actualBuffer, actualBuffer);
      return false;
    }

    return timingSafeEqual(actualBuffer, expectedBuffer);
  }

  /**
   * Extracts components from a deduplication key
   * @param deduplicationKey The deduplication key to parse
   * @returns Object with contractId, eventId, and sequence
   */
  static parseDeduplicationKey(deduplicationKey: string): {
    contractId: string;
    eventId: string;
    sequence: number;
  } {
    const [contractId, eventId, sequenceStr] = deduplicationKey.split(':');
    
    return {
      contractId,
      eventId,
      sequence: parseInt(sequenceStr, 10)
    };
  }

  /**
   * Checks if two events represent the same logical event
   * @param event1 First event
   * @param event2 Second event
   * @returns True if events are duplicates
   */
  static areEventsDuplicates(event1: ContractEvent, event2: ContractEvent): boolean {
    return this.computeDeduplicationKey(event1) === this.computeDeduplicationKey(event2);
  }
}

function canonicalize(value: JsonValue): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  }

  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`)
    .join(',')}}`;
}
