/**
 * @module events/idempotencyStore
 *
 * SQLite-backed idempotency store with robust concurrency handling.
 *
 * ## Concurrency Strategy
 * - **WAL Mode:** Enabled for better concurrent read performance.
 * - **BEGIN IMMEDIATE:** Acquires write lock upfront to prevent deadlocks.
 * - **UNIQUE Constraint:** Primary deduplication mechanism (atomic).
 * - **Single Connection:** Serializes writes to avoid lock contention.
 * - **Retry Logic:** Handles transient SQLITE_BUSY errors gracefully.
 *
 * ## Security
 * - Provider secrets are never stored in the database.
 * - Event payloads are stored as opaque JSON strings (encrypt at rest if needed).
 * - Idempotency keys are HMAC-SHA256 hashes (not reversible).
 */

import DatabaseConstructor from '../db/betterSqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import { createHmac } from 'crypto';
import type { IdempotencyEntry, IncomingEvent, IdempotencyConfig } from './types';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: IdempotencyConfig = {
  ttlMs: 24 * 60 * 60 * 1_000, // 24 hours
  gracePeriodMs: 60 * 1_000, // 60 seconds
  maxRetries: 3,
  retryDelayMs: 10,
  timestampWindowMs: 5 * 60 * 1_000, // 5 minutes
};

/**
 * Load idempotency configuration from environment variables.
 */
export function loadIdempotencyConfig(): IdempotencyConfig {
  return {
    ttlMs: Number(process.env.IDEMPOTENCY_TTL_MS ?? DEFAULT_CONFIG.ttlMs),
    gracePeriodMs: Number(process.env.IDEMPOTENCY_GRACE_PERIOD_MS ?? DEFAULT_CONFIG.gracePeriodMs),
    maxRetries: Number(process.env.IDEMPOTENCY_MAX_RETRIES ?? DEFAULT_CONFIG.maxRetries),
    retryDelayMs: Number(process.env.IDEMPOTENCY_RETRY_DELAY_MS ?? DEFAULT_CONFIG.retryDelayMs),
    timestampWindowMs: Number(process.env.IDEMPOTENCY_TIMESTAMP_WINDOW_MS ?? DEFAULT_CONFIG.timestampWindowMs),
  };
}

// ---------------------------------------------------------------------------
// Idempotency Key Computation
// ---------------------------------------------------------------------------

/**
 * Compute an idempotency key for an incoming event.
 *
 * The key is a deterministic HMAC-SHA256 hash of:
 * - Provider ID
 * - Event type
 * - Event ID
 * - Timestamp (rounded to a 5-minute window to handle clock skew)
 *
 * SECURITY: The key is a one-way hash. Provider secrets are never included.
 *
 * @param event - Incoming event.
 * @param config - Idempotency configuration.
 * @returns Idempotency key (64-character hex string).
 */
export function computeIdempotencyKey(
  event: IncomingEvent,
  config: IdempotencyConfig = DEFAULT_CONFIG,
): string {
  // Round timestamp to the nearest window to handle clock skew
  const windowedTimestamp = Math.floor(event.timestamp / config.timestampWindowMs) * config.timestampWindowMs;

  const payload = `${event.providerId}:${event.eventType}:${event.eventId}:${windowedTimestamp}`;

  // Use a fixed secret for HMAC (or read from env for added security)
  const secret = process.env.IDEMPOTENCY_SECRET ?? 'default-idempotency-secret';

  const hmac = createHmac('sha256', secret);
  hmac.update(payload);
  return hmac.digest('hex');
}

// ---------------------------------------------------------------------------
// IdempotencyStore
// ---------------------------------------------------------------------------

/**
 * SQLite-backed idempotency store with robust concurrency handling.
 *
 * ## Usage
 * ```typescript
 * const store = new IdempotencyStore('./data/idempotency.db');
 * const existing = await store.get(idempotencyKey);
 * if (!existing) {
 *   await store.set(entry);
 * }
 * ```
 */
export class IdempotencyStore {
  private readonly db: ReturnType<typeof DatabaseConstructor>;
  private readonly config: IdempotencyConfig;

  /**
   * @param dbPath - Path to SQLite database file (or ':memory:' for in-memory).
   * @param config - Idempotency configuration.
   */
  constructor(dbPath: string = ':memory:', config?: IdempotencyConfig) {
    this.config = config ?? loadIdempotencyConfig();
    this.db = new DatabaseConstructor(dbPath);

    // Enable WAL mode for better concurrent read performance
    this.db.pragma('journal_mode = WAL');

    // Initialize schema
    this.initializeSchema();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Retrieve an idempotency entry by key.
   *
   * Returns `null` if the entry does not exist or has expired (including grace period).
   *
   * @param idempotencyKey - The idempotency key to look up.
   * @returns The entry, or `null` if not found or expired.
   */
  public get(idempotencyKey: string): IdempotencyEntry | null {
    const nowMs = Date.now();
    const row = this.db
      .prepare(
        `SELECT * FROM idempotency_store 
         WHERE idempotency_key = ? 
         AND expires_at > ?`,
      )
      .get(idempotencyKey, nowMs - this.config.gracePeriodMs) as IdempotencyEntry | undefined;

    return row ?? null;
  }

  /**
   * Atomically insert an idempotency entry.
   *
   * Uses `INSERT OR IGNORE` to leverage SQLite's atomic constraint checking.
   * Returns `true` if the insert succeeded (caller won the race), `false` if
   * a duplicate key already exists (another concurrent request won).
   *
   * IMPORTANT: This method uses `BEGIN IMMEDIATE` to acquire a write lock
   * upfront, preventing deadlocks. It retries on SQLITE_BUSY errors.
   *
   * @param entry - The entry to insert.
   * @returns `true` if inserted, `false` if duplicate.
   */
  public insert(entry: IdempotencyEntry): boolean {
    return this.withRetry(() => {
      this.db.prepare('BEGIN IMMEDIATE').run();

      try {
        const result = this.db
          .prepare(
            `INSERT OR IGNORE INTO idempotency_store 
             (idempotency_key, provider_id, event_type, event_id, response_body, created_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            entry.idempotencyKey,
            entry.providerId,
            entry.eventType,
            entry.eventId,
            entry.responseBody,
            entry.createdAt,
            entry.expiresAt,
          );

        this.db.prepare('COMMIT').run();

        return result.changes > 0;
      } catch (err) {
        this.db.prepare('ROLLBACK').run();
        throw err;
      }
    });
  }

  /**
   * Update the response body for an existing idempotency entry.
   *
   * Used after executing the side effect to store the response.
   *
   * @param idempotencyKey - The key to update.
   * @param responseBody - Serialized response body (JSON string).
   */
  public updateResponse(idempotencyKey: string, responseBody: string): void {
    this.withRetry(() => {
      this.db
        .prepare(
          `UPDATE idempotency_store 
           SET response_body = ? 
           WHERE idempotency_key = ?`,
        )
        .run(responseBody, idempotencyKey);
    });
  }

  /**
   * Purge expired idempotency entries.
   *
   * Uses `BEGIN EXCLUSIVE` to acquire an exclusive lock, preventing reads
   * during deletion. This ensures no race conditions with concurrent lookups.
   *
   * @returns Number of entries deleted.
   */
  public purgeExpired(): number {
    return this.withRetry(() => {
      this.db.prepare('BEGIN EXCLUSIVE').run();

      try {
        const nowMs = Date.now();
        const result = this.db
          .prepare('DELETE FROM idempotency_store WHERE expires_at <= ?')
          .run(nowMs);

        this.db.prepare('COMMIT').run();

        return result.changes;
      } catch (err) {
        this.db.prepare('ROLLBACK').run();
        throw err;
      }
    });
  }

  /**
   * Close the database connection.
   *
   * Call this during graceful shutdown.
   */
  public close(): void {
    this.db.close();
  }

  /**
   * Clear all entries from the store.
   *
   * Intended for use in tests only.
   *
   * @internal
   */
  public _clear(): void {
    this.db.prepare('DELETE FROM idempotency_store').run();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Initialize the database schema.
   */
  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS idempotency_store (
        idempotency_key TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        event_id TEXT NOT NULL,
        response_body TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_expires_at 
      ON idempotency_store(expires_at);
    `);
  }

  /**
   * Execute a function with retry logic for SQLITE_BUSY errors.
   *
   * Uses exponential backoff: 10ms, 25ms, 50ms (configurable).
   *
   * @param fn - Function to execute.
   * @returns The function's return value.
   * @throws The last error if all retries are exhausted.
   */
  private withRetry<T>(fn: () => T): T {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        return fn();
      } catch (err) {
        lastError = err as Error;

        // Check if it's a SQLITE_BUSY error
        if (
          err instanceof Error &&
          (err.message.includes('SQLITE_BUSY') || err.message.includes('database is locked'))
        ) {
          if (attempt < this.config.maxRetries) {
            // Exponential backoff: 10ms, 25ms, 50ms
            const delayMs = this.config.retryDelayMs * Math.pow(2.5, attempt);
            this.sleep(delayMs);
            continue;
          }
        }

        // Non-retryable error or retries exhausted
        throw err;
      }
    }

    throw lastError!;
  }

  /**
   * Synchronous sleep (blocks the event loop — use sparingly).
   *
   * @param ms - Milliseconds to sleep.
   */
  private sleep(ms: number): void {
    const start = Date.now();
    while (Date.now() - start < ms) {
      // Busy-wait (acceptable for short delays in retry logic)
    }
  }
}
