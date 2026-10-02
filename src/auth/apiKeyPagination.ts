/**
 * @module apiKeyPagination
 * @description Cursor-based pagination for API keys with hardened concurrency safety.
 *
 * ## Concurrency invariants
 *
 * 1. **Snapshot consistency** — `paginateApiKeys` operates on a caller-supplied
 *    readonly snapshot.  New keys created concurrently may not appear on the
 *    current page set, but no key present in the snapshot is ever skipped or
 *    duplicated within a single paginated traversal.
 *
 * 2. **Deterministic sort order** — Records are sorted by `(createdAt DESC, id ASC)`
 *    using lexicographic ISO-8601 string comparison.  ISO-8601 strings of equal
 *    precision are lexicographically monotone (newer > older), so `Date.parse`
 *    is intentionally avoided to prevent precision loss when two records share
 *    the same millisecond.  The `id` tiebreaker guarantees a total order even
 *    when two keys are created within the same millisecond, preventing any key
 *    from being silently skipped or duplicated across pages under concurrent
 *    insertion.
 *
 * 3. **Tamper-evident cursors** — Cursors are HMAC-SHA256 signed.  Mutation of
 *    any field (position, version, or issued-at) is detected and rejected with
 *    {@link InvalidApiKeyCursorError}.
 *
 * 4. **Lazy secret loading** — `CURSOR_SECRET` is resolved from the environment
 *    on each signing/verification call via {@link getCursorSecret}, not captured
 *    at module-load time.  Rotating `API_KEYS_CURSOR_SECRET` without a restart
 *    (e.g., via a secrets-manager sidecar) takes effect on the next cursor
 *    operation.  Old cursors signed with a previous secret become invalid after
 *    rotation — this is intentional and documented as a security property.
 *
 * 5. **Idempotent retries** — Presenting the same cursor multiple times always
 *    produces an identical page so long as the underlying snapshot is unchanged.
 *    Under concurrent writes the snapshot may differ across retries, but the
 *    cursor position itself is immutable and always filters correctly.
 *
 * 6. **Boundary safety** — Page-size clamping is applied at both the
 *    `parseApiKeyPageSize` entry point (user-facing) and inside
 *    `paginateApiKeys` (internal call sites), so over-large limits cannot
 *    reach the sort/filter loop regardless of the caller.
 *
 * 7. **Input validation** — `parseApiKeyPageSize` emits a structured warn log
 *    when an invalid (non-integer, non-positive, or non-string) value is
 *    supplied so operators can diagnose mis-configured clients without the
 *    caller silently receiving a default they did not request.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { createLogger } from '../logger';

const log = createLogger({ module: 'apiKeyPagination' });

export const API_KEYS_DEFAULT_PAGE_SIZE = 20;
export const API_KEYS_MAX_PAGE_SIZE = 100;

const CURSOR_VERSION = 1;
const CURSOR_MAX_LENGTH = 512;

/**
 * Fallback secret used only when `API_KEYS_CURSOR_SECRET` is absent from the
 * environment.  Production deployments MUST override this via the env variable.
 *
 * @internal
 */
const CURSOR_SECRET_FALLBACK = 'talenttrust-api-keys-cursor-v1';

/**
 * Resolve the HMAC signing secret for cursor tokens.
 *
 * The secret is read from the environment on each call rather than being
 * captured at module-load time.  This allows the secret to be rotated via a
 * secrets-manager sidecar (or environment update) without restarting the
 * process.  Rotating the secret immediately invalidates all outstanding cursors,
 * which is the correct security behaviour.
 *
 * @returns The active cursor signing secret.
 */
function getCursorSecret(): string {
  return process.env['API_KEYS_CURSOR_SECRET'] ?? CURSOR_SECRET_FALLBACK;
}

/** Public surface of a cursor position embedded in the token. */
export interface ApiKeyCursorPosition {
  /** ISO-8601 creation timestamp of the last item on the previous page. */
  createdAt: string;
  /** Unique identifier of the last item on the previous page. */
  id: string;
}

/** Internal representation stored inside the signed cursor payload. */
interface EncodedApiKeyCursor extends ApiKeyCursorPosition {
  /** Schema version — must equal {@link CURSOR_VERSION}. */
  version: number;
  /**
   * Wall-clock UTC milliseconds at cursor creation time.
   *
   * Stored to enable future cursor-expiry policies.  Not used for ordering or
   * filtering in the current implementation.
   */
  issuedAt: number;
}

/** Return type of {@link paginateApiKeys}. */
export interface ApiKeyPage<T> {
  /** The items on this page (length ≤ the requested limit). */
  items: T[];
  /**
   * Opaque cursor to pass as `cursor` on the next request.
   * `null` when there are no further pages.
   */
  nextCursor: string | null;
}

/**
 * Thrown when a cursor string fails structural, length, regex, or HMAC
 * verification.  Always maps to HTTP 400 — callers must not retry with the
 * same cursor.
 */
export class InvalidApiKeyCursorError extends Error {
  constructor() {
    super('Invalid pagination cursor');
    this.name = 'InvalidApiKeyCursorError';
  }
}

/**
 * Compute the HMAC-SHA256 signature of `value` using the current cursor secret.
 *
 * @param value - Base64url-encoded payload string.
 * @returns Base64url-encoded signature.
 */
function sign(value: string): string {
  return createHmac('sha256', getCursorSecret()).update(value).digest('base64url');
}

/**
 * Timing-safe comparison of two base64url-encoded strings.
 *
 * Returns `false` when the strings differ in length to avoid a short-circuit
 * that would be exploitable as a timing oracle.
 *
 * @param left  - Expected string.
 * @param right - Untrusted string from the client.
 * @returns `true` iff both strings contain identical bytes.
 */
function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

/**
 * Encode a cursor position as a signed, opaque token.
 *
 * Format: `<base64url(JSON payload)>.<base64url(HMAC-SHA256 signature)>`
 *
 * The payload embeds:
 * - `version`  — schema version for forward-compatible parsing.
 * - `createdAt` — ISO-8601 timestamp of the anchor record.
 * - `id`       — identifier of the anchor record.
 * - `issuedAt` — UTC epoch milliseconds at encoding time (future expiry use).
 *
 * @param position - The position to encode.
 * @returns A URL-safe signed cursor string.
 */
export function encodeApiKeyCursor(position: ApiKeyCursorPosition): string {
  const payload: EncodedApiKeyCursor = {
    version: CURSOR_VERSION,
    createdAt: position.createdAt,
    id: position.id,
    issuedAt: Date.now(),
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encodedPayload}.${sign(encodedPayload)}`;
}

/**
 * Decode and verify a cursor token produced by {@link encodeApiKeyCursor}.
 *
 * Validation steps (in order — first failure throws):
 * 1. Type, length, and character-set checks (no external calls).
 * 2. Split on the **last** `.` to separate payload from signature.
 *    Using `lastIndexOf` rather than `indexOf` is more robust: if a future
 *    base64url variant ever embeds dots they would still be contained in the
 *    payload half and would not corrupt the signature split.
 * 3. HMAC-SHA256 verification via {@link constantTimeEqual}.
 * 4. Base64url decode and JSON parse.
 * 5. Schema-level field checks: version, createdAt parsability, id presence.
 *
 * @param cursor - The cursor string provided by the client.
 * @returns Decoded {@link ApiKeyCursorPosition} on success.
 * @throws {@link InvalidApiKeyCursorError} on any validation failure.
 */
export function decodeApiKeyCursor(cursor: string): ApiKeyCursorPosition {
  // ── 1. Structural pre-checks ─────────────────────────────────────────────
  if (
    typeof cursor !== 'string' ||
    cursor.length === 0 ||
    cursor.length > CURSOR_MAX_LENGTH ||
    !/^[A-Za-z0-9_-]+\.[a-zA-Z0-9_-]+$/.test(cursor)
  ) {
    throw new InvalidApiKeyCursorError();
  }

  // ── 2. Split on the last '.' for robustness ───────────────────────────────
  const separatorIndex = cursor.lastIndexOf('.');
  const encodedPayload = cursor.slice(0, separatorIndex);
  const signature = cursor.slice(separatorIndex + 1);

  // ── 3. HMAC verification (constant-time) ─────────────────────────────────
  if (!constantTimeEqual(signature, sign(encodedPayload))) {
    throw new InvalidApiKeyCursorError();
  }

  // ── 4. Decode payload ─────────────────────────────────────────────────────
  try {
    const decoded = JSON.parse(
      Buffer.from(encodedPayload, 'base64url').toString('utf8'),
    ) as Partial<EncodedApiKeyCursor>;

    // ── 5. Schema validation ─────────────────────────────────────────────────
    if (
      decoded.version !== CURSOR_VERSION ||
      typeof decoded.createdAt !== 'string' ||
      decoded.createdAt.length === 0 ||
      // Validate that the stored timestamp is a well-formed ISO-8601 date.
      // We use Date.parse here only for validation (not ordering), so the
      // precision loss it introduces is inconsequential.
      Number.isNaN(Date.parse(decoded.createdAt)) ||
      typeof decoded.id !== 'string' ||
      decoded.id.length === 0 ||
      decoded.id.length > CURSOR_ID_MAX_LENGTH
    ) {
      throw new InvalidApiKeyCursorError();
    }

    return { createdAt: decoded.createdAt, id: decoded.id };
  } catch (error) {
    if (error instanceof InvalidApiKeyCursorError) {
      throw error;
    }
    throw new InvalidApiKeyCursorError();
  }
}

/**
 * Parse and bound a page-size value from an untrusted query parameter.
 *
 * Accepts a string, number, `null`, `undefined`, or empty string.
 *
 * - `undefined | null | ''` → silent default (no log; caller omitted the param).
 * - Non-integer string or value ≤ 0 → warn log + default (caller sent a bad value).
 * - Valid integer → clamped to `[1, API_KEYS_MAX_PAGE_SIZE]`.
 *
 * @param value - Raw value from `req.query.limit`.
 * @returns A page size in the range `[1, API_KEYS_MAX_PAGE_SIZE]`.
 */
export function parseApiKeyPageSize(value: unknown): number {
  // Absent parameter — use default silently.
  if (value === undefined || value === null || value === '') {
    return API_KEYS_DEFAULT_PAGE_SIZE;
  }

  const parsed = typeof value === 'string' ? Number(value) : NaN;

  if (!Number.isInteger(parsed) || parsed <= 0) {
    // Warn so operators can detect misconfigured clients, but do not reject
    // the request — degrading to the default is the safest user experience.
    log.warn('parseApiKeyPageSize: invalid page-size value, using default', {
      received: value,
      default: API_KEYS_DEFAULT_PAGE_SIZE,
    });
    return API_KEYS_DEFAULT_PAGE_SIZE;
  }

  return Math.min(parsed, API_KEYS_MAX_PAGE_SIZE);
}

/**
 * Compare two positioned records for the canonical sort order used in
 * cursor pagination: **`createdAt` descending, `id` ascending**.
 *
 * ## Why lexicographic rather than `Date.parse`
 *
 * `Date.parse` coerces ISO-8601 strings to epoch milliseconds.  When two
 * records share the same timestamp string (same-millisecond insertion under
 * concurrent writes) the date comparison is `0` and the tiebreaker determines
 * order.  The danger is that two different ISO-8601 strings can parse to the
 * same epoch value (e.g. `"2024-01-01T00:00:00.000Z"` vs
 * `"2024-01-01T00:00:00Z"`) making the comparison inconsistent with string
 * equality tests used elsewhere.
 *
 * By comparing ISO-8601 strings lexicographically (which is monotone for
 * equal-precision strings), we guarantee a stable, injective comparison that
 * matches the string equality checks used in `isAfterCursor`.
 *
 * @param left  - First record.
 * @param right - Second record.
 * @returns Negative if `left` should appear before `right`, positive if after,
 *          zero if identical (same `createdAt` and `id`).
 */
function comparePositions<T extends ApiKeyCursorPosition>(left: T, right: T): number {
  // Primary: createdAt descending — newer records come first.
  if (right.createdAt > left.createdAt) return 1;
  if (right.createdAt < left.createdAt) return -1;

  // Tiebreaker: id ascending — deterministic total order for same-ms inserts.
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

/**
 * Determine whether `item` falls strictly after the cursor anchor in the
 * canonical sort order (`createdAt DESC, id ASC`).
 *
 * "After the cursor" means "on a later page", i.e. the item is either:
 * - Older than the cursor record (`item.createdAt < cursor.createdAt`), or
 * - Same age but lexicographically greater `id` (`item.id > cursor.id`).
 *
 * Lexicographic comparison is used for `createdAt` to maintain consistency
 * with {@link comparePositions} — see that function's doc for the rationale.
 *
 * @param item   - Candidate record.
 * @param cursor - Decoded cursor anchor position.
 * @returns `true` iff `item` should appear on a page after the cursor.
 */
function isAfterCursor<T extends ApiKeyCursorPosition>(
  item: T,
  cursor: ApiKeyCursorPosition,
): boolean {
  if (item.createdAt < cursor.createdAt) return true;
  if (item.createdAt > cursor.createdAt) return false;
  // Same timestamp: item appears after cursor only when its id sorts higher.
  return item.id > cursor.id;
}

/**
 * Paginate an in-memory snapshot of API key records using a signed cursor.
 *
 * ## Concurrency model
 *
 * The caller is responsible for taking a consistent snapshot before calling
 * this function.  The function itself is **pure** (no side effects, no I/O)
 * and therefore safe to call from concurrent request handlers sharing the same
 * snapshot reference — JavaScript's single-threaded event loop guarantees that
 * the sort and filter steps complete atomically without interleaving.
 *
 * Because the snapshot may not include keys created after it was taken,
 * concurrent insertions can cause newly-created keys to be absent from the
 * current traversal.  This is the expected and documented behaviour for
 * consistent snapshot-based pagination.  Callers that need newly-created keys
 * to appear immediately should re-fetch the snapshot and restart pagination
 * from the first page.
 *
 * ## Idempotency
 *
 * Calling `paginateApiKeys` with the same snapshot and cursor always returns
 * the same result.  This makes retrying a failed request safe: the client
 * receives an identical page rather than skipping or duplicating records.
 *
 * @param records - Readonly snapshot of all candidate records.
 * @param limit   - Desired page size.  Values outside `[1, API_KEYS_MAX_PAGE_SIZE]`
 *                  are clamped; non-finite values fall back to the default.
 * @param cursor  - Opaque token from the previous page's `nextCursor`, or
 *                  `undefined` for the first page.
 * @returns The current page and an optional cursor for the next page.
 * @throws {@link InvalidApiKeyCursorError} when `cursor` fails verification.
 */
export function paginateApiKeys<T extends ApiKeyCursorPosition>(
  records: readonly T[],
  limit: number,
  cursor?: string,
  options?: ApiKeyPaginationOptions,
): ApiKeyPage<T> {
  // ── Bound the limit ───────────────────────────────────────────────────────
  const boundedLimit = Number.isFinite(limit)
    ? Math.min(Math.max(Math.trunc(limit), 1), API_KEYS_MAX_PAGE_SIZE)
    : API_KEYS_DEFAULT_PAGE_SIZE;

  // ── Stable sort: createdAt DESC, id ASC ──────────────────────────────────
  // Spread to avoid mutating the caller's array; sort is O(n log n) on the
  // snapshot taken before this call.
  const sortedRecords = [...records].sort(comparePositions);

  // ── Decode and verify cursor ──────────────────────────────────────────────
  // `decodeApiKeyCursor` throws `InvalidApiKeyCursorError` on any failure;
  // the caller (route handler) must catch and map this to HTTP 400.
  const cursorPosition = cursor === undefined ? undefined : decodeApiKeyCursor(cursor);

  // ── Filter to records that come after the cursor ──────────────────────────
  const eligibleRecords =
    cursorPosition === undefined
      ? sortedRecords
      : sortedRecords.filter((record) => isAfterCursor(record, cursorPosition));

  // ── Slice the page ────────────────────────────────────────────────────────
  const page = eligibleRecords.slice(0, boundedLimit);
  const hasMore = eligibleRecords.length > boundedLimit;

  return {
    items: page,
    nextCursor:
      hasMore && page.length > 0
        ? encodeApiKeyCursor(page[page.length - 1]!)
        : null,
  };
}
