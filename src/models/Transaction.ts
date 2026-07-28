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
