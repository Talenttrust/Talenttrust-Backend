export const config = {
  network: process.env.STELLAR_NETWORK || 'testnet',
  contractId:
    process.env.ESCROW_CONTRACT_ID || 'CCZMIVUBMG5SBC47SDTC32RWLBJ2HW2DCFVWJEOKCH2IFJBZGBKTXK5W',
  rpcUrl: process.env.STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org',
  frontendUrl: process.env.FRONTEND_URL || 'https://talenttrust-frontend.vercel.app',
  version: '1.0.0',
  apiPaused: process.env.API_PAUSED === 'true',
  pauseCheckTtlMs: Number(process.env.PAUSE_CHECK_TTL_MS) || 10000,
  pauseFailMode: (process.env.PAUSE_FAIL_MODE === 'closed' ? 'closed' : 'open') as 'open' | 'closed',
};

export const explorerUrl = (id: string = config.contractId) =>
  `https://stellar.expert/explorer/${config.network}/contract/${id}`;
