/**
 * @module health/pagination
 * @description Opaque cursor-based pagination for the health probes listing.
 *
 * Design decisions:
 * - Cursors are opaque: Base64-encoded JSON `{ index: number }`. Clients
 *   must not construct or mutate them; they are treated as strings.
 * - The cursor points to the *start* of the next page (exclusive offset).
 *   A `null` nextCursor means there are no more items.
 * - Default page size is {@link DEFAULT_HEALTH_PAGE_SIZE}; hard cap is
 *   {@link MAX_HEALTH_PAGE_SIZE}. A requested limit above the cap is
 *   clamped silently (the response includes the effective limit used).
 * - An unrecognised or tampered cursor returns a {@link CursorError} so the
 *   router can reject it with 400 before running any probe logic.
 */

/** Default number of probes returned per page when `limit` is omitted. */
export const DEFAULT_HEALTH_PAGE_SIZE = 20;

/** Hard upper bound on probes returned per page. Over-limit values are clamped. */
export const MAX_HEALTH_PAGE_SIZE = 100;

// ─── Cursor encoding / decoding ───────────────────────────────────────────────

interface CursorPayload {
  /** Zero-based array index of the first item on the next page. */
  index: number;
}

/**
 * Encode an opaque cursor from a numeric offset.
 *
 * @param index - Zero-based index of the first item on the **next** page.
 * @returns URL-safe Base64 string.
 */
export function encodeCursor(index: number): string {
  const payload: CursorPayload = { index };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

/** Discriminated-union result of {@link decodeCursor}. */
export type CursorResult =
  | { ok: true; index: number }
  | { ok: false; error: CursorError };

export type CursorError = "invalid_cursor" | "cursor_out_of_range";

/**
 * Decode and validate an opaque cursor string.
 *
 * Returns `{ ok: false }` instead of throwing so callers can convert the
 * failure to an HTTP 400 without try/catch boilerplate.
 *
 * @param raw       - The raw cursor string from the query parameter.
 * @param totalItems - Total number of items in the full dataset; used to
 *                    validate the decoded offset is in range.
 */
export function decodeCursor(
  raw: string,
  totalItems: number,
): CursorResult {
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(json);

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as CursorPayload).index !== "number" ||
      !Number.isInteger((parsed as CursorPayload).index) ||
      (parsed as CursorPayload).index < 0
    ) {
      return { ok: false, error: "invalid_cursor" };
    }

    const { index } = parsed as CursorPayload;

    // An index equal to totalItems is valid: it means "start of an empty
    // last page" which simply yields zero items and no nextCursor.
    if (index > totalItems) {
      return { ok: false, error: "cursor_out_of_range" };
    }

    return { ok: true, index };
  } catch {
    return { ok: false, error: "invalid_cursor" };
  }
}

// ─── Clamp helper ─────────────────────────────────────────────────────────────

/**
 * Clamp a requested page size to the allowed range [1, MAX_HEALTH_PAGE_SIZE].
 *
 * @param requested - Caller-supplied limit (already a positive integer).
 */
export function clampPageSize(requested: number): number {
  return Math.min(Math.max(1, requested), MAX_HEALTH_PAGE_SIZE);
}

// ─── Page slice ───────────────────────────────────────────────────────────────

/** Result of a successful {@link paginateItems} call. */
export interface PageResult<T> {
  /** Items for the current page. */
  items: T[];
  /**
   * Opaque cursor for the next page, or `null` when this is the last page.
   */
  nextCursor: string | null;
  /** Effective page size used (after clamping). */
  limit: number;
}

/**
 * Slice an array into a cursor-addressed page.
 *
 * @param allItems   - Full, ordered dataset.
 * @param startIndex - Zero-based index of the first item to include.
 * @param limit      - Desired number of items; will be clamped.
 */
export function paginateItems<T>(
  allItems: T[],
  startIndex: number,
  limit: number,
): PageResult<T> {
  const effectiveLimit = clampPageSize(limit);
  const slice = allItems.slice(startIndex, startIndex + effectiveLimit);
  const nextIndex = startIndex + slice.length;
  const hasMore = nextIndex < allItems.length;

  return {
    items: slice,
    nextCursor: hasMore ? encodeCursor(nextIndex) : null,
    limit: effectiveLimit,
  };
}
