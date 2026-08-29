/**
 * Retry/backoff policy for webhook delivery:
 * - Bounded attempts with exponential backoff and jitter
 * - Configurable via environment variables; safe defaults when unset
 *
 * ## Attempt semantics
 * `maxAttempts` is the total number of delivery attempts *including* the
 * initial attempt. The first attempt is never preceded by a backoff; only
 * subsequent (retry) attempts incur a delay.
 *
 * ## Backoff
 * Exponential backoff starts at `initialDelayMs`, doubling each retry up to
 * `maxDelayMs`, plus up to `jitterFactor` (±) to prevent thundering herds.
 *
 * ## Configuration
 * | Variable                      | Default | Range             | Description                                |
 * |-------------------------------|---------|-------------------|--------------------------------------------|
 * | `WEBHOOK_RETRY_MAX_ATTEMPTS`  | 6       | 1 – 100           | Total attempts including the initial one.  |
 * | `WEBHOOK_RETRY_INITIAL_DELAY_MS` | 1000  | 100 – 60000       | Initial retry delay in ms.                 |
 * | `WEBHOOK_RETRY_MAX_DELAY_MS`  | 30000   | 1000 – 600000     | Cap on exponential backoff in ms.          |
 * | `WEBHOOK_RETRY_MULTIPLIER`    | 2       | 1 – 10            | Exponential backoff multiplier.            |
 * | `WEBHOOK_RETRY_JITTER_FACTOR` | 0.1     | 0 – 1             | Jitter offset (+/-) as a fraction.         |
 *
 * Invalid/out-of-range values are clamped to the allowed range rather than
 * silently producing nonsensical retry settings (e.g. negative delays, zero
 * attempts, or a multiplier of 0).
 */

const DEFAULTS = {
  maxAttempts: 6, // 5 retries after the initial attempt (backwards compatible)
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  multiplier: 2,
  jitterFactor: 0.1,
} as const;

function toNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function loadRetryPolicy(): {
  maxAttempts: number;
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
  jitter: number;
} {
  const maxAttempts = Math.round(
    clamp(toNumber(process.env.WEBHOOK_RETRY_MAX_ATTEMPTS, DEFAULTS.maxAttempts), 1, 100),
  );
  const initialDelayMs = Math.round(
    clamp(toNumber(process.env.WEBHOOK_RETRY_INITIAL_DELAY_MS, DEFAULTS.initialDelayMs), 100, 60_000),
  );
  const maxDelayMs = Math.round(
    clamp(toNumber(process.env.WEBHOOK_RETRY_MAX_DELAY_MS, DEFAULTS.maxDelayMs), 1_000, 600_000),
  );
  const multiplier = clamp(
    toNumber(process.env.WEBHOOK_RETRY_MULTIPLIER, DEFAULTS.multiplier),
    1,
    10,
  );
  const jitter = clamp(
    toNumber(process.env.WEBHOOK_RETRY_JITTER_FACTOR, DEFAULTS.jitterFactor),
    0,
    1,
  );

  return {
    maxAttempts,
    maxRetries: maxAttempts - 1,
    initialDelayMs,
    maxDelayMs,
    multiplier,
    jitter,
  };
}

const loaded = loadRetryPolicy();

/**
 * Webhook retry policy resolved at module load from environment variables.
 * `maxRetries` = number of retries after the initial attempt
 * (`maxAttempts - 1`), retained for backward compatibility with code and
 * tests that reason in terms of "retries".
 */
export const WEBHOOK_RETRY_POLICY = {
  maxRetries: loaded.maxRetries,
  maxAttempts: loaded.maxAttempts,
  initialDelayMs: loaded.initialDelayMs,
  maxDelayMs: loaded.maxDelayMs,
  multiplier: loaded.multiplier,
  jitter: loaded.jitter,
} as const;

export type WebhookRetryPolicy = typeof WEBHOOK_RETRY_POLICY;

/**
 * Calculate the delay for the next retry attempt using exponential backoff with jitter.
 *
 * @param attemptNumber - Zero-based index of the *failed* attempt that is about to
 *   be retried (0 = first retry delay).
 */
export function calculateWebhookRetryDelay(attemptNumber: number): number {
  const { initialDelayMs, multiplier, jitter, maxDelayMs } = WEBHOOK_RETRY_POLICY;

  let delay = initialDelayMs * Math.pow(multiplier, attemptNumber);
  delay = Math.min(delay, maxDelayMs);

  const jitterAmount = delay * jitter * Math.random();
  const jitterOffset = Math.random() < 0.5 ? -jitterAmount : jitterAmount;

  return Math.max(100, Math.round(delay + jitterOffset));
}