import { getDb } from '../db/database';

/**
 * Transaction statuses.
 */
export enum TransactionStatus {
  PENDING = 'PENDING',
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
  TIMEOUT = 'TIMEOUT',
}

/**
 * Interface representing a blockchain transaction in the system.
 */
export interface Transaction {
  hash: string;
  status: TransactionStatus;
  receipt?: any;
  lastCheckedAt?: Date;
  retryCount: number;
  startedAt?: Date;
  /**
   * Token of the poller instance that currently holds the poll lease for this
   * transaction. Absent when no instance owns the transaction.
   *
   * Lease fencing guarantees that only the current owner may mutate the
   * transaction: a poller that loses its lease (e.g. because it expired while
   * an RPC call was in flight and another instance took over) must abandon its
   * poll instead of writing stale state.
   */
  leaseOwner?: string;
  /** When the current lease expires. Absent when no lease is held. */
  leaseExpiresAt?: Date;
}

/**
 * Interface for transaction storage implementations.
 * Abstracts persistence so callers can switch between SQLite and in-memory backends.
 */
export interface TransactionsDbInterface {
  /** Retrieves a transaction by hash, or undefined if not found. */
  get(hash: string): Transaction | undefined;
  /** Stores or updates a transaction. */
  set(hash: string, tx: Transaction): this;
  /** Deletes a transaction by hash. Returns true if a row was removed. */
  delete(hash: string): boolean;
  /** Removes all transaction records. */
  clear(): void;
  /** Returns an iterator over all stored transactions. */
  values(): IterableIterator<Transaction>;

  /**
   * Atomically acquires (or renews) the poll lease for a transaction on behalf
   * of `owner`.
   *
   * A lease is granted when:
   *  - no lease is recorded (including legacy rows that predate leases), or
   *  - the recorded lease has expired, judged with a clock-skew tolerance
   *    (`expiresAt + skewMs < now`), or
   *  - the recorded lease is already held by `owner` (renewal).
   *
   * A transaction row is created as `PENDING` when the hash is not yet known.
   * When a live lease is held by a different owner the acquisition fails and
   * the caller must not poll or write the transaction.
   *
   * @param hash      - Transaction hash.
   * @param owner     - Unique token of the polling instance requesting the lease.
   * @param expiresAt - Absolute time the lease expires.
   * @param now       - Current time (injectable clock) used for expiry checks.
   * @param skewMs    - Clock-skew tolerance applied when judging expiry.
   * @returns true when `owner` now holds the lease, false when a live lease is
   *          held by another instance.
   */
  acquireLease(hash: string, owner: string, expiresAt: Date, now: number, skewMs: number): boolean;
  /** Returns true when the stored lease for the transaction is held by `owner`. */
  isLeaseOwner(hash: string, owner: string): boolean;
  /**
   * Fenced write: persists `tx` only when the stored lease is still held by
   * `owner`. Returns true when the write was applied, false when the lease was
   * lost (the caller must abandon the poll and retry later).
   */
  setIfLeaseOwner(hash: string, tx: Transaction, owner: string): boolean;
}

/**
 * Parses a JSON receipt string safely.
 * Returns undefined for null/undefined input and for malformed JSON.
 */
function safeParseReceipt(receiptStr: string | null | undefined): any {
  if (!receiptStr) return undefined;
  try {
    return JSON.parse(receiptStr);
  } catch {
    return undefined;
  }
}

function rowToTransaction(row: any): Transaction {
  return {
    hash: row.hash,
    status: row.status as TransactionStatus,
    receipt: safeParseReceipt(row.receipt),
    lastCheckedAt: row.last_checked_at ? new Date(row.last_checked_at) : undefined,
    retryCount: row.retry_count,
    startedAt: row.started_at ? new Date(row.started_at) : undefined,
    leaseOwner: row.lease_owner ?? undefined,
    leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at) : undefined,
  };
}

/**
 * In-memory transaction store backed by a plain Map.
 * Useful for tests that need isolated state without database dependencies.
 */
export class InMemoryTransactionStore implements TransactionsDbInterface {
  private readonly store = new Map<string, Transaction>();

  get(hash: string): Transaction | undefined {
    const tx = this.store.get(hash);
    return tx ? { ...tx } : undefined;
  }

  set(hash: string, tx: Transaction): this {
    this.store.set(hash, { ...tx });
    return this;
  }

  delete(hash: string): boolean {
    return this.store.delete(hash);
  }

  clear(): void {
    this.store.clear();
  }

  values(): IterableIterator<Transaction> {
    return this.store.values();
  }

  acquireLease(hash: string, owner: string, expiresAt: Date, now: number, skewMs: number): boolean {
    const existing = this.store.get(hash);

    if (!existing) {
      this.store.set(hash, {
        hash,
        status: TransactionStatus.PENDING,
        retryCount: 0,
        startedAt: new Date(now),
        leaseOwner: owner,
        leaseExpiresAt: expiresAt,
      });
      return true;
    }

    const leaseActive =
      existing.leaseOwner !== undefined &&
      existing.leaseExpiresAt !== undefined &&
      existing.leaseExpiresAt.getTime() + skewMs > now;

    if (!leaseActive || existing.leaseOwner === owner) {
      existing.leaseOwner = owner;
      existing.leaseExpiresAt = expiresAt;
      this.store.set(hash, existing);
      return true;
    }

    return false;
  }

  isLeaseOwner(hash: string, owner: string): boolean {
    return this.store.get(hash)?.leaseOwner === owner;
  }

  setIfLeaseOwner(hash: string, tx: Transaction, owner: string): boolean {
    const existing = this.store.get(hash);
    if (existing?.leaseOwner !== owner) {
      return false;
    }
    this.store.set(hash, tx);
    return true;
  }
}

/**
 * SQLite-backed transaction store.
 *
 * Persists transaction state to the shared database, ensuring polling
 * state survives application restarts.  Uses parameterised queries
 * throughout — receipt JSON is never interpolated into SQL strings.
 *
 * On startup, non-terminal transactions are loaded from the `transactions`
 * table so that {@link TransactionPoller.recoverPendingTransactions} can
 * resume polling where it left off.
 */
export class SqliteTransactionStore implements TransactionsDbInterface {
  /**
   * Retrieves a transaction by its hash from the SQLite database.
   * Returns `undefined` when the hash is not found or when a database
   * error occurs (fail-closed behaviour).
   *
   * @param hash - The blockchain transaction hash.
   */
  get(hash: string): Transaction | undefined {
    try {
      const row = getDb().prepare('SELECT * FROM transactions WHERE hash = ?').get(hash) as any;
      if (!row) return undefined;
      return rowToTransaction(row);
    } catch {
      return undefined;
    }
  }

  /**
   * Inserts or replaces a transaction record in the SQLite database.
   * Uses `INSERT … ON CONFLICT(hash) DO UPDATE` so repeated calls with
   * the same hash update the existing row rather than creating duplicates.
   *
   * The `receipt` field is serialised with `JSON.stringify` and passed as
   * a bound parameter — it is never interpolated into the SQL string.
   *
   * @param hash - The blockchain transaction hash.
   * @param tx   - The transaction state to persist.
   */
  set(hash: string, tx: Transaction): this {
    getDb().prepare(`
      INSERT INTO transactions (hash, status, receipt, last_checked_at, retry_count, started_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(hash) DO UPDATE SET
        status = excluded.status,
        receipt = excluded.receipt,
        last_checked_at = excluded.last_checked_at,
        retry_count = excluded.retry_count,
        started_at = excluded.started_at
    `).run(
      tx.hash,
      tx.status,
      tx.receipt ? JSON.stringify(tx.receipt) : null,
      tx.lastCheckedAt ? tx.lastCheckedAt.toISOString() : null,
      tx.retryCount,
      tx.startedAt ? tx.startedAt.toISOString() : null,
    );
    return this;
  }

  /**
   * Deletes a transaction record by hash.
   *
   * @param hash - The blockchain transaction hash to remove.
   * @returns `true` if a row was deleted, `false` if no row matched.
   */
  delete(hash: string): boolean {
    const info = getDb().prepare('DELETE FROM transactions WHERE hash = ?').run(hash);
    return info.changes > 0;
  }

  /**
   * Removes every row from the `transactions` table.
   */
  clear(): void {
    getDb().prepare('DELETE FROM transactions').run();
  }

  /**
   * Acquires (or renews) the poll lease for a transaction.
   *
   * The read-decision-write sequence runs inside an exclusive transaction so
   * that two processes sharing the same SQLite file cannot both acquire the
   * lease for the same transaction. Rows are created as `PENDING` when the
   * hash is not yet known.
   */
  acquireLease(hash: string, owner: string, expiresAt: Date, now: number, skewMs: number): boolean {
    const db = getDb();
    let acquired = false;

    const decide = (): void => {
      const existing = db
        .prepare('SELECT lease_owner, lease_expires_at FROM transactions WHERE hash = ?')
        .get(hash) as { lease_owner: string | null; lease_expires_at: string | null } | undefined;

      if (!existing) {
        db.prepare(`
          INSERT INTO transactions (hash, status, retry_count, started_at, lease_owner, lease_expires_at)
          VALUES (?, 'PENDING', 0, ?, ?, ?)
        `).run(hash, new Date(now).toISOString(), owner, expiresAt.toISOString());
        acquired = true;
        return;
      }

      const expiryMs = existing.lease_expires_at ? Date.parse(existing.lease_expires_at) : NaN;
      const leaseActive =
        existing.lease_owner !== null &&
        !isNaN(expiryMs) &&
        expiryMs + skewMs > now;

      if (!leaseActive || existing.lease_owner === owner) {
        db.prepare('UPDATE transactions SET lease_owner = ?, lease_expires_at = ? WHERE hash = ?')
          .run(owner, expiresAt.toISOString(), hash);
        acquired = true;
      }
    };

    runExclusive(db, decide);
    return acquired;
  }

  /**
   * Returns true when the stored lease for the transaction is held by `owner`.
   */
  isLeaseOwner(hash: string, owner: string): boolean {
    try {
      const row = getDb()
        .prepare('SELECT lease_owner FROM transactions WHERE hash = ?')
        .get(hash) as { lease_owner: string | null } | undefined;
      return row?.lease_owner === owner;
    } catch {
      return false;
    }
  }

  /**
   * Fenced write: updates the transaction row only while the stored lease is
   * still held by `owner`. The single `UPDATE … WHERE lease_owner = ?`
   * statement is atomic in SQLite, so a poller whose lease was taken over can
   * never clobber the new owner's state.
   */
  setIfLeaseOwner(hash: string, tx: Transaction, owner: string): boolean {
    const info = getDb().prepare(`
      UPDATE transactions
      SET status = ?, receipt = ?, last_checked_at = ?, retry_count = ?, started_at = ?,
          lease_owner = ?, lease_expires_at = ?
      WHERE hash = ? AND lease_owner = ?
    `).run(
      tx.status,
      tx.receipt ? JSON.stringify(tx.receipt) : null,
      tx.lastCheckedAt ? tx.lastCheckedAt.toISOString() : null,
      tx.retryCount,
      tx.startedAt ? tx.startedAt.toISOString() : null,
      tx.leaseOwner ?? null,
      tx.leaseExpiresAt ? tx.leaseExpiresAt.toISOString() : null,
      hash,
      owner,
    );
    return info.changes > 0;
  }

  /**
   * Returns an iterator over all stored transactions.
   *
   * ⚠️ Loads the entire table into memory. For large datasets,
   * prefer paginated queries instead.
   */
  values(): IterableIterator<Transaction> {
    const rows = getDb().prepare('SELECT * FROM transactions').all() as any[];
    return rows.map(rowToTransaction).values();
  }
}

/**
 * Runs `work` inside an exclusive SQLite transaction so a read-decision-write
 * sequence (lease acquisition) is atomic across processes sharing one database
 * file.
 *
 * Real better-sqlite3 exposes `.immediate()` (`BEGIN IMMEDIATE`), which takes
 * the write lock up front; the in-memory test double returns the function
 * unchanged, where single-threaded execution already provides atomicity.
 */
function runExclusive(db: ReturnType<typeof getDb>, work: () => void): void {
  const tx = db.transaction(work);
  const immediate = (tx as { immediate?: () => void }).immediate;
  if (typeof immediate === 'function') {
    immediate();
  } else {
    tx();
  }
}

/**
 * Creates a transaction store based on the `USE_SQLITE_TRANSACTION_STORE`
 * environment variable.
 *
 * - `'true'` (or unset / any other value) → {@link SqliteTransactionStore}
 * - `'false'` → {@link InMemoryTransactionStore}
 *
 * Tests may set this variable to `'false'` to obtain an isolated store
 * without database I/O.
 */
export function createTransactionsDb(): TransactionsDbInterface {
  const useSqlite = process.env.USE_SQLITE_TRANSACTION_STORE !== 'false';
  return useSqlite ? new SqliteTransactionStore() : new InMemoryTransactionStore();
}

export const transactionsDb: TransactionsDbInterface = createTransactionsDb();
