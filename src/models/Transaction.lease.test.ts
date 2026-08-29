import {
  InMemoryTransactionStore,
  SqliteTransactionStore,
  TransactionStatus,
  TransactionsDbInterface,
} from './Transaction';
import { closeDb } from '../db/database';

process.env.DB_PATH = ':memory:';

/**
 * Unit tests for the lease-fencing primitives shared by the transaction stores.
 *
 * These cover the storage contract used by {@link TransactionPoller} to prevent
 * two poller instances from updating the same transaction after a lease owner
 * has changed: lease acquisition/renewal, expiry with clock-skew tolerance, and
 * compare-and-swap (fenced) writes.
 */
describe('Transaction store lease fencing', () => {
  const OWNER_A = 'instance-a';
  const OWNER_B = 'instance-b';

  const runFor = (getStore: () => TransactionsDbInterface): void => {
    const store = (): TransactionsDbInterface => getStore();

    describe('acquireLease', () => {
      it('creates a PENDING transaction and grants the lease for an unknown hash', () => {
        const acquired = store().acquireLease('0xnew', OWNER_A, new Date(1000), 0, 0);
        expect(acquired).toBe(true);

        const tx = store().get('0xnew');
        expect(tx).toBeDefined();
        expect(tx!.status).toBe(TransactionStatus.PENDING);
        expect(tx!.retryCount).toBe(0);
        expect(tx!.leaseOwner).toBe(OWNER_A);
        expect(tx!.leaseExpiresAt?.getTime()).toBe(1000);
      });

      it('renews the lease for the same owner, preserving transaction state', () => {
        store().acquireLease('0xrenew', OWNER_A, new Date(1000), 0, 0);

        const renewed = store().acquireLease('0xrenew', OWNER_A, new Date(5000), 4000, 0);
        expect(renewed).toBe(true);

        const tx = store().get('0xrenew');
        expect(tx!.leaseOwner).toBe(OWNER_A);
        expect(tx!.leaseExpiresAt?.getTime()).toBe(5000);
        expect(tx!.status).toBe(TransactionStatus.PENDING);
      });

      it('refuses to grant a live lease held by another owner', () => {
        store().acquireLease('0xheld', OWNER_A, new Date(10_000), 0, 0);

        const acquired = store().acquireLease('0xheld', OWNER_B, new Date(20_000), 0, 0);
        expect(acquired).toBe(false);

        const tx = store().get('0xheld');
        expect(tx!.leaseOwner).toBe(OWNER_A);
      });

      it('grants the lease to a new owner once the previous lease expires', () => {
        store().acquireLease('0xexpires', OWNER_A, new Date(1000), 0, 0);

        // now=1000, skew=0: the lease is no longer active.
        const acquired = store().acquireLease('0xexpires', OWNER_B, new Date(2000), 1000, 0);
        expect(acquired).toBe(true);
        expect(store().get('0xexpires')!.leaseOwner).toBe(OWNER_B);
      });

      it('applies clock-skew tolerance before a lease may be stolen', () => {
        store().acquireLease('0xskew', OWNER_A, new Date(1000), 0, 0);
        const skewMs = 500;

        // now=1000 is past the nominal expiry but within the skew window
        // (1000 + 500 > 1000) — the lease must still be considered live.
        expect(store().acquireLease('0xskew', OWNER_B, new Date(2000), 1000, skewMs)).toBe(false);

        // At now=1500 (expiry + skew) the lease becomes stealable.
        expect(store().acquireLease('0xskew', OWNER_B, new Date(2500), 1500, skewMs)).toBe(true);
        expect(store().get('0xskew')!.leaseOwner).toBe(OWNER_B);
      });

      it('acquires legacy rows that predate lease tracking', () => {
        store().set('0xlegacy', {
          hash: '0xlegacy',
          status: TransactionStatus.PENDING,
          retryCount: 3,
        });

        const acquired = store().acquireLease('0xlegacy', OWNER_A, new Date(1000), 0, 0);
        expect(acquired).toBe(true);

        const tx = store().get('0xlegacy');
        expect(tx!.leaseOwner).toBe(OWNER_A);
        expect(tx!.retryCount).toBe(3);
      });
    });

    describe('isLeaseOwner', () => {
      it('is true for the current owner and false for everyone else', () => {
        store().acquireLease('0xowner', OWNER_A, new Date(10_000), 0, 0);
        expect(store().isLeaseOwner('0xowner', OWNER_A)).toBe(true);
        expect(store().isLeaseOwner('0xowner', OWNER_B)).toBe(false);
      });

      it('is false for unknown hashes', () => {
        expect(store().isLeaseOwner('0xmissing', OWNER_A)).toBe(false);
      });

      it('is false once a terminal write has cleared the lease', () => {
        store().acquireLease('0xterminal', OWNER_A, new Date(10_000), 0, 0);
        store().setIfLeaseOwner('0xterminal', {
          hash: '0xterminal',
          status: TransactionStatus.SUCCESS,
          retryCount: 0,
        }, OWNER_A);

        expect(store().isLeaseOwner('0xterminal', OWNER_A)).toBe(false);
      });
    });

    describe('setIfLeaseOwner (fenced writes)', () => {
      it('applies the write while the caller owns the lease', () => {
        store().acquireLease('0xwrite', OWNER_A, new Date(10_000), 0, 0);

        const written = store().setIfLeaseOwner('0xwrite', {
          hash: '0xwrite',
          status: TransactionStatus.SUCCESS,
          retryCount: 0,
          receipt: { status: 1 },
        }, OWNER_A);

        expect(written).toBe(true);
        expect(store().get('0xwrite')!.status).toBe(TransactionStatus.SUCCESS);
      });

      it('rejects the write and leaves state untouched when the lease was lost', () => {
        store().acquireLease('0xstale', OWNER_A, new Date(10_000), 0, 0);

        // Owner B takes over after A's lease expires mid-poll.
        store().acquireLease('0xstale', OWNER_B, new Date(20_000), 10_000, 0);
        store().setIfLeaseOwner('0xstale', {
          hash: '0xstale',
          status: TransactionStatus.SUCCESS,
          retryCount: 0,
          receipt: { status: 1, finalizedBy: 'B' },
        }, OWNER_B);

        // A completes late and attempts to write its stale result.
        const staleWrite = store().setIfLeaseOwner('0xstale', {
          hash: '0xstale',
          status: TransactionStatus.SUCCESS,
          retryCount: 0,
          receipt: { status: 1, finalizedBy: 'A' },
        }, OWNER_A);

        expect(staleWrite).toBe(false);
        expect(store().get('0xstale')!.receipt).toEqual({ status: 1, finalizedBy: 'B' });
      });
    });
  };

  describe('InMemoryTransactionStore', () => {
    let store: InMemoryTransactionStore;

    beforeEach(() => {
      store = new InMemoryTransactionStore();
    });

    runFor(() => store);
  });

  describe('SqliteTransactionStore', () => {
    let store: SqliteTransactionStore;

    beforeEach(() => {
      process.env.DB_PATH = ':memory:';
      closeDb();
      store = new SqliteTransactionStore();
    });

    afterEach(() => {
      closeDb();
    });

    runFor(() => store);
  });
});
