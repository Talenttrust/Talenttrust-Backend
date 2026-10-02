jest.mock('../database', () => ({
  database: {
    getApiKeyBySelector: jest.fn(),
    loadDatabase: jest.fn(),
    updateApiKey: jest.fn(),
  },
}));

jest.mock('../config/env.schema', () => ({
  validateEnv: () => ({ AUTH_CACHE_TTL_MS: 1000, AUTH_CACHE_MAX_ENTRIES: 10 }),
}));

import { database } from '../database';
import { ApiKey } from '../database/schema';
import { AuthCache } from './authCache';
import {
  computeKeySelector,
  getAuthCache,
  hashApiKey,
  resetAuthCache,
  validateApiKey,
} from './apiKeys';

const databaseMocks = database as unknown as {
  getApiKeyBySelector: jest.Mock;
  loadDatabase: jest.Mock;
  updateApiKey: jest.Mock;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('validateApiKey cache recovery', () => {
  const secret = 'auth-cache-recovery-test-key';
  const selector = computeKeySelector(secret);
  const credential = hashApiKey(secret);
  const storedKey = {
    id: 'key-1',
    name: 'recovery-test',
    scope: ['contracts:read'],
    created_by: 'user-1',
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    key_hash: `${credential.salt}:${credential.hash}`,
    key_selector: selector,
    is_active: true,
  } as ApiKey;

  beforeEach(() => {
    jest.clearAllMocks();
    resetAuthCache();
    databaseMocks.updateApiKey.mockResolvedValue(undefined);
  });

  afterEach(() => {
    resetAuthCache();
  });

  it('does not cache a validation result completed after invalidation', async () => {
    const lookup = deferred<ApiKey | null>();
    databaseMocks.getApiKeyBySelector.mockReturnValueOnce(lookup.promise);

    const validation = validateApiKey(secret);
    const cache: AuthCache = getAuthCache();
    cache.invalidateByUserId('user-1');
    lookup.resolve(storedKey);

    await expect(validation).resolves.toBeNull();
    expect(cache.get(selector)).toBeNull();
  });

  it('surfaces a storage failure without caching it and succeeds on retry', async () => {
    databaseMocks.getApiKeyBySelector
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce(storedKey);

    await expect(validateApiKey(secret)).rejects.toThrow('database unavailable');
    expect(getAuthCache().get(selector)).toBeNull();

    await expect(validateApiKey(secret)).resolves.toMatchObject({ id: 'key-1' });
    expect(databaseMocks.getApiKeyBySelector).toHaveBeenCalledTimes(2);
    expect(getAuthCache().get(selector)).toMatchObject({ id: 'key-1' });
  });
});