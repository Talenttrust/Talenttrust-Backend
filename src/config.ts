export const config = {
  network: process.env.STELLAR_NETWORK || 'testnet',
  contractId:
    process.env.ESCROW_CONTRACT_ID || 'CCZMIVUBMG5SBC47SDTC32RWLBJ2HW2DCFVWJEOKCH2IFJBZGBKTXK5W',
  rpcUrl: process.env.STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org',
  frontendUrl: process.env.FRONTEND_URL || 'https://talenttrust-frontend.vercel.app',
  version: '1.0.0',
};

export const explorerUrl = () =>
  `https://stellar.expert/explorer/${config.network}/contract/${config.contractId}`;

export const shouldSeedDemoData = (): boolean => {
  const raw = process.env.SEED_DEMO_DATA;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw !== undefined && raw !== '') {
    throw new Error(`SEED_DEMO_DATA must be 'true' or 'false', got '${raw}'`);
  }
  if (process.env.VERCEL_ENV === 'preview') return true;
  return process.env.NODE_ENV !== 'production';
};
