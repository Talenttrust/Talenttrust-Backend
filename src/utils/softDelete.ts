/**
 * Shared soft-delete helpers: retention windows, filtering, and expiry checks.
 *
 * Soft-deleted records keep a `deletedAt` timestamp. Default reads exclude them.
 * Restore is allowed only while `deletedAt` is within the configured retention
 * window. Past the window, a maintenance purge hard-deletes the records.
 */

/** Default retention window (days) when no env override is set. */
export const DEFAULT_SOFT_DELETE_RETENTION_DAYS = 30;

/**
 * Parse a retention-days env value.
 * Empty / undefined → default. Non-positive / NaN → default.
 */
export function parseRetentionDays(
  envValue: string | undefined,
  defaultDays: number = DEFAULT_SOFT_DELETE_RETENTION_DAYS,
): number {
  if (envValue === undefined || envValue.trim() === '') {
    return defaultDays;
  }
  const parsed = Number.parseInt(envValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultDays;
  }
  return parsed;
}

/** True when the record carries a soft-delete timestamp. */
export function isSoftDeleted(
  deletedAt: Date | string | null | undefined,
): boolean {
  return deletedAt !== null && deletedAt !== undefined && deletedAt !== '';
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * True when `deletedAt` is still within the retention window relative to `now`.
 */
export function isWithinRetentionWindow(
  deletedAt: Date | string,
  retentionDays: number,
  now: Date = new Date(),
): boolean {
  const deleted = toDate(deletedAt);
  if (Number.isNaN(deleted.getTime())) {
    return false;
  }
  const expiryMs = deleted.getTime() + retentionDays * 24 * 60 * 60 * 1000;
  return now.getTime() <= expiryMs;
}

/**
 * True when the retention window has fully elapsed (eligible for purge /
 * restore rejection).
 */
export function isPastRetentionWindow(
  deletedAt: Date | string,
  retentionDays: number,
  now: Date = new Date(),
): boolean {
  return !isWithinRetentionWindow(deletedAt, retentionDays, now);
}

/** Drop soft-deleted items from a collection. */
export function filterNotDeleted<T extends { deletedAt?: Date | string | null }>(
  items: T[],
): T[] {
  return items.filter((item) => !isSoftDeleted(item.deletedAt));
}

/**
 * Thrown when a restore is attempted after the retention window has expired.
 * Map to HTTP 410 Gone at the route/controller boundary.
 */
export class SoftDeleteRetentionError extends Error {
  public readonly code = 'soft_delete_retention_expired';
  public readonly statusCode = 410;

  constructor(message = 'Soft-deleted record is past the retention window and cannot be restored') {
    super(message);
    this.name = 'SoftDeleteRetentionError';
  }
}
