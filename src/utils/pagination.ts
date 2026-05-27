/**
 * @title Pagination Utility
 * @notice Provides reusable functions and interfaces for handling pagination in API endpoints.
 * @dev This module includes logic for parsing pagination parameters and generating pagination metadata.
 *
 * ## Bounds Policy
 * The shared `paginationQuerySchema` and `parsePaginationQuery` helper enforce strict bounds:
 * - `page` must be a positive integer (≥ 1). Non-integer strings, NaN, zero, and negative
 *   values are **rejected** with a descriptive error rather than silently clamped.
 * - `limit` must be a positive integer between 1 and `MAX_PAGE_LIMIT` (inclusive). Values
 *   outside that range are rejected the same way.
 * - Omitting a parameter is always safe: defaults kick in (`page = 1`, `limit = DEFAULT_PAGE_LIMIT`).
 *
 * For legacy or internal helpers that prefer silent clamping, `getPaginationOptions` is retained
 * unchanged and clearly marked as the clamping variant.
 */

import { z } from 'zod';

/** Hard upper bound on items-per-page accepted by any list endpoint. */
export const MAX_PAGE_LIMIT = 100;

/** Default page size when the caller does not supply a `limit` parameter. */
export const DEFAULT_PAGE_LIMIT = 20;

export interface PaginationOptions {
  page: number;
  limit: number;
  offset: number;
}

export interface PaginationMetadata {
  totalItems: number;
  itemCount: number;
  itemsPerPage: number;
  totalPages: number;
  currentPage: number;
}

export interface PaginatedResult<T> {
  data: T[];
  meta: PaginationMetadata;
}

/**
 * Shared Zod schema for pagination query parameters.
 *
 * **Rejection policy**: non-integer strings, NaN, zero, negative numbers, and values
 * exceeding `MAX_PAGE_LIMIT` are all rejected (→ 400) rather than silently clamped.
 * This keeps API behaviour predictable and surfaces misconfigured clients early.
 *
 * Designed to be extended by module-specific schemas that add extra filter fields:
 * ```ts
 * const mySchema = paginationQuerySchema.extend({ status: z.string().optional() });
 * ```
 */
export const paginationQuerySchema = z.object({
  page: z.preprocess(
    (v) => (v === undefined || v === '' || v === null ? '1' : v),
    z
      .string()
      .regex(/^\d+$/, 'page must be a positive integer')
      .transform((s) => Number(s))
      .refine((n) => n >= 1, 'page must be at least 1'),
  ),
  limit: z.preprocess(
    (v) => (v === undefined || v === '' || v === null ? String(DEFAULT_PAGE_LIMIT) : v),
    z
      .string()
      .regex(/^\d+$/, 'limit must be a positive integer')
      .transform((s) => Number(s))
      .refine(
        (n) => n >= 1 && n <= MAX_PAGE_LIMIT,
        `limit must be between 1 and ${MAX_PAGE_LIMIT}`,
      ),
  ),
});

/** Inferred type of a successfully parsed pagination query. */
export type ParsedPaginationQuery = z.infer<typeof paginationQuerySchema>;

/**
 * Parse and validate raw query-string pagination parameters.
 *
 * Returns a discriminated union so callers can handle invalid input without exceptions:
 * ```ts
 * const result = parsePaginationQuery(req.query);
 * if (!result.ok) return res.status(400).json({ error: result.error });
 * const { page, limit, offset } = result.value;
 * ```
 *
 * @param query - Raw query object (e.g. `req.query`).
 */
export function parsePaginationQuery(
  query: Record<string, unknown>,
): { ok: true; value: PaginationOptions } | { ok: false; error: string } {
  const result = paginationQuerySchema.safeParse(query);

  if (!result.success) {
    const first = result.error.issues[0];
    return { ok: false, error: first?.message ?? 'Invalid pagination parameters' };
  }

  const { page, limit } = result.data;
  return {
    ok: true,
    value: { page, limit, offset: (page - 1) * limit },
  };
}

/**
 * Slice an array to the window described by `options`.
 * Useful when the full dataset is held in memory and there is no SQL LIMIT/OFFSET available.
 *
 * @param items - Full dataset.
 * @param options - Validated pagination options (from `parsePaginationQuery`).
 */
export function applyPagination<T>(items: T[], options: PaginationOptions): T[] {
  return items.slice(options.offset, options.offset + options.limit);
}

/**
 * @notice Parses pagination query parameters and returns structured options with silent clamping.
 * @dev Prefer `parsePaginationQuery` for new code where strict rejection is desired.
 *      This function clamps out-of-range values rather than returning an error, which is
 *      useful for internal tooling and backward-compatible contexts.
 * @param query The query parameters from the request.
 * @param defaultLimit The default number of items per page (defaults to 10 for backward compat).
 * @returns An object containing the page, limit, and offset.
 */
export function getPaginationOptions(
  query: { page?: any; limit?: any },
  defaultLimit: number = 10
): PaginationOptions {
  const page = Math.max(1, parseInt(query.page as string, 10) || 1);
  const limit = Math.max(1, Math.min(MAX_PAGE_LIMIT, parseInt(query.limit as string, 10) || defaultLimit));
  const offset = (page - 1) * limit;

  return { page, limit, offset };
}

/**
 * @notice Generates pagination metadata based on total items and pagination options.
 * @param totalItems The total number of items available.
 * @param options The pagination options used for the query.
 * @param itemCount The number of items returned in the current page.
 * @returns A structured pagination metadata object.
 */
export function getPaginationMetadata(
  totalItems: number,
  options: PaginationOptions,
  itemCount: number
): PaginationMetadata {
  const totalPages = Math.ceil(totalItems / options.limit);

  return {
    totalItems,
    itemCount,
    itemsPerPage: options.limit,
    totalPages,
    currentPage: options.page,
  };
}
