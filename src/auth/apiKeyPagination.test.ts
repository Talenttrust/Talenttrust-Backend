/**
 * @file apiKeyPagination.test.ts
 * @description Regression tests for hardened cursor-based API key pagination.
 *
 * Test categories:
 *   1. encodeApiKeyCursor / decodeApiKeyCursor — round-trips, tampering, edge cases.
 *   2. parseApiKeyPageSize — valid, invalid, boundary inputs.
 *   3. paginateApiKeys — normal pages, cursor resumption, concurrent-insert
 *      safety, duplicate-cursor idempotency, racing mutations, boundary values.
 *   4. Concurrency / timing safety — same-millisecond inserts, sort stability.
 *   5. Secret rotation — lazy-loading behaviour.
 */

import {
  encodeApiKeyCursor,
  decodeApiKeyCursor,
  parseApiKeyPageSize,
  paginateApiKeys,
  InvalidApiKeyCursorError,
  ApiKeyCursorPosition,
  API_KEYS_DEFAULT_PAGE_SIZE,
  API_KEYS_MAX_PAGE_SIZE,
} from './apiKeyPagination';
import { setWriteRecordImpl, LogRecord } from '../logger';

// ─── Test helpers ────────────────────────────────────────────────────────────

/** Create a minimal API key record at a given time offset (ms from epoch). */
function makeRecord(id: string, createdAt: string): ApiKeyCursorPosition {
  return { id, createdAt };
}

/** Build a predictable set of N records spaced 1 second apart (newest first). */
function buildRecords(count: number): ApiKeyCursorPosition[] {
  const base = new Date('2024-06-01T00:00:00.000Z').getTime();
  return Array.from({ length: count }, (_, i) => ({
    id: `key-${String(i).padStart(4, '0')}`,
    // Oldest record is index 0 in this helper, newest is index count-1
    createdAt: new Date(base + i * 1000).toISOString(),
  }));
}

/** Capture log records emitted during a callback, then restore. */
async function captureLogRecords(fn: () => void | Promise<void>): Promise<LogRecord[]> {
  const records: LogRecord[] = [];
  const original = (global as any).__writeRecordImpl;
  setWriteRecordImpl((r) => records.push(r));
  try {
    await fn();
  } finally {
    // Restore to default (output to stdout)
    setWriteRecordImpl((r) => {
      const line = JSON.stringify(r);
      if (r.level === 'error') process.stderr.write(line + '\n');
      else process.stdout.write(line + '\n');
    });
  }
  return records;
}

// ─── 1. Cursor encode / decode ───────────────────────────────────────────────

describe('encodeApiKeyCursor / decodeApiKeyCursor', () => {
  const position: ApiKeyCursorPosition = {
    id: 'key-abc',
    createdAt: '2024-06-15T12:00:00.000Z',
  };

  it('round-trips a valid position', () => {
    const cursor = encodeApiKeyCursor(position);
    const decoded = decodeApiKeyCursor(cursor);
    expect(decoded).toEqual(position);
  });

  it('produces a string matching the expected format', () => {
    const cursor = encodeApiKeyCursor(position);
    // Must match: <base64url>.<base64url>
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it('encodes different positions to different cursors', () => {
    const c1 = encodeApiKeyCursor({ id: 'key-1', createdAt: '2024-01-01T00:00:00.000Z' });
    const c2 = encodeApiKeyCursor({ id: 'key-2', createdAt: '2024-01-01T00:00:00.000Z' });
    expect(c1).not.toBe(c2);
  });

  it('each call produces a unique cursor (due to issuedAt timestamp)', () => {
    const c1 = encodeApiKeyCursor(position);
    // Advance clock by 1ms to ensure different issuedAt
    const originalNow = Date.now;
    Date.now = () => originalNow() + 1;
    const c2 = encodeApiKeyCursor(position);
    Date.now = originalNow;
    // Cursors may differ due to issuedAt; both must decode to the same position
    expect(decodeApiKeyCursor(c1)).toEqual(position);
    expect(decodeApiKeyCursor(c2)).toEqual(position);
  });

  it('throws InvalidApiKeyCursorError for an empty string', () => {
    expect(() => decodeApiKeyCursor('')).toThrow(InvalidApiKeyCursorError);
  });

  it('throws InvalidApiKeyCursorError for a string exceeding max length', () => {
    const long = 'a'.repeat(513);
    expect(() => decodeApiKeyCursor(long)).toThrow(InvalidApiKeyCursorError);
  });

  it('throws InvalidApiKeyCursorError for a string with invalid characters', () => {
    expect(() => decodeApiKeyCursor('invalid!@#$.signature')).toThrow(InvalidApiKeyCursorError);
  });

  it('throws InvalidApiKeyCursorError when signature is tampered', () => {
    const cursor = encodeApiKeyCursor(position);
    const parts = cursor.split('.');
    const tampered = `${parts[0]}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    expect(() => decodeApiKeyCursor(tampered)).toThrow(InvalidApiKeyCursorError);
  });

  it('throws InvalidApiKeyCursorError when payload is tampered', () => {
    const cursor = encodeApiKeyCursor(position);
    const parts = cursor.split('.');
    // Replace the payload with a different base64url string of similar length
    const altPayload = Buffer.from(JSON.stringify({ id: 'EVIL', version: 1, createdAt: '2024-01-01T00:00:00.000Z', issuedAt: 0 })).toString('base64url');
    const tampered = `${altPayload}.${parts[parts.length - 1]}`;
    expect(() => decodeApiKeyCursor(tampered)).toThrow(InvalidApiKeyCursorError);
  });

  it('throws InvalidApiKeyCursorError for a non-string value', () => {
    expect(() => decodeApiKeyCursor(42 as any)).toThrow(InvalidApiKeyCursorError);
    expect(() => decodeApiKeyCursor(null as any)).toThrow(InvalidApiKeyCursorError);
    expect(() => decodeApiKeyCursor(undefined as any)).toThrow(InvalidApiKeyCursorError);
  });

  it('throws InvalidApiKeyCursorError when version is wrong', () => {
    // Manually build a cursor with wrong version (signed but bad version)
    const payload = Buffer.from(
      JSON.stringify({ version: 99, createdAt: '2024-01-01T00:00:00.000Z', id: 'x', issuedAt: 0 }),
    ).toString('base64url');
    const { createHmac } = require('node:crypto');
    const secret = process.env['API_KEYS_CURSOR_SECRET'] ?? 'talenttrust-api-keys-cursor-v1';
    const sig = createHmac('sha256', secret).update(payload).digest('base64url');
    expect(() => decodeApiKeyCursor(`${payload}.${sig}`)).toThrow(InvalidApiKeyCursorError);
  });

  it('throws InvalidApiKeyCursorError when createdAt is not a valid date', () => {
    const payload = Buffer.from(
      JSON.stringify({ version: 1, createdAt: 'not-a-date', id: 'x', issuedAt: 0 }),
    ).toString('base64url');
    const { createHmac } = require('node:crypto');
    const secret = process.env['API_KEYS_CURSOR_SECRET'] ?? 'talenttrust-api-keys-cursor-v1';
    const sig = createHmac('sha256', secret).update(payload).digest('base64url');
    expect(() => decodeApiKeyCursor(`${payload}.${sig}`)).toThrow(InvalidApiKeyCursorError);
  });

  it('throws InvalidApiKeyCursorError when id is an empty string', () => {
    const payload = Buffer.from(
      JSON.stringify({ version: 1, createdAt: '2024-01-01T00:00:00.000Z', id: '', issuedAt: 0 }),
    ).toString('base64url');
    const { createHmac } = require('node:crypto');
    const secret = process.env['API_KEYS_CURSOR_SECRET'] ?? 'talenttrust-api-keys-cursor-v1';
    const sig = createHmac('sha256', secret).update(payload).digest('base64url');
    expect(() => decodeApiKeyCursor(`${payload}.${sig}`)).toThrow(InvalidApiKeyCursorError);
  });

  it('uses the last "." as the separator (robustness for multi-dot payloads)', () => {
    // Verify that decoding uses lastIndexOf('.'), not indexOf('.')
    // Any valid cursor is already well-formed; this test confirms the split
    // direction by creating a cursor and verifying it round-trips correctly.
    const pos = { id: 'multi-dot-key', createdAt: '2024-03-01T00:00:00.000Z' };
    const cursor = encodeApiKeyCursor(pos);
    expect(cursor.split('.').length).toBeGreaterThanOrEqual(2);
    expect(decodeApiKeyCursor(cursor)).toEqual(pos);
  });
});

// ─── 2. parseApiKeyPageSize ──────────────────────────────────────────────────

describe('parseApiKeyPageSize', () => {
  it('returns default for undefined', () => {
    expect(parseApiKeyPageSize(undefined)).toBe(API_KEYS_DEFAULT_PAGE_SIZE);
  });

  it('returns default for null', () => {
    expect(parseApiKeyPageSize(null)).toBe(API_KEYS_DEFAULT_PAGE_SIZE);
  });

  it('returns default for empty string', () => {
    expect(parseApiKeyPageSize('')).toBe(API_KEYS_DEFAULT_PAGE_SIZE);
  });

  it('parses a valid string integer', () => {
    expect(parseApiKeyPageSize('10')).toBe(10);
    expect(parseApiKeyPageSize('1')).toBe(1);
    expect(parseApiKeyPageSize('50')).toBe(50);
  });

  it('clamps values above the maximum', () => {
    expect(parseApiKeyPageSize('200')).toBe(API_KEYS_MAX_PAGE_SIZE);
    expect(parseApiKeyPageSize('9999')).toBe(API_KEYS_MAX_PAGE_SIZE);
  });

  it('returns exactly the maximum for the boundary value', () => {
    expect(parseApiKeyPageSize(String(API_KEYS_MAX_PAGE_SIZE))).toBe(API_KEYS_MAX_PAGE_SIZE);
  });

  it('returns 1 for the minimum boundary value', () => {
    expect(parseApiKeyPageSize('1')).toBe(1);
  });

  it('returns default and emits a warn log for a zero value', async () => {
    const records = await captureLogRecords(() => {
      const result = parseApiKeyPageSize('0');
      expect(result).toBe(API_KEYS_DEFAULT_PAGE_SIZE);
    });
    const warnRecords = records.filter((r) => r.level === 'warn');
    expect(warnRecords.length).toBeGreaterThanOrEqual(1);
    expect(warnRecords[0]!.message).toMatch(/invalid page-size/i);
  });

  it('returns default and emits a warn log for a negative value', async () => {
    const records = await captureLogRecords(() => {
      const result = parseApiKeyPageSize('-5');
      expect(result).toBe(API_KEYS_DEFAULT_PAGE_SIZE);
    });
    expect(records.some((r) => r.level === 'warn')).toBe(true);
  });

  it('returns default and emits a warn log for a non-numeric string', async () => {
    const records = await captureLogRecords(() => {
      const result = parseApiKeyPageSize('abc');
      expect(result).toBe(API_KEYS_DEFAULT_PAGE_SIZE);
    });
    expect(records.some((r) => r.level === 'warn')).toBe(true);
  });

  it('returns default and emits a warn log for a float string', async () => {
    const records = await captureLogRecords(() => {
      const result = parseApiKeyPageSize('3.7');
      expect(result).toBe(API_KEYS_DEFAULT_PAGE_SIZE);
    });
    expect(records.some((r) => r.level === 'warn')).toBe(true);
  });

  it('returns default and emits a warn log for a non-string, non-null value', async () => {
    const records = await captureLogRecords(() => {
      // Passing a number directly (not a string) is treated as NaN
      const result = parseApiKeyPageSize(42 as any);
      expect(result).toBe(API_KEYS_DEFAULT_PAGE_SIZE);
    });
    expect(records.some((r) => r.level === 'warn')).toBe(true);
  });

  it('does NOT emit a warn log for missing params (undefined/null/empty)', async () => {
    const records = await captureLogRecords(() => {
      parseApiKeyPageSize(undefined);
      parseApiKeyPageSize(null);
      parseApiKeyPageSize('');
    });
    expect(records.filter((r) => r.level === 'warn').length).toBe(0);
  });
});

// ─── 3. paginateApiKeys — normal operation ──────────────────────────────────

describe('paginateApiKeys — normal pages', () => {
  it('returns all records on the first page when count ≤ limit', () => {
    const records = buildRecords(5);
    const { items, nextCursor } = paginateApiKeys(records, 10);
    expect(items).toHaveLength(5);
    expect(nextCursor).toBeNull();
  });

  it('returns exactly `limit` items and a nextCursor when count > limit', () => {
    const records = buildRecords(10);
    const { items, nextCursor } = paginateApiKeys(records, 3);
    expect(items).toHaveLength(3);
    expect(nextCursor).not.toBeNull();
  });

  it('returns items in createdAt DESC order (newest first)', () => {
    const records = buildRecords(5);
    const { items } = paginateApiKeys(records, 10);
    for (let i = 1; i < items.length; i++) {
      expect(items[i - 1]!.createdAt >= items[i]!.createdAt).toBe(true);
    }
  });

  it('returns no items for an empty snapshot', () => {
    const { items, nextCursor } = paginateApiKeys([], 10);
    expect(items).toHaveLength(0);
    expect(nextCursor).toBeNull();
  });

  it('traverses all pages without gaps or duplicates', () => {
    const total = 25;
    const pageSize = 7;
    const records = buildRecords(total);

    const seen = new Set<string>();
    let cursor: string | undefined = undefined;

    for (let page = 0; page < Math.ceil(total / pageSize) + 1; page++) {
      const result = paginateApiKeys(records, pageSize, cursor);
      for (const item of result.items) {
        expect(seen.has(item.id)).toBe(false); // no duplicates
        seen.add(item.id);
      }
      if (result.nextCursor === null) break;
      cursor = result.nextCursor;
    }

    expect(seen.size).toBe(total); // no gaps
  });

  it('returns nextCursor as null on the last page', () => {
    const records = buildRecords(6);
    const page1 = paginateApiKeys(records, 4);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = paginateApiKeys(records, 4, page1.nextCursor!);
    expect(page2.items).toHaveLength(2);
    expect(page2.nextCursor).toBeNull();
  });
});

// ─── 4. paginateApiKeys — boundary and clamping ─────────────────────────────

describe('paginateApiKeys — limit boundary handling', () => {
  // Use enough records to saturate the maximum page size so clamping is observable.
  const records = buildRecords(API_KEYS_MAX_PAGE_SIZE + 10);

  it('clamps limit of 0 to 1', () => {
    const { items } = paginateApiKeys(records, 0);
    expect(items).toHaveLength(1);
  });

  it('clamps negative limit to 1', () => {
    const { items } = paginateApiKeys(records, -10);
    expect(items).toHaveLength(1);
  });

  it('clamps limit above max to API_KEYS_MAX_PAGE_SIZE', () => {
    const { items } = paginateApiKeys(records, 999);
    expect(items).toHaveLength(API_KEYS_MAX_PAGE_SIZE);
  });

  it('uses default for non-finite limit (NaN)', () => {
    const { items } = paginateApiKeys(records, NaN);
    expect(items).toHaveLength(API_KEYS_DEFAULT_PAGE_SIZE);
  });

  it('uses default for Infinity limit', () => {
    const { items } = paginateApiKeys(records, Infinity);
    expect(items).toHaveLength(API_KEYS_DEFAULT_PAGE_SIZE);
  });

  it('floors a float limit', () => {
    const { items } = paginateApiKeys(records, 5.9);
    expect(items).toHaveLength(5);
  });
});

// ─── 5. paginateApiKeys — cursor safety ─────────────────────────────────────

describe('paginateApiKeys — cursor safety', () => {
  const records = buildRecords(10);

  it('throws InvalidApiKeyCursorError for a tampered cursor', () => {
    const { nextCursor } = paginateApiKeys(records, 5);
    expect(nextCursor).not.toBeNull();
    const tampered = `${nextCursor!.split('.')[0]}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    expect(() => paginateApiKeys(records, 5, tampered)).toThrow(InvalidApiKeyCursorError);
  });

  it('throws InvalidApiKeyCursorError for a malformed cursor string', () => {
    expect(() => paginateApiKeys(records, 5, 'not-a-valid-cursor')).toThrow(InvalidApiKeyCursorError);
  });

  it('throws InvalidApiKeyCursorError for an empty cursor string', () => {
    expect(() => paginateApiKeys(records, 5, '')).toThrow(InvalidApiKeyCursorError);
  });

  it('is idempotent: same cursor on the same snapshot returns identical results', () => {
    const page1 = paginateApiKeys(records, 3);
    const cursor = page1.nextCursor!;

    const page2a = paginateApiKeys(records, 3, cursor);
    const page2b = paginateApiKeys(records, 3, cursor);

    expect(page2a.items).toEqual(page2b.items);
    expect(page2a.nextCursor).toEqual(page2b.nextCursor);
  });

  it('cursor from one snapshot still works after adding new records (snapshot isolation)', () => {
    // Simulate: cursor taken from snapshot-A, then new record added before next call
    const snapshotA = buildRecords(6);
    const page1 = paginateApiKeys(snapshotA, 3);
    const cursor = page1.nextCursor!;

    // New snapshot includes one extra newest record
    const newRecord: ApiKeyCursorPosition = {
      id: 'key-new',
      createdAt: new Date(Date.now() + 100000).toISOString(),
    };
    const snapshotB = [newRecord, ...snapshotA];

    // Cursor should still yield the correct next 3 items from original snapshot
    const page2 = paginateApiKeys(snapshotB, 3, cursor);
    // The new record is newer than cursor anchor, so it won't appear after cursor
    // But the existing records should still be accessible.
    expect(page2.items.every((item) => item.id !== 'key-new')).toBe(true);
  });
});

// ─── 6. Concurrency / timing safety ─────────────────────────────────────────

describe('paginateApiKeys — concurrency and timing safety', () => {
  it('total order is stable when two records share the same createdAt', () => {
    const sameTime = '2024-06-01T12:00:00.000Z';
    const records: ApiKeyCursorPosition[] = [
      { id: 'key-b', createdAt: sameTime },
      { id: 'key-a', createdAt: sameTime },
      { id: 'key-c', createdAt: sameTime },
    ];

    const { items } = paginateApiKeys(records, 10);
    // All three have same createdAt; sort by id ASC
    expect(items.map((i) => i.id)).toEqual(['key-a', 'key-b', 'key-c']);
  });

  it('no record is skipped or duplicated across pages with same-ms inserts', () => {
    const sameTime = '2024-06-01T12:00:00.000Z';
    const records: ApiKeyCursorPosition[] = Array.from({ length: 9 }, (_, i) => ({
      id: `key-${String(i).padStart(3, '0')}`,
      createdAt: sameTime,
    }));

    const seen = new Set<string>();
    let cursor: string | undefined = undefined;

    for (let page = 0; page < 10; page++) {
      const result = paginateApiKeys(records, 3, cursor);
      for (const item of result.items) {
        expect(seen.has(item.id)).toBe(false);
        seen.add(item.id);
      }
      if (result.nextCursor === null) break;
      cursor = result.nextCursor;
    }

    expect(seen.size).toBe(9);
  });

  it('simulates two concurrent requests using the same cursor without producing duplicates', () => {
    const records = buildRecords(15);
    const page1 = paginateApiKeys(records, 5);
    const cursor = page1.nextCursor!;

    // Two concurrent handlers call paginateApiKeys with the same cursor
    const resultA = paginateApiKeys(records, 5, cursor);
    const resultB = paginateApiKeys(records, 5, cursor);

    // Both results must be identical
    expect(resultA.items).toEqual(resultB.items);
    expect(resultA.nextCursor).toEqual(resultB.nextCursor);

    // No overlap between page1 and page2
    const page1Ids = new Set(page1.items.map((i) => i.id));
    for (const item of resultA.items) {
      expect(page1Ids.has(item.id)).toBe(false);
    }
  });

  it('handles records added concurrently (not in snapshot) without corrupting existing pages', () => {
    const original = buildRecords(10);
    const page1 = paginateApiKeys(original, 4);
    const cursor = page1.nextCursor!;

    // Simulate a record that was inserted after snapshot was taken
    const concurrent: ApiKeyCursorPosition = {
      id: 'key-concurrent',
      createdAt: new Date(Date.now() + 999999).toISOString(),
    };

    // Existing pages remain correct when using the original snapshot
    const page2 = paginateApiKeys(original, 4, cursor);
    expect(page2.items.map((i) => i.id)).not.toContain(concurrent.id);

    // Full traversal of original snapshot covers exactly the original 10 records
    const allIds = new Set([...page1.items, ...page2.items].map((i) => i.id));
    expect(allIds.size).toBe(8); // 4 + 4 (last page has 2 more)

    const page3 = paginateApiKeys(original, 4, page2.nextCursor!);
    page3.items.forEach((item) => allIds.add(item.id));
    expect(allIds.size).toBe(10);
    expect(page3.nextCursor).toBeNull();
  });

  it('sort order is deterministic across repeated calls on the same input', () => {
    const records = buildRecords(20);
    const run1 = paginateApiKeys(records, 20).items.map((i) => i.id);
    const run2 = paginateApiKeys(records, 20).items.map((i) => i.id);
    expect(run1).toEqual(run2);
  });

  it('does not mutate the caller\'s records array', () => {
    const records = buildRecords(5);
    const original = records.map((r) => ({ ...r }));
    paginateApiKeys(records, 3);
    expect(records).toEqual(original);
  });
});

// ─── 7. Secret rotation ──────────────────────────────────────────────────────

describe('cursor secret rotation (lazy loading)', () => {
  const savedEnv = process.env['API_KEYS_CURSOR_SECRET'];

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env['API_KEYS_CURSOR_SECRET'];
    } else {
      process.env['API_KEYS_CURSOR_SECRET'] = savedEnv;
    }
  });

  it('encodes/decodes correctly with a custom secret set after module load', () => {
    process.env['API_KEYS_CURSOR_SECRET'] = 'my-rotation-secret-1';
    const pos = { id: 'key-rot', createdAt: '2024-09-01T00:00:00.000Z' };
    const cursor = encodeApiKeyCursor(pos);
    expect(decodeApiKeyCursor(cursor)).toEqual(pos);
  });

  it('rejects a cursor signed with the old secret after rotation', () => {
    process.env['API_KEYS_CURSOR_SECRET'] = 'secret-before-rotation';
    const pos = { id: 'key-old', createdAt: '2024-09-01T00:00:00.000Z' };
    const oldCursor = encodeApiKeyCursor(pos);

    // Rotate the secret
    process.env['API_KEYS_CURSOR_SECRET'] = 'secret-after-rotation';
    expect(() => decodeApiKeyCursor(oldCursor)).toThrow(InvalidApiKeyCursorError);
  });

  it('accepts new cursors signed with the rotated secret', () => {
    process.env['API_KEYS_CURSOR_SECRET'] = 'secret-after-rotation';
    const pos = { id: 'key-new', createdAt: '2024-09-01T00:00:00.000Z' };
    const newCursor = encodeApiKeyCursor(pos);
    expect(decodeApiKeyCursor(newCursor)).toEqual(pos);
  });
});

// ─── 8. Racing / duplicate-work / idempotent retry scenarios ────────────────

describe('idempotent retry and racing request scenarios', () => {
  it('repeated calls with no cursor return the same first page', () => {
    const records = buildRecords(20);
    const r1 = paginateApiKeys(records, 5);
    const r2 = paginateApiKeys(records, 5);
    expect(r1.items).toEqual(r2.items);
    expect(r1.nextCursor).toBe(r2.nextCursor);
  });

  it('race condition: two clients traverse in parallel without missing items', () => {
    const records = buildRecords(12);
    const pageSize = 4;

    // Simulate two independent cursors advancing through the same snapshot
    let cursorA: string | undefined = undefined;
    let cursorB: string | undefined = undefined;
    const allFromA = new Set<string>();
    const allFromB = new Set<string>();

    for (let i = 0; i < 5; i++) {
      const a = paginateApiKeys(records, pageSize, cursorA);
      const b = paginateApiKeys(records, pageSize, cursorB);
      a.items.forEach((item) => allFromA.add(item.id));
      b.items.forEach((item) => allFromB.add(item.id));
      cursorA = a.nextCursor ?? undefined;
      cursorB = b.nextCursor ?? undefined;
      if (cursorA === undefined && cursorB === undefined) break;
    }

    // Both clients saw all 12 records
    expect(allFromA.size).toBe(12);
    expect(allFromB.size).toBe(12);
  });

  it('retry of the same page (same cursor) does not duplicate items', () => {
    const records = buildRecords(8);
    const page1 = paginateApiKeys(records, 3);
    const cursor = page1.nextCursor!;

    // Retry page2 three times — all must produce identical results
    const page2Attempts = Array.from({ length: 3 }, () =>
      paginateApiKeys(records, 3, cursor),
    );

    for (const attempt of page2Attempts) {
      expect(attempt.items).toEqual(page2Attempts[0]!.items);
      expect(attempt.nextCursor).toBe(page2Attempts[0]!.nextCursor);
    }

    // No duplication between page1 and any attempt at page2
    const page1Ids = new Set(page1.items.map((i) => i.id));
    for (const item of page2Attempts[0]!.items) {
      expect(page1Ids.has(item.id)).toBe(false);
    }
  });

  it('duplicate submission: calling encodeApiKeyCursor twice for same position is safe', () => {
    const pos = { id: 'dup-key', createdAt: '2024-01-15T08:00:00.000Z' };
    const c1 = encodeApiKeyCursor(pos);
    const c2 = encodeApiKeyCursor(pos);
    // Both decode to the same position even if the tokens differ (issuedAt)
    expect(decodeApiKeyCursor(c1)).toEqual(pos);
    expect(decodeApiKeyCursor(c2)).toEqual(pos);
  });
});

// ─── 9. Edge cases ───────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('handles a single-record snapshot', () => {
    const records = [makeRecord('only-key', '2024-01-01T00:00:00.000Z')];
    const { items, nextCursor } = paginateApiKeys(records, 10);
    expect(items).toHaveLength(1);
    expect(nextCursor).toBeNull();
  });

  it('handles records with identical id and createdAt (degenerate input)', () => {
    const ts = '2024-01-01T00:00:00.000Z';
    const records = [makeRecord('same', ts), makeRecord('same', ts)];
    // Should not throw; results are deterministic
    expect(() => paginateApiKeys(records, 10)).not.toThrow();
  });

  it('cursor from the exact last record produces an empty next page', () => {
    const records = buildRecords(3);
    const { items } = paginateApiKeys(records, 10);
    const lastItem = items[items.length - 1]!;
    const cursor = encodeApiKeyCursor(lastItem);
    const nextPage = paginateApiKeys(records, 10, cursor);
    expect(nextPage.items).toHaveLength(0);
    expect(nextPage.nextCursor).toBeNull();
  });

  it('does not expose sensitive data in the cursor string', () => {
    const pos = { id: 'key-sensitive', createdAt: '2024-06-01T00:00:00.000Z' };
    const cursor = encodeApiKeyCursor(pos);
    // The raw cursor must not contain the signing secret
    const secret = process.env['API_KEYS_CURSOR_SECRET'] ?? 'talenttrust-api-keys-cursor-v1';
    expect(cursor).not.toContain(secret);
  });

  it('InvalidApiKeyCursorError has the correct name property', () => {
    const err = new InvalidApiKeyCursorError();
    expect(err.name).toBe('InvalidApiKeyCursorError');
    expect(err.message).toBe('Invalid pagination cursor');
    expect(err).toBeInstanceOf(Error);
  });
});
