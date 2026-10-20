const DEFAULT_BODY_LIMIT = '100kb';

function resolveBodyLimit(raw: string | undefined): string {
  const value = (raw ?? '').trim() || DEFAULT_BODY_LIMIT;
  // A bare integer means bytes; decimals need a unit. This matches how the `bytes` package parses limits.
  if (!/^(\d+|\d+(\.\d+)?\s*(b|kb|mb|gb|tb|pb))$/i.test(value)) {
    throw new Error(`Invalid BODY_LIMIT "${value}". Use a size such as 100kb or 1mb.`);
  }
  return value;
}

export const config = {
  network: process.env.STELLAR_NETWORK || 'testnet',
  contractId:
    process.env.ESCROW_CONTRACT_ID || 'CCZMIVUBMG5SBC47SDTC32RWLBJ2HW2DCFVWJEOKCH2IFJBZGBKTXK5W',
  rpcUrl: process.env.STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org',
  frontendUrl: process.env.FRONTEND_URL || 'https://talenttrust-frontend.vercel.app',
  version: '1.0.0',
  bodyLimit: resolveBodyLimit(process.env.BODY_LIMIT),
};

export const explorerUrl = (id: string = config.contractId) =>
  `https://stellar.expert/explorer/${config.network}/contract/${id}`;
