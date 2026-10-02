import {
  AbandonedPollInfo,
  IBlockchainProvider,
  SystemClock,
  TransactionPoller,
} from './TransactionPoller';
import {
  InMemoryTransactionStore,
  SqliteTransactionStore,
  TransactionStatus,
} from '../models/Transaction';
import { closeDb } from '../db/database';

process.env.DB_PATH = ':memory:';

/**
 * Integration tests for TransactionPoller lease fencing.
 *
 * These exercise two poller instances sharing one store — the scenario behind
 * the issue — including the SQLite-backed fence (real `UPDATE … WHERE
 * lease_owner = ?` compare-and-swap) and restart recovery across instances.
 */
describe('TransactionPoller lease fencing (integration)', () => {
  let sqliteStore: SqliteTransactionStore;

  function createMockProvider(): jest.Mocked<IBlockchainProvider> {
    return { getTransactionReceipt: jest.fn() };
  }

  async function flushMicrotasks(): Promise<void> {
    await new Promise<void>((resolve) => {
      jest.requireActual<typeof import('timers')>('timers').setImmediate(resolve);
    });
  }

  async function advanceTimersAndFlush(ms: number): Promise<void> {
    jest.advanceTimersByTime(ms);
    await flushMicrotasks();
  }

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    process.env.DB_PATH = ':memory:';
    closeDb();
    sqliteStore = new SqliteTransactionStore();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    closeDb();
  });

  describe('two poller instances sharing one store', () => {
    it('exactly one instance wins the lease on a concurrent start; the other defers', async () => {
      const store = new InMemoryTransactionStore();
      const providerA = createMockProvider();
      const providerB = createMockProvider();
      providerA.getTransactionReceipt.mockResolvedValue({ status: 1, transactionHash: '0xrace', finalizedBy: 'A' });
      providerB.getTransactionReceipt.mockResolvedValue({ status: 1, transactionHash: '0xrace', finalizedBy: 'B' });

      const reports: AbandonedPollInfo[] = [];
      const pollerA = new TransactionPoller(
        providerA, 3, 100, undefined, SystemClock, store,
        { leaseToken: 'instance-a', onPollAbandoned: (info) => reports.push(info) },
      );
      const pollerB = new TransactionPoller(
        providerB, 3, 100, undefined, SystemClock, store,
        { leaseToken: 'instance-b', onPollAbandoned: (info) => reports.push(info) },
      );

      await Promise.all([pollerA.poll('0xrace'), pollerB.poll('0xrace')]);
      await flushMicrotasks();

      const stored = store.get('0xrace');
      expect(stored?.status).toBe(TransactionStatus.SUCCESS);

      // Exactly one instance polled; the loser deferred without writing.
      const totalProviderCalls =
        providerA.getTransactionReceipt.mock.calls.length +
        providerB.getTransactionReceipt.mock.calls.length;
      expect(totalProviderCalls).toBe(1);

      const winner = providerA.getTransactionReceipt.mock.calls.length === 1 ? 'A' : 'B';
      expect(stored?.receipt.finalizedBy).toBe(winner);
      expect(reports).toHaveLength(0);
      expect(pollerA.abandonedPolls).toBe(0);
      expect(pollerB.abandonedPolls).toBe(0);
    });

    it('fences out the old worker late write through the SQLite store', async () => {
      const txHash = '0xsql-takeover';
      let resolveLateRpc!: (receipt: any) => void;
      const providerA = createMockProvider();
      const providerB = createMockProvider();
      providerA.getTransactionReceipt.mockImplementation(
        () => new Promise((resolve) => { resolveLateRpc = resolve; }),
      );
      providerB.getTransactionReceipt.mockResolvedValue({ status: 0, transactionHash: txHash, finalizedBy: 'B' });

      const reports: AbandonedPollInfo[] = [];
      const pollerA = new TransactionPoller(
        providerA, 3, 100, undefined, SystemClock, sqliteStore,
        { leaseToken: 'instance-a', leaseDurationMs: 100, leaseSkewMs: 0, onPollAbandoned: (info) => reports.push(info) },
      );
      const pollerB = new TransactionPoller(
        providerB, 3, 100, undefined, SystemClock, sqliteStore,
        { leaseToken: 'instance-b', leaseDurationMs: 100, leaseSkewMs: 0 },
      );

      const pollPromiseA = pollerA.poll(txHash);
      await flushMicrotasks();
      expect(sqliteStore.get(txHash)?.leaseOwner).toBe('instance-a');

      // A's 100ms lease expires while its RPC is in flight; B takes over.
      await advanceTimersAndFlush(100);
      const pollPromiseB = pollerB.poll(txHash);
      await flushMicrotasks();
      expect(sqliteStore.get(txHash)?.status).toBe(TransactionStatus.FAILED);

      // A completes late; its SUCCESS write must be rejected by the SQL fence.
      resolveLateRpc({ status: 1, transactionHash: txHash, finalizedBy: 'A' });
      await flushMicrotasks();
      await Promise.all([pollPromiseA, pollPromiseB]);

      const stored = sqliteStore.get(txHash);
      expect(stored?.status).toBe(TransactionStatus.FAILED);
      expect(stored?.receipt).toEqual({ status: 0, transactionHash: txHash, finalizedBy: 'B' });
      expect(reports).toEqual([
        expect.objectContaining({ txHash, reason: 'lease-lost-during-rpc', leaseOwner: 'instance-a' }),
      ]);
      expect(pollerA.abandonedPolls).toBe(1);
    });

    it('renews the lease across backoff iterations through the SQLite store', async () => {
      const provider = createMockProvider();
      provider.getTransactionReceipt.mockResolvedValue(null);

      const poller = new TransactionPoller(
        provider, 3, 100, undefined, SystemClock, sqliteStore,
        { leaseToken: 'instance-a', leaseDurationMs: 100, leaseSkewMs: 0 },
      );

      const pollPromise = poller.poll('0xsql-renew');
      await flushMicrotasks();
      expect(sqliteStore.get('0xsql-renew')?.leaseOwner).toBe('instance-a');
      expect(sqliteStore.get('0xsql-renew')?.retryCount).toBe(1);

      // Step through the backoff schedule (75/150/300ms with jitter 0.5): the
      // lease is renewed on every iteration, so the poll is never abandoned
      // even though each individual 100ms lease is shorter than the total time
      // the poll stays alive.
      await advanceTimersAndFlush(75);
      expect(sqliteStore.get('0xsql-renew')?.retryCount).toBe(2);

      await advanceTimersAndFlush(150);
      expect(sqliteStore.get('0xsql-renew')?.retryCount).toBe(3);

      await advanceTimersAndFlush(300);
      expect(poller.abandonedPolls).toBe(0);
      expect(sqliteStore.get('0xsql-renew')?.status).toBe(TransactionStatus.TIMEOUT);
      await pollPromise;
    });
  });

  describe('restart recovery across instances', () => {
    it('resumes only transactions whose lease has expired, skipping live leases (SQLite)', async () => {
      // A dead instance's lease expired long ago.
      sqliteStore.acquireLease('0xrestart-expired', 'dead-instance', new Date(-10_000), -10_000, 0);
      // Another live instance still holds a lease.
      sqliteStore.acquireLease('0xrestart-live', 'live-instance', new Date(10_000), 0, 0);

      const provider = createMockProvider();
      provider.getTransactionReceipt.mockResolvedValue({ status: 1, transactionHash: '0xrestart-expired' });

      const restarted = new TransactionPoller(
        provider, 3, 100, undefined, SystemClock, sqliteStore,
        { leaseToken: 'fresh-instance', leaseSkewMs: 0 },
      );

      await restarted.recoverPendingTransactions();
      await flushMicrotasks();

      expect(provider.getTransactionReceipt).toHaveBeenCalledTimes(1);
      expect(provider.getTransactionReceipt).toHaveBeenCalledWith('0xrestart-expired');
      expect(sqliteStore.get('0xrestart-expired')?.status).toBe(TransactionStatus.SUCCESS);
      expect(sqliteStore.get('0xrestart-live')?.leaseOwner).toBe('live-instance');
      expect(sqliteStore.get('0xrestart-live')?.status).toBe(TransactionStatus.PENDING);
    });
  });
});
