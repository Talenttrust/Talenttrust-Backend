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
 * @notice Validates contract ID format (alphanumeric with hyphens/underscores).
 */
function validateContractIdFormat(contractId: string): boolean {
  const contractIdPattern = /^[a-zA-Z0-9_-]+$/;
  return contractIdPattern.test(contractId);
}

/**
 * @notice Validates event ID format (alphanumeric with hyphens/underscores).
 */
function validateEventIdFormat(eventId: string): boolean {
  const eventIdPattern = /^[a-zA-Z0-9_-]+$/;
  return eventIdPattern.test(eventId);
}

/**
 * @notice Validates timestamp range (not too old or too far in future).
 */
function validateTimestampRange(timestamp: string): { valid: boolean; reason?: string } {
  const eventTime = new Date(timestamp).getTime();
  const now = Date.now();
  const fiveMinutes = 5 * 60 * 1000;
  const twentyFourHours = 24 * 60 * 60 * 1000;
  
  if (eventTime > now + fiveMinutes) {
    return { valid: false, reason: 'timestamp is too far in the future' };
  }
  
  if (eventTime < now - twentyFourHours) {
    return { valid: false, reason: 'timestamp is too old' };
  }
  
  return { valid: true };
}

/**
 * @notice Validates payload size (max 10KB).
 */
function validatePayloadSize(payload: Record<string, unknown>): { valid: boolean; reason?: string } {
  const payloadSize = JSON.stringify(payload).length;
  if (payloadSize > 10 * 1024) {
    return { valid: false, reason: 'payload too large (max 10KB)' };
  }
  return { valid: true };
}

/**
 * @notice Validates and normalizes unknown payloads into a strict contract event.
 * @dev Implements comprehensive validation with security constraints.
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

  // Additional security validations
  const trimmedContractId = contractId.trim();
  const trimmedEventId = eventId.trim();

  if (!validateContractIdFormat(trimmedContractId)) {
    return { ok: false, reason: 'contractId contains invalid characters' };
  }

  if (!validateEventIdFormat(trimmedEventId)) {
    return { ok: false, reason: 'eventId contains invalid characters' };
  }

  const timestampValidation = validateTimestampRange(timestamp);
  if (!timestampValidation.valid) {
    return { ok: false, reason: timestampValidation.reason || 'Invalid timestamp' };
  }

  const payloadSizeValidation = validatePayloadSize(eventPayload);
  if (!payloadSizeValidation.valid) {
    return { ok: false, reason: payloadSizeValidation.reason || 'Invalid payload' };
  }

  // Validate length constraints
  if (trimmedContractId.length > 255) {
    return { ok: false, reason: 'contractId too long (max 255 characters)' };
  }

  if (trimmedEventId.length > 255) {
    return { ok: false, reason: 'eventId too long (max 255 characters)' };
  }

  return {
    ok: true,
    event: {
      contractId: trimmedContractId,
      eventId: trimmedEventId,
      sequence,
      timestamp: new Date(timestamp).toISOString(), // Normalize to ISO format
      type: type as ContractEvent['type'],
      payload: eventPayload,
    },
  };
}

/**
 * @notice Validates payload structure without strict security constraints.
 * @dev Used for testing and development environments.
 */
export function validateContractEventPayloadLenient(payload: unknown): ValidationResult {
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
      timestamp: new Date(timestamp).toISOString(),
      type: type as ContractEvent['type'],
      payload: eventPayload,
    },
  };
}