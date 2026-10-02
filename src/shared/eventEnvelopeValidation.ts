/**
 * @title Event envelope validation
 * @notice Shared validation preamble for inbound event payloads
 *         (used by contract-event ingestion and dispute-event ingestion).
 * @dev    Behaviour-preserving extraction of the per-field preamble that was
 *         previously duplicated inline in
 *         {@link validateContractEventPayload} (`src/contracts/validation.ts`)
 *         and {@link EventIngestionService.validateEvent}
 *         (`src/events/eventIngestionService.ts`).
 *
 *         Callers opt into the exact behaviour they previously relied on by
 *         passing:
 *         - `timestampRule` – `'iso'` for ISO-string-only timestamps
 *           (contract ingestion) and `'numeric'` for numeric-or-numeric-string
 *           timestamps (event ingestion service).
 *         - `messageSuffix` – the punctuation appended to every per-field
 *           message (no suffix for contracts, trailing `.` for events).
 *         - `rootErrorMessage` – the final message used when the input itself
 *           is not a JSON object; callers pass the fully-formed string
 *           (e.g. `'Payload must be a JSON object'`,
 *           `'Event must be a JSON object.'`).
 *         - `abortEarly` – `true` for short-circuit on first failure (used by
 *           the contracts validator to fail-fast), `false` to collect every
 *           per-field error (used by the events validator).
 *
 *         The helper is intentionally lightweight: it does not enforce
 *         trim-normalised values, and it does not run any caller-specific
 *         follow-up checks (e.g. `type` whitelist, age check, contract-type
 *         specific payload validation). Those remain the callers'
 *         responsibility.
 */

/**
 * @notice Per-field validation error produced by {@link validateEventEnvelopePreamble}.
 */
export interface FieldError {
  field: string;
  message: string;
}

/**
 * @notice Behaviour-shaping options for {@link validateEventEnvelopePreamble}.
 */
export interface EnvelopeValidationOptions {
  /**
   * Final error message used when `value` is not a JSON object. The helper
   * consumes this string verbatim — it does NOT append `messageSuffix`.
   */
  rootErrorMessage: string;
  /**
   * Suffix appended to every per-field message (e.g. trailing `.`).
   * Leave empty (`''`) for callers that do not suffix their messages.
   */
  messageSuffix: string;
  /**
   * How `timestamp` is checked:
   * - `'iso'`: must be a string parseable by `Date.parse`.
   * - `'numeric'`: must be a finite number or a non-empty numeric string.
   */
  timestampRule: 'iso' | 'numeric';
  /**
   * When `true`, the helper short-circuits on the first failing field
   * (contracts-style fail-fast). When `false`, every field is checked
   * and all matching errors are returned (events-style accumulation).
   */
  abortEarly: boolean;
}

/**
 * @notice Type guard used by every envelope validator.
 * @dev    Arrays are intentionally excluded — an array is a valid JS object
 *         but not a valid envelope-shaped payload for either caller.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Coerce `value` into a finite number, or return `null` if not possible.
 * Accepts finite numbers directly and non-empty numeric strings.
 */
function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * @notice Validate the standard event-envelope preamble.
 *
 * @param value   The unknown inbound payload.
 * @param options Behaviour-shaping options (see {@link EnvelopeValidationOptions}).
 * @returns       A list of field-level errors. An empty list means the
 *                envelope passed every preamble check.
 */
export function validateEventEnvelopePreamble(
  value: unknown,
  options: EnvelopeValidationOptions,
): FieldError[] {
  const errors: FieldError[] = [];

  if (!isRecord(value)) {
    errors.push({ field: 'event', message: options.rootErrorMessage });
    // Root failures make per-field reads meaningless; return regardless
    // of `abortEarly` to prevent spurious runtime errors.
    return errors;
  }

  const { contractId, eventId, sequence, timestamp, payload } = value;

  // contractId: non-empty string
  if (typeof contractId !== 'string' || contractId.trim().length === 0) {
    errors.push({
      field: 'contractId',
      message: 'contractId is required' + options.messageSuffix,
    });
    if (options.abortEarly) return errors;
  }

  // eventId: non-empty string
  if (typeof eventId !== 'string' || eventId.trim().length === 0) {
    errors.push({
      field: 'eventId',
      message: 'eventId is required' + options.messageSuffix,
    });
    if (options.abortEarly) return errors;
  }

  // sequence: non-negative integer
  if (typeof sequence !== 'number' || !Number.isInteger(sequence) || sequence < 0) {
    errors.push({
      field: 'sequence',
      message: 'sequence must be a non-negative integer' + options.messageSuffix,
    });
    if (options.abortEarly) return errors;
  }

  // timestamp
  if (options.timestampRule === 'iso') {
    if (typeof timestamp !== 'string' || Number.isNaN(Date.parse(timestamp))) {
      errors.push({
        field: 'timestamp',
        message: 'timestamp must be a valid ISO string' + options.messageSuffix,
      });
      if (options.abortEarly) return errors;
    }
  } else {
    const parsed = toFiniteNumber(timestamp);
    if (parsed === null) {
      errors.push({
        field: 'timestamp',
        message:
          'timestamp must be a valid epoch number or numeric string' +
          options.messageSuffix,
      });
      if (options.abortEarly) return errors;
    }
  }

  // payload: object
  if (!isRecord(payload)) {
    errors.push({
      field: 'payload',
      message: 'payload must be an object' + options.messageSuffix,
    });
    if (options.abortEarly) return errors;
  }

  return errors;
}
