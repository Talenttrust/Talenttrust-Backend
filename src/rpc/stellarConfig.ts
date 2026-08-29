/**
 * stellarConfig.ts — Configuration for the Stellar RPC transport.
 *
 * Centralizes env-var validation for the timeout and retry parameters
 * consumed by `src/rpc/stellarClient.ts`.  Loaded once at module import
 * time so the production `defaultTransport` fails fast on misconfiguration.
 *
 * ## Environment variables
 *  - `STELLAR_RPC_TIMEOUT_MS`          per-request timeout (ms); > 0; default **5000**.
 *  - `STELLAR_RPC_MAX_RETRIES`         number of retry attempts after the first try;
 *                                       >= 0; default **3**.
 *  - `STELLAR_RPC_RETRY_BASE_DELAY_MS` initial backoff (ms); >= 0; default **200**.
 *  - `STELLAR_RPC_RETRY_MAX_DELAY_MS`  maximum backoff cap (ms); >= base; default **2000**.
 *
 * ## Security notes
 *  - Validation uses a strict Zod schema that rejects non-integer or out-of-range
 *    values explicitly to prevent a hung Soroban RPC from stalling the system.
 *  - An invalid value throws — there is no silent fallback to defaults.
 */

import { z } from "zod";

/** Resolved, fully-validated configuration for the resilient Stellar transport. */
export interface StellarRpcConfig {
  /** Per-request AbortController timeout in milliseconds. */
  timeoutMs: number;
  /** Number of retry attempts after the first try (so total tries = maxRetries + 1). */
  maxRetries: number;
  /** Initial backoff delay (ms) before jitter + exponential growth. */
  retryBaseDelayMs: number;
  /** Upper bound (ms) for any single backoff sleep. */
  retryMaxDelayMs: number;
}

/** Built-in defaults applied when an env var is absent. */
export const DEFAULT_STELLAR_RPC_CONFIG: StellarRpcConfig = {
  timeoutMs: 5_000,
  maxRetries: 3,
  retryBaseDelayMs: 200,
  retryMaxDelayMs: 2_000,
};

/**
 * Zod schema for the Stellar RPC env vars.  Each field is a string with a
 * built-in default, transformed into a strictly-validated integer.
 *
 * The schema strictly rejects:
 *  - non-integer values
 *  - out-of-range values (timeout > 120_000; max retries > 10; etc.)
 *  - non-positive timeout (timeout must be > 0)
 *  - negative delays
 *  - `retryMaxDelayMs < retryBaseDelayMs` (caught by superRefine)
 */
const stellarRpcEnvSchema = z
  .object({
    STELLAR_RPC_TIMEOUT_MS: z
      .string()
      .default(String(DEFAULT_STELLAR_RPC_CONFIG.timeoutMs))
      .transform((val) => parseInt(val, 10))
      .pipe(
        z
          .number()
          .int("STELLAR_RPC_TIMEOUT_MS must be an integer")
          .positive("STELLAR_RPC_TIMEOUT_MS must be > 0")
          .max(120_000, "STELLAR_RPC_TIMEOUT_MS must be <= 120000"),
      ),
    STELLAR_RPC_MAX_RETRIES: z
      .string()
      .default(String(DEFAULT_STELLAR_RPC_CONFIG.maxRetries))
      .transform((val) => parseInt(val, 10))
      .pipe(
        z
          .number()
          .int("STELLAR_RPC_MAX_RETRIES must be an integer")
          .min(0, "STELLAR_RPC_MAX_RETRIES must be >= 0")
          .max(10, "STELLAR_RPC_MAX_RETRIES must be <= 10"),
      ),
    STELLAR_RPC_RETRY_BASE_DELAY_MS: z
      .string()
      .default(String(DEFAULT_STELLAR_RPC_CONFIG.retryBaseDelayMs))
      .transform((val) => parseInt(val, 10))
      .pipe(
        z
          .number()
          .int("STELLAR_RPC_RETRY_BASE_DELAY_MS must be an integer")
          .nonnegative("STELLAR_RPC_RETRY_BASE_DELAY_MS must be >= 0")
          .max(60_000, "STELLAR_RPC_RETRY_BASE_DELAY_MS must be <= 60000"),
      ),
    STELLAR_RPC_RETRY_MAX_DELAY_MS: z
      .string()
      .default(String(DEFAULT_STELLAR_RPC_CONFIG.retryMaxDelayMs))
      .transform((val) => parseInt(val, 10))
      .pipe(
        z
          .number()
          .int("STELLAR_RPC_RETRY_MAX_DELAY_MS must be an integer")
          .nonnegative("STELLAR_RPC_RETRY_MAX_DELAY_MS must be >= 0")
          .max(60_000, "STELLAR_RPC_RETRY_MAX_DELAY_MS must be <= 60000"),
      ),
  })
  .superRefine((obj, ctx) => {
    // retryMaxDelayMs must be >= retryBaseDelayMs so the cap is meaningful.
    if (obj.STELLAR_RPC_RETRY_MAX_DELAY_MS < obj.STELLAR_RPC_RETRY_BASE_DELAY_MS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["STELLAR_RPC_RETRY_MAX_DELAY_MS"],
        message:
          "STELLAR_RPC_RETRY_MAX_DELAY_MS must be >= STELLAR_RPC_RETRY_BASE_DELAY_MS",
      });
    }
  });

/**
 * Loads and validates Stellar RPC configuration from the given env object.
 *
 * Behavior:
 *  - Missing env vars fall back to {@link DEFAULT_STELLAR_RPC_CONFIG}.
 *  - Invalid env vars (non-integer, out of range, max < base) throw —
 *    defaults are not silently substituted, so misconfiguration is loud.
 *
 * @param env - Process env object; defaults to `process.env`.
 * @throws {Error} If any of the env vars fails schema validation.
 */
export function loadStellarRpcConfig(
  env: NodeJS.ProcessEnv = process.env,
): StellarRpcConfig {
  const parsed = stellarRpcEnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.errors
      .map((e) => `${e.path.join(".") || "(root)"}: ${e.message}`)
      .join("; ");
    throw new Error(`Invalid Stellar RPC configuration: ${issues}`);
  }
  const r = parsed.data;
  const cfg: StellarRpcConfig = {
    timeoutMs: r.STELLAR_RPC_TIMEOUT_MS,
    maxRetries: r.STELLAR_RPC_MAX_RETRIES,
    retryBaseDelayMs: r.STELLAR_RPC_RETRY_BASE_DELAY_MS,
    retryMaxDelayMs: r.STELLAR_RPC_RETRY_MAX_DELAY_MS,
  };
  return Object.freeze(cfg) as StellarRpcConfig;
}
