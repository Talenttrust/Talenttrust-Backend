import * as StellarSdk from '@stellar/stellar-sdk';
import { rpc } from '@stellar/stellar-sdk';
import { sorobanEnv } from '../../sorobanEnv';
import { withRetry } from '../../utils/retry';

/**
 * Soroban RPC Service
 * Handles on-chain interactions: reads (e.g., getting contract data, simulating transactions)
 * and writes (e.g., submitting transactions and polling for their status).
 */
export class SorobanRpcService {
  private server: rpc.Server;

  constructor(rpcUrl: string = sorobanEnv.sorobanRpcUrl) {
    this.server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') });
  }

  /**
   * Retrieves specific data from a contract.
   * [IDEMPOTENT READ] Retried automatically on transient failures.
   *
   * @param contractId - The exact standard base32 string representing the contract id.
   * @param key - The StellarSdk.xdr.ScVal key for the contract data.
   * @returns Detailed contract data as an xdr.LedgerEntryData or undefined if not found.
   */
  public async getContractData(
    contractId: string,
    key: StellarSdk.xdr.ScVal
  ): Promise<rpc.Api.LedgerEntryResult | undefined> {
    try {
      const ledgerKey = StellarSdk.xdr.LedgerKey.contractData(
        new StellarSdk.xdr.LedgerKeyContractData({
          contract: new StellarSdk.Address(contractId).toScAddress(),
          key: key,
          durability: StellarSdk.xdr.ContractDataDurability.persistent(),
        })
      );
      // rpc.Server.getLedgerEntries is the standard method for getting contract state
      const response = await withRetry(
        () => this.server.getLedgerEntries(ledgerKey),
        {
          maxAttempts: sorobanEnv.sorobanRpcRetryAttempts,
          baseDelayMs: sorobanEnv.sorobanRpcRetryBaseDelayMs,
        }
      );
      if (response.entries && response.entries.length > 0) {
        return response.entries[0];
      }
      return undefined;
    } catch (error) {
      console.error('Error fetching contract data:', error);
      throw error;
    }
  }

  /**
   * Fetches the most recent ledger known to the RPC server.
   * [IDEMPOTENT READ] Retried automatically on transient failures.
   *
   * Used by sync workers to discover the chain head so they only scan up to a
   * real, settled ledger instead of an arbitrary upper bound.
   *
   * @returns The latest ledger metadata (id, sequence, protocol version).
   */
  public async getLatestLedger(): Promise<rpc.Api.GetLatestLedgerResponse> {
    try {
      return await withRetry(
        () => this.server.getLatestLedger(),
        {
          maxAttempts: sorobanEnv.sorobanRpcRetryAttempts,
          baseDelayMs: sorobanEnv.sorobanRpcRetryBaseDelayMs,
        }
      );
    } catch (error) {
      console.error('Error fetching latest ledger:', error);
      throw error;
    }
  }

  /**
   * Queries contract events from the network for a given filter/ledger window.
   * [IDEMPOTENT READ] Retried automatically on transient failures.
   *
   * Thin pass-through to the underlying RPC `getEvents` call. Pagination is left
   * to the caller via the returned `cursor` so large windows can be streamed.
   *
   * @param request - Event filters plus the ledger/cursor window to scan.
   * @returns A page of decoded events together with the paging cursor.
   */
  public async getEvents(
    request: rpc.Server.GetEventsRequest
  ): Promise<rpc.Api.GetEventsResponse> {
    try {
      return await withRetry(
        () => this.server.getEvents(request),
        {
          maxAttempts: sorobanEnv.sorobanRpcRetryAttempts,
          baseDelayMs: sorobanEnv.sorobanRpcRetryBaseDelayMs,
        }
      );
    } catch (error) {
      console.error('Error fetching contract events:', error);
      throw error;
    }
  }

  /**
   * Simulates a given transaction on the Soroban network to calculate fees and resource usage.
   * [IDEMPOTENT READ] Retried automatically on transient failures.
   *
   * @param transaction - The unsigned or signed transaction to be simulated.
   * @returns The simulation result, potentially including the expected return value and auth/resource events.
   */
  public async simulateTransaction(
    transaction: StellarSdk.Transaction
  ): Promise<rpc.Api.SimulateTransactionResponse> {
    try {
      return await withRetry(
        () => this.server.simulateTransaction(transaction),
        {
          maxAttempts: sorobanEnv.sorobanRpcRetryAttempts,
          baseDelayMs: sorobanEnv.sorobanRpcRetryBaseDelayMs,
        }
      );
    } catch (error) {
      console.error('Error simulating transaction:', error);
      throw error;
    }
  }

  /**
   * Submits a signed Soroban transaction to the network.
   * [NON-IDEMPOTENT MUTATING CALL] Never retried automatically.
   *
   * @param transaction - A constructed, signed transaction.
   * @returns The initial response after attempting to submit the transaction.
   */
  public async sendTransaction(
    transaction: StellarSdk.Transaction
  ): Promise<rpc.Api.SendTransactionResponse> {
    try {
      return await this.server.sendTransaction(transaction);
    } catch (error) {
      console.error('Error sending transaction:', error);
      throw error;
    }
  }

  /**
   * Periodically checks the status of a specific transaction until it is successful, failed, or timed out.
   * [IDEMPOTENT READ] The inner RPC queries are retried automatically on transient failures.
   *
   * @param hash - The hash of the submitted transaction.
   * @param timeoutMs - Maximum amount of time to wait in milliseconds (default 30 seconds)
   * @param delayMs - Delay between polling checks in milliseconds (default 2 seconds)
   * @returns The final transaction status.
   */
  public async getTransactionStatus(
    hash: string,
    timeoutMs: number = 30000,
    delayMs: number = 2000
  ): Promise<rpc.Api.GetTransactionResponse> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const txResponse = await withRetry(
        () => this.server.getTransaction(hash),
        {
          maxAttempts: sorobanEnv.sorobanRpcRetryAttempts,
          baseDelayMs: sorobanEnv.sorobanRpcRetryBaseDelayMs,
        }
      );

      if (txResponse.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) {
        return txResponse;
      }

      // Wait before the next poll
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    throw new Error(`Transaction polling timed out after ${timeoutMs}ms for hash ${hash}`);
  }
}
