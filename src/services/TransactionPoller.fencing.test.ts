import {
  AbandonedPollInfo,
  IBlockchainProvider,
  SystemClock,
  TransactionPoller,
} from './TransactionPoller';
import {
  InMemoryTransactionStore,
  TransactionStatus,
} from '../models/Transaction';

/**
 * Unit tests for TransactionPoller lease fencing.
 *
 * These cover the poller behaviour that prevents two poller instances from
 * updating the same transaction after a lease owner has changed: lease
 * acquisition, lease expiry mid-RPC, late writes by an old worker, process
 * restart recovery, clock-skew tolerance, and abandonment reporting.
 */
describe('TransactionPoller lease fencing', () => {
  let mockProvider: jest.Mocked<IBlockchainProvider>;
  let store: InMemoryTransactionStore;
  const initialDelay = 100;
  const maxRetries = 3;

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
    // Pin the fake clock to a known instant so absolute lease-expiry timestamps
    // in tests are relative to t=0 rather than the real wall clock.
    jest.setSystemTime(0);
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    store = new InMemoryTransactionStore();
    mockProvider = createMockProvider();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('lease acquisition', () => {
    it('holds the lease while polling and releases it on a terminal write', async () => {
      const txHash = '0xacquired';
      mockProvider.getTransactionReceipt.mockImplementation((hash) => {
        // While the RPC is in flight the lease must be held by this instance.
        expect(store.get(hash)?.leaseOwner).toBe('poller-a');
        return Promise.resolve({ status: 1, transactionHash: hash });
      });

      const poller = new TransactionPoller(
        mockProvider, maxRetries, initialDelay, undefined, SystemClock, store,
        { leaseToken: 'poller-a', leaseDurationMs: 1000, leaseSkewMs: 0 },
      );

      await poller.poll(txHash);

      const tx = store.get(txHash);
      expect(tx?.status).toBe(TransactionStatus.SUCCESS);
      // Terminal state releases the lease.
      expect(tx?.leaseOwner).toBeUndefined();
      expect(tx?.leaseExpiresAt).toBeUndefined();
    });

    it('defers to another instance holding a live lease without polling or reporting', async () => {
      const txHash = '0xdeferred';
      store.set(txHash, {
        hash: txHash,
        status: TransactionStatus.PENDING,
        retryCount: 0,
        leaseOwner: 'poller-a',
        leaseExpiresAt: new Date(10_000),
      });

      const reports: AbandonedPollInfo[] = [];
      const pollerB = new TransactionPoller(
        mockProvider, maxRetries, initialDelay, undefined, SystemClock, store,
        { leaseToken: 'poller-b', leaseDurationMs: 1000, leaseSkewMs: 0, onPollAbandoned: (info) => reports.push(info) },
      );

      await pollerB.poll(txHash);

      expect(mockProvider.getTransactionReceipt).not.toHaveBeenCalled();
      expect(store.get(txHash)?.leaseOwner).toBe('poller-a');
      expect(reports).toHaveLength(0);
      expect(pollerB.abandonedPolls).toBe(0);
    });
  });

  describe('lease expiry during RPC call', () => {
    it('abandons the poll when the lease expires while the RPC is in flight', async () => {
      const txHash = '0xexpire-during-rpc';
      let resolveLateRpc!: (receipt: any) => void;
      const providerA = createMockProvider();
      const providerB = createMockProvider();
      providerA.getTransactionReceipt.mockImplementation(
        () => new Promise((resolve) => { resolveLateRpc = resolve; }),
      );
      providerB.getTransactionReceipt.mockResolvedValue({ status: 1, transactionHash: txHash });

      const reports: AbandonedPollInfo[] = [];
      const pollerA = new TransactionPoller(
        providerA, maxRetries, initialDelay, undefined, SystemClock, store,
        { leaseToken: 'poller-a', leaseDurationMs: 100, leaseSkewMs: 0, onPollAbandoned: (info) => reports.push(info) },
      );
      const pollerB = new TransactionPoller(
        providerB, maxRetries, initialDelay, undefined, SystemClock, store,
        { leaseToken: 'poller-b', leaseDurationMs: 100, leaseSkewMs: 0 },
      );

      const pollPromiseA = pollerA.poll(txHash);
      await flushMicrotasks();
      expect(store.get(txHash)?.leaseOwner).toBe('poller-a');

      // The lease (100ms) expires while A's RPC is still pending; B takes over.
      await advanceTimersAndFlush(100);
      const pollPromiseB = pollerB.poll(txHash);
      await flushMicrotasks();
      expect(store.get(txHash)?.status).toBe(TransactionStatus.SUCCESS);

      // A's RPC finally returns — A must abandon instead of writing.
      resolveLateRpc({ status: 1, transactionHash: txHash });
      await flushMicrotasks();
      await Promise.all([pollPromiseA, pollPromiseB]);

      expect(reports).toEqual([
        expect.objectContaining({ txHash, reason: 'lease-lost-during-rpc', leaseOwner: 'poller-a' }),
      ]);
      expect(reports[0]!.abandonedAt).toBeInstanceOf(Date);
      expect(pollerA.abandonedPolls).toBe(1);
      expect(store.get(txHash)?.leaseOwner).toBeUndefined();
    });

    it('does not abandon when the lease merely lapses but no one took it over', async () => {
      const txHash = '0xself-renew';
      mockProvider.getTransactionReceipt.mockImplementation(() => {
        // Simulate an RPC that outlives the lease duration but is still owned.
        return Promise.resolve(null);
      });

      const poller = new TransactionPoller(
        mockProvider, maxRetries, initialDelay, undefined, SystemClock, store,
        { leaseToken: 'poller-a', leaseDurationMs: 100, leaseSkewMs: 0 },
      );

      const pollPromise = poller.poll(txHash);
      await flushMicrotasks();

      // Advance past the lease duration; the poller renews on the next
      // iteration instead of abandoning.
      await advanceTimersAndFlush(1000);
      expect(poller.abandonedPolls).toBe(0);
      expect(store.get(txHash)?.leaseOwner).toBe('poller-a');
      expect(store.get(txHash)?.status).toBe(TransactionStatus.PENDING);

      // Exhaust retries so the loop terminates.
      if (store.get(txHash)) {
        store.set(txHash, { ...store.get(txHash)!, status: TransactionStatus.SUCCESS });
      }
      jest.runAllTimers();
      await pollPromise;
    });
  });

  describe('old worker completes late', () => {
    it('fences out the late write of an old worker after a takeover', async () => {
      const txHash = '0xlate-worker';
      let resolveLateRpc!: (receipt: any) => void;
      const providerA = createMockProvider();
      const providerB = createMockProvider();
      providerA.getTransactionReceipt.mockImplementation(
        () => new Promise((resolve) => { resolveLateRpc = resolve; }),
      );
      // B observes a reverted (FAILED) chain state.
      providerB.getTransactionReceipt.mockResolvedValue({ status: 0, transactionHash: txHash, finalizedBy: 'B' });

      const pollerA = new TransactionPoller(
        providerA, maxRetries, initialDelay, undefined, SystemClock, store,
        { leaseToken: 'poller-a', leaseDurationMs: 100, leaseSkewMs: 0 },
      );
      const pollerB = new TransactionPoller(
        providerB, maxRetries, initialDelay, undefined, SystemClock, store,
        { leaseToken: 'poller-b', leaseDurationMs: 100, leaseSkewMs: 0 },
      );

      const pollPromiseA = pollerA.poll(txHash);
      await flushMicrotasks();

      await advanceTimersAndFlush(100);
      const pollPromiseB = pollerB.poll(txHash);
      await flushMicrotasks();
      expect(store.get(txHash)?.status).toBe(TransactionStatus.FAILED);

      // A completes late with a conflicting SUCCESS result.
      resolveLateRpc({ status: 1, transactionHash: txHash, finalizedBy: 'A' });
      await flushMicrotasks();
      await Promise.all([pollPromiseA, pollPromiseB]);

      // A's stale SUCCESS must not clobber B's FAILED outcome.
      const stored = store.get(txHash);
      expect(stored?.status).toBe(TransactionStatus.FAILED);
      expect(stored?.receipt).toEqual({ status: 0, transactionHash: txHash, finalizedBy: 'B' });
      expect(pollerA.abandonedPolls).toBe(1);
    });
  });

  describe('process restart', () => {
    it('resumes only transactions whose previous lease has expired', async () => {
      // A dead instance's lease has long expired.
      store.set('0xrestart-expired', {
        hash: '0xrestart-expired',
        status: TransactionStatus.PENDING,
        retryCount: 1,
        leaseOwner: 'dead-instance',
        leaseExpiresAt: new Date(-10_000),
      });
      // Another live instance still holds a lease.
      store.set('0xrestart-live', {
        hash: '0xrestart-live',
        status: TransactionStatus.PENDING,
        retryCount: 0,
        leaseOwner: 'live-instance',
        leaseExpiresAt: new Date(10_000),
      });

      mockProvider.getTransactionReceipt.mockResolvedValue({ status: 1, transactionHash: '0xrestart-expired' });

      const restarted = new TransactionPoller(
        mockProvider, maxRetries, initialDelay, undefined, SystemClock, store,
        { leaseToken: 'fresh-instance', leaseSkewMs: 0 },
      );

      await restarted.recoverPendingTransactions();
      await flushMicrotasks();

      expect(mockProvider.getTransactionReceipt).toHaveBeenCalledTimes(1);
      expect(mockProvider.getTransactionReceipt).toHaveBeenCalledWith('0xrestart-expired');
      expect(store.get('0xrestart-expired')?.status).toBe(TransactionStatus.SUCCESS);
      // The live lease is untouched by recovery.
      expect(store.get('0xrestart-live')?.leaseOwner).toBe('live-instance');
      expect(store.get('0xrestart-live')?.status).toBe(TransactionStatus.PENDING);
    });

    it('treats unleased legacy PENDING rows as recoverable', async () => {
      store.set('0xlegacy', {
        hash: '0xlegacy',
        status: TransactionStatus.PENDING,
        retryCount: 2,
      });

      mockProvider.getTransactionReceipt.mockResolvedValue({ status: 1, transactionHash: '0xlegacy' });

      const restarted = new TransactionPoller(
        mockProvider, maxRetries, initialDelay, undefined, SystemClock, store,
        { leaseToken: 'fresh-instance', leaseSkewMs: 0 },
      );

      await restarted.recoverPendingTransactions();
      await flushMicrotasks();

      expect(mockProvider.getTransactionReceipt).toHaveBeenCalledWith('0xlegacy');
      expect(store.get('0xlegacy')?.status).toBe(TransactionStatus.SUCCESS);
    });
  });

  describe('clock skew', () => {
    it('defers takeover while a lease is within the skew window and steals it afterwards', async () => {
      const txHash = '0xskew';
      store.set(txHash, {
        hash: txHash,
        status: TransactionStatus.PENDING,
        retryCount: 0,
        leaseOwner: 'poller-a',
        leaseExpiresAt: new Date(1000), // nominal expiry at t=1000
      });
      mockProvider.getTransactionReceipt.mockResolvedValue({ status: 1, transactionHash: txHash });

      const pollerB = new TransactionPoller(
        mockProvider, maxRetries, initialDelay, undefined, SystemClock, store,
        { leaseToken: 'poller-b', leaseDurationMs: 1000, leaseSkewMs: 500 },
      );

      // now=1100: past nominal expiry but inside the skew window (1000+500).
      jest.advanceTimersByTime(1100);
      await pollerB.poll(txHash);
      await flushMicrotasks();

      expect(mockProvider.getTransactionReceipt).not.toHaveBeenCalled();
      expect(store.get(txHash)?.leaseOwner).toBe('poller-a');

      // now=1600: past expiry + skew — the lease is stealable.
      jest.advanceTimersByTime(500);
      await pollerB.poll(txHash);
      await flushMicrotasks();

      expect(mockProvider.getTransactionReceipt).toHaveBeenCalledTimes(1);
      expect(store.get(txHash)?.status).toBe(TransactionStatus.SUCCESS);
    });
  });

  describe('abandonment reporting', () => {
    it('reports abandoned polls for retry via the callback and counter', async () => {
      const txHash = '0xreported';
      let resolveLateRpc!: (receipt: any) => void;
      const providerA = createMockProvider();
      const providerB = createMockProvider();
      providerA.getTransactionReceipt.mockImplementation(
        () => new Promise((resolve) => { resolveLateRpc = resolve; }),
      );
      providerB.getTransactionReceipt.mockResolvedValue({ status: 1, transactionHash: txHash });

      const reports: AbandonedPollInfo[] = [];
      const pollerA = new TransactionPoller(
        providerA, maxRetries, initialDelay, undefined, SystemClock, store,
        {
          leaseToken: 'poller-a',
          leaseDurationMs: 100,
          leaseSkewMs: 0,
          onPollAbandoned: (info) => reports.push(info),
        },
      );
      const pollerB = new TransactionPoller(
        providerB, maxRetries, initialDelay, undefined, SystemClock, store,
        { leaseToken: 'poller-b', leaseDurationMs: 100, leaseSkewMs: 0 },
      );

      const pollPromiseA = pollerA.poll(txHash);
      await flushMicrotasks();
      await advanceTimersAndFlush(100);
      const pollPromiseB = pollerB.poll(txHash);
      await flushMicrotasks();
      resolveLateRpc({ status: 1, transactionHash: txHash });
      await flushMicrotasks();
      await Promise.all([pollPromiseA, pollPromiseB]);

      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({
        txHash,
        reason: 'lease-lost-during-rpc',
        leaseOwner: 'poller-a',
      });
      expect(reports[0]!.abandonedAt).toBeInstanceOf(Date);
      expect(pollerA.abandonedPolls).toBe(1);
      expect(pollerB.abandonedPolls).toBe(0);
    });
  });

  describe('lease configuration', () => {
    it('rejects non-positive lease durations', () => {
      expect(() => new TransactionPoller(mockProvider, maxRetries, initialDelay, undefined, SystemClock, store, { leaseDurationMs: 0 }))
        .toThrow('leaseDurationMs must be a positive finite number');
      expect(() => new TransactionPoller(mockProvider, maxRetries, initialDelay, undefined, SystemClock, store, { leaseDurationMs: -5 }))
        .toThrow('leaseDurationMs must be a positive finite number');
      expect(() => new TransactionPoller(mockProvider, maxRetries, initialDelay, undefined, SystemClock, store, { leaseDurationMs: Infinity }))
        .toThrow('leaseDurationMs must be a positive finite number');
    });

    it('rejects negative or infinite clock-skew tolerances', () => {
      expect(() => new TransactionPoller(mockProvider, maxRetries, initialDelay, undefined, SystemClock, store, { leaseSkewMs: -1 }))
        .toThrow('leaseSkewMs must be a non-negative finite number');
      expect(() => new TransactionPoller(mockProvider, maxRetries, initialDelay, undefined, SystemClock, store, { leaseSkewMs: Infinity }))
        .toThrow('leaseSkewMs must be a non-negative finite number');
    });
  });
});
