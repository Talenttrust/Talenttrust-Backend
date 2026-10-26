/**
 * Static registry of supported escrow tokens.
 *
 * The registry is configuration, not chain state: metadata (decimals, symbol,
 * contract id) is validated once at startup and never fetched from Soroban.
 * `EscrowStore.create` resolves `token` against this registry so clients can
 * only escrow assets the contract deployment actually supports, and responses
 * format base-unit amounts with the token's decimals.
 *
 * Configuration:
 *   - Defaults: native XLM SAC + testnet USDC SAC (contract id and issuer
 *     overridable with TOKENS_USDC_CONTRACT_ID / TOKENS_USDC_ISSUER).
 *   - TOKENS_JSON: a JSON array of entries that *overrides* defaults sharing
 *     its symbol (case-insensitive) or contract id and *extends* the registry
 *     with new symbols. Invalid entries fail startup with a clear message.
 */

/** One registered token. `issuer` is null for the native asset. */
export interface Token {
  symbol: string;
  name: string;
  contractId: string;
  decimals: number;
  issuer?: string | null;
}

/** Contract-id strkey: version byte C or D + 55 base32 chars (56 total). */
const CONTRACT_STRKEY = /^[CD][A-Z2-7]{55}$/;
/** Account-id strkey: version byte G + 55 base32 chars (56 total). */
const ACCOUNT_STRKEY = /^G[A-Z2-7]{55}$/;
/** Ticker-style symbol: no whitespace, bounded length. */
const SYMBOL_PATTERN = /^[A-Za-z0-9._-]{1,32}$/;
const MAX_DECIMALS = 18;

/** Native XLM Stellar Asset Contract (testnet & mainnet SAC derivation is network-scoped; 7 decimals). */
export const XLM_CONTRACT_ID = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
/** Circle's testnet USDC Stellar Asset Contract (Stellar assets use 7 decimals). */
export const USDC_TESTNET_CONTRACT_ID = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';

/** Validate one registry entry, throwing an Error whose message names `where` and the offending field. */
function validateTokenEntry(raw: unknown, where: string): Token {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${where} must be an object with symbol, name, contractId and decimals`);
  }
  const entry = raw as Record<string, unknown>;
  for (const key of Object.keys(entry)) {
    if (!['symbol', 'name', 'contractId', 'decimals', 'issuer'].includes(key)) {
      throw new Error(`${where} has unknown field "${key}" (allowed: symbol, name, contractId, decimals, issuer)`);
    }
  }
  const { symbol, name, contractId, decimals, issuer } = entry;
  if (typeof symbol !== 'string' || !SYMBOL_PATTERN.test(symbol)) {
    throw new Error(`${where}.symbol must be a 1-32 character ticker of A-Z a-z 0-9 . _ - (got ${JSON.stringify(symbol)})`);
  }
  if (typeof name !== 'string' || !name.trim() || name.length > 64) {
    throw new Error(`${where}.name must be a non-empty string of at most 64 characters (got ${JSON.stringify(name)})`);
  }
  if (typeof contractId !== 'string' || !CONTRACT_STRKEY.test(contractId)) {
    throw new Error(`${where}.contractId must be a Stellar contract id (C… strkey, 56 chars) (got ${JSON.stringify(contractId)})`);
  }
  if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    throw new Error(`${where}.decimals must be an integer from 0 to ${MAX_DECIMALS} (got ${JSON.stringify(decimals)})`);
  }
  if (issuer !== undefined && issuer !== null && (typeof issuer !== 'string' || !ACCOUNT_STRKEY.test(issuer))) {
    throw new Error(`${where}.issuer must be null or a Stellar account id (G… strkey) (got ${JSON.stringify(issuer)})`);
  }
  return {
    symbol,
    name,
    contractId,
    decimals,
    issuer: issuer ?? null,
  };
}

/** Built-in testnet registry: native XLM + Circle testnet USDC (both configurable). */
function defaultTokens(env: Record<string, string | undefined>): Token[] {
  const usdcContractId = env.TOKENS_USDC_CONTRACT_ID?.trim() || USDC_TESTNET_CONTRACT_ID;
  const usdcIssuer = env.TOKENS_USDC_ISSUER?.trim() || null;
  return [
    validateTokenEntry(
      { symbol: 'XLM', name: 'Stellar Lumens', contractId: XLM_CONTRACT_ID, decimals: 7, issuer: null },
      'default token XLM',
    ),
    validateTokenEntry(
      { symbol: 'USDC', name: 'USD Coin', contractId: usdcContractId, decimals: 7, issuer: usdcIssuer },
      'default token USDC',
    ),
  ];
}

/**
 * Build the effective registry from `env` (defaults, TOKENS_USDC_* overrides,
 * then TOKENS_JSON override/extend). Throws with a clear message on any invalid
 * entry — this runs at module load, i.e. a bad TOKENS_JSON fails startup.
 */
export function buildTokenRegistry(env: Record<string, string | undefined> = process.env): Token[] {
  const registry = defaultTokens(env);
  const raw = env.TOKENS_JSON?.trim();
  if (!raw) return registry;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`TOKENS_JSON is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('TOKENS_JSON must be a JSON array of token entries');
  }
  const entries = parsed.map((entry, index) => validateTokenEntry(entry, `TOKENS_JSON[${index}]`));
  for (const entry of entries) {
    const existing = registry.findIndex(
      (t) => t.symbol.toLowerCase() === entry.symbol.toLowerCase() || t.contractId === entry.contractId,
    );
    if (existing >= 0) registry[existing] = entry;
    else registry.push(entry);
  }
  return registry;
}

/** The registry active for this process (validated at module load = startup). */
const REGISTRY: readonly Token[] = buildTokenRegistry();

/** All registered tokens, in registration order. */
export function getTokenRegistry(): readonly Token[] {
  return REGISTRY;
}

/**
 * Resolve a raw `token` value: exact contract id first, then
 * case-insensitive symbol. Returns undefined for anything unregistered or not
 * a string (callers turn that into `unsupported_token` / `token_not_found`).
 */
export function resolveToken(raw: unknown): Token | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  if (!value) return undefined;
  const byContract = REGISTRY.find((t) => t.contractId === value);
  if (byContract) return byContract;
  const lowered = value.toLowerCase();
  return REGISTRY.find((t) => t.symbol.toLowerCase() === lowered);
}

/**
 * Format base units with `decimals` fractional digits using string math only —
 * no floats, so i128-sized amounts stay exact. Always pads the fraction:
 * formatUnits(1500000000n, 7) === '150.0000000'.
 */
export function formatUnits(baseUnits: bigint | string, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error(`formatUnits: decimals must be a non-negative integer (got ${decimals})`);
  }
  const digits = typeof baseUnits === 'bigint' ? baseUnits.toString() : String(baseUnits);
  if (!/^-?\d+$/.test(digits)) {
    throw new Error(`formatUnits: ${JSON.stringify(baseUnits)} is not an integer base-unit amount`);
  }
  const negative = digits.startsWith('-');
  const unsigned = negative ? digits.slice(1) : digits;
  if (decimals === 0) return `${negative ? '-' : ''}${unsigned}`;
  const padded = unsigned.padStart(decimals + 1, '0');
  const splitAt = padded.length - decimals;
  return `${negative ? '-' : ''}${padded.slice(0, splitAt)}.${padded.slice(splitAt)}`;
}

/**
 * Format base units for a registered token's decimals. Unregistered symbols
 * (unreachable for validated creates) fall back to the raw base-unit string so
 * no response ever invents a precision.
 */
export function formatTokenUnits(baseUnits: bigint | string, tokenSymbol: string): string {
  const token = resolveToken(tokenSymbol);
  return token ? formatUnits(baseUnits, token.decimals) : String(baseUnits);
}
