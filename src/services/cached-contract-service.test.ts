import type { CacheStore } from '../cache/cache-store';
import type { ContractRecord, CreateContractInput } from '../types/contract';
import {
  buildContractDetailKey,
  buildContractsListKey,
  CachedContractService,
} from './cached-contract-service';
import type { ContractServicePort } from './contract-service';

function createContract(id: string): ContractRecord {
  return {
    id,
    title: `Contract ${id}`,
    clientId: 'client-1',
    freelancerId: 'freelancer-1',
    budget: 100,
    currency: 'USDC',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('CachedContractService', () => {
  it('caches contract list reads after the first miss', () => {
    const source: ContractServicePort = {
      listContracts: jest.fn(() => [createContract('ctr-1')]),
      getContractById: jest.fn(),
      createContract: jest.fn(),
    };
    const cache = new Map<string, unknown>();
    const cacheStore: CacheStore = {
      get: <T>(key: string) => cache.get(key) as T | undefined,
      set: (key, value) => void cache.set(key, value),
      delete: (key) => void cache.delete(key),
      clear: () => cache.clear(),
    };

    const service = new CachedContractService(source, cacheStore, {
      enabled: true,
      ttlSeconds: 30,
      maxItems: 10,
    });

    expect(service.listContracts()).toHaveLength(1);
    expect(service.listContracts()).toHaveLength(1);
    expect(source.listContracts).toHaveBeenCalledTimes(1);
    expect(cache.has(buildContractsListKey())).toBe(true);
  });

  it('caches detail lookups after the first miss', () => {
    const source: ContractServicePort = {
      listContracts: jest.fn(),
      getContractById: jest.fn(() => createContract('ctr-2')),
      createContract: jest.fn(),
    };
    const cache = new Map<string, unknown>();
    const cacheStore: CacheStore = {
      get: <T>(key: string) => cache.get(key) as T | undefined,
      set: (key, value) => void cache.set(key, value),
      delete: (key) => void cache.delete(key),
      clear: () => cache.clear(),
    };

    const service = new CachedContractService(source, cacheStore, {
      enabled: true,
      ttlSeconds: 30,
      maxItems: 10,
    });

    expect(service.getContractById('ctr-2')?.id).toBe('ctr-2');
    expect(service.getContractById('ctr-2')?.id).toBe('ctr-2');
    expect(source.getContractById).toHaveBeenCalledTimes(1);
    expect(cache.has(buildContractDetailKey('ctr-2'))).toBe(true);
  });

  it('invalidates list and detail keys after writes', () => {
    const created = createContract('ctr-3');
    const source: ContractServicePort = {
      listContracts: jest.fn(() => [created]),
      getContractById: jest.fn(() => created),
      createContract: jest.fn((_input: CreateContractInput) => created),
    };
    const deletedKeys: string[] = [];
    const cacheStore: CacheStore = {
      get: jest.fn(),
      set: jest.fn(),
      delete: (key) => deletedKeys.push(key),
      clear: jest.fn(),
    };

    const service = new CachedContractService(source, cacheStore, {
      enabled: true,
      ttlSeconds: 30,
      maxItems: 10,
    });

    const result = service.createContract({
      title: 'New',
      clientId: 'client-1',
      freelancerId: 'freelancer-2',
      budget: 100,
      currency: 'USDC',
    });

    expect(result.id).toBe('ctr-3');
    expect(deletedKeys).toEqual([
      buildContractsListKey(),
      buildContractDetailKey('ctr-3'),
    ]);
  });

  it('falls back to source when cache get/set fails', () => {
    const source: ContractServicePort = {
      listContracts: jest.fn(() => [createContract('ctr-4')]),
      getContractById: jest.fn(),
      createContract: jest.fn(),
    };
    const cacheStore: CacheStore = {
      get: () => {
        throw new Error('cache down');
      },
      set: () => {
        throw new Error('cache down');
      },
      delete: jest.fn(),
      clear: jest.fn(),
    };

    const service = new CachedContractService(source, cacheStore, {
      enabled: true,
      ttlSeconds: 30,
      maxItems: 10,
    });

    expect(service.listContracts()).toHaveLength(1);
    expect(source.listContracts).toHaveBeenCalledTimes(1);
  });

  it('bypasses cache entirely when disabled', () => {
    const source: ContractServicePort = {
      listContracts: jest.fn(() => [createContract('ctr-5')]),
      getContractById: jest.fn(),
      createContract: jest.fn(),
    };
    const cacheStore: CacheStore = {
      get: jest.fn(),
      set: jest.fn(),
      delete: jest.fn(),
      clear: jest.fn(),
    };

    const service = new CachedContractService(source, cacheStore, {
      enabled: false,
      ttlSeconds: 30,
      maxItems: 10,
    });

    service.listContracts();
    service.listContracts();

    expect(source.listContracts).toHaveBeenCalledTimes(2);
    expect(cacheStore.get).not.toHaveBeenCalled();
  });

  it('returns undefined detail results without crashing when not found', () => {
    const source: ContractServicePort = {
      listContracts: jest.fn(),
      getContractById: jest.fn(() => undefined),
      createContract: jest.fn(),
    };
    const cacheStore: CacheStore = {
      get: jest.fn(() => undefined),
      set: jest.fn(),
      delete: jest.fn(),
      clear: jest.fn(),
    };

    const service = new CachedContractService(source, cacheStore, {
      enabled: true,
      ttlSeconds: 30,
      maxItems: 10,
    });

    expect(service.getContractById('missing')).toBeUndefined();
  });
});
