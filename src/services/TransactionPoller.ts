import { TransactionStatus, transactionsDb } from '../models/Transaction';

/**
 * Blockchain provider abstraction to decouple polling logic from specific web3/ethers implementations.
 */
export interface IBlockchainProvider {
  getTransactionReceipt(hash: string): Promise<any>;
}

/**
 * Monitors blockchain transaction status using an exponential backoff strategy.
 * Designed to ensure eventual consistency and respect RPC rate limits during peak network congestion.
 */
export class TransactionPoller {
  private readonly provider: IBlockchainProvider;
  private readonly maxRetries: number;
  private readonly initialDelay: number;

  /**
   * @param provider The blockchain provider instance.
   * @param maxRetries Maximum polling attempts before timeout (default: 5).
   * @param initialDelay Starting interval in milliseconds for backoff (default: 1000ms).
   */
  constructor(provider: IBlockchainProvider, maxRetries: number = 5, initialDelay: number = 1000) {
    this.provider = provider;
    this.maxRetries = maxRetries;
    this.initialDelay = initialDelay;
  }

  /**
   * Orchestrates the polling lifecycle for a given transaction hash.
   * Initializes local state if necessary and triggers the recursive backoff loop.
   */
  public async poll(txHash: string): Promise<void> {
    let transaction = transactionsDb.get(txHash);

    if (!transaction) {
      transaction = {
        hash: txHash,
        status: TransactionStatus.PENDING,
        retryCount: 0,
      };
      transactionsDb.set(txHash, transaction);
    }

    try {
      await this.pollWithBackoff(txHash);
    } catch (error) {
      // Catch fatal orchestrator errors to prevent process-level unhandled rejections
      console.error(`Polling orchestrator failed for ${txHash}:`, error);
    }
  }

  /**
   * Recursive implementation of exponential backoff polling.
   * Balances the need for low-latency confirmation against API rate limits.
   */
  private async pollWithBackoff(txHash: string): Promise<void> {
    const transaction = transactionsDb.get(txHash);
    
    // Stop early if transaction was completed externally or deleted
    if (!transaction || transaction.status !== TransactionStatus.PENDING) {
      return;
    }

    // Circuit breaker for long-running pending transactions
    if (transaction.retryCount >= this.maxRetries) {
      transaction.status = TransactionStatus.TIMEOUT;
      transaction.lastCheckedAt = new Date();
      return;
    }

    try {
      const receipt = await this.provider.getTransactionReceipt(txHash);

      if (receipt) {
        // Map common blockchain status codes (1: Success, 0: Reverted)
        transaction.status = receipt.status === 1 ? TransactionStatus.SUCCESS : TransactionStatus.FAILED;
        transaction.receipt = receipt;
        transaction.lastCheckedAt = new Date();
        return;
      }
    } catch (error) {
      // Non-fatal error; log for observability and retry on the next interval
      console.warn(`RPC error while fetching receipt for ${txHash}:`, error);
    }

    transaction.retryCount++;
    transaction.lastCheckedAt = new Date();

    const delay = this.initialDelay * Math.pow(2, transaction.retryCount - 1);
    
    // Enforce backoff delay using the event loop to avoid blocking resources
    await new Promise(resolve => setTimeout(resolve, delay));
    return this.pollWithBackoff(txHash);
  }


}
