import { randomUUID } from 'crypto';
import { Transaction, TransactionStatus, TransactionsDbInterface, transactionsDb } from '../models/Transaction';
import { calculateDelay } from '../utils/retry';
import { logger } from '../logger';

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

/** Why a poll was abandoned mid-flight. */
export type AbandonReason =
  | 'lease-lost-before-poll'
  | 'lease-renewal-failed'
  | 'lease-lost-during-rpc'
  | 'fence-rejected-write';

/** Structured report emitted when a poll is abandoned because its lease was lost. */
export interface AbandonedPollInfo {
  txHash: string;
  reason: AbandonReason;
  /** Token of the instance that lost the lease. */
  leaseOwner: string;
  abandonedAt: Date;
}

export interface TransactionPollerOptions {
  /**
   * How long (ms) a poll lease is held before another instance may take over.
   * The lease is renewed before every RPC call, so this only bounds how long an
   * in-flight RPC may outlive its owner without the transaction being fenced.
   * Default: 30_000.
   */
  leaseDurationMs?: number;
  /**
   * Clock-skew tolerance (ms) applied when judging whether a lease has expired.
   * A lease is only considered expired when `expiresAt + skewMs < now`, so a
   * node with a slightly slow clock cannot have its lease stolen early by a
   * fast-clocked peer. Default: 5_000.
   */
  leaseSkewMs?: number;
  /**
   * Unique token identifying this poller instance. Generated per instance when
   * omitted, so every poller in a process group has a distinct fencing token.
   */
  leaseToken?: string;
  /**
   * Invoked whenever this instance abandons a poll because the lease was lost.
   * Enables reporting abandoned work for retry (e.g. re-enqueueing the hash).
   */
  onPollAbandoned?: (info: AbandonedPollInfo) => void;
}

/**
 * Monitors blockchain transaction status using an exponential backoff strategy.
 * Designed to ensure eventual consistency and respect RPC rate limits during peak network congestion.
 *
 * Lease fencing: each transaction carries a lease (`leaseOwner` / `leaseExpiresAt`
 * in the store). Only the current lease owner may mutate a transaction, and every
 * write is applied via a compare-and-swap (`setIfLeaseOwner`) so a poller whose
 * lease expired — or was taken over by another instance — while an RPC call was
 * in flight abandons its poll instead of clobbering the new owner's state.
 */
export class TransactionPoller {
  public readonly name = 'transaction-poller';
  private readonly provider: IBlockchainProvider;
  private readonly maxRetries: number;
  private readonly initialDelay: number;
  private readonly maxTotalDurationMs?: number;
  private readonly clock: IClock;
  private readonly store: TransactionsDbInterface;
  private readonly leaseToken: string;
  private readonly leaseDurationMs: number;
  private readonly leaseSkewMs: number;
  private readonly onPollAbandoned?: (info: AbandonedPollInfo) => void;
  private acceptingNewPolls = true;
  private readonly activePolls = new Map<string, Promise<void>>();
  private abandonedPollCount = 0;

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
   * @param options Optional lease-fencing configuration; see {@link TransactionPollerOptions}.
   */
  constructor(
    provider: IBlockchainProvider,
    maxRetries: number = 5,
    initialDelay: number = 1000,
    maxTotalDurationMs?: number,
    clock: IClock = SystemClock,
    store: TransactionsDbInterface = transactionsDb,
    options: TransactionPollerOptions = {}
  ) {
    if (maxTotalDurationMs !== undefined && (isNaN(maxTotalDurationMs) || maxTotalDurationMs <= 0 || maxTotalDurationMs === Infinity)) {
      throw new Error('maxTotalDurationMs must be a positive finite number to prevent silently disabling timeouts');
    }

    const {
      leaseDurationMs = 30_000,
      leaseSkewMs = 5_000,
      leaseToken = randomUUID(),
      onPollAbandoned,
    } = options;

    if (isNaN(leaseDurationMs) || leaseDurationMs <= 0 || leaseDurationMs === Infinity) {
      throw new Error('leaseDurationMs must be a positive finite number');
    }
    if (isNaN(leaseSkewMs) || leaseSkewMs < 0 || leaseSkewMs === Infinity) {
      throw new Error('leaseSkewMs must be a non-negative finite number');
    }

    this.provider = provider;
    this.maxRetries = maxRetries;
    this.initialDelay = initialDelay;
    this.maxTotalDurationMs = maxTotalDurationMs;
    this.clock = clock;
    this.store = store;
    this.leaseToken = leaseToken;
    this.leaseDurationMs = leaseDurationMs;
    this.leaseSkewMs = leaseSkewMs;
    this.onPollAbandoned = onPollAbandoned;
  }

  /** Number of polls this instance has abandoned because it lost the lease. */
  public get abandonedPolls(): number {
    return this.abandonedPollCount;
  }

  /**
   * Orchestrates the polling lifecycle for a given transaction hash.
   * Acquires the poll lease (creating the transaction when necessary) and
   * triggers the recursive backoff loop. When a live lease is held by another
   * poller instance the call defers to that owner and returns without polling.
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

    const current = this.store.get(txHash);
    if (current && current.status !== TransactionStatus.PENDING) {
      // Terminal state — nothing left to poll.
      return;
    }

    const now = this.clock.now();
    const acquired = this.store.acquireLease(
      txHash,
      this.leaseToken,
      new Date(now + this.leaseDurationMs),
      now,
      this.leaseSkewMs,
    );
    if (!acquired) {
      // A live lease is held by another poller instance; defer to it. The
      // transaction is picked up once that lease expires.
      logger.debug('Transaction poll deferred: lease held by another instance', {
        txHash,
        leaseOwner: this.leaseToken,
      });
      return;
    }

    // Backfill startedAt for legacy rows created before the duration ceiling
    // existed, so the ceiling can be enforced after an upgrade.
    const afterAcquire = this.store.get(txHash);
    if (afterAcquire && !afterAcquire.startedAt) {
      this.store.setIfLeaseOwner(txHash, {
        ...afterAcquire,
        startedAt: new Date(now),
        leaseOwner: this.leaseToken,
        leaseExpiresAt: new Date(now + this.leaseDurationMs),
      }, this.leaseToken);
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
   *
   * Only transactions whose lease is free, expired, or already owned by this
   * instance are resumed; transactions with a live lease held by another
   * poller instance are skipped so the fencing guarantee holds across restarts
   * and concurrent workers.
   */
  public async recoverPendingTransactions(): Promise<void> {
    const pendingTransactions = Array.from(this.store.values()).filter(
      tx => tx.status === TransactionStatus.PENDING
    );

    for (const tx of pendingTransactions) {
      const now = this.clock.now();
      const acquired = this.store.acquireLease(
        tx.hash,
        this.leaseToken,
        new Date(now + this.leaseDurationMs),
        now,
        this.leaseSkewMs,
      );
      if (!acquired) {
        // Another poller instance holds a live lease; skip this transaction.
        logger.debug('Recovery skipped: transaction lease held by another instance', {
          txHash: tx.hash,
          leaseOwner: this.leaseToken,
        });
        continue;
      }

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
   *
   * Every mutation of the transaction is fenced: the lease is renewed before
   * each RPC call, ownership is re-checked after the call returns, and each
   * write is a compare-and-swap that only applies while this instance still
   * owns the lease. When the lease is lost the poll is abandoned and reported
   * (see {@link TransactionPollerOptions.onPollAbandoned}) so the work can be
   * retried by the new owner.
   */
  private async pollWithBackoff(txHash: string): Promise<void> {
    const transaction = this.store.get(txHash);

    // Stop early if transaction was completed externally or deleted
    if (!transaction || transaction.status !== TransactionStatus.PENDING) {
      return;
    }

    // Fence check: only the current lease owner may touch the transaction.
    // A live lease held by another instance means the poll must be abandoned
    // and reported for retry by that instance.
    if (transaction.leaseOwner !== this.leaseToken) {
      this.reportAbandoned(txHash, 'lease-lost-before-poll');
      return;
    }

    // Circuit breaker for long-running pending transactions
    if (transaction.retryCount >= this.maxRetries) {
      this.writeTerminal(txHash, TransactionStatus.TIMEOUT);
      return;
    }

    // Circuit breaker for absolute duration ceiling
    if (this.maxTotalDurationMs !== undefined && transaction.startedAt) {
      const elapsedMs = this.clock.now() - transaction.startedAt.getTime();
      if (elapsedMs >= this.maxTotalDurationMs) {
        this.writeTerminal(txHash, TransactionStatus.TIMEOUT);
        return;
      }
    }

    // Renew the lease so it covers the upcoming RPC call. Renewal fails when
    // another instance took the lease over while we were sleeping.
    const now = this.clock.now();
    const renewed = this.store.acquireLease(
      txHash,
      this.leaseToken,
      new Date(now + this.leaseDurationMs),
      now,
      this.leaseSkewMs,
    );
    if (!renewed) {
      this.reportAbandoned(txHash, 'lease-renewal-failed');
      return;
    }

    let receipt: any;
    try {
      receipt = await this.provider.getTransactionReceipt(txHash);
    } catch (error) {
      // Non-fatal error; log for observability and retry on the next interval
      console.warn(`RPC error while fetching receipt for ${txHash}:`, error);
    }

    // The lease may have expired — and been taken over by another instance —
    // while the RPC call was in flight. Re-check ownership before writing.
    const afterRpc = this.store.get(txHash);
    if (!afterRpc) {
      // Row deleted while the RPC was in flight — stop without resurrecting it.
      return;
    }
    if (afterRpc.leaseOwner !== this.leaseToken) {
      this.reportAbandoned(txHash, 'lease-lost-during-rpc');
      return;
    }

    if (receipt) {
      // Map common blockchain status codes (1: Success, 0: Reverted)
      const status = receipt.status === 1 ? TransactionStatus.SUCCESS : TransactionStatus.FAILED;
      this.writeTerminal(txHash, status, receipt);
      return;
    }

    // Re-read the current row before incrementing so overlapping iterations
    // (e.g. recovery plus poll, or batched timer fire in tests) cannot lose
    // retry-count increments by writing from a stale snapshot.
    const current = this.store.get(txHash);
    if (!current) {
      return;
    }
    if (current.leaseOwner !== this.leaseToken) {
      this.reportAbandoned(txHash, 'fence-rejected-write');
      return;
    }

    const updated: Transaction = {
      ...current,
      retryCount: current.retryCount + 1,
      lastCheckedAt: new Date(this.clock.now()),
      leaseOwner: this.leaseToken,
      leaseExpiresAt: new Date(this.clock.now() + this.leaseDurationMs),
    };
    if (!this.store.setIfLeaseOwner(txHash, updated, this.leaseToken)) {
      this.reportAbandoned(txHash, 'fence-rejected-write');
      return;
    }

    const delay = calculateDelay(current.retryCount, this.initialDelay, Infinity, true);

    // Enforce backoff delay using the event loop to avoid blocking resources
    await new Promise(resolve => setTimeout(resolve, delay));
    return this.pollWithBackoff(txHash);
  }

  /**
   * Fenced terminal write (SUCCESS / FAILED / TIMEOUT). Re-reads the current
   * row so retryCount and other state are preserved, clears the lease, and
   * applies the write only while this instance still owns the lease.
   */
  private writeTerminal(txHash: string, status: TransactionStatus, receipt?: any): void {
    const current = this.store.get(txHash);
    if (!current) {
      return;
    }

    const updated: Transaction = {
      ...current,
      status,
      ...(receipt !== undefined ? { receipt } : {}),
      lastCheckedAt: new Date(this.clock.now()),
      // Terminal state releases the lease so a later cycle can start fresh.
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
    };

    if (!this.store.setIfLeaseOwner(txHash, updated, this.leaseToken)) {
      this.reportAbandoned(txHash, 'fence-rejected-write');
    }
  }

  /**
   * Records an abandoned poll: increments the abandonment counter, emits a
   * structured warning, and invokes the optional callback so callers can
   * re-enqueue the transaction for retry.
   */
  private reportAbandoned(txHash: string, reason: AbandonReason): void {
    this.abandonedPollCount += 1;
    logger.warn('Transaction poll abandoned — lease no longer held', {
      txHash,
      leaseOwner: this.leaseToken,
      reason,
    });
    this.onPollAbandoned?.({
      txHash,
      reason,
      leaseOwner: this.leaseToken,
      abandonedAt: new Date(this.clock.now()),
    });
  }
}
