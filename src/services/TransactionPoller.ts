import { TransactionStatus, TransactionsDbInterface, transactionsDb } from '../models/Transaction';
import { calculateDelay } from '../utils/retry';

/**
 * Blockchain provider abstraction to decouple polling logic from specific web3/ethers implementations.
 */
export interface IBlockchainProvider {
  getTransactionReceipt(hash: string): Promise<any>;
}

export interface IClock {
  now(): number;
}

export const SystemClock: IClock = {
  now: () => Date.now(),
};

/**
 * Monitors blockchain transaction status using an exponential backoff strategy.
 * Designed to ensure eventual consistency and respect RPC rate limits during peak network congestion.
 */
export class TransactionPoller {
  public readonly name = 'transaction-poller';
  private readonly provider: IBlockchainProvider;
  private readonly maxRetries: number;
  private readonly initialDelay: number;
  private readonly maxTotalDurationMs?: number;
  private readonly clock: IClock;
  private readonly store: TransactionsDbInterface;
  private acceptingNewPolls = true;
  private readonly activePolls = new Map<string, Promise<void>>();

  /**
   * @param provider The blockchain provider instance.
   * @param maxRetries Maximum polling attempts before timeout (default: 5).
   * @param initialDelay Starting interval in milliseconds for backoff (default: 1000ms).
   * @param maxTotalDurationMs Optional absolute maximum duration in milliseconds before timing out.
   *                           If provided, acts as an additional guard alongside maxRetries;
   *                           whichever threshold is reached first will trigger a TIMEOUT.
   * @param clock Optional injectable clock for testing (default: SystemClock).
   * @param store Optional transaction store (default: global transactionsDb).
   *              Inject an InMemoryTransactionStore for test isolation.
   */
  constructor(
    provider: IBlockchainProvider,
    maxRetries: number = 5,
    initialDelay: number = 1000,
    maxTotalDurationMs?: number,
    clock: IClock = SystemClock,
    store: TransactionsDbInterface = transactionsDb
  ) {
    if (maxTotalDurationMs !== undefined && (isNaN(maxTotalDurationMs) || maxTotalDurationMs <= 0 || maxTotalDurationMs === Infinity)) {
      throw new Error('maxTotalDurationMs must be a positive finite number to prevent silently disabling timeouts');
    }
    
    this.provider = provider;
    this.maxRetries = maxRetries;
    this.initialDelay = initialDelay;
    this.maxTotalDurationMs = maxTotalDurationMs;
    this.clock = clock;
    this.store = store;
  }

  /**
   * Orchestrates the polling lifecycle for a given transaction hash.
   * Initializes local state if necessary and triggers the recursive backoff loop.
   */
  public async poll(txHash: string): Promise<void> {
    if (!this.acceptingNewPolls) {
      return;
    }

    const existingPoll = this.activePolls.get(txHash);
    if (existingPoll) {
      await existingPoll;
      return;
    }

    let transaction = this.store.get(txHash);

    if (!transaction) {
      transaction = {
        hash: txHash,
        status: TransactionStatus.PENDING,
        retryCount: 0,
        startedAt: new Date(this.clock.now()),
      };
      this.store.set(txHash, transaction);
    } else if (!transaction.startedAt) {
      transaction.startedAt = new Date(this.clock.now());
      this.store.set(txHash, transaction);
    }

    const pollPromise = (async () => {
      try {
        await this.pollWithBackoff(txHash);
      } catch (error) {
        // Catch fatal orchestrator errors to prevent process-level unhandled rejections
        console.error(`Polling orchestrator failed for ${txHash}:`, error);
      }
    })();

    this.activePolls.set(txHash, pollPromise);
    try {
      await pollPromise;
    } finally {
      this.activePolls.delete(txHash);
    }
  }

  /**
   * Recovers and resumes polling for any transactions left in a PENDING state
   * (e.g., after an application restart).
   */
  public async recoverPendingTransactions(): Promise<void> {
    const pendingTransactions = Array.from(this.store.values()).filter(
      tx => tx.status === TransactionStatus.PENDING
    );

    for (const tx of pendingTransactions) {
      // Re-enqueue the polling process in the background.
      this.pollWithBackoff(tx.hash).catch(error => {
        console.error(`Recovery polling failed for ${tx.hash}:`, error);
      });
    }
  }

  /**
   * Stops accepting new polling work during shutdown.
   */
  public stopAccepting(): void {
    this.acceptingNewPolls = false;
  }

  /**
   * Waits for in-flight polling work to finish before continuing shutdown.
   */
  public async drain(): Promise<void> {
    if (this.activePolls.size === 0) {
      return;
    }

    await Promise.allSettled(Array.from(this.activePolls.values()));
  }

  /**
   * Persists any pending transactions so shutdown can checkpoint state.
   */
  public async checkpoint(): Promise<void> {
    for (const transaction of this.store.values()) {
      if (transaction.status === TransactionStatus.PENDING) {
        this.store.set(transaction.hash, transaction);
      }
    }
  }

  /**
   * Finalizes the poller after the drain phase.
   */
  public async close(): Promise<void> {
    await this.drain();
  }

  /**
   * Recursive implementation of exponential backoff polling.
   * Balances the need for low-latency confirmation against API rate limits.
   */
  private async pollWithBackoff(txHash: string): Promise<void> {
    const transaction = this.store.get(txHash);
    
    // Stop early if transaction was completed externally or deleted
    if (!transaction || transaction.status !== TransactionStatus.PENDING) {
      return;
    }

    // Circuit breaker for long-running pending transactions
    if (transaction.retryCount >= this.maxRetries) {
      transaction.status = TransactionStatus.TIMEOUT;
      transaction.lastCheckedAt = new Date(this.clock.now());
      this.store.set(txHash, transaction);
      return;
    }

    // Circuit breaker for absolute duration ceiling
    if (this.maxTotalDurationMs !== undefined && transaction.startedAt) {
      const elapsedMs = this.clock.now() - transaction.startedAt.getTime();
      if (elapsedMs >= this.maxTotalDurationMs) {
        transaction.status = TransactionStatus.TIMEOUT;
        transaction.lastCheckedAt = new Date(this.clock.now());
        this.store.set(txHash, transaction);
        return;
      }
    }

    try {
      const receipt = await this.provider.getTransactionReceipt(txHash);

      if (receipt) {
        // Map common blockchain status codes (1: Success, 0: Reverted)
        transaction.status = receipt.status === 1 ? TransactionStatus.SUCCESS : TransactionStatus.FAILED;
        transaction.receipt = receipt;
        transaction.lastCheckedAt = new Date(this.clock.now());
        this.store.set(txHash, transaction);
        return;
      }
    } catch (error) {
      // Non-fatal error; log for observability and retry on the next interval
      console.warn(`RPC error while fetching receipt for ${txHash}:`, error);
    }

    transaction.retryCount++;
    transaction.lastCheckedAt = new Date(this.clock.now());
    this.store.set(txHash, transaction);

    const delay = calculateDelay(transaction.retryCount - 1, this.initialDelay, Infinity, true);
    
    // Enforce backoff delay using the event loop to avoid blocking resources
    await new Promise(resolve => setTimeout(resolve, delay));
    return this.pollWithBackoff(txHash);
  }
}
