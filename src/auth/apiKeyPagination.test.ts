import {
  API_KEYS_DEFAULT_PAGE_SIZE,
  API_KEYS_MAX_PAGE_SIZE,
  decodeApiKeyCursor,
  encodeApiKeyCursor,
  InvalidApiKeyCursorError,
  paginateApiKeys,
  parseApiKeyPageSize,
} from './apiKeyPagination';

describe('API-key cursor pagination', () => {
  const records = [
    { id: 'key-3', createdAt: '2026-01-03T00:00:00.000Z', name: 'third' },
    { id: 'key-2', createdAt: '2026-01-02T00:00:00.000Z', name: 'second' },
    { id: 'key-1', createdAt: '2026-01-01T00:00:00.000Z', name: 'first' },
  ];

  it('round-trips an opaque cursor', () => {
    const cursor = encodeApiKeyCursor(records[0]);
    expect(cursor).not.toContain('{');
    expect(decodeApiKeyCursor(cursor)).toEqual({
      id: 'key-3',
      createdAt: '2026-01-03T00:00:00.000Z',
    });
  });

  it.each(['bad', '', 'abc.def', `${encodeApiKeyCursor(records[0])}x`])(
    'rejects an invalid cursor: %s',
    (cursor) => {
      expect(() => decodeApiKeyCursor(cursor)).toThrow(InvalidApiKeyCursorError);
    },
  );

  it('returns an empty page for an empty result set', () => {
    expect(paginateApiKeys([], 20)).toEqual({ items: [], nextCursor: null });
  });

  it('returns no cursor at the exact page boundary', () => {
    expect(paginateApiKeys(records, 3)).toEqual({ items: records, nextCursor: null });
  });

  it('returns a stable cursor and continues from that cursor', () => {
    const firstPage = paginateApiKeys(records, 2);
    expect(firstPage.items.map((item) => item.id)).toEqual(['key-3', 'key-2']);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = paginateApiKeys(records, 2, firstPage.nextCursor ?? undefined);
    expect(secondPage.items.map((item) => item.id)).toEqual(['key-1']);
    expect(secondPage.nextCursor).toBeNull();
  });

  it('does not skip records with identical timestamps', () => {
    const sameTimestamp = [
      { id: 'key-b', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'key-a', createdAt: '2026-01-01T00:00:00.000Z' },
    ];

    const firstPage = paginateApiKeys(sameTimestamp, 1);
    expect(firstPage.items.map((item) => item.id)).toEqual(['key-b']);

    const secondPage = paginateApiKeys(sameTimestamp, 1, firstPage.nextCursor ?? undefined);
    expect(secondPage.items.map((item) => item.id)).toEqual(['key-a']);
  });

  it('clamps over-limit requests to the configured maximum', () => {
    expect(parseApiKeyPageSize(API_KEYS_MAX_PAGE_SIZE + 1)).toBe(API_KEYS_MAX_PAGE_SIZE);
    expect(parseApiKeyPageSize('999999')).toBe(API_KEYS_MAX_PAGE_SIZE);
    expect(paginateApiKeys(records, API_KEYS_MAX_PAGE_SIZE + 1).items).toHaveLength(records.length);
  });

  it('uses the bounded default for missing or invalid limits', () => {
    expect(parseApiKeyPageSize(undefined)).toBe(API_KEYS_DEFAULT_PAGE_SIZE);
    expect(parseApiKeyPageSize('not-a-number')).toBe(API_KEYS_DEFAULT_PAGE_SIZE);
    expect(parseApiKeyPageSize('-1')).toBe(API_KEYS_DEFAULT_PAGE_SIZE);
  });
});
