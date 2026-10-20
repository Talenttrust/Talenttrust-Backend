export const config = {
  network: process.env.STELLAR_NETWORK || 'testnet',
  contractId:
    process.env.ESCROW_CONTRACT_ID || 'CCZMIVUBMG5SBC47SDTC32RWLBJ2HW2DCFWWJEOKCHHIFJBGBKTXK5W',
  rpcUrl: process.env.STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org',
  frontendUrl: process.env.FRONTEND_URL || 'https://talenttrust-frontend.vercel.app',
  version: '1.0.0',
  profileMaxDisplayNameLength: 60,
  profileMaxBioLength: 1000,
  profileMaxSkills: 20,
  profileMaxSkillLength: 30,
  profileMaxPageSize: 100,
  profileDefaultPageSize: 20,
};

export const explorerUrl = (id: string = config.contractId) =>
  `https://stellar.expert/explorer/${config.network}/contract/${id}`;
