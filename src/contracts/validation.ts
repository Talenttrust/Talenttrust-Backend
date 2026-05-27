import { ContractEvent } from './types';

type ValidationResult =
  | { ok: true; event: ContractEvent }
  | { ok: false; reason: string };

const EVENT_TYPES = new Set<ContractEvent['type']>([
  'CONTRACT_CREATED',
  'CONTRACT_FUNDED',
  'CONTRACT_COMPLETED',
  'CONTRACT_CANCELLED',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @notice Validates and normalizes unknown payloads into a strict contract event.
 */
export function validateContractEventPayload(payload: unknown): ValidationResult {
  if (!isRecord(payload)) {
    return { ok: false, reason: 'Payload must be a JSON object' };
  }

  const { contractId, eventId, sequence, timestamp, type, payload: eventPayload } = payload;

  if (typeof contractId !== 'string' || contractId.trim().length === 0) {
    return { ok: false, reason: 'contractId is required' };
  }

  if (typeof eventId !== 'string' || eventId.trim().length === 0) {
    return { ok: false, reason: 'eventId is required' };
  }

  if (typeof sequence !== 'number' || !Number.isInteger(sequence) || sequence < 0) {
    return { ok: false, reason: 'sequence must be a non-negative integer' };
  }

  if (typeof timestamp !== 'string' || Number.isNaN(Date.parse(timestamp))) {
    return { ok: false, reason: 'timestamp must be a valid ISO string' };
  }

  if (typeof type !== 'string' || !EVENT_TYPES.has(type as ContractEvent['type'])) {
    return { ok: false, reason: 'type is invalid' };
  }

  if (!isRecord(eventPayload)) {
    return { ok: false, reason: 'payload must be an object' };
  }

  return {
    ok: true,
    event: {
      contractId: contractId.trim(),
      eventId: eventId.trim(),
      sequence,
      timestamp,
      type: type as ContractEvent['type'],
      payload: eventPayload,
    },
  };
}