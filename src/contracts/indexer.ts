import { ContractEventProcessor } from './processor';
import { CursorRepository } from './cursor.repository';
import { CursorResumeRequest, CursorResumeResult, CursorUpdateResult } from './cursor.types';
import { ContractEvent, PersistedContractEvent } from './types';

/**
 * @notice Result of indexing a batch of events with replay protection.
 */
export interface IndexerBatchResult {
  /** Number of events successfully indexed */
  processedCount: number;

  /** Number of duplicate events skipped */
  duplicateCount: number;

  /** Error messages if any events failed */
  errors: string[];

  /** Updated cursor after successful batch */
  newCursor?: {
    sourceId: string;
    lastSequence: number;
    updatedAt: string;
  };
}

/**
 * @notice Replay-safe contract event indexer with cursor-based checkpointing.
 *
 * Core guarantees:
 * 1. Events indexed in stable order by sequence number within each contract
 * 2. Cursor checkpoints enable resuming from last known position
 * 3. Replay protection deduplicates events across all ingestion attempts
 * 4. Idempotent - processing same batch twice produces same result
 *
 * @dev Thread-safe with respect to checkpoints if repository is thread-safe.
 */
export class ContractEventIndexer {
  constructor(
    private readonly eventProcessor: ContractEventProcessor,
    private readonly cursorRepository: CursorRepository,
  ) {}

  /**
   * Resume indexing from last known cursor position.
   *
   * @param request - Specify source and optionally override resume position
   * @returns Current cursor state and effective resume sequence
   */
  async resumeFromCursor(request: CursorResumeRequest): Promise<CursorResumeResult> {
    const cursor = await this.cursorRepository.getCursor(request.sourceId);

    if (request.fromSequence !== undefined) {
      // Force resume from specific sequence
      return {
        cursor,
        resumeFromSequence: request.fromSequence,
        isFreshStart: cursor === null,
      };
    }

    if (cursor === null) {
      // Fresh start - resume from sequence 0
      return {
        cursor: null,
        resumeFromSequence: 0,
        isFreshStart: true,
      };
    }

    // Resume from next sequence after cursor
    return {
      cursor,
      resumeFromSequence: cursor.lastSequence + 1,
      isFreshStart: false,
    };
  }

  /**
   * Index a batch of events with stable ordering and deduplication.
   *
   * Events are sorted by sequence number to ensure deterministic processing order.
   * Duplicate events (same contractId:eventId:sequence) are silently skipped.
   * Cursor is updated to the highest sequence number successfully indexed.
   *
   * Replay Invariants:
   * 1. Re-indexing an identical batch yields 0 new processed events and increments duplicateCount by the batch size.
   * 2. Indexing a partially-overlapping batch processes only new events, tracking overlaps as duplicates.
   * 3. Malformed events are surfaced in the errors array without aborting the batch.
   *
   * @param sourceId - Identifier for this indexing source (enables multiple concurrent sources)
   * @param events - Events to index (may include duplicates or out-of-order submissions)
   * @returns Result with counts and updated cursor
   *
   * @example
   * const result = await indexer.indexBatch('block-1000', [
   *   { contractId: 'c1', eventId: 'e1', sequence: 10, ...rest },
   *   { contractId: 'c1', eventId: 'e2', sequence: 11, ...rest },
   * ]);
   * console.log(`Indexed ${result.processedCount}, duplicates: ${result.duplicateCount}`);
   */
  async indexBatch(sourceId: string, events: unknown[]): Promise<IndexerBatchResult> {
    const errors: string[] = [];
    let processedCount = 0;
    let duplicateCount = 0;
    let maxSequence = -1;

    // Sort events by sequence for stable ordering
    const sortedEvents = this.sortEventsBySequence(events);

    for (const event of sortedEvents) {
      try {
        const result = await this.eventProcessor.ingest(event);

        if (result.status === 'accepted') {
          processedCount++;
          // Extract sequence if event validation succeeded
          maxSequence = this.updateMaxSequence(event, maxSequence);
        } else if (result.status === 'duplicate') {
          duplicateCount++;
          maxSequence = this.updateMaxSequence(event, maxSequence);
        } else if (result.status === 'invalid') {
          errors.push(`[application] ${result.reason || 'Event validation failed'}`);
        }
      } catch (error) {
        const errorClass = this.classifyRpcError(error);
        const message = error instanceof Error ? error.message : 'unknown';
        const retryAfter = this.extractRetryAfter(error);
        const providerCode = this.extractProviderCode(error);
        const retryInfo = retryAfter !== null ? ` (retry after ${retryAfter}s)` : '';
        const codeInfo = providerCode !== null ? ` (provider code: ${providerCode})` : '';
        errors.push(`[${errorClass}] ${message}${retryInfo}${codeInfo}`);
      }
    }

    // Update cursor with highest indexed sequence
    let newCursor = undefined;
    if (maxSequence >= 0) {
      const updateResult = await this.cursorRepository.updateCursor(sourceId, maxSequence);
      if (updateResult.success) {
        newCursor = {
          sourceId: updateResult.cursor.sourceId,
          lastSequence: updateResult.cursor.lastSequence,
          updatedAt: updateResult.cursor.updatedAt,
        };
      }
    }

    return {
      processedCount,
      duplicateCount,
      errors: errors.length > 0 ? errors : [],
      newCursor,
    };
  }

  /**
   * Get current cursor state for a source.
   */
  async getCursor(sourceId: string) {
    return this.cursorRepository.getCursor(sourceId);
  }

  /**
   * List all cursor checkpoints.
   */
  async listCursors() {
    return this.cursorRepository.listCursors();
  }

  /**
   * Get all indexed events (for audit/reporting).
   */
  async getIndexedEvents(): Promise<PersistedContractEvent[]> {
    return this.eventProcessor.listEvents();
  }

  /**
   * Sort events by sequence number for deterministic indexing order.
   * Handles mixed-type inputs gracefully.
   *
   * @private
   */
  private sortEventsBySequence(events: unknown[]): unknown[] {
    const validPairs = events.map((event, index) => {
      const seq = this.extractSequence(event);
      return { event, originalIndex: index, sequence: seq };
    });

    // Sort by sequence, then by original index for stability
    validPairs.sort((a, b) => {
      const seqDiff = a.sequence - b.sequence;
      return seqDiff !== 0 ? seqDiff : a.originalIndex - b.originalIndex;
    });

    return validPairs.map((pair) => pair.event);
  }

  /**
   * Safely extract sequence number from unknown event.
   * @private
   */
  private extractSequence(event: unknown): number {
    if (typeof event !== 'object' || event === null) {
      return Infinity; // Sort invalid events last
    }
    const seq = (event as Record<string, unknown>).sequence;
    return typeof seq === 'number' && Number.isInteger(seq) && seq >= 0 ? seq : Infinity;
  }

  /**
   * Update max sequence tracker for cursor.
   * @private
   */
  private updateMaxSequence(event: unknown, currentMax: number): number {
    const seq = this.extractSequence(event);
    return seq >= 0 && seq !== Infinity ? Math.max(currentMax, seq) : currentMax;
  }

  /**
   * Classify an RPC error into an explicit retry class.
   * @private
   */
  private classifyRpcError(error: unknown): string {
    const status = this.extractHttpStatus(error);
    const message = error instanceof Error ? error.message.toLowerCase() : '';

    if (this.isTimeoutError(error, message)) return 'timeout';
    if (status === 429 || message.includes('rate limit') || message.includes('too many requests')) return 'rate_limit';
    if (this.isMalformedResponse(message)) return 'malformed_response';
    if (this.isTransportError(error, message)) return 'transport';
    if (status !== null && status >= 400) return 'application';
    return 'unknown';
  }

  private extractHttpStatus(error: unknown): number | null {
    if (error && typeof error === 'object') {
      const err = error as Record<string, unknown>;
      if (typeof err.status === 'number') return err.status;
      if (typeof err.statusCode === 'number') return err.statusCode;
      if (err.response && typeof err.response === 'object') {
        const resp = err.response as Record<string, unknown>;
        if (typeof resp.status === 'number') return resp.status;
      }
    }
    return null;
  }

  private extractRetryAfter(error: unknown): string | null {
    if (error && typeof error === 'object') {
      const err = error as Record<string, unknown>;
      const response = err.response && typeof err.response === 'object' ? err.response as Record<string, unknown> : err;
      const headers = response.headers;
      if (headers && typeof headers === 'object') {
        const h = headers as Record<string, unknown>;
        const val = h['retry-after'] ?? h['Retry-After'];
        if (typeof val === 'string' || typeof val === 'number') return String(val);
      }
    }
    return null;
  }

  private extractProviderCode(error: unknown): string | null {
    if (error && typeof error === 'object') {
      const err = error as Record<string, unknown>;
      const source = err.error && typeof err.error === 'object' ? err.error as Record<string, unknown> : err;
      if (typeof source.code === 'string' || typeof source.code === 'number') return String(source.code);
      if (typeof err.code === 'string' || typeof err.code === 'number') return String(err.code);
    }
    return null;
  }

  private isTimeoutError(error: unknown, message: string): boolean {
    if (error instanceof Error) {
      const name = error.name.toLowerCase();
      if (name === 'timeouterror' || name === 'aborterror') return true;
    }
    return message.includes('timeout') || message.includes('timed out');
  }

  private isMalformedResponse(message: string): boolean {
    return message.includes('json') && (message.includes('unexpected') || message.includes('parse') || message.includes('syntax'));
  }

  private isTransportError(error: unknown, message: string): boolean {
    if (message.includes('econnreset') || message.includes('econnrefused') || message.includes('network') || message.includes('socket')) return true;
    if (error instanceof TypeError && message.includes('fetch')) return true;
    return false;
  }
}
