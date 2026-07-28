import {
  DEFAULT_SOFT_DELETE_RETENTION_DAYS,
  SoftDeleteRetentionError,
  filterNotDeleted,
  isPastRetentionWindow,
  isSoftDeleted,
  isWithinRetentionWindow,
  parseRetentionDays,
} from './softDelete';

describe('softDelete utils', () => {
  describe('parseRetentionDays', () => {
    it('returns default when env is undefined or empty', () => {
      expect(parseRetentionDays(undefined)).toBe(DEFAULT_SOFT_DELETE_RETENTION_DAYS);
      expect(parseRetentionDays('')).toBe(DEFAULT_SOFT_DELETE_RETENTION_DAYS);
      expect(parseRetentionDays('   ')).toBe(DEFAULT_SOFT_DELETE_RETENTION_DAYS);
    });

    it('parses positive integers', () => {
      expect(parseRetentionDays('7')).toBe(7);
      expect(parseRetentionDays('30')).toBe(30);
    });

    it('falls back to default for invalid or non-positive values', () => {
      expect(parseRetentionDays('0')).toBe(DEFAULT_SOFT_DELETE_RETENTION_DAYS);
      expect(parseRetentionDays('-5')).toBe(DEFAULT_SOFT_DELETE_RETENTION_DAYS);
      expect(parseRetentionDays('abc')).toBe(DEFAULT_SOFT_DELETE_RETENTION_DAYS);
    });

    it('honours a custom default', () => {
      expect(parseRetentionDays(undefined, 14)).toBe(14);
    });
  });

  describe('isSoftDeleted', () => {
    it('is false for null/undefined/empty', () => {
      expect(isSoftDeleted(undefined)).toBe(false);
      expect(isSoftDeleted(null)).toBe(false);
      expect(isSoftDeleted('')).toBe(false);
    });

    it('is true for Date or non-empty string', () => {
      expect(isSoftDeleted(new Date())).toBe(true);
      expect(isSoftDeleted('2026-01-01T00:00:00.000Z')).toBe(true);
    });
  });

  describe('retention window', () => {
    const deletedAt = new Date('2026-01-01T00:00:00.000Z');

    it('is within window before expiry', () => {
      const now = new Date('2026-01-15T00:00:00.000Z');
      expect(isWithinRetentionWindow(deletedAt, 30, now)).toBe(true);
      expect(isPastRetentionWindow(deletedAt, 30, now)).toBe(false);
    });

    it('is past window after expiry', () => {
      const now = new Date('2026-02-05T00:00:00.000Z');
      expect(isWithinRetentionWindow(deletedAt, 30, now)).toBe(false);
      expect(isPastRetentionWindow(deletedAt, 30, now)).toBe(true);
    });

    it('treats exact expiry boundary as still within window', () => {
      const now = new Date('2026-01-31T00:00:00.000Z');
      expect(isWithinRetentionWindow(deletedAt, 30, now)).toBe(true);
    });

    it('rejects invalid deletedAt timestamps', () => {
      expect(isWithinRetentionWindow('not-a-date', 30, new Date())).toBe(false);
    });

    it('uses Date.now defaults when now is omitted', () => {
      const recent = new Date();
      expect(isWithinRetentionWindow(recent, 30)).toBe(true);
      expect(isPastRetentionWindow(recent, 30)).toBe(false);
    });
  });

  describe('filterNotDeleted', () => {
    it('drops soft-deleted items', () => {
      const items = [
        { id: 'a', deletedAt: null },
        { id: 'b', deletedAt: new Date() },
        { id: 'c' },
      ];
      expect(filterNotDeleted(items).map((i) => i.id)).toEqual(['a', 'c']);
    });
  });

  describe('SoftDeleteRetentionError', () => {
    it('exposes 410 status and stable code', () => {
      const err = new SoftDeleteRetentionError();
      expect(err.statusCode).toBe(410);
      expect(err.code).toBe('soft_delete_retention_expired');
      expect(err.name).toBe('SoftDeleteRetentionError');
    });
  });
});
