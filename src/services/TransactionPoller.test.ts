import { TransactionPoller, IBlockchainProvider, SystemClock } from './TransactionPoller';
import {
  Transaction,
  TransactionStatus,
  transactionsDb,
  InMemoryTransactionStore,
  SqliteTransactionStore,
} from '../models/Transaction';
import { closeDb, getDb } from '../db/database';
import path from 'path';
import fs from 'fs';
import os from 'os';

// Run against in-memory DB for tests
process.env.DB_PATH = ':memory:';

/**
 * Minimal blockchain receipt shape used by {@link TransactionPoller}.
 */
interface MockReceipt {
  status: 0 | 1;
  transactionHash: string;
}

/**
 * Creates a Jest mock of {@link IBlockchainProvider} with a stubbed
 * `getTransactionReceipt` implementation.
 */
function createMockProvider(): jest.Mocked<IBlockchainProvider> {
  return {
    getTransactionReceipt: jest.fn(),
  };
}

/**
 * Yields control until all pending microtasks (Promise continuations) have run.
 * Required when using fake timers because `await` chains resolve on microtasks,
 * not on timer ticks.
 */
async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => {
    jest.requireActual<typeof import('timers')>('timers').setImmediate(resolve);
  });
}

/**
 * Advances fake timers by `ms` milliseconds and drains the microtask queue so
 * polling continuations can execute.
 */
async function advanceTimersAndFlush(ms: number): Promise<void> {
  jest.advanceTimersByTime(ms);
  await flushMicrotasks();
}

/**
 * Runs only the next scheduled timer (one backoff interval) and drains microtasks.
 */
async function runNextBackoffTick(): Promise<void> {
  jest.runOnlyPendingTimers();
  await flushMicrotasks();
}

/**
 * Computes the expected backoff delay with jitter (mocked Math.random() = 0.5)
 * for a given retry count using the poller formula:
 * `initialDelay * 2^(retryCount - 1) * 0.75`.
 */
function expectedBackoffDelay(initialDelay: number, retryCount: number): number {
  const exponential = initialDelay * Math.pow(2, retryCount - 1);
  return exponential * 0.75; // Because Math.random() is mocked to 0.5
}

/**
 * Seeds the in-memory transaction store with a pre-existing record.
 */
function seedTransaction(
  hash: string,
  overrides: Partial<Omit<Transaction, 'hash'>> = {},
): Transaction {
  const transaction: Transaction = {
    hash,
    status: TransactionStatus.PENDING,
    retryCount: 0,
    ...overrides,
  };
  transactionsDb.set(hash, transaction);
  return transaction;
}

describe('TransactionPoller', () => {
  let mockProvider: jest.Mocked<IBlockchainProvider>;
  let poller: TransactionPoller;

  /** Small base delay keeps timer-based tests fast while preserving the formula. */
  const initialDelay = 100;
  const maxRetries = 3;

  beforeAll(() => {
    process.env.DB_PATH = ':memory:';
  });

  afterAll(() => {
    closeDb();
  });

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0.5); // Jitter multiplier becomes 0.75
    transactionsDb.clear();
    mockProvider = createMockProvider();
    poller = new TransactionPoller(mockProvider, maxRetries, initialDelay);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('constructor defaults', () => {
    it('uses maxRetries=5 and initialDelay=1000 when omitted', () => {
      const defaultPoller = new TransactionPoller(mockProvider);
      expect((defaultPoller as unknown as { maxRetries: number }).maxRetries).toBe(5);
      expect((defaultPoller as unknown as { initialDelay: number }).initialDelay).toBe(1000);
    });
  });

  describe('transaction registration', () => {
    it('creates a PENDING transaction when the hash is not yet tracked', async () => {
      const txHash = '0xnew';
      mockProvider.getTransactionReceipt.mockResolvedValue({ status: 1, transactionHash: txHash });

      await poller.poll(txHash);

      const stored = transactionsDb.get(txHash);
      expect(stored).toBeDefined();
      expect(stored?.status).toBe(TransactionStatus.SUCCESS);
      expect(stored?.retryCount).toBe(0);
    });

    it('reuses an existing transaction record instead of resetting state', async () => {
      const txHash = '0xexisting';
      seedTransaction(txHash, { retryCount: 2 });
      mockProvider.getTransactionReceipt.mockResolvedValue({ status: 1, transactionHash: txHash });

      await poller.poll(txHash);

      expect(transactionsDb.get(txHash)?.retryCount).toBe(2);
      expect(transactionsDb.get(txHash)?.status).toBe(TransactionStatus.SUCCESS);
    });
  });

  describe('receipt-driven status transitions', () => {
    it('sets SUCCESS and stores the receipt when the chain reports status 1', async () => {
      const txHash = '0xsuccess';
      const receipt: MockReceipt = { status: 1, transactionHash: txHash };
      mockProvider.getTransactionReceipt.mockResolvedValueOnce(receipt);

      await poller.poll(txHash);

      const stored = transactionsDb.get(txHash);
      expect(stored?.status).toBe(TransactionStatus.SUCCESS);
      expect(stored?.receipt).toEqual(receipt);
      expect(stored?.lastCheckedAt).toBeInstanceOf(Date);
      expect(mockProvider.getTransactionReceipt).toHaveBeenCalledTimes(1);
      expect(mockProvider.getTransactionReceipt).toHaveBeenCalledWith(txHash);
    });

    it('sets FAILED and stores the receipt when the chain reports status 0', async () => {
      const txHash = '0xreverted';
      const receipt: MockReceipt = { status: 0, transactionHash: txHash };
      mockProvider.getTransactionReceipt.mockResolvedValueOnce(receipt);

      await poller.poll(txHash);

      const stored = transactionsDb.get(txHash);
      expect(stored?.status).toBe(TransactionStatus.FAILED);
      expect(stored?.receipt).toEqual(receipt);
      expect(stored?.lastCheckedAt).toBeInstanceOf(Date);
      expect(mockProvider.getTransactionReceipt).toHaveBeenCalledTimes(1);
    });

    it('keeps polling through null receipts until a final receipt arrives', async () => {
      const txHash = '0xpending-then-success';
      mockProvider.getTransactionReceipt
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ status: 1, transactionHash: txHash });

      const pollPromise = poller.poll(txHash);

      await flushMicrotasks();
      expect(transactionsDb.get(txHash)?.status).toBe(TransactionStatus.PENDING);
      expect(transactionsDb.get(txHash)?.retryCount).toBe(1);

      await runNextBackoffTick();
      expect(transactionsDb.get(txHash)?.retryCount).toBe(2);

      await runNextBackoffTick();
      expect(transactionsDb.get(txHash)?.status).toBe(TransactionStatus.SUCCESS);
      expect(mockProvider.getTransactionReceipt).toHaveBeenCalledTimes(3);

      await pollPromise;
    });
  });

  describe('RPC error resilience', () => {
    it('logs a warning, increments retryCount, and continues polling after an RPC error', async () => {
      const txHash = '0xrpc-error';
      const rpcError = new Error('RPC unavailable');
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

      mockProvider.getTransactionReceipt
        .mockRejectedValueOnce(rpcError)
        .mockResolvedValueOnce({ status: 1, transactionHash: txHash });

      const pollPromise = poller.poll(txHash);

      await flushMicrotasks();
      expect(warnSpy).toHaveBeenCalledWith(
        `RPC error while fetching receipt for ${txHash}:`,
        rpcError,
      );
      expect(transactionsDb.get(txHash)?.status).toBe(TransactionStatus.PENDING);
      expect(transactionsDb.get(txHash)?.retryCount).toBe(1);

      await runNextBackoffTick();
      expect(transactionsDb.get(txHash)?.status).toBe(TransactionStatus.SUCCESS);

      await pollPromise;
      warnSpy.mockRestore();
    });
  });

  describe('exponential backoff schedule with full jitter', () => {
    it('schedules delays using full-jitter bounds', async () => {
      const txHash = '0xbackoff-formula';
      mockProvider.getTransactionReceipt.mockResolvedValue(null);

      const pollPromise = poller.poll(txHash);
      const setTimeoutSpy = jest.spyOn(global, 'setTimeout');

      await flushMicrotasks();
      expect(mockProvider.getTransactionReceipt).toHaveBeenCalledTimes(1);
      expect(transactionsDb.get(txHash)?.retryCount).toBe(1);

      const firstScheduledDelay = setTimeoutSpy.mock.calls.at(-1)?.[1];
      expect(firstScheduledDelay).toBe(expectedBackoffDelay(initialDelay, 1));

      await runNextBackoffTick();
      expect(transactionsDb.get(txHash)?.retryCount).toBe(2);

      const secondScheduledDelay = setTimeoutSpy.mock.calls.at(-1)?.[1];
      expect(secondScheduledDelay).toBe(expectedBackoffDelay(initialDelay, 2));

      await runNextBackoffTick();
      expect(transactionsDb.get(txHash)?.retryCount).toBe(3);

      const thirdScheduledDelay = setTimeoutSpy.mock.calls.at(-1)?.[1];
      expect(thirdScheduledDelay).toBe(expectedBackoffDelay(initialDelay, 3));

      // Stop further polling
      const tx = transactionsDb.get(txHash);
      if (tx) {
        tx.status = TransactionStatus.SUCCESS;
        transactionsDb.set(txHash, tx);
      }
      jest.runAllTimers();
      await pollPromise;
    });

    it('does not invoke the provider again until the backoff interval passes', async () => {
      const txHash = '0xbackoff-timing';
      mockProvider.getTransactionReceipt.mockResolvedValue(null);

      const pollPromise = poller.poll(txHash);
      await flushMicrotasks();
      expect(mockProvider.getTransactionReceipt).toHaveBeenCalledTimes(1);

      const delay = expectedBackoffDelay(initialDelay, 1);
      await advanceTimersAndFlush(delay - 1);
      expect(mockProvider.getTransactionReceipt).toHaveBeenCalledTimes(1);

      // Complete the first backoff window.
      await advanceTimersAndFlush(1);
      expect(mockProvider.getTransactionReceipt).toHaveBeenCalledTimes(2);

      const tx = transactionsDb.get(txHash);
      if (tx) {
        tx.status = TransactionStatus.SUCCESS;
        transactionsDb.set(txHash, tx);
      }
      jest.runAllTimers();
      await pollPromise;
    });
  });

  describe('TIMEOUT transition', () => {
    it('sets TIMEOUT after maxRetries exhausted with persistently null receipts', async () => {
      const txHash = '0xtimeout';
      mockProvider.getTransactionReceipt.mockResolvedValue(null);

      const pollPromise = poller.poll(txHash);

      // Attempt 1: retryCount 0 → 1
      await flushMicrotasks();
      expect(transactionsDb.get(txHash)?.retryCount).toBe(1);

      // Attempt 2: retryCount 1 → 2
      await advanceTimersAndFlush(expectedBackoffDelay(initialDelay, 1));
      expect(transactionsDb.get(txHash)?.retryCount).toBe(2);

      // Attempt 3: retryCount 2 → 3
      await advanceTimersAndFlush(expectedBackoffDelay(initialDelay, 2));
      expect(transactionsDb.get(txHash)?.retryCount).toBe(3);

      // Attempt 4: retryCount >= maxRetries → TIMEOUT
      await advanceTimersAndFlush(expectedBackoffDelay(initialDelay, 3));

      const stored = transactionsDb.get(txHash);
      expect(stored?.status).toBe(TransactionStatus.TIMEOUT);
      expect(stored?.lastCheckedAt).toBeInstanceOf(Date);
      expect(mockProvider.getTransactionReceipt).toHaveBeenCalledTimes(maxRetries);

      await pollPromise;
    });
  });

  describe('early termination when status is no longer PENDING', () => {
    it('returns early when status is changed externally to a non-PENDING value', async () => {
      const txHash = '0xexternal-success';
      mockProvider.getTransactionReceipt.mockResolvedValue(null);

      const pollPromise = poller.poll(txHash);
      await flushMicrotasks();
      expect(mockProvider.getTransactionReceipt).toHaveBeenCalledTimes(1);

      const tx = transactionsDb.get(txHash);
      expect(tx).toBeDefined();
      tx!.status = TransactionStatus.SUCCESS;
      transactionsDb.set(txHash, tx!);

      await advanceTimersAndFlush(expectedBackoffDelay(initialDelay, 1));
      expect(mockProvider.getTransactionReceipt).toHaveBeenCalledTimes(1);

      await pollPromise;
    });

    it('returns early when status is changed externally to FAILED', async () => {
      const txHash = '0xexternal-failed';
      mockProvider.getTransactionReceipt.mockResolvedValue(null);

      const pollPromise = poller.poll(txHash);
      await flushMicrotasks();

      const tx = transactionsDb.get(txHash);
      expect(tx).toBeDefined();
      tx!.status = TransactionStatus.FAILED;
      transactionsDb.set(txHash, tx!);

      await advanceTimersAndFlush(expectedBackoffDelay(initialDelay, 1));
      expect(mockProvider.getTransactionReceipt).toHaveBeenCalledTimes(1);

      await pollPromise;
    });

    it('returns early when the transaction record is deleted externally', async () => {
      const txHash = '0xdeleted';
      mockProvider.getTransactionReceipt.mockResolvedValue(null);

      const pollPromise = poller.poll(txHash);
      await flushMicrotasks();
      expect(mockProvider.getTransactionReceipt).toHaveBeenCalledTimes(1);

      transactionsDb.delete(txHash);

      await advanceTimersAndFlush(expectedBackoffDelay(initialDelay, 1));
      expect(mockProvider.getTransactionReceipt).toHaveBeenCalledTimes(1);

      await pollPromise;
    });

    it('does not poll when the transaction is already in a terminal state', async () => {
      const txHash = '0xalready-done';
      seedTransaction(txHash, { status: TransactionStatus.SUCCESS });

      await poller.poll(txHash);

      expect(mockProvider.getTransactionReceipt).not.toHaveBeenCalled();
    });
  });

  describe('recovery routine', () => {
    it('re-enqueues polling for all PENDING transactions', async () => {
      seedTransaction('0xpending1');
      seedTransaction('0xpending2');
      seedTransaction('0xsuccess1', { status: TransactionStatus.SUCCESS });
      
      mockProvider.getTransactionReceipt.mockResolvedValue({ status: 1, transactionHash: 'hash' });
      
      await poller.recoverPendingTransactions();
      
      await flushMicrotasks();
      
      expect(mockProvider.getTransactionReceipt).toHaveBeenCalledTimes(2);
      expect(mockProvider.getTransactionReceipt).toHaveBeenCalledWith('0xpending1');
      expect(mockProvider.getTransactionReceipt).toHaveBeenCalledWith('0xpending2');
    });
  });

  describe('orchestrator error handling', () => {
    it('catches fatal pollWithBackoff errors and logs them without rejecting poll()', async () => {
      const txHash = '0xfatal';
      seedTransaction(txHash);
      const fatalError = new Error('Fatal orchestrator failure');
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      const originalMethod = (poller as unknown as { pollWithBackoff: (hash: string) => Promise<void> })
        .pollWithBackoff;
      (poller as unknown as { pollWithBackoff: jest.Mock }).pollWithBackoff = jest
        .fn()
        .mockRejectedValue(fatalError);

      await expect(poller.poll(txHash)).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalledWith(
        `Polling orchestrator failed for ${txHash}:`,
        fatalError,
      );

      (poller as unknown as { pollWithBackoff: typeof originalMethod }).pollWithBackoff = originalMethod;
      errorSpy.mockRestore();
    });
  });

  describe('duration ceiling (maxTotalDurationMs)', () => {
    it('throws an error if ceiling is set to an invalid value (<= 0, NaN, Infinity)', () => {
      expect(() => new TransactionPoller(mockProvider, maxRetries, initialDelay, 0)).toThrow('maxTotalDurationMs must be a positive finite number');
      expect(() => new TransactionPoller(mockProvider, maxRetries, initialDelay, -50)).toThrow('maxTotalDurationMs must be a positive finite number');
      expect(() => new TransactionPoller(mockProvider, maxRetries, initialDelay, NaN)).toThrow('maxTotalDurationMs must be a positive finite number');
      expect(() => new TransactionPoller(mockProvider, maxRetries, initialDelay, Infinity)).toThrow('maxTotalDurationMs must be a positive finite number');
    });

    it('transitions to TIMEOUT immediately if ceiling is reached before max retries', async () => {
      const txHash = '0xceiling-timeout';
      // Poller with a strict 200ms ceiling.
      const ceilingPoller = new TransactionPoller(mockProvider, maxRetries, initialDelay, 200);
      mockProvider.getTransactionReceipt.mockResolvedValue(null);

      const pollPromise = ceilingPoller.poll(txHash);
      
      await flushMicrotasks();
      expect(transactionsDb.get(txHash)?.retryCount).toBe(1);

      // Advance by 200ms, which hits the ceiling exactly
      await advanceTimersAndFlush(200);

      const stored = transactionsDb.get(txHash);
      // Even though retryCount is 1 (maxRetries is 3), we hit the ceiling
      expect(stored?.status).toBe(TransactionStatus.TIMEOUT);
      expect(mockProvider.getTransactionReceipt).toHaveBeenCalledTimes(1);

      await pollPromise;
    });

    it('transitions to TIMEOUT before the first retry if the initial delay itself exceeds the ceiling', async () => {
      const txHash = '0xceiling-before-first-retry';
      // Poller with a ceiling of 50ms, while initialDelay is 100ms.
      const ceilingPoller = new TransactionPoller(mockProvider, maxRetries, 100, 50);
      mockProvider.getTransactionReceipt.mockResolvedValue(null);

      const pollPromise = ceilingPoller.poll(txHash);
      
      await flushMicrotasks();
      // Initially, retryCount is 1 because of the first inline attempt.
      expect(transactionsDb.get(txHash)?.retryCount).toBe(1);

      // The first delay scheduled will be 100 * 0.75 = 75ms.
      // So let's advance time by 75ms to wake it up.
      await advanceTimersAndFlush(75);

      const stored = transactionsDb.get(txHash);
      // On waking up at 75ms, elapsed time is 75 >= 50, so it immediately times out
      // without incrementing retryCount or calling the provider again.
      expect(stored?.status).toBe(TransactionStatus.TIMEOUT);
      expect(stored?.retryCount).toBe(1);
      expect(mockProvider.getTransactionReceipt).toHaveBeenCalledTimes(1);

      await pollPromise;
    });

    it('does not transition to TIMEOUT if transaction completes before ceiling', async () => {
      const txHash = '0xceiling-success';
      const ceilingPoller = new TransactionPoller(mockProvider, maxRetries, initialDelay, 200);
      
      mockProvider.getTransactionReceipt
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ status: 1, transactionHash: txHash });

      const pollPromise = ceilingPoller.poll(txHash);
      
      await flushMicrotasks();
      expect(transactionsDb.get(txHash)?.retryCount).toBe(1);

      // Advance by less than the ceiling (e.g., 100ms)
      await advanceTimersAndFlush(100);

      const stored = transactionsDb.get(txHash);
      expect(stored?.status).toBe(TransactionStatus.SUCCESS);
      
      await pollPromise;
    });
  });

  describe('SQLite persistence', () => {
    const testDbDir = os.tmpdir();

    /** Returns an isolated file path so tests never share state. */
    function uniqueDbPath(): string {
      return path.join(testDbDir, `tt-transactions-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
    }

    /** Cleans up a test DB file if it exists. */
    function cleanupDbPath(p: string): void {
      try { fs.unlinkSync(p); } catch { /* ignore */ }
    }

    beforeAll(() => {
      process.env.USE_SQLITE_TRANSACTION_STORE = 'true';
    });

    afterEach(() => {
      jest.useRealTimers();
      jest.restoreAllMocks();
    });

    it('state survives restart simulation', async () => {
      const dbPath = uniqueDbPath();
      const oldPath = process.env.DB_PATH;
      process.env.DB_PATH = dbPath;
      closeDb();

      try {
        const store = new SqliteTransactionStore();
        store.set('0xrestart-sim', {
          hash: '0xrestart-sim',
          status: TransactionStatus.PENDING,
          retryCount: 2,
        });

        closeDb();

        const freshStore = new SqliteTransactionStore();
        const tx = freshStore.get('0xrestart-sim');
        expect(tx).toBeDefined();
        expect(tx!.hash).toBe('0xrestart-sim');
        expect(tx!.status).toBe(TransactionStatus.PENDING);
        expect(tx!.retryCount).toBe(2);
      } finally {
        closeDb();
        process.env.DB_PATH = oldPath;
        cleanupDbPath(dbPath);
      }
    });

    it('restarts polling during backoff and continues schedule', async () => {
      const store = new InMemoryTransactionStore();
      const backoffMockProvider = createMockProvider();
      backoffMockProvider.getTransactionReceipt.mockResolvedValue(null);

      store.set('0xbackoff-restart', {
        hash: '0xbackoff-restart',
        status: TransactionStatus.PENDING,
        retryCount: 1,
      });

      jest.useFakeTimers();
      jest.spyOn(Math, 'random').mockReturnValue(0.5);

      const restartedPoller = new TransactionPoller(
        backoffMockProvider, maxRetries, initialDelay, undefined, SystemClock, store
      );

      const setTimeoutSpy = jest.spyOn(global, 'setTimeout');

      await restartedPoller.recoverPendingTransactions();
      await flushMicrotasks();

      const firstDelay = setTimeoutSpy.mock.calls.at(-1)?.[1];
      expect(firstDelay).toBe(expectedBackoffDelay(initialDelay, 2));

      await runNextBackoffTick();
      expect(backoffMockProvider.getTransactionReceipt).toHaveBeenCalledTimes(2);

      const tx = store.get('0xbackoff-restart');
      if (tx) {
        tx.status = TransactionStatus.SUCCESS;
        store.set('0xbackoff-restart', tx);
      }
      jest.runAllTimers();
    });

    it('loads only PENDING transactions on recovery, ignoring terminal states', async () => {
      jest.useFakeTimers();
      jest.spyOn(Math, 'random').mockReturnValue(0.5);

      const store = new InMemoryTransactionStore();
      store.set('0xterm-success', { hash: '0xterm-success', status: TransactionStatus.SUCCESS, retryCount: 0 });
      store.set('0xterm-failed', { hash: '0xterm-failed', status: TransactionStatus.FAILED, retryCount: 0 });
      store.set('0xterm-timeout', { hash: '0xterm-timeout', status: TransactionStatus.TIMEOUT, retryCount: 0 });

      const mockProv = createMockProvider();
      mockProv.getTransactionReceipt.mockResolvedValue({ status: 1, transactionHash: 'hash' });

      const termPoller = new TransactionPoller(
        mockProv, maxRetries, initialDelay, undefined, SystemClock, store
      );

      await termPoller.recoverPendingTransactions();
      await flushMicrotasks();

      expect(mockProv.getTransactionReceipt).not.toHaveBeenCalled();
    });

    it('handles empty pending state on startup', async () => {
      const store = new InMemoryTransactionStore();
      const mockProv = createMockProvider();
      mockProv.getTransactionReceipt.mockResolvedValue({ status: 1 });

      const emptyPoller = new TransactionPoller(
        mockProv, maxRetries, initialDelay, undefined, SystemClock, store
      );

      await emptyPoller.recoverPendingTransactions();
      await flushMicrotasks();

      expect(mockProv.getTransactionReceipt).not.toHaveBeenCalled();
    });

    it('handles corrupted receipt JSON without crashing', () => {
      const dbPath = uniqueDbPath();
      const oldPath = process.env.DB_PATH;
      process.env.DB_PATH = dbPath;
      closeDb();

      try {
        const db = getDb();
        db.prepare(`
          INSERT INTO transactions (hash, status, receipt, retry_count)
          VALUES (?, ?, ?, ?)
        `).run('0xcorrupted', 'PENDING', '{invalid_json}', 0);

        const store = new SqliteTransactionStore();
        const tx = store.get('0xcorrupted');
        expect(tx).toBeDefined();
        expect(tx!.receipt).toBeUndefined();
        expect(tx!.status).toBe(TransactionStatus.PENDING);
      } finally {
        closeDb();
        process.env.DB_PATH = oldPath;
        cleanupDbPath(dbPath);
      }
    });

    it('does not re-poll terminal transactions after restart', async () => {
      const dbPath = uniqueDbPath();
      const oldPath = process.env.DB_PATH;
      process.env.DB_PATH = dbPath;
      closeDb();

      try {
        const db = getDb();

        db.prepare(`
          INSERT INTO transactions (hash, status, receipt, retry_count)
          VALUES (?, ?, ?, ?)
        `).run('0xdone-success', 'SUCCESS', '{}', 0);

        db.prepare(`
          INSERT INTO transactions (hash, status, receipt, retry_count)
          VALUES (?, ?, ?, ?)
        `).run('0xdone-failed', 'FAILED', '{}', 3);

        db.prepare(`
          INSERT INTO transactions (hash, status, receipt, retry_count)
          VALUES (?, ?, ?, ?)
        `).run('0xdone-timeout', 'TIMEOUT', '{}', 5);

        const store = new SqliteTransactionStore();
        const mockProv = createMockProvider();
        mockProv.getTransactionReceipt.mockResolvedValue({ status: 1, transactionHash: 'hash' });

        const termPoller = new TransactionPoller(
          mockProv, maxRetries, initialDelay, undefined, SystemClock, store
        );

        await termPoller.recoverPendingTransactions();

        expect(mockProv.getTransactionReceipt).not.toHaveBeenCalled();
      } finally {
        closeDb();
        process.env.DB_PATH = oldPath;
        cleanupDbPath(dbPath);
      }
    });
  });
});
