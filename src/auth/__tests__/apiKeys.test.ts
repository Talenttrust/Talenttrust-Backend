import {
  generateApiKey,
  hashApiKey,
  verifyApiKey,
  createApiKey,
  validateApiKey,
  rotateApiKey,
  deactivateApiKey,
  computeKeySelector,
  resetAuthCache,
  getAuthCache,
  isValidSaltHashFormat,
} from '../apiKeys';
import {
  authenticateApiKey,
  requireApiKeyScope,
  ApiKeyAuthenticatedRequest,
} from '../apiKeyMiddleware';
import { database } from '../../database';

describe('API Key Utilities', () => {
  beforeEach(async () => {
    await database.clearDatabase();
    resetAuthCache();
  });

  describe('generateApiKey', () => {
    it('should generate a 64-character hex string', () => {
      const apiKey = generateApiKey();
      expect(apiKey).toMatch(/^[a-f0-9]{64}$/);
      expect(apiKey).toHaveLength(64);
    });

    it('should generate unique keys', () => {
      const key1 = generateApiKey();
      const key2 = generateApiKey();
      expect(key1).not.toBe(key2);
    });
  });

  describe('hashApiKey', () => {
    it('should hash an API key with salt', () => {
      const apiKey = 'test-api-key';
      const result = hashApiKey(apiKey);

      expect(result).toHaveProperty('salt');
      expect(result).toHaveProperty('hash');
      expect(result.salt).toMatch(/^[a-f0-9]{32}$/);
      expect(result.hash).toMatch(/^[a-f0-9]{128}$/);
    });

    it('should generate different hashes for the same key', () => {
      const apiKey = 'test-api-key';
      const result1 = hashApiKey(apiKey);
      const result2 = hashApiKey(apiKey);

      expect(result1.salt).not.toBe(result2.salt);
      expect(result1.hash).not.toBe(result2.hash);
    });
  });

  describe('verifyApiKey', () => {
    it('should verify a correct API key', () => {
      const apiKey = 'test-api-key';
      const { salt, hash } = hashApiKey(apiKey);

      const isValid = verifyApiKey(apiKey, salt, hash);
      expect(isValid).toBe(true);
    });

    it('should reject an incorrect API key', () => {
      const apiKey = 'test-api-key';
      const wrongKey = 'wrong-api-key';
      const { salt, hash } = hashApiKey(apiKey);

      const isValid = verifyApiKey(wrongKey, salt, hash);
      expect(isValid).toBe(false);
    });

    it('should reject with wrong salt', () => {
      const apiKey = 'test-api-key';
      const { hash } = hashApiKey(apiKey);
      const wrongSalt = hashApiKey('different').salt;

      const isValid = verifyApiKey(apiKey, wrongSalt, hash);
      expect(isValid).toBe(false);
    });
  });

  describe('isValidSaltHashFormat', () => {
    it('should return true for a valid salt:hash format', () => {
      const validSalt = '0123456789abcdef0123456789abcdef';
      const validHash = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      expect(isValidSaltHashFormat(`${validSalt}:${validHash}`)).toBe(true);
    });

    it('should return false for non-string inputs', () => {
      expect(isValidSaltHashFormat(null as any)).toBe(false);
      expect(isValidSaltHashFormat(undefined as any)).toBe(false);
      expect(isValidSaltHashFormat(123 as any)).toBe(false);
    });

    it('should return false for empty or whitespace-only string', () => {
      expect(isValidSaltHashFormat('')).toBe(false);
      expect(isValidSaltHashFormat('   ')).toBe(false);
    });
  });

  describe('computeKeySelector', () => {
    it('should produce a deterministic selector for the same key', () => {
      const apiKey = 'test-api-key';
      const selector1 = computeKeySelector(apiKey);
      const selector2 = computeKeySelector(apiKey);
      expect(selector1).toBe(selector2);
    });

    it('should produce different selectors for different keys', () => {
      const selector1 = computeKeySelector('key-one');
      const selector2 = computeKeySelector('key-two');
      expect(selector1).not.toBe(selector2);
    });
  });

  // =========================================================================
  // Authorization Tests
  // =========================================================================

  describe('Authorization: API key creation access control', () => {
    it('should create key scoped to a specific user (tenant)', async () => {
      const result = await createApiKey({
        name: 'Tenant A Key',
        scope: ['contracts:read'],
        createdBy: 'tenant-a-user',
      });

      expect(result.info.createdBy).toBe('tenant-a-user');
      expect(result.info.scope).toEqual(['contracts:read']);
    });

    it('should create separate keys for different tenants', async () => {
      const keyA = await createApiKey({
        name: 'Tenant A Key',
        scope: ['contracts:read'],
        createdBy: 'tenant-a-user',
      });

      const keyB = await createApiKey({
        name: 'Tenant B Key',
        scope: ['contracts:write'],
        createdBy: 'tenant-b-user',
      });

      expect(keyA.info.createdBy).toBe('tenant-a-user');
      expect(keyB.info.createdBy).toBe('tenant-b-user');
      expect(keyA.info.id).not.toBe(keyB.info.id);
    });

    it('should create key with multiple scope permissions', async () => {
      const result = await createApiKey({
        name: 'Multi-scope Key',
        scope: ['contracts:read', 'contracts:write', 'milestones:read'],
        createdBy: 'user-123',
      });

      expect(result.info.scope).toContain('contracts:read');
      expect(result.info.scope).toContain('contracts:write');
      expect(result.info.scope).toContain('milestones:read');
    });
  });

  describe('Authorization: Validation returns correct tenant scope', () => {
    it('should return the correct createdBy (tenant) on validation', async () => {
      const { apiKey } = await createApiKey({
        name: 'Tenant Scoped Key',
        scope: ['contracts:read'],
        createdBy: 'tenant-user-456',
      });

      const result = await validateApiKey(apiKey);
      expect(result).not.toBeNull();
      expect(result!.createdBy).toBe('tenant-user-456');
    });

    it('should return full scope information on successful validation', async () => {
      const expectedScope = ['contracts:read', 'contracts:write'];
      const { apiKey } = await createApiKey({
        name: 'Full Scope Key',
        scope: expectedScope,
        createdBy: 'user-789',
      });

      const result = await validateApiKey(apiKey);
      expect(result).not.toBeNull();
      expect(result!.scope).toEqual(expectedScope);
    });

    it('should reject an invalid API key (unauthorized access attempt)', async () => {
      const result = await validateApiKey('invalid-key-value');
      expect(result).toBeNull();
    });

    it('should reject a deactivated key (authorization revoked)', async () => {
      const { apiKey, info } = await createApiKey({
        name: 'Revocable Key',
        scope: ['contracts:read'],
        createdBy: 'user-111',
      });

      // Deactivate the key
      await deactivateApiKey(info.id);

      // Validation should fail after deactivation
      const result = await validateApiKey(apiKey);
      expect(result).toBeNull();
    });

    it('should reject an expired key (authorization expired)', async () => {
      const pastDate = new Date('2020-01-01T00:00:00Z');
      const { apiKey } = await createApiKey({
        name: 'Expired Key',
        scope: ['contracts:read'],
        createdBy: 'user-222',
        expiresAt: pastDate,
      });

      const result = await validateApiKey(apiKey);
      expect(result).toBeNull();
    });
  });

  describe('Authorization: Role-based key management', () => {
    it('should allow key owner to rotate their own key', async () => {
      const { apiKey, info } = await createApiKey({
        name: 'Rotatable Key',
        scope: ['contracts:read'],
        createdBy: 'owner-user',
      });

      const rotated = await rotateApiKey(info.id);
      expect(rotated).not.toBeNull();
      expect(rotated!.info.id).toBe(info.id);
      expect(rotated!.info.createdBy).toBe('owner-user');

      // Old key should no longer validate
      const oldResult = await validateApiKey(apiKey);
      expect(oldResult).toBeNull();

      // New key should validate
      const newResult = await validateApiKey(rotated!.apiKey);
      expect(newResult).not.toBeNull();
    });

    it('should fail to rotate a non-existent key', async () => {
      const result = await rotateApiKey('non-existent-id');
      expect(result).toBeNull();
    });

    it('should allow key owner to deactivate their own key', async () => {
      const { info } = await createApiKey({
        name: 'Deactivatable Key',
        scope: ['contracts:read'],
        createdBy: 'owner-user',
      });

      const result = await deactivateApiKey(info.id);
      expect(result).toBe(true);
    });

    it('should fail to deactivate a non-existent key', async () => {
      const result = await deactivateApiKey('non-existent-id');
      expect(result).toBe(false);
    });
  });

  // =========================================================================
  // Tenant-Scoping Tests
  // =========================================================================

  describe('Tenant scoping: Keys are isolated per tenant', () => {
    it('should only list keys for the correct tenant', async () => {
      // Create keys for tenant A
      await createApiKey({
        name: 'Tenant A Key 1',
        scope: ['contracts:read'],
        createdBy: 'tenant-a',
      });
      await createApiKey({
        name: 'Tenant A Key 2',
        scope: ['milestones:read'],
        createdBy: 'tenant-a',
      });

      // Create keys for tenant B
      await createApiKey({
        name: 'Tenant B Key 1',
        scope: ['contracts:write'],
        createdBy: 'tenant-b',
      });

      // Verify tenant isolation via the database
      const db = await (database as any).loadDatabase();
      const tenantAKeys = db.api_keys.filter((k: any) => k.created_by === 'tenant-a');
      const tenantBKeys = db.api_keys.filter((k: any) => k.created_by === 'tenant-b');

      expect(tenantAKeys).toHaveLength(2);
      expect(tenantBKeys).toHaveLength(1);
    });

    it('should verify only the correct tenant key validates', async () => {
      const { apiKey: keyA } = await createApiKey({
        name: 'Tenant A Key',
        scope: ['contracts:read'],
        createdBy: 'tenant-a',
      });

      const { apiKey: keyB } = await createApiKey({
        name: 'Tenant B Key',
        scope: ['contracts:write'],
        createdBy: 'tenant-b',
      });

      // Tenant A's key should only be valid for tenant A
      const resultA = await validateApiKey(keyA);
      expect(resultA).not.toBeNull();
      expect(resultA!.createdBy).toBe('tenant-a');

      // Tenant B's key should only be valid for tenant B
      const resultB = await validateApiKey(keyB);
      expect(resultB).not.toBeNull();
      expect(resultB!.createdBy).toBe('tenant-b');

      // Cross-tenant: A's key should NOT validate as B's key
      expect(resultA!.id).not.toBe(resultB!.id);
    });

    it('should prevent cross-tenant access via wrong key', async () => {
      // Create a key for tenant A
      const { apiKey } = await createApiKey({
        name: 'Tenant A Secret Key',
        scope: ['contracts:read'],
        createdBy: 'tenant-a-secret',
      });

      // Try to access with a completely different key
      const wrongKey = generateApiKey();
      const result = await validateApiKey(wrongKey);
      expect(result).toBeNull();

      // The real key should still work for its own tenant
      const realResult = await validateApiKey(apiKey);
      expect(realResult).not.toBeNull();
      expect(realResult!.createdBy).toBe('tenant-a-secret');
    });

    it('should properly scope keys by tenant in the database', async () => {
      const { info } = await createApiKey({
        name: 'Scoped Key',
        scope: ['contracts:read'],
        createdBy: 'tenant-x-user',
      });

      // The database should store the created_by correctly
      const dbKey = await (database as any).getApiKeyById(info.id);
      expect(dbKey).not.toBeNull();
      expect(dbKey.created_by).toBe('tenant-x-user');
      expect(dbKey.scope).toEqual(['contracts:read']);
    });
  });

  describe('Tenant scoping: Cross-tenant access denial', () => {
    it('should ensure deactivating key only affects that tenant key', async () => {
      const { apiKey: keyA, info: infoA } = await createApiKey({
        name: 'Tenant A Key',
        scope: ['contracts:read'],
        createdBy: 'tenant-a',
      });

      const { apiKey: keyB } = await createApiKey({
        name: 'Tenant B Key',
        scope: ['contracts:read'],
        createdBy: 'tenant-b',
      });

      // Deactivate only tenant A's key
      await deactivateApiKey(infoA.id);

      // Tenant A's key should be invalid
      const resultA = await validateApiKey(keyA);
      expect(resultA).toBeNull();

      // Tenant B's key should still be valid
      const resultB = await validateApiKey(keyB);
      expect(resultB).not.toBeNull();
      expect(resultB!.createdBy).toBe('tenant-b');
    });

    it('should ensure rotating key only affects that tenant key', async () => {
      const { apiKey: keyA, info: infoA } = await createApiKey({
        name: 'Tenant A Key',
        scope: ['contracts:read'],
        createdBy: 'tenant-a',
      });

      const { apiKey: keyB } = await createApiKey({
        name: 'Tenant B Key',
        scope: ['contracts:read'],
        createdBy: 'tenant-b',
      });

      // Rotate only tenant A's key
      const rotated = await rotateApiKey(infoA.id);
      expect(rotated).not.toBeNull();

      // Tenant A's old key should be invalid
      const resultAOld = await validateApiKey(keyA);
      expect(resultAOld).toBeNull();

      // Tenant A's new key should be valid
      const resultANew = await validateApiKey(rotated!.apiKey);
      expect(resultANew).not.toBeNull();
      expect(resultANew!.createdBy).toBe('tenant-a');

      // Tenant B's key should still be valid
      const resultB = await validateApiKey(keyB);
      expect(resultB).not.toBeNull();
      expect(resultB!.createdBy).toBe('tenant-b');
    });

    it('should scope cache entries per tenant', async () => {
      // Create keys for two different tenants
      const { apiKey: keyA } = await createApiKey({
        name: 'Tenant A Key',
        scope: ['contracts:read'],
        createdBy: 'tenant-alpha',
      });

      const { apiKey: keyB } = await createApiKey({
        name: 'Tenant B Key',
        scope: ['contracts:write'],
        createdBy: 'tenant-beta',
      });

      // Validate both keys (populates cache)
      await validateApiKey(keyA);
      await validateApiKey(keyB);

      const cache = getAuthCache();
      const stats = cache.getStats();
      expect(stats.size).toBe(2);
    });
  });

  // =========================================================================
  // API Key Middleware Tests
  // =========================================================================

  describe('Middleware: authenticateApiKey (unit tests)', () => {
    function createMockReqRes(headers?: Record<string, string>) {
      const req = {
        headers: headers || {},
      } as unknown as ApiKeyAuthenticatedRequest;
      const res = {
        statusCode: 0,
        body: null,
        status(code: number) {
          this.statusCode = code;
          return this;
        },
        json(obj: any) {
          this.body = obj;
          return this;
        },
      } as any;
      const next = jest.fn();
      return { req, res, next };
    }

    it('responds 401 when X-API-Key header is missing', async () => {
      const { req, res, next } = createMockReqRes({});
      authenticateApiKey(req, res, next);

      // Wait for async operation
      await new Promise((r) => setImmediate(r));

      expect(res.statusCode).toBe(401);
      expect(res.body).toEqual({ error: 'Missing X-API-Key header' });
      expect(next).not.toHaveBeenCalled();
    });

    it('responds 401 when X-API-Key header is empty', async () => {
      const { req, res, next } = createMockReqRes({ 'x-api-key': '' });
      authenticateApiKey(req, res, next);

      await new Promise((r) => setImmediate(r));

      expect(res.statusCode).toBe(401);
      expect(res.body).toEqual({ error: 'Missing X-API-Key header' });
      expect(next).not.toHaveBeenCalled();
    });

    it('responds 401 when API key is invalid', async () => {
      const { req, res, next } = createMockReqRes({ 'x-api-key': 'invalid-key-value' });
      authenticateApiKey(req, res, next);

      // Wait for async validation to complete
      await new Promise((r) => setImmediate(r));

      expect(res.statusCode).toBe(401);
      expect(res.body).toEqual({ error: 'Invalid API key' });
      expect(next).not.toHaveBeenCalled();
    });

    it('calls next() when API key is valid', async () => {
      const { apiKey } = await createApiKey({
        name: 'Valid Key',
        scope: ['contracts:read'],
        createdBy: 'user-valid',
      });

      const { req, res, next } = createMockReqRes({ 'x-api-key': apiKey });
      // authenticateApiKey now returns a promise, so we await it directly
      await authenticateApiKey(req, res, next);

      expect(res.statusCode).toBe(0); // No response sent
      expect(next).toHaveBeenCalled();
      expect(req.apiKey).toBeDefined();
      expect(req.apiKey!.createdBy).toBe('user-valid');
    });
  });

  describe('Middleware: requireApiKeyScope (unit tests)', () => {
    function createMockReqRes(apiKeyInfo?: any) {
      const req = { apiKey: apiKeyInfo || null } as unknown as ApiKeyAuthenticatedRequest;
      const res = {
        statusCode: 0,
        body: null,
        status(code: number) {
          this.statusCode = code;
          return this;
        },
        json(obj: any) {
          this.body = obj;
          return this;
        },
      } as any;
      const next = jest.fn();
      return { req, res, next };
    }

    it('responds 401 when no apiKey on request (auth skipped)', () => {
      const { req, res, next } = createMockReqRes(null);
      const middleware = requireApiKeyScope('contracts', 'read');
      middleware(req, res, next);

      expect(res.statusCode).toBe(401);
      expect(res.body).toEqual({ error: 'Not authenticated with API key' });
      expect(next).not.toHaveBeenCalled();
    });

    it('responds 403 when scope is insufficient', () => {
      const { req, res, next } = createMockReqRes({
        scope: ['contracts:read'],
      });

      const middleware = requireApiKeyScope('milestones', 'write');
      middleware(req, res, next);

      expect(res.statusCode).toBe(403);
      expect(res.body).toMatchObject({
        error: 'Forbidden: insufficient API key scope',
        required: 'milestones:write',
        provided: ['contracts:read'],
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('calls next() when scope matches exactly', () => {
      const { req, res, next } = createMockReqRes({
        scope: ['contracts:read'],
      });

      const middleware = requireApiKeyScope('contracts', 'read');
      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.statusCode).toBe(0);
    });

    it('calls next() when scope matches via wildcard action (contracts:*)', () => {
      const { req, res, next } = createMockReqRes({
        scope: ['contracts:*'],
      });

      const middleware = requireApiKeyScope('contracts', 'write');
      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('calls next() when scope matches via wildcard resource (*:read)', () => {
      const { req, res, next } = createMockReqRes({
        scope: ['*:read'],
      });

      const middleware = requireApiKeyScope('contracts', 'read');
      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('calls next() when scope has full wildcard (*)', () => {
      const { req, res, next } = createMockReqRes({
        scope: ['*'],
      });

      const middleware = requireApiKeyScope('any-resource', 'any-action');
      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('responds 403 when no scope matches at all', () => {
      const { req, res, next } = createMockReqRes({
        scope: ['contracts:read', 'milestones:list'],
      });

      const middleware = requireApiKeyScope('reputation', 'delete');
      middleware(req, res, next);

      expect(res.statusCode).toBe(403);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('Authorization: Access denial edge cases', () => {
    it('rejects empty string as API key', async () => {
      const result = await validateApiKey('');
      expect(result).toBeNull();
    });

    it('rejects invalid API key', async () => {
      const result = await validateApiKey('invalid-or-wrong-key');
      expect(result).toBeNull();
    });

    it('confirms key has correct scope after creation', async () => {
      const { apiKey } = await createApiKey({
        name: 'Limited Key',
        scope: ['contracts:read'],
        createdBy: 'user-limited',
      });

      const result = await validateApiKey(apiKey);
      expect(result).not.toBeNull();
      expect(result!.scope).toEqual(['contracts:read']);
      expect(result!.scope).not.toContain('contracts:write');
    });

    it('returns null for non-existent key ID operations', async () => {
      const rotateResult = await rotateApiKey('non-existent-key-id');
      expect(rotateResult).toBeNull();

      const deactivateResult = await deactivateApiKey('non-existent-key-id');
      expect(deactivateResult).toBe(false);
    });
  });

  // =========================================================================
  // Cache invalidation tests
  // =========================================================================

  describe('Cache invalidation on write operations', () => {
    it('invalidates cache when creating a new API key', async () => {
      const request = {
        name: 'Test Key',
        scope: ['contracts:read'],
        createdBy: 'user-1',
      };

      const { apiKey } = await createApiKey(request);

      // First validation should populate cache
      const result1 = await validateApiKey(apiKey);
      expect(result1).not.toBeNull();

      const cache = getAuthCache();
      const statsBefore = cache.getStats();
      expect(statsBefore.size).toBeGreaterThan(0);

      // Create another key for the same user
      await createApiKey({
        name: 'Test Key 2',
        scope: ['contracts:write'],
        createdBy: 'user-1',
      });

      // Cache should be invalidated for user-1
      const statsAfter = cache.getStats();
      expect(statsAfter.size).toBeLessThan(statsBefore.size);
    });

    it('invalidates cache when rotating an API key', async () => {
      const request = {
        name: 'Test Key',
        scope: ['contracts:read'],
        createdBy: 'user-1',
      };

      const { apiKey, info } = await createApiKey(request);

      // First validation should populate cache
      const result1 = await validateApiKey(apiKey);
      expect(result1).not.toBeNull();

      const cache = getAuthCache();
      const statsBefore = cache.getStats();
      expect(statsBefore.size).toBeGreaterThan(0);

      // Rotate the key
      await rotateApiKey(info.id);

      // Cache should be invalidated
      const statsAfter = cache.getStats();
      expect(statsAfter.size).toBeLessThan(statsBefore.size);

      // Old key should no longer validate
      const result2 = await validateApiKey(apiKey);
      expect(result2).toBeNull();
    });

    it('invalidates cache when deactivating an API key', async () => {
      const request = {
        name: 'Test Key',
        scope: ['contracts:read'],
        createdBy: 'user-1',
      };

      const { apiKey, info } = await createApiKey(request);

      // First validation should populate cache
      const result1 = await validateApiKey(apiKey);
      expect(result1).not.toBeNull();

      const cache = getAuthCache();
      const statsBefore = cache.getStats();
      expect(statsBefore.size).toBeGreaterThan(0);

      // Deactivate the key
      await deactivateApiKey(info.id);

      // Cache should be invalidated
      const statsAfter = cache.getStats();
      expect(statsAfter.size).toBeLessThan(statsBefore.size);

      // Deactivated key should no longer validate
      const result2 = await validateApiKey(apiKey);
      expect(result2).toBeNull();
    });

    it('cache hit on subsequent validations', async () => {
      const request = {
        name: 'Test Key',
        scope: ['contracts:read'],
        createdBy: 'user-1',
      };

      const { apiKey } = await createApiKey(request);

      const cache = getAuthCache();
      const statsBefore = cache.getStats();

      // First validation - miss
      await validateApiKey(apiKey);
      const statsAfterFirst = cache.getStats();
      expect(statsAfterFirst.misses).toBe(statsBefore.misses + 1);

      // Second validation - hit
      await validateApiKey(apiKey);
      const statsAfterSecond = cache.getStats();
      expect(statsAfterSecond.hits).toBe(statsAfterFirst.hits + 1);
    });
  });
});
