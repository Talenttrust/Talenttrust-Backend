function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid ${name}: "${raw}". Must be a positive integer.`);
  }
  return value;
}

export const config = {
  network: process.env.STELLAR_NETWORK || 'testnet',
  contractId:
    process.env.ESCROW_CONTRACT_ID || 'CCZMIVUBMG5SBC47SDTC32RWLBJ2HW2DCFVWJEOKCH2IFJBZGBKTXK5W',
  rpcUrl: process.env.STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org',
  frontendUrl: process.env.FRONTEND_URL || 'https://talenttrust-frontend.vercel.app',
  /** Passphrase override for networks without a well-known name. */
  networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE || undefined,
  /** Per-check timeout for /health/ready. */
  healthCheckTimeoutMs: positiveIntEnv('HEALTH_CHECK_TIMEOUT_MS', 2000),
  /** How long /health/ready reuses the last result (single-flight in between). */
  healthCacheMs: positiveIntEnv('HEALTH_CACHE_MS', 10000),
  version: '1.0.0',
};

export const explorerUrl = (id: string = config.contractId) =>
  `https://stellar.expert/explorer/${config.network}/contract/${id}`;
