/**
 * @notice Cursor checkpoint for resuming indexing from stable checkpoints.
 * @dev Cursor captures the last successfully indexed event sequence for a contract.
 *      Multiple sources (e.g., onchain blocks, API pagination) use cursors to resume safely.
 */
export interface IndexerCursor {
  /** Unique identifier for the source (e.g., contract ID or API endpoint) */
  sourceId: string;

  /** Last successfully indexed event sequence for this source */
  lastSequence: number;

  /** Timestamp when this cursor was last updated */
  updatedAt: string;

  /** Metadata for this cursor (e.g., block hash, checkpoint name) */
  metadata?: Record<string, unknown>;
}

/**
 * @notice Result of attempting to update a cursor checkpoint.
 */
export interface CursorUpdateResult {
  /** Whether the cursor was successfully updated */
  success: boolean;

  /** New cursor state after update */
  cursor: IndexerCursor;

  /** Reason for failure, if any */
  reason?: string;
}

/**
 * @notice Request to resume indexing from a stored cursor.
 */
export interface CursorResumeRequest {
  sourceId: string;
  /** Optional: force resume from a specific sequence (default: use stored cursor) */
  fromSequence?: number;
}

/**
 * @notice Response when resuming from a cursor.
 */
export interface CursorResumeResult {
  /** Cursor checkpoint that was resumed from */
  cursor: IndexerCursor | null;

  /** Effective sequence to resume from */
  resumeFromSequence: number;

  /** Whether this is a fresh start (no prior cursor) */
  isFreshStart: boolean;
}
