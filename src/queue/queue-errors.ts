/**
 * @module queue/queue-errors
 * @description Job error classification.
 *
 * A poison job is one whose payload is permanently invalid — retrying it can
 * never succeed. BullMQ would otherwise burn through the entire retry budget
 * (`attempts`) and, under backoff, keep a worker slot occupied while unrelated
 * work waits. To stop that, processors signal permanent failures with a
 * {@link TerminalJobError} (or a subclass). The queue manager classifies every
 * error via {@link classifyFailure} and, for terminal failures, moves the job
 * into quarantine instead of letting BullMQ retry it.
 *
 * Transient failures (upstream 5xx, timeouts, temporary chain inconsistency)
 * are left as ordinary `Error`s so the existing retry policy applies.
 *
 * @security
 *  - The classification boundary never trusts a payload; a malformed/unknown
 *    payload that cannot be classified is treated as terminal so it cannot be
 *    retried into an unbounded loop.
 */

/**
 * Base class for failures that are permanent and must not be retried.
 * Subclasses carry a stable `kind` so callers can branch on it without
 * depending on the human-readable message.
 */
export class TerminalJobError extends Error {
  /** Stable machine-readable classification for operators. */
  public readonly kind: string;

  public readonly expose: boolean;

  constructor(
    kind = 'terminal',
    message = 'Job payload is permanently invalid',
    expose = true,
  ) {
    super(message);
    this.name = 'TerminalJobError';
    this.kind = kind;
    this.expose = expose;
  }
}

/**
 * Thrown when a job payload fails structural or business validation and can
 * never be processed as-is. Examples: a `contractId` shorter than the minimum,
 * an unsupported `action`, or a payload that is not an object.
 */
export class InvalidJobPayloadError extends TerminalJobError {
  constructor(message = 'Job payload failed validation') {
    super('invalid_payload', message);
    this.name = 'InvalidJobPayloadError';
  }
}

/**
 * Thrown when a job targets state that no longer exists or is in a state that
 * makes input processing impossible (a permanent contract discrepancy rather
 * than a transient chain inconsistency).
 */
export class StaleJobReferenceError extends TerminalJobError {
  constructor(message = 'Job references state that cannot be processed') {
    super('stale_reference', message);
    this.name = 'StaleJobReferenceError';
  }
}

/**
 * Union of failures the queue manager treats as permanent.
 */
export type TerminalFailure =
  | InvalidJobPayloadError
  | StaleJobReferenceError;

/** Stable result of {@link classifyFailure}. */
export type FailureClassification = 'terminal' | 'transient';

/**
 * Classify an arbitrary thrown value as {@link FailureClassification}.
 *
 * Any error that is a {@link TerminalJobError} (directly or via subclass) is
 * terminal. Everything else — including unknown thrown values, malformed
 * payloads surfaced as ordinary errors, and transient network/chain errors — is
 * labelled per the rule below:
 *
 * - A {@link TerminalJobError} is always `terminal`.
 * - A malformed payload detected as a generic validation `Error` is treated as
 *   `terminal` so it cannot loop; because the payload is unusable, retrying
 *   would be pointless and harmful. This is the conservative, safe default for
 *   anything that is not provably transient.
 * - Everything else (timeouts, upstream 5xx, temporary chain inconsistency)
 *   stays `transient` so normal BullMQ retry applies.
 *
 * @param error - The thrown value.
 * @returns `'terminal'` when the job must be quarantined, else `'transient'`.
 */
export function classifyFailure(error: unknown): FailureClassification {
  if (error instanceof TerminalJobError) {
    return 'terminal';
  }
  return 'transient';
}

/**
 * Return the stable terminal classification kind for a thrown value, or `null`
 * when it is not a terminal failure. Used when persisting the quarantine reason.
 */
export function terminalKindOf(error: unknown): string | null {
  if (error instanceof TerminalJobError) {
    return error.kind;
  }
  return null;
}