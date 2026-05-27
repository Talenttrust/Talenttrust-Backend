import { IndexerCursor, CursorUpdateResult, CursorResumeResult, CursorResumeRequest } from './cursor.types';

/**
 * @notice Persistence interface for indexer cursors.
 * @dev Concrete implementations can use different backends (in-memory, SQLite, Redis, etc.)
 *      while keeping replay protection and checkpoint semantics consistent.
 */
export interface CursorRepository {
  /**
   * Get cursor for a source, or null if no prior checkpoint exists.
   */
  getCursor(sourceId: string): Promise<IndexerCursor | null>;

  /**
   * Update cursor with a new sequence number, atomically.
   * Must be idempotent - replaying the update should be safe.
   */
  updateCursor(sourceId: string, newSequence: number, metadata?: Record<string, unknown>): Promise<CursorUpdateResult>;

  /**
   * List all cursors in storage.
   */
  listCursors(): Promise<IndexerCursor[]>;

  /**
   * Delete a cursor (for testing or administrative cleanup).
   */
  deleteCursor(sourceId: string): Promise<boolean>;
}

/**
 * @notice In-memory cursor repository for deterministic tests and local development.
 */
export class InMemoryCursorRepository implements CursorRepository {
  private readonly cursorsBySourceId = new Map<string, IndexerCursor>();

  async getCursor(sourceId: string): Promise<IndexerCursor | null> {
    return this.cursorsBySourceId.get(sourceId) ?? null;
  }

  async updateCursor(
    sourceId: string,
    newSequence: number,
    metadata?: Record<string, unknown>,
  ): Promise<CursorUpdateResult> {
    const now = new Date().toISOString();

    const cursor: IndexerCursor = {
      sourceId,
      lastSequence: newSequence,
      updatedAt: now,
      metadata,
    };

    this.cursorsBySourceId.set(sourceId, cursor);

    return {
      success: true,
      cursor,
    };
  }

  async listCursors(): Promise<IndexerCursor[]> {
    return Array.from(this.cursorsBySourceId.values());
  }

  async deleteCursor(sourceId: string): Promise<boolean> {
    return this.cursorsBySourceId.delete(sourceId);
  }
}
