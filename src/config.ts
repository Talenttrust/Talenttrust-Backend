export const config = {
  network: process.env.STELLAR_NETWORK || 'testnet',
  contractId:
    process.env.ESCROW_CONTRACT_ID || 'CCZMIVUBMG5SBC47SDTC32RWLBJ2HW2DCFVWJEOKCH2IFJBZGBKTXK5W',
  rpcUrl: process.env.STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org',
  frontendUrl: process.env.FRONTEND_URL || 'https://talenttrust-frontend.vercel.app',
  version: '1.0.0',
};

export const explorerUrl = (id: string = config.contractId) =>
  `https://stellar.expert/explorer/${config.network}/contract/${id}`;

export function storageConfig() {
  const driver = process.env.STORAGE_DRIVER || 'memory';
  if (driver !== 'memory' && driver !== 'sqlite') throw new Error('STORAGE_DRIVER must be memory or sqlite');
  return { driver, path: process.env.SQLITE_PATH || './data/talenttrust.db',
    seedDemoData: process.env.SEED_DEMO_DATA !== 'false' };
}
