import { loadCacheConfig, parsePositiveInteger } from './cache-config';

describe('cache config', () => {
  it('loads default config values', () => {
    expect(loadCacheConfig({})).toEqual({
      enabled: true,
      ttlSeconds: 30,
      maxItems: 100,
    });
  });

  it('loads explicit config values', () => {
    expect(
      loadCacheConfig({
        CACHE_ENABLED: 'false',
        CACHE_TTL_SECONDS: '45',
        CACHE_MAX_ITEMS: '50',
      }),
    ).toEqual({
      enabled: false,
      ttlSeconds: 45,
      maxItems: 50,
    });
  });

  it('rejects invalid positive integers', () => {
    expect(() => parsePositiveInteger('0', 30, 'CACHE_TTL_SECONDS')).toThrow(
      'CACHE_TTL_SECONDS must be a positive integer.',
    );
  });
});
