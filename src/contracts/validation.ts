import { ContractEvent } from './types';
import {
  EnvelopeValidationOptions,
  validateEventEnvelopePreamble,
} from '../shared/eventEnvelopeValidation';

type ValidationResult =
  | { ok: true; event: ContractEvent }
  | { ok: false; reason: string };

const EVENT_TYPES = new Set<ContractEvent['type']>([
  'CONTRACT_CREATED',
  'CONTRACT_FUNDED',
  'MILESTONE_RELEASED',
  'CONTRACT_COMPLETED',
  'CONTRACT_CANCELLED',
]);

/**
 * Preamble options for the contract-event validator.
 * Mirrors the inline behaviour that used to live here:
 * - short-circuit on first failure (`abortEarly: true`)
 * - ISO-string timestamps only (`timestampRule: 'iso'`)
 * - no trailing-period punctuation on messages
 */
const CONTRACT_PREAMBLE_OPTIONS = {
  rootErrorMessage: 'Payload must be a JSON object',
  messageSuffix: '',
  timestampRule: 'iso',
  abortEarly: true,
} satisfies EnvelopeValidationOptions;

/**
 * @notice Validates and normalizes unknown payloads into a strict contract event.
 * @dev    The per-field preamble is delegated to the shared envelope validator
 *         so the dispute-event ingestion path can reuse the exact same checks.
 *         The `type` whitelist and event-payload shape remain specific to
 *         contract ingestion.
 */
export function validateContractEventPayload(payload: unknown): ValidationResult {
  const errors = validateEventEnvelopePreamble(payload, CONTRACT_PREAMBLE_OPTIONS);
  if (errors.length > 0) {
    return { ok: false, reason: errors[0].message };
  }

  // `validateEventEnvelopePreamble` already enforces isRecord + per-field
  // types. The casts below are safe because the helper has just validated
  // each destructured field against its expected predicate.
  const checked = payload as Record<string, unknown>;

  if (
    typeof checked.type !== 'string' ||
    !EVENT_TYPES.has(checked.type as ContractEvent['type'])
  ) {
    return { ok: false, reason: 'type is invalid' };
  }

  return {
    ok: true,
    event: {
      contractId: (checked.contractId as string).trim(),
      eventId: (checked.eventId as string).trim(),
      sequence: checked.sequence as number,
      timestamp: checked.timestamp as string,
      type: checked.type as ContractEvent['type'],
      payload: checked.payload as Record<string, unknown>,
    },
  };
}