const intEnv = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

export const config = {
  network: process.env.STELLAR_NETWORK || 'testnet',
  contractId:
    process.env.ESCROW_CONTRACT_ID || 'CCZMIVUBMG5SBC47SDTC32RWLBJ2HW2DCFVWJEOKCH2IFJBZGBKTXK5W',
  rpcUrl: process.env.STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org',
  frontendUrl: process.env.FRONTEND_URL || 'https://talenttrust-frontend.vercel.app',
  version: '1.0.0',
  /** Per-call Soroban RPC timeout. */
  rpcTimeoutMs: intEnv(process.env.RPC_TIMEOUT_MS, 4000),
  /** How long a successful /api/v1/chain on-chain snapshot stays cached. */
  chainStatusTtlMs: intEnv(process.env.CHAIN_STATUS_TTL_MS, 15000),
  /** Minimum interval between cache-bypassing ?refresh=true fetches. */
  chainRefreshMinIntervalMs: intEnv(process.env.CHAIN_REFRESH_MIN_INTERVAL_MS, 5000),
};

export const explorerUrl = (id: string = config.contractId) =>
  `https://stellar.expert/explorer/${config.network}/contract/${id}`;
