import {
  Account,
  BASE_FEE,
  Contract,
  Networks,
  Transaction,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import { config } from '../config';

/** Well-known all-zero account, used only as a throwaway simulation source. */
export const THROWAWAY_SOURCE_ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

export const networkPassphraseFor = (network: string): string =>
  network === 'public' || network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;

export class RpcError extends Error {}
export class RpcTimeoutError extends RpcError {}
export class RpcSimulationError extends RpcError {}

/**
 * Collapse RPC/transport errors into a short single-line message so raw
 * upstream payloads (URLs, diagnostic logs, stack-ish text) are never echoed
 * verbatim to API clients.
 */
export function sanitizeRpcError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const cleaned = raw
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/https?:\/\/\S+/g, '[redacted-url]')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 160)
    .trim();
  return cleaned.length > 0 ? cleaned : 'rpc request failed';
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new RpcTimeoutError(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new RpcError(String(err)));
      },
    );
  });
}

/** Minimal transport surface the reader needs; `rpc.Server` satisfies it. */
export interface RpcTransport {
  simulateTransaction(tx: Transaction): Promise<rpc.Api.SimulateTransactionResponse>;
  /** `sequence` (SDK v17+) or `latestLedger` (older RPC responses). */
  getLatestLedger(): Promise<{ sequence?: number; latestLedger?: number }>;
}

export interface ContractReaderOptions {
  rpcUrl: string;
  contractId: string;
  network?: string;
  timeoutMs?: number;
  transport?: RpcTransport;
}

/**
 * Thin read-only wrapper around a Soroban RPC server: builds unsigned
 * `Contract.call(...)` transactions from a throwaway source account and
 * simulates them to read contract state. No transaction is ever submitted.
 */
export class ContractReader {
  private readonly transport: RpcTransport;
  private readonly contractId: string;
  private readonly networkPassphrase: string;
  private readonly timeoutMs: number;

  constructor(options: ContractReaderOptions) {
    this.contractId = options.contractId;
    this.networkPassphrase = networkPassphraseFor(options.network ?? 'testnet');
    this.timeoutMs = options.timeoutMs ?? config.rpcTimeoutMs;
    this.transport = options.transport ?? (new rpc.Server(options.rpcUrl) as unknown as RpcTransport);
  }

  async getLatestLedger(): Promise<number> {
    const info = await withTimeout(this.transport.getLatestLedger(), this.timeoutMs, 'getLatestLedger');
    const sequence = info.sequence ?? info.latestLedger;
    if (typeof sequence !== 'number') throw new RpcError('getLatestLedger response missing ledger sequence');
    return sequence;
  }

  /** Simulate a contract read (`version`, `is_paused`, ...) and decode its return value. */
  async simulateRead(method: string, args: xdr.ScVal[] = []): Promise<unknown> {
    const contract = new Contract(this.contractId);
    const source = new Account(THROWAWAY_SOURCE_ACCOUNT, '0');
    const tx = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(contract.call(method, ...args))
      .setTimeout(0)
      .build();

    const sim = await withTimeout(
      this.transport.simulateTransaction(tx),
      this.timeoutMs,
      `simulate ${method}`,
    );
    if (rpc.Api.isSimulationError(sim)) throw new RpcSimulationError(sanitizeRpcError(sim.error));
    if (!rpc.Api.isSimulationSuccess(sim)) throw new RpcError(`unexpected simulation response for ${method}`);
    const retval = sim.result?.retval;
    if (retval == null) throw new RpcError(`simulation for ${method} returned no value`);
    return scValToNative(retval);
  }
}
