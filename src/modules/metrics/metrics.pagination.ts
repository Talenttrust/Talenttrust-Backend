import { createHash } from 'node:crypto';

export const METRICS_DEFAULT_PAGE_SIZE = 20;
export const METRICS_MAX_PAGE_SIZE = 100;

const CURSOR_VERSION = 1;
const MAX_CURSOR_LENGTH = 512;

export interface MetricListItem {
  id: string;
  createdAt: string | Date;
  [key: string]: unknown;
}

export interface MetricsPaginationQuery {
  cursor?: string;
  limit?: string | number;
}

export interface MetricsPage<T> {
  items: T[];
  nextCursor: string | null;
}

interface CursorPayload {
  version: number;
  createdAt: string;
  id: string;
  filterHash: string;
}

export class InvalidMetricsCursorError extends Error {
  readonly code = 'invalid_metrics_cursor';

  constructor() {
    super('Invalid metrics pagination cursor');
    this.name = 'InvalidMetricsCursorError';
  }
}

function filterHash(filterKey: string): string {
  return createHash('sha256').update(filterKey).digest('hex');
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string, expectedFilterHash: string): CursorPayload {
  if (
    typeof cursor !== 'string' ||
    cursor.length === 0 ||
    cursor.length > MAX_CURSOR_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(cursor)
  ) {
    throw new InvalidMetricsCursorError();
  }

  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    );

    if (
      typeof decoded !== 'object' ||
      decoded === null ||
      !('version' in decoded) ||
      !('createdAt' in decoded) ||
      !('id' in decoded) ||
      !('filterHash' in decoded) ||
      decoded.version !== CURSOR_VERSION ||
      typeof decoded.createdAt !== 'string' ||
      Number.isNaN(Date.parse(decoded.createdAt)) ||
      typeof decoded.id !== 'string' ||
      decoded.id.length === 0 ||
      typeof decoded.filterHash !== 'string' ||
      decoded.filterHash !== expectedFilterHash
    ) {
      throw new InvalidMetricsCursorError();
    }

    return decoded as CursorPayload;
  } catch (error) {
    if (error instanceof InvalidMetricsCursorError) {
      throw error;
    }
    throw new InvalidMetricsCursorError();
  }
}

export function resolveMetricsPageSize(
  requestedLimit: MetricsPaginationQuery['limit'],
): number {
  if (requestedLimit === undefined || requestedLimit === '') {
    return METRICS_DEFAULT_PAGE_SIZE;
  }

  const parsed = typeof requestedLimit === 'number'
    ? requestedLimit
    : Number(requestedLimit);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return METRICS_DEFAULT_PAGE_SIZE;
  }

  return Math.min(Math.max(Math.floor(parsed), 1), METRICS_MAX_PAGE_SIZE);
}

function createdAtValue(item: MetricListItem): string {
  return item.createdAt instanceof Date
    ? item.createdAt.toISOString()
    : item.createdAt;
}

function compareItems<T extends MetricListItem>(left: T, right: T): number {
  const dateComparison = createdAtValue(left).localeCompare(createdAtValue(right));
  return dateComparison !== 0 ? dateComparison : left.id.localeCompare(right.id);
}

function isAfterCursor<T extends MetricListItem>(item: T, cursor: CursorPayload): boolean {
  const dateComparison = createdAtValue(item).localeCompare(cursor.createdAt);
  return dateComparison > 0 || (dateComparison === 0 && item.id.localeCompare(cursor.id) > 0);
}

/**
 * Paginate an already-filtered metrics collection.
 *
 * The caller should apply the endpoint's existing filters before calling this
 * function and pass a deterministic representation of those filters as
 * filterKey. The filter hash embedded in the cursor prevents a cursor from
 * one filter set being reused with another filter set.
 */
export function paginateMetrics<T extends MetricListItem>(
  records: readonly T[],
  query: MetricsPaginationQuery = {},
  filterKey = '',
): MetricsPage<T> {
  const pageSize = resolveMetricsPageSize(query.limit);
  const expectedFilterHash = filterHash(filterKey);
  const cursor = query.cursor !== undefined
    ? decodeCursor(query.cursor, expectedFilterHash)
    : undefined;

  const ordered = [...records].sort(compareItems);
  const start = cursor
    ? ordered.findIndex((item) => isAfterCursor(item, cursor))
    : 0;
  const pageStart = start < 0 ? ordered.length : start;
  const page = ordered.slice(pageStart, pageStart + pageSize + 1);
  const hasNextPage = page.length > pageSize;
  const items = hasNextPage ? page.slice(0, pageSize) : page;

  if (!hasNextPage || items.length === 0) {
    return { items, nextCursor: null };
  }

  const lastItem = items[items.length - 1];
  return {
    items,
    nextCursor: encodeCursor({
      version: CURSOR_VERSION,
      createdAt: createdAtValue(lastItem),
      id: lastItem.id,
      filterHash: expectedFilterHash,
    }),
  };
}
