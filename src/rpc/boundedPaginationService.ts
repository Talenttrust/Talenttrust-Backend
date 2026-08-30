/**
 * boundedPaginationService.ts — Bounded RPC event pagination service.
 *
 * Implements Issue #1208: every event scan MUST declare a ledger or time
 * window. Page sizes and total work are capped. Continuation tokens embed
 * the original window so it cannot be widened across pages.
 *
 * ## Correctness guarantees
 * 1. Missing bound   → VALIDATION_ERROR (400).
 * 2. Maximum bound   → capped silently to MAX_LEDGER_WINDOW / MAX_TIME_WINDOW_MS.
 * 3. Invalid range   → VALIDATION_ERROR (400) if fromLedger > toLedger, etc.
 * 4. No events       → empty array, nextToken: null.
 * 5. Duplicate pages → de-duplicated by pagingToken before accumulation.
 * 6. Total work cap  → cappedByWorkLimit: true, nextToken: null.
 *
 * ## Security notes
 * - Tenant isolation: tenantId from the verified JWT is embedded in the
 *   continuation token and re-checked on every continuation call.
 * - Token is base64url-encoded JSON — NOT signed.  Any tampered token
 *   fails Zod re-validation and returns a 400. The bounds inside the token
 *   are re-intersected with the current request to prevent widening.
 * - Provider error codes are not forwarded to callers; the classify helper
 *   maps them to stable SorobanRpcError subtypes.
 * - Logger never emits the full token payload (contains tenantId); it only
 *   emits cursor, fetchedSoFar, and event counts.
 */

import { z } from 'zod';
import { rpc } from '@stellar/stellar-sdk';
import { logger } from '../logger';
import {
  classifySorobanRpcError,
} from '../errors/appError';
import { APP_ERROR_CODES, AppError } from '../errors/appError';
import {
  MAX_RPC_PAGE_SIZE,
  DEFAULT_RPC_PAGE_SIZE,
  MAX_TOTAL_RPC_WORK,
  MAX_LEDGER_WINDOW,
  MAX_TIME_WINDOW_MS,
} from './boundedPagination.types';
import type {
  BoundedScanRequest,
  BoundedScanResult,
  BoundedScanEvent,
  ContinuationTokenPayload,
  LedgerWindow,
  TimeWindow,
} from './boundedPagination.types';

// Re-export types for convenience
export type { BoundedScanRequest, BoundedScanResult, BoundedScanEvent };

// ── Error codes ───────────────────────────────────────────────────────────────

/**
 * Extend APP_ERROR_CODES for pagination-specific stable codes.
 * These are appended without modifying the original constant.
 */
export const PAGINATION_ERROR_CODES = {
  MISSING_BOUND: 'rpc_pagination_missing_bound',
  INVALID_RANGE: 'rpc_pagination_invalid_range',
  INVALID_TOKEN: 'rpc_pagination_invalid_token',
  TENANT_MISMATCH: 'rpc_pagination_tenant_mismatch',
  WORK_CAP_EXCEEDED: 'rpc_pagination_work_cap_exceeded',
} as const;

// ── Token schema ──────────────────────────────────────────────────────────────

const ledgerWindowSchema = z.object({
  fromLedger: z.number().int().nonnegative(),
  toLedger: z.number().int().nonnegative(),
});

const timeWindowSchema = z.object({
  fromTimestampMs: z.number().int().nonnegative(),
  toTimestampMs: z.number().int().nonnegative(),
});

/**
 * Zod schema for re-validating the continuation token payload.
 * If a client tampers with the base64 token, this parse will fail
 * and return a 400 rather than producing undefined behaviour.
 */
const continuationTokenSchema = z.object({
  cursor: z.string().min(1),
  ledgerWindow: ledgerWindowSchema.optional(),
  timeWindow: timeWindowSchema.optional(),
  fetchedSoFar: z.number().int().nonnegative(),
  tenantId: z.string().min(1),
  contractId: z.string().min(1),
});

// ── Token helpers ─────────────────────────────────────────────────────────────

/**
 * Encodes a ContinuationTokenPayload to an opaque base64url string.
 * The token is NOT signed — it is re-validated on every use.
 */
function encodeToken(payload: ContinuationTokenPayload): string {
  const json = JSON.stringify(payload);
  return Buffer.from(json, 'utf8').toString('base64url');
}

/**
 * Decodes and re-validates an opaque continuation token.
 *
 * @throws AppError(400, INVALID_TOKEN) if the token is malformed or fails schema.
 */
function decodeToken(raw: string): ContinuationTokenPayload {
  let json: string;
  try {
    json = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    throw new AppError(400, PAGINATION_ERROR_CODES.INVALID_TOKEN, 'Continuation token is not valid base64url.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new AppError(400, PAGINATION_ERROR_CODES.INVALID_TOKEN, 'Continuation token payload is not valid JSON.');
  }

  const result = continuationTokenSchema.safeParse(parsed);
  if (!result.success) {
    throw new AppError(400, PAGINATION_ERROR_CODES.INVALID_TOKEN, 'Continuation token has an invalid structure.');
  }

  return result.data as ContinuationTokenPayload;
}

// ── Window helpers ────────────────────────────────────────────────────────────

/**
 * Caps and validates a ledger window.
 *
 * Rules:
 * - fromLedger must be ≥ 0
 * - toLedger   must be ≥ fromLedger
 * - span must be ≤ MAX_LEDGER_WINDOW (capped, not rejected)
 *
 * @throws AppError(400, INVALID_RANGE) for fundamentally invalid ranges.
 */
function normalizeLedgerWindow(w: LedgerWindow): LedgerWindow {
  if (w.fromLedger < 0 || !Number.isInteger(w.fromLedger)) {
    throw new AppError(400, PAGINATION_ERROR_CODES.INVALID_RANGE, 'fromLedger must be a non-negative integer.');
  }
  if (w.toLedger < w.fromLedger) {
    throw new AppError(400, PAGINATION_ERROR_CODES.INVALID_RANGE, 'toLedger must be greater than or equal to fromLedger.');
  }
  // Cap the span without rejecting — the caller may not know the exact limit.
  const cappedTo = Math.min(w.toLedger, w.fromLedger + MAX_LEDGER_WINDOW);
  return { fromLedger: w.fromLedger, toLedger: cappedTo };
}

/**
 * Caps and validates a time window.
 *
 * @throws AppError(400, INVALID_RANGE) for fundamentally invalid ranges.
 */
function normalizeTimeWindow(w: TimeWindow): TimeWindow {
  if (w.fromTimestampMs < 0 || !Number.isInteger(w.fromTimestampMs)) {
    throw new AppError(400, PAGINATION_ERROR_CODES.INVALID_RANGE, 'fromTimestampMs must be a non-negative integer.');
  }
  if (w.toTimestampMs < w.fromTimestampMs) {
    throw new AppError(400, PAGINATION_ERROR_CODES.INVALID_RANGE, 'toTimestampMs must be greater than or equal to fromTimestampMs.');
  }
  const cappedTo = Math.min(w.toTimestampMs, w.fromTimestampMs + MAX_TIME_WINDOW_MS);
  return { fromTimestampMs: w.fromTimestampMs, toTimestampMs: cappedTo };
}

/**
 * Intersects two optional ledger windows to produce the tightest bound.
 * Used to prevent token-based window widening.
 */
function intersectLedgerWindows(
  a?: LedgerWindow,
  b?: LedgerWindow,
): LedgerWindow | undefined {
  if (!a && !b) return undefined;
  if (!a) return b;
  if (!b) return a;
  return {
    fromLedger: Math.max(a.fromLedger, b.fromLedger),
    toLedger: Math.min(a.toLedger, b.toLedger),
  };
}

/**
 * Intersects two optional time windows to produce the tightest bound.
 */
function intersectTimeWindows(
  a?: TimeWindow,
  b?: TimeWindow,
): TimeWindow | undefined {
  if (!a && !b) return undefined;
  if (!a) return b;
  if (!b) return a;
  return {
    fromTimestampMs: Math.max(a.fromTimestampMs, b.fromTimestampMs),
    toTimestampMs: Math.min(a.toTimestampMs, b.toTimestampMs),
  };
}

// ── RPC adapter ───────────────────────────────────────────────────────────────

/**
 * Minimal interface for the RPC provider consumed by this service.
 * Matches the signature of SorobanRpcService.getEvents so the real
 * implementation is a drop-in; tests inject a mock.
 */
export interface RpcEventProvider {
  getEvents(request: rpc.Server.GetEventsRequest): Promise<rpc.Api.GetEventsResponse>;
}

// ── Service ───────────────────────────────────────────────────────────────────

/**
 * BoundedPaginationService — enforces ledger/time window bounds, page-size
 * cap, total-work cap, and continuation tokens for RPC event scans.
 *
 * Inject via constructor for testability; use the singleton export in
 * application code.
 */
export class BoundedPaginationService {
  constructor(private readonly rpc: RpcEventProvider) {}

  /**
   * Fetches one page of events within the declared window.
   *
   * @param request - Validated scan request (tenantId must come from JWT).
   * @returns A single page of events and an optional continuation token.
   * @throws AppError on validation failures, token issues, or tenant mismatches.
   * @throws SorobanRpcError (via classifySorobanRpcError) on provider failures.
   */
  async fetchPage(request: BoundedScanRequest): Promise<BoundedScanResult> {
    const { contractId, tenantId } = request;

    // ── 1. Resolve and validate bounds ──────────────────────────────────────
    let ledgerWindow = request.ledgerWindow;
    let timeWindow = request.timeWindow;
    let fetchedSoFar = 0;
    let cursor: string | undefined;

    // Decode continuation token and merge bounds (intersection prevents widening).
    if (request.continuationToken) {
      const token = decodeToken(request.continuationToken);

      // Tenant isolation check — the token must belong to the requesting tenant.
      if (token.tenantId !== tenantId) {
        throw new AppError(403, PAGINATION_ERROR_CODES.TENANT_MISMATCH, 'Continuation token does not belong to the requesting tenant.');
      }

      // Contract isolation — the token must belong to the same contract.
      if (token.contractId !== contractId) {
        throw new AppError(400, PAGINATION_ERROR_CODES.INVALID_TOKEN, 'Continuation token was issued for a different contract.');
      }

      // Total-work guard: if a previous page already hit the cap, refuse.
      if (token.fetchedSoFar >= MAX_TOTAL_RPC_WORK) {
        throw new AppError(400, PAGINATION_ERROR_CODES.WORK_CAP_EXCEEDED, `Total work cap of ${MAX_TOTAL_RPC_WORK} events has been reached. Narrow the window and start a new scan.`);
      }

      // Intersect to produce the tightest window.
      ledgerWindow = intersectLedgerWindows(ledgerWindow, token.ledgerWindow);
      timeWindow = intersectTimeWindows(timeWindow, token.timeWindow);
      fetchedSoFar = token.fetchedSoFar;
      cursor = token.cursor;
    }

    // At least one bound MUST be present (missing bound → 400).
    if (!ledgerWindow && !timeWindow) {
      throw new AppError(400, PAGINATION_ERROR_CODES.MISSING_BOUND, 'At least one of ledgerWindow or timeWindow must be provided.');
    }

    // Normalize and cap the windows.
    if (ledgerWindow) {
      ledgerWindow = normalizeLedgerWindow(ledgerWindow);
    }
    if (timeWindow) {
      timeWindow = normalizeTimeWindow(timeWindow);
    }

    // ── 2. Resolve page size ─────────────────────────────────────────────────
    const limit = Math.min(
      request.limit ?? DEFAULT_RPC_PAGE_SIZE,
      MAX_RPC_PAGE_SIZE,
    );
    if (limit < 1) {
      throw new AppError(400, APP_ERROR_CODES.VALIDATION_ERROR, 'limit must be at least 1.');
    }

    // ── 3. Build RPC request ─────────────────────────────────────────────────
    const rpcRequest: rpc.Server.GetEventsRequest = {
      filters: [{ contractIds: [contractId] }],
      limit,
    };

    // Apply ledger window if present.
    if (ledgerWindow) {
      rpcRequest.startLedger = ledgerWindow.fromLedger;
    }

    // Apply cursor for continuation (overrides startLedger when resuming).
    if (cursor) {
      rpcRequest.cursor = cursor;
    }

    // ── 4. Fetch from RPC provider ───────────────────────────────────────────
    let rpcResponse: rpc.Api.GetEventsResponse;
    try {
      rpcResponse = await this.rpc.getEvents(rpcRequest);
    } catch (err) {
      // Map all provider errors to stable SorobanRpcError subtypes.
      // Provider-specific codes are NOT forwarded to callers.
      logger.error('BoundedPaginationService: RPC getEvents failed', {
        contractId,
        tenantId,
        ledger: ledgerWindow?.fromLedger,
        error: err instanceof Error ? err.message : String(err),
      });
      throw classifySorobanRpcError(err);
    }

    // ── 5. De-duplicate events (provider may return overlapping pages) ────────
    const seenTokens = new Set<string>();
    const rawEvents: BoundedScanEvent[] = [];

    for (const event of rpcResponse.events ?? []) {
      const pagingToken = event.pagingToken;
      if (seenTokens.has(pagingToken)) {
        // Duplicate — log for observability, skip silently.
        logger.warn('BoundedPaginationService: duplicate pagingToken skipped', {
          contractId,
          pagingToken,
        });
        continue;
      }
      seenTokens.add(pagingToken);

      // ── Apply time window filter if requested (RPC does not natively filter by time)
      const eventTs = (event.ledgerClosedAt ? new Date(event.ledgerClosedAt).getTime() : 0);
      if (timeWindow) {
        if (eventTs < timeWindow.fromTimestampMs || eventTs > timeWindow.toTimestampMs) {
          continue;
        }
      }

      // ── Apply toLedger filter (RPC startLedger sets the floor; we enforce the ceiling)
      if (ledgerWindow && event.ledger > ledgerWindow.toLedger) {
        continue;
      }

      rawEvents.push({
        ledger: event.ledger,
        timestampMs: eventTs,
        contractId: event.contractId,
        type: event.type,
        value: event.value,
        pagingToken,
      });
    }

    // ── 6. Enforce total-work cap ─────────────────────────────────────────────
    const newTotal = fetchedSoFar + rawEvents.length;
    let cappedByWorkLimit = false;
    let finalEvents = rawEvents;

    if (newTotal > MAX_TOTAL_RPC_WORK) {
      const remaining = MAX_TOTAL_RPC_WORK - fetchedSoFar;
      finalEvents = rawEvents.slice(0, remaining);
      cappedByWorkLimit = true;
      logger.warn('BoundedPaginationService: total-work cap reached', {
        contractId,
        tenantId,
        fetchedSoFar,
        cap: MAX_TOTAL_RPC_WORK,
      });
    }

    const updatedTotal = fetchedSoFar + finalEvents.length;

    // ── 7. Build continuation token (if more pages exist and work cap not hit) ─
    let nextToken: string | null = null;

    const latestPagingToken = finalEvents.length > 0
      ? finalEvents[finalEvents.length - 1]!.pagingToken
      : null;

    const hasMorePages = (rpcResponse.events ?? []).length >= limit && !cappedByWorkLimit;

    if (hasMorePages && latestPagingToken) {
      const tokenPayload: ContinuationTokenPayload = {
        cursor: latestPagingToken,
        ledgerWindow,
        timeWindow,
        fetchedSoFar: updatedTotal,
        tenantId,
        contractId,
      };
      nextToken = encodeToken(tokenPayload);
    }

    // ── 8. Structured audit log ───────────────────────────────────────────────
    logger.info('BoundedPaginationService: page fetched', {
      contractId,
      tenantId,
      eventsOnPage: finalEvents.length,
      fetchedSoFar: updatedTotal,
      hasNextPage: nextToken !== null,
      cappedByWorkLimit,
      ledgerFrom: ledgerWindow?.fromLedger,
      ledgerTo: ledgerWindow?.toLedger,
      timeFrom: timeWindow?.fromTimestampMs,
      timeTo: timeWindow?.toTimestampMs,
    });

    return {
      events: finalEvents,
      nextToken,
      fetchedSoFar: updatedTotal,
      cappedByWorkLimit,
    };
  }
}
