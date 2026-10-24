const NETWORK_PASSPHRASES: Record<string, string> = {
  testnet: 'Test SDF Network ; September 2015',
  public: 'Public Global Stellar Network ; September 2015',
  mainnet: 'Public Global Stellar Network ; September 2015',
  futurenet: 'Test SDF Future Network ; October 2022',
  standalone: 'Standalone Network ; February 2017',
};

const network = process.env.STELLAR_NETWORK || 'testnet';

export const config = {
  network,
  networkPassphrase:
    process.env.STELLAR_NETWORK_PASSPHRASE ||
    NETWORK_PASSPHRASES[network.toLowerCase()] ||
    NETWORK_PASSPHRASES.testnet,
  contractId:
    process.env.ESCROW_CONTRACT_ID || 'CCZMIVUBMG5SBC47SDTC32RWLBJ2HW2DCFVWJEOKCH2IFJBZGBKTXK5W',
  rpcUrl: process.env.STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org',
  frontendUrl: process.env.FRONTEND_URL || 'https://talenttrust-frontend.vercel.app',
  txCacheMax: Math.max(1, Number(process.env.TX_CACHE_MAX) || 200),
  version: '1.0.0',
};

export const explorerUrl = (id: string = config.contractId) =>
  `https://stellar.expert/explorer/${config.network}/contract/${id}`;
