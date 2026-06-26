import { loadContractMetadataCacheConfig } from './contractMetadataCache';

describe('loadContractMetadataCacheConfig', () => {
  it('uses safe defaults when env vars are absent', () => {
    const config = loadContractMetadataCacheConfig({});

    expect(config).toEqual({
      ttlMs: 5_000,
      swrMs: 30_000,
      maxEntries: 500,
    });
  });

  it('reads overrides from env', () => {
    const config = loadContractMetadataCacheConfig({
      CONTRACT_METADATA_CACHE_TTL_MS: '1200',
      CONTRACT_METADATA_CACHE_SWR_MS: '9000',
      CONTRACT_METADATA_CACHE_MAX_ENTRIES: '42',
    });

    expect(config).toEqual({
      ttlMs: 1_200,
      swrMs: 9_000,
      maxEntries: 42,
    });
  });

  it('rejects negative or fractional values', () => {
    expect(() =>
      loadContractMetadataCacheConfig({ CONTRACT_METADATA_CACHE_TTL_MS: '-1' }),
    ).toThrow('must be a non-negative integer');

    expect(() =>
      loadContractMetadataCacheConfig({ CONTRACT_METADATA_CACHE_SWR_MS: '1.5' }),
    ).toThrow('must be a non-negative integer');

    expect(() =>
      loadContractMetadataCacheConfig({ CONTRACT_METADATA_CACHE_MAX_ENTRIES: '0' }),
    ).toThrow('must be a positive integer');
  });
});
