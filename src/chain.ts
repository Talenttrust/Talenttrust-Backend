import { config } from './config';
import { ContractReader, RpcTransport } from './stellar/rpc';

/**
 * On-chain escrow contract structure matching Soroban escrow contract:
 * lib.rs:
 * pub struct Contract {
 *     pub client: Address,
 *     pub freelancer: Address,
 *     pub token: Address,
 *     pub total_amount: i128,
 *     pub funded_amount: i128,
 *     pub released_amount: i128,
 *     pub status: ContractStatus,
 *     pub milestones: Vec<Milestone>,
 *     pub dispute: Option<Dispute>,
 *     pub reputation_issued: bool,
 * }
 */

export type ChainContractStatus =
  | 'Created'
  | 'Funded'
  | 'Completed'
  | 'Disputed'
  | 'Resolved'
  | 'Cancelled';

export interface ChainMilestone {
  index?: number;
  title?: string;
  amount: string | number | bigint;
  released: boolean;
}

export interface OnChainEscrow {
  client: string;
  freelancer: string;
  token: string;
  totalAmount: string | number | bigint;
  fundedAmount: string | number | bigint;
  releasedAmount: string | number | bigint;
  status: ChainContractStatus;
  milestones: ChainMilestone[];
  reputationIssued: boolean;
}

export interface ChainReaderResult {
  contract: OnChainEscrow;
  latestLedger: number;
}

export interface ChainReader {
  getContract(escrowId: string): Promise<ChainReaderResult | null>;
}

export class ChainUnavailableError extends Error {
  constructor(message: string = 'Chain RPC service unavailable') {
    super(message);
    this.name = 'ChainUnavailableError';
  }
}

/** Demo on-chain contract matching seed contract 1 for local exploration & verification */
export const DEMO_ESCROW_3: OnChainEscrow = {
  client: 'GCLIENTDEMOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  freelancer: 'GFREELANCERDEMOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  token: 'CDEMOTOKENAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  totalAmount: 1500,
  fundedAmount: 1500,
  releasedAmount: 250,
  status: 'Funded',
  milestones: [
    { index: 0, title: 'Wireframes', amount: 250, released: true },
    { index: 1, title: 'Visual design', amount: 500, released: false },
    { index: 2, title: 'Implementation', amount: 750, released: false },
  ],
  reputationIssued: false,
};

export function isDemoChainFixtureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.ENABLE_DEMO_CHAIN_FIXTURE === 'true') return true;
  if (env.ENABLE_DEMO_CHAIN_FIXTURE === 'false') return false;
  return env.NODE_ENV === 'development' || env.NODE_ENV === 'test';
}

export class SorobanRpcChainReader implements ChainReader {
  constructor(
    private rpcUrl: string = config.rpcUrl,
    private contractId: string = config.contractId,
    private networkPassphrase?: string,
    private transport?: RpcTransport,
  ) {}

  async getContract(escrowId: string): Promise<ChainReaderResult | null> {
    // Demo seed mapping for local exploration & testing when explicitly enabled
    if (escrowId === '3' && isDemoChainFixtureEnabled()) {
      let latestLedger = 1000;
      if (this.transport || process.env.NODE_ENV !== 'test') {
        try {
          const reader = new ContractReader({
            rpcUrl: this.rpcUrl,
            contractId: this.contractId,
            network: config.network,
            transport: this.transport,
          });
          latestLedger = await reader.getLatestLedger();
        } catch {
          // Fall back to 1000 if RPC is unreachable
        }
      }
      return {
        contract: {
          ...DEMO_ESCROW_3,
          milestones: DEMO_ESCROW_3.milestones.map((m) => ({ ...m })),
        },
        latestLedger,
      };
    }

    let idNum: bigint;
    try {
      idNum = BigInt(escrowId);
    } catch {
      return null;
    }

    try {
      // Dynamically load stellar-sdk for RPC simulation
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const StellarSdk = require('@stellar/stellar-sdk');
      const networkPassphrase =
        this.networkPassphrase ||
        (config.network === 'mainnet'
          ? StellarSdk.Networks.PUBLIC
          : StellarSdk.Networks.TESTNET);

      const rpcServer = this.transport ?? new StellarSdk.rpc.Server(this.rpcUrl);
      const contract = new StellarSdk.Contract(this.contractId);
      const dummyAccount = new StellarSdk.Account(
        'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7',
        '1',
      );

      const tx = new StellarSdk.TransactionBuilder(dummyAccount, {
        fee: '100',
        networkPassphrase,
      })
        .addOperation(
          contract.call('get_contract', StellarSdk.nativeToScVal(idNum, { type: 'u64' })),
        )
        .setTimeout(30)
        .build();

      const sim = await rpcServer.simulateTransaction(tx);

      if (StellarSdk.rpc.Api.isSimulationError(sim)) {
        const errStr = String(sim.error);
        if (
          errStr.includes('Error(Contract, #5)') ||
          errStr.includes('ContractNotFound') ||
          errStr.includes('#5')
        ) {
          return null;
        }
        throw new ChainUnavailableError(errStr);
      }

      if (StellarSdk.rpc.Api.isSimulationSuccess(sim) && sim.result?.retval) {
        const native = StellarSdk.scValToNative(sim.result.retval) as Record<string, unknown>;
        if (!native) return null;

        const rawStatus = native.status;
        const statusStr = (
          Array.isArray(rawStatus) ? rawStatus[0] : String(rawStatus)
        ) as ChainContractStatus;

        const rawMilestones = (native.milestones as Array<Record<string, unknown>>) || [];
        const milestones: ChainMilestone[] = rawMilestones.map((m, idx) => ({
          index: idx,
          title: typeof m.title === 'string' ? m.title : '',
          amount: (m.amount ?? 0).toString(),
          released: Boolean(m.released),
        }));

        const onChainContract: OnChainEscrow = {
          client: String(native.client || ''),
          freelancer: String(native.freelancer || ''),
          token: String(native.token || ''),
          totalAmount: (native.total_amount ?? native.totalAmount ?? 0).toString(),
          fundedAmount: (native.funded_amount ?? native.fundedAmount ?? 0).toString(),
          releasedAmount: (native.released_amount ?? native.releasedAmount ?? 0).toString(),
          status: statusStr,
          milestones,
          reputationIssued: Boolean(native.reputation_issued ?? native.reputationIssued),
        };

        return {
          contract: onChainContract,
          latestLedger: sim.latestLedger ?? 0,
        };
      }

      return null;
    } catch (err) {
      if (err instanceof ChainUnavailableError) throw err;
      throw new ChainUnavailableError((err as Error).message);
    }
  }
}
