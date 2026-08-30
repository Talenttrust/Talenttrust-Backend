import {
  ContractMetadataCache,
  buildContractMetadataCacheKey,
  contractMetadataCache,
  invalidateContractMetadataCache,
  resetContractMetadataCache,
} from './contractMetadata';

describe('ContractMetadataCache', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2024-01-01T00:00:00Z'));
    resetContractMetadataCache();
  });

  afterEach(() => {
    jest.useRealTimers();
    resetContractMetadataCache();
  });

  it('returns cache miss on first fetch and stores the value', async () => {
    const cache = new ContractMetadataCache<{ version: number }>({ ttlMs: 5_000, maxEntries: 10 });
    const fetcher = jest.fn().mockResolvedValue({ version: 1 });

    await expect(cache.get('testnet', 'C123', fetcher)).resolves.toEqual({ version: 1 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cache.stats().misses).toBe(1);
    expect(cache.stats().entries).toBe(1);
  });

  it('returns a fresh hit without refetching', async () => {
    const cache = new ContractMetadataCache<{ version: number }>({ ttlMs: 5_000, maxEntries: 10 });
    const fetcher = jest.fn().mockResolvedValue({ version: 7 });

    await cache.get('mainnet', 'C123', fetcher);
    await cache.get('mainnet', 'C123', fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cache.stats().hits).toBe(1);
  });

  it('treats expired entries as misses and refetches', async () => {
    const cache = new ContractMetadataCache<{ version: number }>({ ttlMs: 2_000, maxEntries: 10 });
    const fetcher = jest.fn()
      .mockResolvedValueOnce({ version: 1 })
      .mockResolvedValueOnce({ version: 2 });

    await expect(cache.get('mainnet', 'C123', fetcher)).resolves.toEqual({ version: 1 });
    jest.advanceTimersByTime(2_001);
    await expect(cache.get('mainnet', 'C123', fetcher)).resolves.toEqual({ version: 2 });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(cache.stats().misses).toBe(2);
  });

  it('keeps the same contract address isolated by network', async () => {
    const fetcher = jest.fn()
      .mockResolvedValueOnce({ network: 'testnet', version: 1 })
      .mockResolvedValueOnce({ network: 'mainnet', version: 2 });

    await expect(contractMetadataCache.get('testnet', 'C123', fetcher)).resolves.toEqual({ network: 'testnet', version: 1 });
    await expect(contractMetadataCache.get('mainnet', 'C123', fetcher)).resolves.toEqual({ network: 'mainnet', version: 2 });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(buildContractMetadataCacheKey('testnet', 'C123')).not.toBe(buildContractMetadataCacheKey('mainnet', 'C123'));
  });

  it('records refresh failures and exposes cache age', async () => {
    const cache = new ContractMetadataCache<{ version: number }>({ ttlMs: 10_000, maxEntries: 10 });
    const fetcher = jest.fn().mockRejectedValue(new Error('rpc unavailable'));

    await expect(cache.get('mainnet', 'C123', fetcher)).rejects.toThrow('rpc unavailable');

    expect(cache.stats().refreshFailures).toBe(1);
    expect(cache.ageMs('mainnet', 'C123')).toBeUndefined();
    expect(cache.stats().entries).toBe(0);

    invalidateContractMetadataCache('mainnet', 'C123');
    expect(cache.stats().entries).toBe(0);
  });
});
