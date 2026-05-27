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
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxAttempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 5000,
  jitter: true,
  isRetryable: () => true,
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

      const delay = calculateDelay(
        attempt,
        opts.baseDelayMs,
        opts.maxDelayMs,
        opts.jitter
      );
      await sleep(delay);
    }
  }

  throw lastError;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}