/**
 * @module contracts/cursor.repository
 * @description Reusable cursor encode/decode primitives.
 *
 * The cursor is a base-64 URL-safe JSON blob containing a {@link CursorPosition}.
 * Encoding is intentionally opaque to callers — they should treat it as an
 * untyped string and never parse it themselves.
 *
 * Security note: the cursor value is decoded with a try/catch and the
 * resulting fields are validated before use, so a malformed or tampered
 * cursor produces a 400 rather than a runtime exception.
 */

import type { CursorPosition } from './cursor.types';
import { CURSOR_MAX_LIMIT, CURSOR_DEFAULT_LIMIT, CURSOR_MAX_LENGTH } from './cursor.types';
import { IndexerCursor, CursorUpdateResult, CursorResumeResult, CursorResumeRequest } from './cursor.types';

/**
 * Encodes a {@link CursorPosition} into an opaque base-64 string suitable for
 * embedding in an API response.
 *
 * @param position - The anchor row's `createdAt` + `id` tuple.
 * @returns A base-64 URL-safe encoded cursor string.
 */
export function encodeCursor(position: CursorPosition): string {
  const json = JSON.stringify(position);
  return Buffer.from(json, 'utf8').toString('base64url');
}

/**
 * Decodes a cursor string previously produced by {@link encodeCursor}.
 *
 * Enforces a maximum length of {@link CURSOR_MAX_LENGTH} characters and strict
 * base64url charset validation before performing any buffer allocations or
 * JSON parsing to prevent DoS via excessively large or malformed inputs.
 *
 * @param cursor - The opaque cursor string from the client.
 * @returns The decoded {@link CursorPosition}.
 * @throws {Error} When the cursor is malformed, oversized, tampered, or missing required fields.
 */
export function decodeCursor(cursor: string): CursorPosition {
  if (typeof cursor !== 'string' || cursor.length > CURSOR_MAX_LENGTH) {
    throw new Error('Invalid pagination cursor: malformed');
  }

  // Base64url strict charset (RFC 4648 §5). Rejects padding (=), whitespace, or other encodings.
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new Error('Invalid pagination cursor: malformed');
  }

  let parsed: unknown;
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Invalid pagination cursor: cannot decode');
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>)['createdAt'] !== 'string' ||
    typeof (parsed as Record<string, unknown>)['id'] !== 'string'
  ) {
    throw new Error('Invalid pagination cursor: missing required fields');
  }

  const pos = parsed as CursorPosition;

  // Basic ISO-8601 sanity check — rejects obviously garbage timestamps
  if (isNaN(Date.parse(pos.createdAt))) {
    throw new Error('Invalid pagination cursor: createdAt is not a valid date');
  }

  return pos;
}

/**
 * Clamps and validates a raw `limit` value from query params.
 *
 * @param raw - The raw value from `req.query.limit`.
 * @returns A safe integer in [1, {@link CURSOR_MAX_LIMIT}].
 * @throws {Error} When the supplied value exceeds {@link CURSOR_MAX_LIMIT}.
 */
export function parseLimit(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') {
    return CURSOR_DEFAULT_LIMIT;
  }

  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`Invalid limit: must be a positive integer`);
  }
  if (n > CURSOR_MAX_LIMIT) {
    throw new Error(
      `Invalid limit: ${n} exceeds maximum allowed page size of ${CURSOR_MAX_LIMIT}`
    );
  }
  return n;
}

/** Result of {@link resolveCursorQueryParam} when the raw value is well-formed (or absent). */
export interface CursorQueryOk {
  ok: true;
  /** The validated cursor, or `undefined` when none was supplied. */
  cursor: string | undefined;
}

/** Result of {@link resolveCursorQueryParam} when the raw value fails validation. */
export interface CursorQueryError {
  ok: false;
  message: string;
}

/**
 * Validates a raw `cursor` query-string value without throwing.
 *
 * Both contracts-listing handlers need to eagerly reject a garbage cursor
 * with a 400 before calling the service layer. This centralizes that check
 * so callers get a discriminated result instead of duplicating a
 * decode-then-catch block.
 *
 * @param rawCursor - The raw `req.query['cursor']` value (usually `string | undefined`).
 * @returns `{ ok: true, cursor }` when the value is absent or decodes successfully,
 *   otherwise `{ ok: false, message }` with the same message `decodeCursor` throws.
 */
export function resolveCursorQueryParam(rawCursor: unknown): CursorQueryOk | CursorQueryError {
  if (rawCursor !== undefined && typeof rawCursor === 'string') {
    try {
      decodeCursor(rawCursor);
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  const cursor =
    typeof rawCursor === 'string' && rawCursor.length > 0 ? rawCursor : undefined;

  return { ok: true, cursor };
}



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
