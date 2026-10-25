import {
  Account,
  Address,
  Contract,
  Keypair,
  nativeToScVal,
  rpc,
  scValToNative,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { config } from '../config';
import { decodeEscrow, decodeReputation, DecodedEscrow, DecodedReputation } from './decode';

export type ChainFailure = 'not_found' | 'contract' | 'unavailable';

export class ChainReadError extends Error {
  constructor(public failure: ChainFailure, public contractError?: { name: string; code: number }) {
    super(failure);
  }
}

export interface ChainReadClient {
  getContract(id: bigint): Promise<{ value: DecodedEscrow; latestLedger: number }>;
  getReputation(address: string): Promise<{ value: DecodedReputation; latestLedger: number }>;
}

function contractError(error: unknown): { name: string; code: number } | undefined {
  const text = typeof error === 'string' ? error : JSON.stringify(error);
  const match = text.match(/(?:Error\([^,]+,\s*)?#(\d+)/i);
  if (!match) return undefined;
  return { name: 'ContractError', code: Number(match[1]) };
}

export class SorobanChainReadClient implements ChainReadClient {
  private readonly server = new rpc.Server(config.rpcUrl, { timeout: 8_000 });
  private readonly source = Keypair.random();

  private async simulate(method: string, args: Array<[unknown, unknown]>): Promise<{ native: unknown; latestLedger: number }> {
    try {
      const account = new Account(this.source.publicKey(), '0');
      const operationArgs = args.map(([value, type]) => nativeToScVal(value, type as never));
      const tx = new TransactionBuilder(account, { fee: '100', networkPassphrase: config.networkPassphrase })
        .addOperation(new Contract(config.contractId).call(method, ...operationArgs))
        .setTimeout(30)
        .build();
      const [simulation, latest] = await Promise.all([this.server.simulateTransaction(tx), this.server.getLatestLedger()]);
      if ('error' in simulation) {
        const parsed = contractError(simulation.error);
        if (parsed?.code === 5) throw new ChainReadError('not_found');
        throw new ChainReadError('contract', parsed ?? { name: 'ContractError', code: 0 });
      }
      if (!simulation.result?.retval) throw new ChainReadError('contract', { name: 'MissingResult', code: 0 });
      return { native: scValToNative(simulation.result.retval), latestLedger: latest.sequence };
    } catch (error) {
      if (error instanceof ChainReadError) throw error;
      throw new ChainReadError('unavailable');
    }
  }

  async getContract(id: bigint) {
    const result = await this.simulate('get_contract', [[id, { type: 'u64' }]]);
    try {
      return { value: decodeEscrow(result.native), latestLedger: result.latestLedger };
    } catch {
      throw new ChainReadError('contract', { name: 'DecodeError', code: 0 });
    }
  }

  async getReputation(address: string) {
    const result = await this.simulate('get_reputation', [[new Address(address).toScVal(), undefined]]);
    try {
      return { value: decodeReputation(result.native), latestLedger: result.latestLedger };
    } catch {
      throw new ChainReadError('contract', { name: 'DecodeError', code: 0 });
    }
  }
}
