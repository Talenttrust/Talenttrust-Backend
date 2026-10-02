/**
 * @file types.cursor.test.ts
 * @description Focused coverage for the audit cursor codec's failure-recovery
 * contract (issue #1383): `decodeCursor` must be total and deterministic —
 * every malformed input produces the same typed `CursorFormatError`, and it
 * must never return `null`/a primitive/a half-built object for the store to
 * trip over later.
 */

import {
  CURSOR_MAX_LENGTH,
  CursorFormatError,
  decodeCursor,
  encodeCursor,
  isCursorData,
  type CursorData,
} from './types';
import { AuditStore } from './store';

/** Base64-encodes a raw JSON string so we can feed arbitrary payloads to decode. */
const b64 = (raw: string): string => Buffer.from(raw, 'utf-8').toString('base64');

const validCursor = (filters: CursorData['filters'] = {}): CursorData => ({
  lastId: '11111111-1111-4111-8111-111111111111',
  lastTimestamp: '2026-01-01T00:00:00.000Z',
  filters,
});

describe('encodeCursor / decodeCursor round-trip', () => {
  it('round-trips a cursor with no filters', () => {
    const data = validCursor();
    expect(decodeCursor(encodeCursor(data))).toEqual(data);
  });

  it('round-trips every supported filter', () => {
    const data = validCursor({
      action: 'CONTRACT_CREATED',
      severity: 'WARNING',
      actor: 'user-1',
      resource: 'contract',
      resourceId: 'contract-9',
      from: '2025-12-31T00:00:00.000Z',
      to: '2026-01-02T00:00:00.000Z',
    });
    expect(decodeCursor(encodeCursor(data))).toEqual(data);
  });

  it('is deterministic regardless of filter key insertion order', () => {
    const a = encodeCursor(validCursor({ actor: 'u1', resource: 'contract' }));
    const b = encodeCursor(validCursor({ resource: 'contract', actor: 'u1' }));
    expect(a).toBe(b);
  });

  it('drops unknown filter keys instead of echoing caller state', () => {
    const encoded = encodeCursor({
      ...validCursor(),
      filters: { actor: 'u1', injected: 'nope' } as CursorData['filters'],
    });
    expect(decodeCursor(encoded).filters).toEqual({ actor: 'u1' });
  });
});

describe('decodeCursor — deterministic rejection of malformed input', () => {
  const malformed: Array<[string, string]> = [
    ['empty string', ''],
    ['not a string', undefined as unknown as string],
    ['bad charset', 'not a cursor!!'],
    ['oversized', 'A'.repeat(CURSOR_MAX_LENGTH + 1)],
    ['not JSON', b64('{ this is not json')],
    ['JSON null', b64('null')],
    ['JSON number', b64('42')],
    ['JSON string', b64('"cursor"')],
    ['JSON array', b64('[]')],
    ['empty object', b64('{}')],
    ['missing lastTimestamp', b64(JSON.stringify({ lastId: 'a', filters: {} }))],
    [
      'unparseable lastTimestamp',
      b64(JSON.stringify({ lastId: 'a', lastTimestamp: 'not-a-date', filters: {} })),
    ],
    ['missing filters', b64(JSON.stringify({ lastId: 'a', lastTimestamp: '2026-01-01T00:00:00.000Z' }))],
    [
      'filters is an array',
      b64(JSON.stringify({ lastId: 'a', lastTimestamp: '2026-01-01T00:00:00.000Z', filters: [] })),
    ],
    [
      'unknown filter key',
      b64(JSON.stringify({ lastId: 'a', lastTimestamp: '2026-01-01T00:00:00.000Z', filters: { evil: 'x' } })),
    ],
    [
      'invalid action filter',
      b64(JSON.stringify({ lastId: 'a', lastTimestamp: '2026-01-01T00:00:00.000Z', filters: { action: 'NOT_REAL' } })),
    ],
    [
      'invalid severity filter',
      b64(JSON.stringify({ lastId: 'a', lastTimestamp: '2026-01-01T00:00:00.000Z', filters: { severity: 'LOUD' } })),
    ],
  ];

  it.each(malformed)('throws a CursorFormatError for %s', (_label, input) => {
    expect(() => decodeCursor(input)).toThrow(CursorFormatError);
  });

  it.each(malformed)('is deterministic for %s (same class, message, code)', (_label, input) => {
    let first: CursorFormatError | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        decodeCursor(input);
        throw new Error('expected decodeCursor to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(CursorFormatError);
        const cursorError = err as CursorFormatError;
        expect(cursorError.message).toBe('Invalid cursor format');
        expect(cursorError.code).toBe('invalid_cursor_format');
        expect(typeof cursorError.reason).toBe('string');
        if (first) {
          expect(cursorError.reason).toBe(first.reason);
        } else {
          first = cursorError;
        }
      }
    }
  });

  it('regression: base64("null") no longer silently returns null', () => {
    // Previously this returned `null` cast to CursorData; the store then read
    // `.lastId`/`.filters` off it and either threw a TypeError or (after the
    // store's catch-all) silently restarted pagination.
    let result: unknown = 'not-run';
    try {
      result = decodeCursor(b64('null'));
    } catch (err) {
      expect(err).toBeInstanceOf(CursorFormatError);
      expect((err as CursorFormatError).reason).toBe('not_an_object');
    }
    expect(result).toBe('not-run');
  });

  it('does not echo the raw cursor value in the error', () => {
    const secret = b64('{"lastId":"tenant-secret-value"}');
    try {
      decodeCursor(secret);
      throw new Error('expected decodeCursor to throw');
    } catch (err) {
      expect((err as Error).message).not.toContain('tenant-secret-value');
    }
  });
});

describe('isCursorData', () => {
  it('accepts a valid parsed cursor', () => {
    expect(isCursorData(validCursor({ actor: 'u1' }))).toBe(true);
  });

  it.each([null, undefined, 1, 'x', [], {}, { lastId: '' }])(
    'rejects %p without throwing',
    (value) => {
      expect(isCursorData(value)).toBe(false);
    },
  );
});

describe('recovery through the in-memory store', () => {
  it('a malformed cursor yields a deterministic first page instead of throwing', () => {
    const store = new AuditStore();
    for (let i = 0; i < 5; i += 1) {
      store.append({
        action: 'CONTRACT_CREATED',
        severity: 'INFO',
        actor: `u${i}`,
        resource: 'contract',
        resourceId: `c${i}`,
        metadata: {},
      });
    }

    const page = store.queryWithCursor({ cursor: b64('null'), limit: 2 });

    expect(page.entries.map((entry) => entry.resourceId)).toEqual(['c0', 'c1']);
    expect(page.limit).toBe(2);
  });
});
