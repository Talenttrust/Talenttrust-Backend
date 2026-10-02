/**
 * boundedPagination.types.ts — Shared types for bounded RPC event pagination.
 *
 * ## Design
 * Every scan request MUST supply either a ledger window or a time window
 * (or both). Open-ended full-history scans are explicitly rejected so
 * they cannot consume unbounded RPC capacity.
 *
 * A continuation token (opaque, base64-encoded JSON) is returned when more
 * results remain within the declared window. The token encodes the next
 * cursor position AND re-embeds the original window bounds so they cannot
 * be widened on subsequent calls — preventing a malicious client from
 * using a token to escape the window it agreed to at call time.
 *
 * ## Security notes
 * - The token is NOT signed; it is treated as opaque client input and is
 *   fully re-validated on every call. Tampered tokens are caught by Zod
 *   and result in a 400, not a 500.
 * - Window bounds are enforced server-side regardless of what the token
 *   contains; the server always intersects the requested window with the
 *   token's embedded window to produce the tightest bound.
 * - Tenant isolation is enforced at the route layer (requireAuth) and
 *   re-checked in the service (tenantId must match req.user.id).
 */

/** Maximum number of events returned in a single page. */
export const MAX_RPC_PAGE_SIZE = 200;

/** Default page size when the caller omits `limit`. */
export const DEFAULT_RPC_PAGE_SIZE = 50;

/**
 * Maximum total events that may be fetched across all continuation pages
 * within a single bound window. Prevents deep recursive replay scans.
 */
export const MAX_TOTAL_RPC_WORK = 10_000;

/**
 * Maximum ledger span allowed in a single request.
 * At ~6 s/ledger on Stellar, 17 280 ledgers ≈ 28 days.
 */
export const MAX_LEDGER_WINDOW = 17_280;

/**
 * Maximum time window in milliseconds (28 days).
 * Mirrors MAX_LEDGER_WINDOW to keep ledger and time bounds equivalent.
 */
export const MAX_TIME_WINDOW_MS = 28 * 24 * 60 * 60 * 1000;

// ── Request ──────────────────────────────────────────────────────────────────

/** Ledger-based window — both ends are inclusive. */
export interface LedgerWindow {
  /** First ledger to include (inclusive). Must be ≥ 0. */
  fromLedger: number;
  /** Last ledger to include (inclusive). Must be ≥ fromLedger. */
  toLedger: number;
}

/** Time-based window — epoch milliseconds, both ends are inclusive. */
export interface TimeWindow {
  /** Start of window as epoch ms (inclusive). */
  fromTimestampMs: number;
  /** End of window as epoch ms (inclusive). Must be ≥ fromTimestampMs. */
  toTimestampMs: number;
}

/**
 * Parameters for a bounded event scan request.
 *
 * At least one of `ledgerWindow` or `timeWindow` MUST be provided.
 * Callers may supply both to double-bound the scan.
 */
export interface BoundedScanRequest {
  /** Contract address to scan (required). */
  contractId: string;

  /** Authenticated tenant making the request — enforced by middleware. */
  tenantId: string;

  /** Ledger-based bounds for the scan (optional, but at least one bound is required). */
  ledgerWindow?: LedgerWindow;

  /** Time-based bounds for the scan (optional, but at least one bound is required). */
  timeWindow?: TimeWindow;

  /**
   * Maximum events per page (1–MAX_RPC_PAGE_SIZE).
   * Defaults to DEFAULT_RPC_PAGE_SIZE.
   */
  limit?: number;

  /**
   * Opaque continuation token returned by a previous page.
   * When provided, the service resumes from the cursor embedded in the token.
   * The token's embedded window bounds are intersected with the current request
   * to prevent window-widening attacks.
   */
  continuationToken?: string;
}

// ── Continuation token ───────────────────────────────────────────────────────

/**
 * Internal structure encoded inside the opaque continuation token.
 *
 * Not exposed in public API docs — clients treat the token as opaque.
 * The server re-validates this structure on every call so a tampered
 * token results in a 400 rather than undefined behaviour.
 */
export interface ContinuationTokenPayload {
  /** Next RPC cursor to pass to getEvents. */
  cursor: string;
  /** The ledger window from the original request (preserved for anti-widening). */
  ledgerWindow?: LedgerWindow;
  /** The time window from the original request (preserved for anti-widening). */
  timeWindow?: TimeWindow;
  /**
   * Running count of events fetched so far across all pages in this scan.
   * Enforced against MAX_TOTAL_RPC_WORK to cap total RPC work.
   */
  fetchedSoFar: number;
  /** Tenant that owns this token — checked on every continuation call. */
  tenantId: string;
  /** contractId the token was issued for — prevents cross-contract reuse. */
  contractId: string;
}

// ── Response ─────────────────────────────────────────────────────────────────

/** A single paginated event returned by the bounded scan. */
export interface BoundedScanEvent {
  /** Ledger sequence the event was observed at. */
  ledger: number;
  /** Unix timestamp (ms) of the ledger. */
  timestampMs: number;
  /** The Stellar contract address that emitted this event. */
  contractId: string;
  /** Event type/topic string. */
  type: string;
  /** Decoded event value — opaque to pagination layer. */
  value: unknown;
  /** RPC-level paging cursor for this event. */
  pagingToken: string;
}

/** Structured result returned by a bounded scan page. */
export interface BoundedScanResult {
  /** Events on this page. */
  events: BoundedScanEvent[];
  /**
   * Opaque continuation token for the next page.
   * `null` when this page exhausted the declared window.
   */
  nextToken: string | null;
  /**
   * Total events fetched across all pages in this scan window so far.
   * Useful for client-side progress bars and audit logging.
   */
  fetchedSoFar: number;
  /**
   * Whether the total-work cap was hit. When `true`, the scan was
   * terminated early; the client should narrow the window or reduce
   * the page size.
   */
  cappedByWorkLimit: boolean;
}
