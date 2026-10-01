import { describe, expect, it } from 'vitest';
import { decodeApiKeyCursor, encodeApiKeyCursor, paginateApiKeys, InvalidApiKeyCursorError } from './apiKeyPagination';

describe('api key pagination invariants', () => {
  it('round-trips a cursor and rejects tampering', () => {
    const cursor = encodeApiKeyCursor({ createdAt: '2026-01-01T00:00:00.000Z', id: 'key-1' });
    expect(decodeApiKeyCursor(cursor)).toEqual({ createdAt: '2026-01-01T00:00:00.000Z', id: 'key-1' });
    expect(() => decodeApiKeyCursor(cursor + 'x')).toThrow(InvalidApiKeyCursorError);
  });

  it('bounds page size and produces a continuation cursor', () => {
    const page = paginateApiKeys([{ createdAt: '2026-01-03T00:00:00.000Z', id: '3' }, { createdAt: '2026-01-02T00:00:00.000Z', id: '2' }], 1);
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
  });
});
