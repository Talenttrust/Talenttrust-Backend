/**
 * Retry and Backoff Utilities
 *
 * this will provide reusable retry policies for transient failures.
 *
 * @module retry
 */

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: boolean;
  isRetryable?: (error: unknown) => boolean;
  /** Maximum milliseconds to honor from a Retry-After header (safety ceiling). */
  maxRetryAfterMs?: number;
  /** Optional Retry-After header value from upstream response. */
  retryAfterHeader?: string | null;
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxAttempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 5000,
  jitter: true,
  isRetryable: () => true,
  maxRetryAfterMs: 60000,
  retryAfterHeader: null,
};


export function calculateDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitter: boolean
): number {
  const exponential = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
  return jitter ? exponential * (0.5 + Math.random() * 0.5) : exponential;
}

/**
 * Parse an HTTP `Retry-After` header value and return the delay in milliseconds.
 *
 * Supports both delta-seconds and HTTP-date formats.
 * Returns `null` for malformed values.
 *
 * @param headerValue - The raw `Retry-After` header value
 * @param maxRetryAfterMs - Safety ceiling to clamp the result (default 60s)
 * @returns Delay in milliseconds, or `null` if unparseable
 */
export function parseRetryAfter(
  headerValue: string | null | undefined,
  maxRetryAfterMs: number = 60000
): number | null {
  if (!headerValue) return null;

  const trimmed = headerValue.trim();

  // Try delta-seconds format (integer or decimal)
  const delta = parseInt(trimmed, 10);
  if (!isNaN(delta) && delta >= 0 && String(delta) === trimmed) {
    return Math.min(delta * 1000, maxRetryAfterMs);
  }

  // Try HTTP-date format (RFC 1123)
  const parsed = Date.parse(trimmed);
  if (!isNaN(parsed)) {
    const now = Date.now();
    const diff = parsed - now;
    if (diff > 0) {
      return Math.min(diff, maxRetryAfterMs);
    }
    return 0; // date is in the past, no delay needed
  }

  return null; // malformed
}

/**
 * Retries an async operation with exponential backoff.
 *
 * @param fn - The async function to retry
 * @param options - Retry configuration options
 * @returns The resolved value of fn
 * @throws The last error if all attempts fail
 *
 * @example
 * const data = await withRetry(() => fetchFromApi(), { maxAttempts: 5 });
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: unknown;

  for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      const isLastAttempt = attempt === opts.maxAttempts - 1;
      if (isLastAttempt || !opts.isRetryable(error)) {
        throw error;
      }

      // Check for Retry-After header override (takes precedence over backoff)
      const retryAfterMs = parseRetryAfter(opts.retryAfterHeader, opts.maxRetryAfterMs);

      const delay = retryAfterMs !== null
        ? retryAfterMs
        : calculateDelay(attempt, opts.baseDelayMs, opts.maxDelayMs, opts.jitter);
      await sleep(delay);
    }
  }

  throw lastError;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}