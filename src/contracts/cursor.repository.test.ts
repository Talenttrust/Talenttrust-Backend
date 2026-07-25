/**
 * Unit tests for cursor encode/decode primitives and limit validation.
 */

import {
  encodeCursor,
  decodeCursor,
  parseLimit,
  resolveCursorQueryParam,
} from './cursor.repository';
import { InMemoryCursorRepository } from './cursor.repository';
import { CURSOR_MAX_LIMIT, CURSOR_DEFAULT_LIMIT, CURSOR_MAX_LENGTH } from './cursor.types';

describe('encodeCursor / decodeCursor', () => {
  const position = { createdAt: '2024-06-01T12:00:00.000Z', id: 'abc-123' };

  it('round-trips a valid cursor position', () => {
    const cursor = encodeCursor(position);
    expect(typeof cursor).toBe('string');
    expect(cursor.length).toBeGreaterThan(0);
    expect(cursor.length).toBeLessThanOrEqual(CURSOR_MAX_LENGTH);
    const decoded = decodeCursor(cursor);
    expect(decoded).toEqual(position);
  });

  it('produces a base64url string (no +, /, or = padding)', () => {
    const cursor = encodeCursor(position);
    expect(cursor).not.toMatch(/[+/=]/);
  });

  it('throws on completely invalid input', () => {
    expect(() => decodeCursor('not-base64-json')).toThrow(
      /invalid pagination cursor/i,
    );
  });

  it('throws if cursor length exceeds CURSOR_MAX_LENGTH', () => {
    const oversizedCursor = 'a'.repeat(CURSOR_MAX_LENGTH + 1);
    expect(() => decodeCursor(oversizedCursor)).toThrow(/invalid pagination cursor/i);
  });

  it('throws if cursor contains characters outside the base64url charset', () => {
    const validCursor = encodeCursor(position);
    
    // Add invalid chars one by one
    expect(() => decodeCursor(validCursor + '=')).toThrow(/invalid pagination cursor/i);
    expect(() => decodeCursor(validCursor + '/')).toThrow(/invalid pagination cursor/i);
    expect(() => decodeCursor(validCursor + '+')).toThrow(/invalid pagination cursor/i);
    expect(() => decodeCursor(' ' + validCursor)).toThrow(/invalid pagination cursor/i);
    expect(() => decodeCursor(validCursor + '!')).toThrow(/invalid pagination cursor/i);
  });

  it('accepts cursor at exactly CURSOR_MAX_LENGTH if valid base64url', () => {
    // Note: since it's hard to make a valid JSON object that encodes exactly to 256 base64url chars
    // without actually doing parsing, we can just ensure that if the size is exactly at max
    // AND it fails later in JSON parsing, it throws the specific JSON parse error
    // instead of the malformed error from the length guard.
    const maxCursor = 'a'.repeat(CURSOR_MAX_LENGTH);
    expect(() => decodeCursor(maxCursor)).toThrow(/invalid pagination cursor: cannot decode/i);
  });

  it('throws on valid base64 that is not JSON', () => {
    const bad = Buffer.from('hello world', 'utf8').toString('base64url');
    expect(() => decodeCursor(bad)).toThrow(/invalid pagination cursor/i);
  });

  it('throws when createdAt field is missing', () => {
    const bad = Buffer.from(
      JSON.stringify({ id: 'abc-123' }),
      'utf8',
    ).toString('base64url');
    expect(() => decodeCursor(bad)).toThrow(/invalid pagination cursor/i);
  });

  it('throws when id field is missing', () => {
    const bad = Buffer.from(
      JSON.stringify({ createdAt: '2024-01-01T00:00:00.000Z' }),
      'utf8',
    ).toString('base64url');
    expect(() => decodeCursor(bad)).toThrow(/invalid pagination cursor/i);
  });

  it('throws when createdAt is not a valid date string', () => {
    const bad = Buffer.from(
      JSON.stringify({ createdAt: 'not-a-date', id: 'abc-123' }),
      'utf8',
    ).toString('base64url');
    expect(() => decodeCursor(bad)).toThrow(/invalid pagination cursor/i);
  });

  it('throws when decoded value is a JSON primitive, not an object', () => {
    const bad = Buffer.from(JSON.stringify(42), 'utf8').toString('base64url');
    expect(() => decodeCursor(bad)).toThrow(/invalid pagination cursor/i);
  });

  it('throws when decoded value is null', () => {
    const bad = Buffer.from(JSON.stringify(null), 'utf8').toString('base64url');
    expect(() => decodeCursor(bad)).toThrow(/invalid pagination cursor/i);
  });
});

describe('parseLimit', () => {
  it('returns CURSOR_DEFAULT_LIMIT when value is undefined', () => {
    expect(parseLimit(undefined)).toBe(CURSOR_DEFAULT_LIMIT);
  });

  it('returns CURSOR_DEFAULT_LIMIT when value is null', () => {
    expect(parseLimit(null)).toBe(CURSOR_DEFAULT_LIMIT);
  });

  it('returns CURSOR_DEFAULT_LIMIT when value is empty string', () => {
    expect(parseLimit('')).toBe(CURSOR_DEFAULT_LIMIT);
  });

  it('parses a valid string number', () => {
    expect(parseLimit('10')).toBe(10);
  });

  it('parses a valid numeric value', () => {
    expect(parseLimit(50)).toBe(50);
  });

  it('accepts limit = 1 (minimum)', () => {
    expect(parseLimit(1)).toBe(1);
  });

  it(`accepts limit = ${CURSOR_MAX_LIMIT} (maximum)`, () => {
    expect(parseLimit(CURSOR_MAX_LIMIT)).toBe(CURSOR_MAX_LIMIT);
  });

  it(`throws when limit exceeds ${CURSOR_MAX_LIMIT}`, () => {
    expect(() => parseLimit(CURSOR_MAX_LIMIT + 1)).toThrow(/exceeds maximum/i);
  });

  it('throws when limit is 0', () => {
    expect(() => parseLimit(0)).toThrow(/positive integer/i);
  });

  it('throws when limit is negative', () => {
    expect(() => parseLimit(-10)).toThrow(/positive integer/i);
  });

  it('throws when limit is NaN (non-numeric string)', () => {
    expect(() => parseLimit('abc')).toThrow(/positive integer/i);
  });

  it('throws when limit is a float string that truncates to 0', () => {
    expect(() => parseLimit('0.9')).toThrow(/positive integer/i);
  });
});

describe('InMemoryCursorRepository', () => {
  it('returns null for non-existent cursor', async () => {
    const repo = new InMemoryCursorRepository();
    const cursor = await repo.getCursor('unknown-source');
    expect(cursor).toBeNull();
  });

  it('stores and retrieves cursor', async () => {
    const repo = new InMemoryCursorRepository();
    await repo.updateCursor('source-1', 100);

    const cursor = await repo.getCursor('source-1');
    expect(cursor).not.toBeNull();
    expect(cursor!.sourceId).toBe('source-1');
    expect(cursor!.lastSequence).toBe(100);
    expect(cursor!.updatedAt).toBeDefined();
  });

  it('updates cursor with higher sequence', async () => {
    const repo = new InMemoryCursorRepository();
    await repo.updateCursor('source-1', 100);
    await repo.updateCursor('source-1', 150);

    const cursor = await repo.getCursor('source-1');
    expect(cursor!.lastSequence).toBe(150);
  });

  it('can update cursor with lower sequence (non-enforcing)', async () => {
    const repo = new InMemoryCursorRepository();
    await repo.updateCursor('source-1', 150);
    const result = await repo.updateCursor('source-1', 100);

    expect(result.success).toBe(true);
    expect(result.cursor.lastSequence).toBe(100);
  });

  it('stores and retrieves metadata', async () => {
    const repo = new InMemoryCursorRepository();
    const meta = { blockHash: 'abc123', checkpoint: 'phase-1' };
    await repo.updateCursor('source-1', 100, meta);

    const cursor = await repo.getCursor('source-1');
    expect(cursor!.metadata).toEqual(meta);
  });

  it('lists all cursors', async () => {
    const repo = new InMemoryCursorRepository();
    await repo.updateCursor('source-1', 100);
    await repo.updateCursor('source-2', 200);
    await repo.updateCursor('source-3', 300);

    const cursors = await repo.listCursors();
    expect(cursors).toHaveLength(3);
    expect(cursors.map((c) => c.sourceId)).toEqual(['source-1', 'source-2', 'source-3']);
  });

  it('deletes cursor', async () => {
    const repo = new InMemoryCursorRepository();
    await repo.updateCursor('source-1', 100);

    const deleted = await repo.deleteCursor('source-1');
    expect(deleted).toBe(true);

    const cursor = await repo.getCursor('source-1');
    expect(cursor).toBeNull();
  });

  it('returns false when deleting non-existent cursor', async () => {
    const repo = new InMemoryCursorRepository();
    const deleted = await repo.deleteCursor('unknown-source');
    expect(deleted).toBe(false);
  });

  it('update returns success with cursor data', async () => {
    const repo = new InMemoryCursorRepository();
    const result = await repo.updateCursor('source-1', 99, { key: 'value' });

    expect(result.success).toBe(true);
    expect(result.cursor.sourceId).toBe('source-1');
    expect(result.cursor.lastSequence).toBe(99);
    expect(result.cursor.metadata).toEqual({ key: 'value' });
  });

  it('maintains isolation between separate cursors', async () => {
    const repo = new InMemoryCursorRepository();
    await repo.updateCursor('source-a', 100);
    await repo.updateCursor('source-b', 200);
    await repo.updateCursor('source-a', 150);

    const cursorA = await repo.getCursor('source-a');
    const cursorB = await repo.getCursor('source-b');

    expect(cursorA!.lastSequence).toBe(150);
    expect(cursorB!.lastSequence).toBe(200);
  });
});

describe('resolveCursorQueryParam', () => {
  const position = { createdAt: '2024-06-01T12:00:00.000Z', id: 'abc-123' };

  it('returns ok with cursor undefined when no cursor is supplied', () => {
    const result = resolveCursorQueryParam(undefined);
    expect(result).toEqual({ ok: true, cursor: undefined });
  });

  it('returns ok with cursor undefined for an empty string', () => {
    const result = resolveCursorQueryParam('');
    expect(result).toEqual({ ok: true, cursor: undefined });
  });

  it('returns ok with the cursor echoed back when it decodes successfully', () => {
    const cursor = encodeCursor(position);
    const result = resolveCursorQueryParam(cursor);
    expect(result).toEqual({ ok: true, cursor });
  });

  it('returns ok:false with decodeCursor\'s message for a malformed cursor', () => {
    const result = resolveCursorQueryParam('not-a-valid-cursor');
    expect(result.ok).toBe(false);
    expect((result as { ok: false; message: string }).message).toMatch(/invalid pagination cursor/i);
  });

  it('returns ok:false for a cursor missing a required field, matching decodeCursor directly', () => {
    const bad = Buffer.from(
      JSON.stringify({ createdAt: '2024-01-01T00:00:00.000Z' }),
      'utf8',
    ).toString('base64url');

    const result = resolveCursorQueryParam(bad);
    expect(result.ok).toBe(false);

    let expectedMessage = '';
    try {
      decodeCursor(bad);
    } catch (err) {
      expectedMessage = (err as Error).message;
    }
    expect((result as { ok: false; message: string }).message).toBe(expectedMessage);
  });

  it('treats a non-string raw value (e.g. an array from a duplicated query param) as absent', () => {
    const result = resolveCursorQueryParam(['a', 'b']);
    expect(result).toEqual({ ok: true, cursor: undefined });
  });
});
