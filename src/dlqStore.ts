/**
 * @module dlqStore
 *
 * Dead Letter Queue (DLQ) storage abstraction for failed webhook deliveries.
 *
 * ## Purpose
 * When a webhook delivery fails after all retries, the event is pushed to the
 * DLQ for manual inspection or delayed retry. This module provides an
 * in-memory implementation suitable for single-process deployments.
 *
 * ## Production Considerations
 * For multi-process or persistent DLQ storage, replace `InMemoryDlqStore`
 * with a Redis-backed or database-backed implementation that implements the
 * same `DlqStore` interface.
 *
 * ## Security
 * DLQ entries may contain sensitive payload data. Ensure that:
 * - Payloads are encrypted at rest if persisted to disk/database.
 * - Provider IDs are sanitized before use as metric labels.
 * - Secrets are never included in DLQ entries.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single DLQ entry representing a failed webhook delivery.
 */
export interface DlqEntry {
  /** Opaque provider identifier. Must NOT contain secrets. */
  providerId: string;
  /** Globally unique delivery identifier. */
  deliveryId: string;
  /** Destination URL that failed. */
  targetUrl: string;
  /** Arbitrary JSON-serialisable payload body. */
  payload: unknown;
  /** Timestamp (ms since epoch) when the entry was added to the DLQ. */
  timestamp: number;
}

/**
 * DLQ store interface.
 *
 * Implementations must be **synchronous** (non-blocking) for metrics sampling.
 * Async operations (e.g., Redis calls) should be batched or cached.
 */
export interface DlqStore {
  /**
   * Add a failed delivery to the DLQ.
   *
   * @param entry - The DLQ entry to store.
   */
  push(entry: DlqEntry): void;

  /**
   * Return the current DLQ depth (number of entries) per provider.
   *
   * @returns Map of provider ID → entry count.
   */
  getDepthByProvider(): Map<string, number>;

  /**
   * Return the age (in seconds) of the oldest entry per provider.
   *
   * @returns Map of provider ID → age in seconds. Providers with empty queues
   *   are omitted from the map.
   */
  getOldestAgeByProvider(): Map<string, number>;

  /**
   * Remove up to `count` entries from the DLQ for a given provider.
   * Used for testing drainage and manual retry workflows.
   *
   * @param providerId - Provider whose entries to drain.
   * @param count - Maximum number of entries to remove.
   * @returns Array of removed entries.
   */
  drain(providerId: string, count: number): DlqEntry[];

  /**
   * Remove all entries from the DLQ.
   * Intended for use in tests only.
   *
   * @internal
   */
  clear(): void;
}

// ---------------------------------------------------------------------------
// InMemoryDlqStore
// ---------------------------------------------------------------------------

/**
 * In-memory DLQ store implementation.
 *
 * Entries are held in a `Map<providerId, Array<DlqEntry>>`. This is suitable
 * for single-process deployments or development/testing. For production
 * multi-process deployments, use a Redis-backed or database-backed store.
 */
export class InMemoryDlqStore implements DlqStore {
  private readonly entries: Map<string, DlqEntry[]> = new Map();

  /**
   * Add a failed delivery to the DLQ.
   */
  public push(entry: DlqEntry): void {
    const queue = this.entries.get(entry.providerId) ?? [];
    queue.push(entry);
    this.entries.set(entry.providerId, queue);
  }

  /**
   * Return the current DLQ depth per provider.
   */
  public getDepthByProvider(): Map<string, number> {
    const result = new Map<string, number>();
    for (const [providerId, queue] of this.entries.entries()) {
      result.set(providerId, queue.length);
    }
    return result;
  }

  /**
   * Return the age (in seconds) of the oldest entry per provider.
   */
  public getOldestAgeByProvider(): Map<string, number> {
    const result = new Map<string, number>();
    const nowMs = Date.now();

    for (const [providerId, queue] of this.entries.entries()) {
      if (queue.length === 0) {
        continue; // Skip providers with empty queues
      }

      // Oldest entry is the first one (FIFO order)
      const oldest = queue[0];
      const ageSeconds = (nowMs - oldest.timestamp) / 1_000;
      result.set(providerId, ageSeconds);
    }

    return result;
  }

  /**
   * Remove up to `count` entries from the DLQ for a given provider.
   */
  public drain(providerId: string, count: number): DlqEntry[] {
    const queue = this.entries.get(providerId);
    if (!queue || queue.length === 0) {
      return [];
    }

    const drained = queue.splice(0, count);

    // Remove the provider entry entirely if the queue is now empty
    if (queue.length === 0) {
      this.entries.delete(providerId);
    }

    return drained;
  }

  /**
   * Atomically remove up to `replayCap` entries and return them.
   * If the queue has more than `replayCap` entries, only the oldest `replayCap`
   * are removed. The removal and cap check happen in a single synchronous step so
   * concurrent callers (in the same process) cannot observe an intermediate state
   * where entries are removed but the cap has not yet been enforced.
   *
   * @param providerId - Provider whose entries to drain.
   * @param replayCap - Maximum number of entries to remove in this batch.
   * @returns Array of removed entries (at most `replayCap`).
   */
  public drainWithCap(providerId: string, replayCap: number): DlqEntry[] {
    if (replayCap <= 0) return [];

    const queue = this.entries.get(providerId);
    if (!queue || queue.length === 0) return [];

    // Splice is synchronous — read + remove in one operation
    const batch = queue.splice(0, replayCap);
    if (queue.length === 0) {
      this.entries.delete(providerId);
    }
    return batch;
  }

  /**
   * Remove all entries from the DLQ.
   * Intended for use in tests only.
   *
   * @internal
   */
  public clear(): void {
    this.entries.clear();
  }
}
