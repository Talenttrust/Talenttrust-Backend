/**
 * reputationConfig.ts — Configuration for the reputation upstream client.
 *
 * Defines retry and circuit-breaker parameters for outbound HTTP calls to
 * an external reputation service. Validated at startup via Zod so
 * misconfiguration fails fast.
 *
 * ## Environment variables
 *
 * ### Retry
 *  - `REPUTATION_CLIENT_MAX_ATTEMPTS`       total attempts (default 3)
 *  - `REPUTATION_CLIENT_BASE_DELAY_MS`      initial backoff in ms (default 200)
 *  - `REPUTATION_CLIENT_MAX_DELAY_MS`       backoff cap in ms (default 5000)
 *
 * ### Circuit breaker
 *  - `REPUTATION_CLIENT_CB_FAILURE_THRESHOLD` consecutive failures to trip (default 5)
 *  - `REPUTATION_CLIENT_CB_SUCCESS_THRESHOLD` consecutive successes to close (default 1)
 *  - `REPUTATION_CLIENT_CB_TIMEOUT_MS`        cooldown in ms (default 30_000)
 */

import { z } from 'zod';

/** Resolved, validated configuration for the reputation upstream client. */
export interface ReputationClientConfig {
  /** Base URL of the external reputation service. */
  baseUrl: string;
  /** Per-request timeout in ms. */
  timeoutMs: number;
  /** Retry: total attempts including the first try. */
  maxAttempts: number;
  /** Retry: initial backoff delay in ms. */
  baseDelayMs: number;
  /** Retry: upper bound for any single backoff sleep in ms. */
  maxDelayMs: number;
  /** Circuit breaker: consecutive failures before tripping to OPEN. */
  cbFailureThreshold: number;
  /** Circuit breaker: consecutive successes in HALF_OPEN before CLOSED. */
  cbSuccessThreshold: number;
  /** Circuit breaker: cooldown in ms before transitioning OPEN → HALF_OPEN. */
  cbTimeoutMs: number;
}

/** Safe defaults applied when an env var is absent. */
export const DEFAULT_REPUTATION_CLIENT_CONFIG: ReputationClientConfig = {
  baseUrl: 'https://example.invalid/reputation',
  timeoutMs: 5_000,
  maxAttempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 5_000,
  cbFailureThreshold: 5,
  cbSuccessThreshold: 1,
  cbTimeoutMs: 30_000,
};

const envSchema = z.object({
  REPUTATION_CLIENT_BASE_URL: z.string().default(DEFAULT_REPUTATION_CLIENT_CONFIG.baseUrl),
  REPUTATION_CLIENT_TIMEOUT_MS: z
    .string()
    .default(String(DEFAULT_REPUTATION_CLIENT_CONFIG.timeoutMs))
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().int().positive().max(120_000)),
  REPUTATION_CLIENT_MAX_ATTEMPTS: z
    .string()
    .default(String(DEFAULT_REPUTATION_CLIENT_CONFIG.maxAttempts))
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().int().min(1).max(20)),
  REPUTATION_CLIENT_BASE_DELAY_MS: z
    .string()
    .default(String(DEFAULT_REPUTATION_CLIENT_CONFIG.baseDelayMs))
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().int().nonnegative().max(60_000)),
  REPUTATION_CLIENT_MAX_DELAY_MS: z
    .string()
    .default(String(DEFAULT_REPUTATION_CLIENT_CONFIG.maxDelayMs))
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().int().nonnegative().max(60_000)),
  REPUTATION_CLIENT_CB_FAILURE_THRESHOLD: z
    .string()
    .default(String(DEFAULT_REPUTATION_CLIENT_CONFIG.cbFailureThreshold))
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().int().min(1).max(100)),
  REPUTATION_CLIENT_CB_SUCCESS_THRESHOLD: z
    .string()
    .default(String(DEFAULT_REPUTATION_CLIENT_CONFIG.cbSuccessThreshold))
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().int().min(1).max(20)),
  REPUTATION_CLIENT_CB_TIMEOUT_MS: z
    .string()
    .default(String(DEFAULT_REPUTATION_CLIENT_CONFIG.cbTimeoutMs))
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().int().min(1_000).max(300_000)),
}).superRefine((obj, ctx) => {
  if (obj.REPUTATION_CLIENT_MAX_DELAY_MS < obj.REPUTATION_CLIENT_BASE_DELAY_MS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['REPUTATION_CLIENT_MAX_DELAY_MS'],
      message: 'REPUTATION_CLIENT_MAX_DELAY_MS must be >= REPUTATION_CLIENT_BASE_DELAY_MS',
    });
  }
});

/**
 * Loads and validates reputation client configuration.
 *
 * Missing env vars fall back to safe defaults. Invalid values throw.
 */
export function loadReputationClientConfig(
  env: NodeJS.ProcessEnv = process.env,
): ReputationClientConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.errors
      .map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`)
      .join('; ');
    throw new Error(`Invalid reputation client configuration: ${issues}`);
  }
  const r = parsed.data;
  return Object.freeze({
    baseUrl: r.REPUTATION_CLIENT_BASE_URL,
    timeoutMs: r.REPUTATION_CLIENT_TIMEOUT_MS,
    maxAttempts: r.REPUTATION_CLIENT_MAX_ATTEMPTS,
    baseDelayMs: r.REPUTATION_CLIENT_BASE_DELAY_MS,
    maxDelayMs: r.REPUTATION_CLIENT_MAX_DELAY_MS,
    cbFailureThreshold: r.REPUTATION_CLIENT_CB_FAILURE_THRESHOLD,
    cbSuccessThreshold: r.REPUTATION_CLIENT_CB_SUCCESS_THRESHOLD,
    cbTimeoutMs: r.REPUTATION_CLIENT_CB_TIMEOUT_MS,
  }) as ReputationClientConfig;
}