import { z } from 'zod';
import { isSafeUrl } from './utils/ssrf';

/**
 * Soroban contract ID must be a 56-character Stellar Strkey starting with 'C'.
 * Matches the base32 encoding used by the Stellar SDK for contract addresses.
 */
const sorobanContractId = z
  .string()
  .regex(/^C[A-Z2-7]{55}$/, 'Must be a 56-char Stellar contract Strkey starting with C');

/**
 * Validation schema for all Soroban / Stellar environment variables.
 *
 * Required at startup — missing or malformed values abort the process
 * rather than surfacing as cryptic RPC errors deep in escrow flows.
 *
 * @security Never include secret keys here; those belong in separate
 * secret-management env vars and must never be logged.
 */
const sorobanEnvSchema = z.object({
  /** Soroban RPC endpoint. Must be a public HTTPS URL (SSRF-safe). */
  SOROBAN_RPC_URL: z
    .string()
    .url('SOROBAN_RPC_URL must be a valid URL')
    .refine(isSafeUrl, 'SOROBAN_RPC_URL must not point to internal resources')
    .default('https://rpc-futurenet.stellar.org:443'),

  /** Stellar network passphrase — uniquely identifies the network. */
  SOROBAN_NETWORK_PASSPHRASE: z
    .string()
    .min(1, 'SOROBAN_NETWORK_PASSPHRASE is required')
    .default('Test SDF Future Network ; October 2022'),

  /**
   * Primary escrow contract ID.
   * Optional — only required when escrow flows are active.
   */
  SOROBAN_ESCROW_CONTRACT_ID: sorobanContractId.optional(),

  /**
   * Token contract ID (e.g. USDC on the target network).
   * Optional — only required when token transfer flows are active.
   */
  SOROBAN_TOKEN_CONTRACT_ID: sorobanContractId.optional(),
  /**
   * Optional pinned metadata hash for the escrow contract (SHA-256 hex, 64 chars).
   * When provided, runtime modules should verify fetched on-chain metadata
   * matches this value before performing sensitive operations.
   */
  SOROBAN_ESCROW_CONTRACT_METADATA_HASH: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'SOROBAN_ESCROW_CONTRACT_METADATA_HASH must be a 64-character hex string')
    .optional(),

  /** Number of retry attempts for idempotent RPC calls. */
  SOROBAN_RPC_RETRY_ATTEMPTS: z
    .string()
    .default('5')
    .transform((val) => val === '' ? 5 : parseInt(val, 10))
    .pipe(z.number().int().positive()),

  /** Base delay between retries in milliseconds. */
  SOROBAN_RPC_RETRY_BASE_DELAY_MS: z
    .string()
    .default('200')
    .transform((val) => val === '' ? 200 : parseInt(val, 10))
    .pipe(z.number().int().positive()),
});

/** Raw validated shape (SCREAMING_SNAKE_CASE keys from zod). */
type RawSorobanEnv = z.infer<typeof sorobanEnvSchema>;

/** Camel-cased shape — matches the property names the rest of the codebase uses. */
export interface SorobanEnv {
  sorobanRpcUrl: string;
  sorobanNetworkPassphrase: string;
  sorobanEscrowContractId?: string;
  sorobanTokenContractId?: string;
  sorobanEscrowContractMetadataHash?: string;
  sorobanRpcRetryAttempts: number;
  sorobanRpcRetryBaseDelayMs: number;
}

function toSorobanEnv(raw: RawSorobanEnv): SorobanEnv {
  return {
    sorobanRpcUrl: raw.SOROBAN_RPC_URL,
    sorobanNetworkPassphrase: raw.SOROBAN_NETWORK_PASSPHRASE,
    sorobanEscrowContractId: raw.SOROBAN_ESCROW_CONTRACT_ID,
    sorobanTokenContractId: raw.SOROBAN_TOKEN_CONTRACT_ID,
    sorobanEscrowContractMetadataHash: raw.SOROBAN_ESCROW_CONTRACT_METADATA_HASH,
    sorobanRpcRetryAttempts: raw.SOROBAN_RPC_RETRY_ATTEMPTS,
    sorobanRpcRetryBaseDelayMs: raw.SOROBAN_RPC_RETRY_BASE_DELAY_MS,
  };
}

/** Replaceable exit handler — swap in tests to avoid process.exit. */
/* istanbul ignore next */
let _exit: (code: number) => never = (code) => process.exit(code);

/** Override the exit handler. Intended for testing only. */
export function setExitHandler(fn: (code: number) => never): void {
  _exit = fn;
}

/**
 * Parse and validate Soroban environment variables.
 *
 * Throws on invalid input in tests; calls process.exit(1) in production
 * so the process never starts in a misconfigured state.
 *
 * @param env - Source of env vars, defaults to process.env.
 * @returns Validated, typed Soroban configuration.
 * @throws {Error} In test environments when validation fails.
 */
export function parseSorobanEnv(env: NodeJS.ProcessEnv = process.env): SorobanEnv {
  const result = sorobanEnvSchema.safeParse(env);

  if (!result.success) {
    // Surface field paths and messages only — never the actual values.
    const issues = result.error.errors
      .map((e) => `  ${/* istanbul ignore next */ e.path.join('.') || 'root'}: ${e.message}`)
      .join('\n');

    const msg = `[sorobanEnv] Startup validation failed:\n${issues}`;

    const isTest = process.env.NODE_ENV === 'test' || !!process.env.JEST_WORKER_ID;
    if (isTest) throw new Error(msg);

    console.error(msg);
    return _exit(1);
  }

  return toSorobanEnv(result.data);
}

/**
 * Validated Soroban configuration, resolved once at module load.
 *
 * Import this instead of reading process.env directly so callers
 * always get typed, validated values.
 */
export const sorobanEnv = parseSorobanEnv();
