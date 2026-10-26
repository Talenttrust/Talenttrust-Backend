const DEFAULT_BODY_LIMIT = '100kb';

function resolveBodyLimit(raw: string | undefined): string {
  const value = (raw ?? '').trim() || DEFAULT_BODY_LIMIT;
  // A bare integer means bytes; decimals need a unit. This matches how the `bytes` package parses limits.
  if (!/^(\d+|\d+(\.\d+)?\s*(b|kb|mb|gb|tb|pb))$/i.test(value)) {
    throw new Error(`Invalid BODY_LIMIT "${value}". Use a size such as 100kb or 1mb.`);
  }
  return value;
}
const slaRaw = Number(process.env.DISPUTE_SLA_HOURS);

const network = process.env.STELLAR_NETWORK || 'testnet';

/** Stellar network passphrases by STELLAR_NETWORK name. */
const NETWORK_PASSPHRASES: Record<string, string> = {
  testnet: 'Test SDF Network ; September 2015',
  mainnet: 'Public Global Stellar Network ; September 2015',
  public: 'Public Global Stellar Network ; September 2015',
  futurenet: 'Test SDF Future Network ; October 2022',
};

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid ${name}: "${raw}". Must be a positive integer.`);
  }
  return value;
}

const intEnv = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

export const config = {
  network,
  networkPassphrase:
    process.env.STELLAR_NETWORK_PASSPHRASE ||
    NETWORK_PASSPHRASES[network.toLowerCase()] ||
    NETWORK_PASSPHRASES.testnet,
  contractId:
    process.env.ESCROW_CONTRACT_ID || 'CCZMIVUBMG5SBC47SDTC32RWLBJ2HW2DCFVWJEOKCH2IFJBZGBKTXK5W',
  rpcUrl: process.env.STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org',
  txTimeoutSeconds: Math.max(1, Number.parseInt(process.env.TX_TIMEOUT_SECONDS || '300', 10) || 300),
  frontendUrl: process.env.FRONTEND_URL || 'https://talenttrust-frontend.vercel.app',
  disputeSlaHours: Number.isFinite(slaRaw) && slaRaw > 0 ? slaRaw : 72,
  version: '1.0.0',
  /** Per-call Soroban RPC timeout. */
  rpcTimeoutMs: intEnv(process.env.RPC_TIMEOUT_MS, 4000),
  /** How long a successful /api/v1/chain on-chain snapshot stays cached. */
  chainStatusTtlMs: intEnv(process.env.CHAIN_STATUS_TTL_MS, 15000),
  /** Minimum interval between cache-bypassing ?refresh=true fetches. */
  chainRefreshMinIntervalMs: intEnv(process.env.CHAIN_REFRESH_MIN_INTERVAL_MS, 5000),
  requireIfMatch: process.env.REQUIRE_IF_MATCH === 'true',
  apiPaused: process.env.API_PAUSED === 'true',
  pauseCheckTtlMs: Number(process.env.PAUSE_CHECK_TTL_MS) || 10000,
  pauseFailMode: (process.env.PAUSE_FAIL_MODE === 'closed' ? 'closed' : 'open') as 'open' | 'closed',
  /** Set PAUSE_CHECK_CHAIN=false to skip the on-chain is_paused probe (tests, offline dev). */
  pauseCheckChain: process.env.PAUSE_CHECK_CHAIN !== 'false',
  bodyLimit: resolveBodyLimit(process.env.BODY_LIMIT),
  /** Extra comma-separated CORS origins (added to FRONTEND_URL and local dev origins). */
  corsOrigins: process.env.CORS_ORIGINS || '',
  /** Poll interval for the long-running server's event indexer (0 = disabled; serverless uses the cron). */
  indexerIntervalMs: process.env.INDEXER_INTERVAL_MS ? Number(process.env.INDEXER_INTERVAL_MS) : 0,
  /** Per-check timeout for /health/ready. */
  healthCheckTimeoutMs: positiveIntEnv('HEALTH_CHECK_TIMEOUT_MS', 2000),
  /** How long /health/ready reuses the last result (single-flight in between). */
  healthCacheMs: positiveIntEnv('HEALTH_CACHE_MS', 10000),
  /** Max relayed transactions remembered for GET /api/v1/tx. */
  txCacheMax: intEnv(process.env.TX_CACHE_MAX, 200),
  /** Native SAC token contract id for XLM on the configured network. */
  nativeTokenContractId:
    process.env.NATIVE_TOKEN_CONTRACT_ID ||
    'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
};

export const explorerUrl = (id: string = config.contractId) =>
  `https://stellar.expert/explorer/${config.network}/contract/${id}`;
