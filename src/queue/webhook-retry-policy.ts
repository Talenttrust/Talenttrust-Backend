/**
 * Failed webhooks are persisted to SQLite with deduplication
 * keys and a retry policy that applies exponential backoff with jitter.
 * 
 * Retry/backoff policy for webhook delivery:
 * - Max 5 retry attempts
 * - Exponential backoff starting at 1 second, doubling each attempt
 * - Jitter of 10% to prevent thundering herd
 * - Total timeout window of ~30 seconds before moving to DLQ
 */

export const WEBHOOK_RETRY_POLICY = {
  maxRetries: 5,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  multiplier: 2,
  jitter: 0.1,
} as const;

export type WebhookRetryPolicy = typeof WEBHOOK_RETRY_POLICY;

/**
 * Calculate the delay for the next retry attempt using exponential backoff with jitter.
 */
export function calculateWebhookRetryDelay(attemptNumber: number): number {
  const { initialDelayMs, multiplier, jitter, maxDelayMs } = WEBHOOK_RETRY_POLICY;
  
  let delay = initialDelayMs * Math.pow(multiplier, attemptNumber);
  delay = Math.min(delay, maxDelayMs);
  
  const jitterAmount = delay * jitter * Math.random();
  const jitterOffset = Math.random() < 0.5 ? -jitterAmount : jitterAmount;
  
  return Math.max(100, Math.round(delay + jitterOffset));
}