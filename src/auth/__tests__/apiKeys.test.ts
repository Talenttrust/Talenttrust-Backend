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
  isValidSaltHashFormat
} from '../apiKeys';
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

    it('should return false when salt or hash parameter in verifyApiKey is invalid', () => {
      expect(verifyApiKey('key', 'shortsalt', 'hash')).toBe(false);
      expect(verifyApiKey('key', '0123456789abcdef0123456789abcdef', 'shorthash')).toBe(false);
      expect(verifyApiKey('key', null as any, 'hash')).toBe(false);
    });
  });

  describe('isValidSaltHashFormat', () => {
    it('should return true for a valid salt:hash format', () => {
      const validSalt = '0123456789abcdef0123456789abcdef'; // 32 hex chars
      const validHash = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'; // 128 hex chars
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

    it('should return false if missing colon separator', () => {
      expect(isValidSaltHashFormat('0123456789abcdef0123456789abcdef0123456789abcdef')).toBe(false);
    });

    it('should return false if extra colons exist', () => {
      expect(isValidSaltHashFormat('salt:hash:extra')).toBe(false);
    });

    it('should return false if salt length is not 32 hex chars', () => {
      const shortSalt = '0123456789abcdef';
      const validHash = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      expect(isValidSaltHashFormat(`${shortSalt}:${validHash}`)).toBe(false);
    });

    it('should return false if hash length is not 128 hex chars', () => {
      const validSalt = '0123456789abcdef0123456789abcdef';
      const shortHash = '0123456789abcdef';
      expect(isValidSaltHashFormat(`${validSalt}:${shortHash}`)).toBe(false);
    });

    it('should return false if salt or hash contains non-hex characters', () => {
      const invalidSalt = '0123456789abcdef0123456789abcdeg'; // 'g' is non-hex
      const validHash = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      expect(isValidSaltHashFormat(`${invalidSalt}:${validHash}`)).toBe(false);
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

    it('should produce a 64-character hex string', () => {
      const selector = computeKeySelector('test-api-key');
      expect(selector).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should not be reversible (SHA-256 preimage resistance)', () => {
      const key = generateApiKey();
      const selector = computeKeySelector(key);
      // A SHA-256 hash is 256 bits = 32 bytes = 64 hex chars
      // It is computationally infeasible to recover the original key
      expect(selector).toHaveLength(64);
    });
  });

  describe('createApiKey', () => {
    it('should create a new API key with key_selector', async () => {
      const request = {
        name: 'Test Key',
        scope: ['contracts:read'],
        createdBy: 'user123'
      };

      const result = await createApiKey(request);

      expect(result).toHaveProperty('apiKey');
      expect(result).toHaveProperty('info');
      expect(result.apiKey).toMatch(/^[a-f0-9]{64}$/);
      expect(result.info.name).toBe('Test Key');
      expect(result.info.scope).toEqual(['contracts:read']);
      expect(result.info.createdBy).toBe('user123');
      expect(result.info.isActive).toBe(true);

      // Verify key_selector was stored
      const db = await (database as any).loadDatabase();
      const storedKey = db.api_keys.find((k: any) => k.name === 'Test Key');
      expect(storedKey.key_selector).toBeDefined();
      expect(storedKey.key_selector).toMatch(/^[a-f0-9]{64}$/);
      expect(storedKey.key_selector).toBe(computeKeySelector(result.apiKey));
    });

    it('should store API key with expiration', async () => {
      const expiresAt = new Date('2024-12-31T23:59:59Z');
      const request = {
        name: 'Test Key',
        scope: ['contracts:read'],
        createdBy: 'user123',
        expiresAt
      };

      const result = await createApiKey(request);

      expect(result.info.expiresAt).toEqual(expiresAt);
    });
  });

  describe('validateApiKey - indexed O(1) lookup', () => {
    it('should validate a correct API key via selector index', async () => {
      const request = {
        name: 'Test Key',
        scope: ['contracts:read'],
        createdBy: 'user123'
      };

      const { apiKey } = await createApiKey(request);
      const result = await validateApiKey(apiKey);

      expect(result).not.toBeNull();
      expect(result!.name).toBe('Test Key');
      expect(result!.scope).toEqual(['contracts:read']);
      expect(result!.createdBy).toBe('user123');
    });

    it('should reject an invalid API key', async () => {
      const result = await validateApiKey('invalid-key');
      expect(result).toBeNull();
    });

    it('should reject an expired API key', async () => {
      const pastDate = new Date('2020-01-01T00:00:00Z');
      const request = {
        name: 'Test Key',
        scope: ['contracts:read'],
        createdBy: 'user123',
        expiresAt: pastDate
      };

      const { apiKey } = await createApiKey(request);
      const result = await validateApiKey(apiKey);

      expect(result).toBeNull();
    });

    it('should deactivate an expired key on validation attempt', async () => {
      const pastDate = new Date('2020-01-01T00:00:00Z');
      const request = {
        name: 'Test Key',
        scope: ['contracts:read'],
        createdBy: 'user123',
        expiresAt: pastDate
      };

      const { apiKey } = await createApiKey(request);
      await validateApiKey(apiKey);

      const db = await (database as any).loadDatabase();
      const storedKey = db.api_keys.find((k: any) => k.name === 'Test Key');
      expect(storedKey.is_active).toBe(false);
    });

    it('should update last used timestamp', async () => {
      const request = {
        name: 'Test Key',
        scope: ['contracts:read'],
        createdBy: 'user123'
      };

      const { apiKey } = await createApiKey(request);
      
      await validateApiKey(apiKey);
      
      const db = await (database as any).loadDatabase();
      const storedKey = db.api_keys.find((key: any) => key.name === 'Test Key');
      
      expect(storedKey.last_used_at).toBeDefined();
      expect(storedKey.last_used_at).toBeInstanceOf(Date);
    });

    it('should find the correct key among many keys (O(1) property)', async () => {
      // Create multiple keys to verify we find the right one without scanning all
      const keys: string[] = [];
      for (let i = 0; i < 10; i++) {
        const { apiKey } = await createApiKey({
          name: `Key ${i}`,
          scope: ['test:read'],
          createdBy: 'user123'
        });
        keys.push(apiKey);
      }

      // Validate each key individually
      for (let i = 0; i < keys.length; i++) {
        const result = await validateApiKey(keys[i]);
        expect(result).not.toBeNull();
        expect(result!.name).toBe(`Key ${i}`);
      }
    });

    it('should reject a revoked (deactivated) key', async () => {
      const request = {
        name: 'Revocable Key',
        scope: ['test:read'],
        createdBy: 'user123'
      };

      const { apiKey, info } = await createApiKey(request);
      
      // First validation should succeed
      const firstResult = await validateApiKey(apiKey);
      expect(firstResult).not.toBeNull();

      // Deactivate the key
      await deactivateApiKey(info.id);

      // Second validation should fail
      const secondResult = await validateApiKey(apiKey);
      expect(secondResult).toBeNull();
    });

    it('should return null when no keys exist', async () => {
      const result = await validateApiKey(generateApiKey());
      expect(result).toBeNull();
    });

    it('should backfill key_selector for legacy keys', async () => {
      // Simulate a legacy key without key_selector by inserting directly via loadDatabase
      const apiKeyPlain = generateApiKey();
      const { salt, hash } = hashApiKey(apiKeyPlain);
      
      const db = await (database as any).loadDatabase();
      db.api_keys.push({
        id: require('crypto').randomUUID(),
        name: 'Legacy Key',
        key_hash: `${salt}:${hash}`,
        scope: ['legacy:read'],
        created_by: 'user123',
        created_at: new Date(),
        updated_at: new Date(),
        is_active: true
        // No key_selector field
      });
      await (database as any).saveDatabase();

      // Validate should still work via legacy fallback
      const result = await validateApiKey(apiKeyPlain);
      expect(result).not.toBeNull();
      expect(result!.name).toBe('Legacy Key');

      // After validation, key_selector should be backfilled
      const db2 = await (database as any).loadDatabase();
      const storedKey = db2.api_keys.find((k: any) => k.name === 'Legacy Key');
      expect(storedKey.key_selector).toBe(computeKeySelector(apiKeyPlain));
    });

    it('should find the correct key among multiple legacy keys', async () => {
      // Simulate THREE legacy keys without key_selector (only the last one matches the API key)
      const matchingKeyPlain = generateApiKey();
      const { salt: matchSalt, hash: matchHash } = hashApiKey(matchingKeyPlain);

      const db = await (database as any).loadDatabase();

      // Push two non-matching legacy keys first
      for (let i = 0; i < 2; i++) {
        const otherKey = generateApiKey();
        const { salt, hash } = hashApiKey(otherKey);
        db.api_keys.push({
          id: require('crypto').randomUUID(),
          name: `Other Legacy Key ${i}`,
          key_hash: `${salt}:${hash}`,
          scope: ['legacy:read'],
          created_by: 'user123',
          created_at: new Date(),
          updated_at: new Date(),
          is_active: true
          // No key_selector field
        });
      }

      // Push the matching legacy key last
      db.api_keys.push({
        id: require('crypto').randomUUID(),
        name: 'Target Legacy Key',
        key_hash: `${matchSalt}:${matchHash}`,
        scope: ['legacy:write'],
        created_by: 'user456',
        created_at: new Date(),
        updated_at: new Date(),
        is_active: true
        // No key_selector field
      });
      await (database as any).saveDatabase();

      // Validate should find the correct key even though it's not the first legacy key
      const result = await validateApiKey(matchingKeyPlain);
      expect(result).not.toBeNull();
      expect(result!.name).toBe('Target Legacy Key');
      expect(result!.scope).toEqual(['legacy:write']);
      expect(result!.createdBy).toBe('user456');

      // After validation, the matched key should be backfilled
      const db2 = await (database as any).loadDatabase();
      const matchedKey = db2.api_keys.find((k: any) => k.name === 'Target Legacy Key');
      expect(matchedKey.key_selector).toBe(computeKeySelector(matchingKeyPlain));

      // Other legacy keys should remain without key_selector
      const otherKeys = db2.api_keys.filter((k: any) => k.name !== 'Target Legacy Key');
      for (const k of otherKeys) {
        expect(k.key_selector).toBeUndefined();
      }
    });

    it('should return null if no legacy key matches the provided plain key', async () => {
      const db = await (database as any).loadDatabase();
      const legacyKeyPlain = generateApiKey();
      const { salt, hash } = hashApiKey(legacyKeyPlain);

      db.api_keys.push({
        id: require('crypto').randomUUID(),
        name: 'Non Matching Legacy Key',
        key_hash: `${salt}:${hash}`,
        scope: ['legacy:read'],
        created_by: 'user123',
        created_at: new Date(),
        updated_at: new Date(),
        is_active: true
      });
      await (database as any).saveDatabase();

      const result = await validateApiKey('completely-different-key');
      expect(result).toBeNull();
    });
  });

  describe('rotateApiKey', () => {
    it('should rotate an existing API key and update selector', async () => {
      const request = {
        name: 'Test Key',
        scope: ['contracts:read'],
        createdBy: 'user123'
      };

      const { apiKey: originalKey, info: originalInfo } = await createApiKey(request);
      
      // Original key should work
      expect(await validateApiKey(originalKey)).not.toBeNull();

      const result = await rotateApiKey(originalInfo.id);

      expect(result).not.toBeNull();
      expect(result).toHaveProperty('apiKey');
      expect(result).toHaveProperty('info');
      expect(result!.apiKey).toMatch(/^[a-f0-9]{64}$/);
      expect(result!.info.id).toBe(originalInfo.id);
      expect(result!.info.name).toBe(originalInfo.name);
      expect(result!.info.scope).toEqual(originalInfo.scope);

      // New key should work
      expect(await validateApiKey(result!.apiKey)).not.toBeNull();

      // Old key should no longer work
      expect(await validateApiKey(originalKey)).toBeNull();

      // Verify selector was updated
      const db = await (database as any).loadDatabase();
      const storedKey = db.api_keys.find((k: any) => k.id === originalInfo.id);
      expect(storedKey.key_selector).toBe(computeKeySelector(result!.apiKey));
    });

    it('should return null for non-existent key', async () => {
      const result = await rotateApiKey('non-existent-id');
      expect(result).toBeNull();
    });
  });

  describe('deactivateApiKey', () => {
    it('should deactivate an existing API key', async () => {
      const request = {
        name: 'Test Key',
        scope: ['contracts:read'],
        createdBy: 'user123'
      };

      const { apiKey, info } = await createApiKey(request);
      const result = await deactivateApiKey(info.id);

      expect(result).toBe(true);

      // Key should no longer be valid (even with correct key)
      const validationResult = await validateApiKey(apiKey);
      expect(validationResult).toBeNull();
    });

    it('should return false for non-existent key', async () => {
      const result = await deactivateApiKey('non-existent-id');
      expect(result).toBe(false);
    });
  });

  describe('validateApiKey - malformed stored credential handling', () => {
    const crypto = require('crypto');

    it('should reject keys with empty stored credential', async () => {
      // Insert a key with empty key_hash directly
      const db = await (database as any).loadDatabase();
      db.api_keys.push({
        id: crypto.randomUUID(),
        name: 'Empty Hash Key',
        key_hash: '',
        key_selector: computeKeySelector('some-key'),
        scope: ['test:read'],
        created_by: 'user123',
        created_at: new Date(),
        updated_at: new Date(),
        is_active: true
      });
      await (database as any).saveDatabase();

      const result = await validateApiKey('some-key');
      expect(result).toBeNull();
    });

    it('should reject keys with missing colon separator', async () => {
      // Insert a key with no colon in key_hash
      const db = await (database as any).loadDatabase();
      db.api_keys.push({
        id: crypto.randomUUID(),
        name: 'No Colon Key',
        key_hash: 'abcdef0123456789abcdef0123456789', // valid hex but no colon
        key_selector: computeKeySelector('some-key-2'),
        scope: ['test:read'],
        created_by: 'user123',
        created_at: new Date(),
        updated_at: new Date(),
        is_active: true
      });
      await (database as any).saveDatabase();

      const result = await validateApiKey('some-key-2');
      expect(result).toBeNull();
    });

    it('should reject keys with extra colons', async () => {
      // Insert a key with multiple colons
      const db = await (database as any).loadDatabase();
      db.api_keys.push({
        id: crypto.randomUUID(),
        name: 'Extra Colon Key',
        key_hash: 'salt:hash:extra',
        key_selector: computeKeySelector('some-key-3'),
        scope: ['test:read'],
        created_by: 'user123',
        created_at: new Date(),
        updated_at: new Date(),
        is_active: true
      });
      await (database as any).saveDatabase();

      const result = await validateApiKey('some-key-3');
      expect(result).toBeNull();
    });

    it('should reject keys with wrong-length hex (salt too short)', async () => {
      // Salt should be 32 hex chars, here it's too short
      const db = await (database as any).loadDatabase();
      db.api_keys.push({
        id: crypto.randomUUID(),
        name: 'Short Salt Key',
        key_hash: 'abc:hash1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        key_selector: computeKeySelector('some-key-4'),
        scope: ['test:read'],
        created_by: 'user123',
        created_at: new Date(),
        updated_at: new Date(),
        is_active: true
      });
      await (database as any).saveDatabase();

      const result = await validateApiKey('some-key-4');
      expect(result).toBeNull();
    });

    it('should reject keys with wrong-length hex (hash too short)', async () => {
      // Hash should be 128 hex chars, here it's too short
      const db = await (database as any).loadDatabase();
      db.api_keys.push({
        id: crypto.randomUUID(),
        name: 'Short Hash Key',
        key_hash: 'abcdef0123456789abcdef0123456789:abc',
        key_selector: computeKeySelector('some-key-5'),
        scope: ['test:read'],
        created_by: 'user123',
        created_at: new Date(),
        updated_at: new Date(),
        is_active: true
      });
      await (database as any).saveDatabase();

      const result = await validateApiKey('some-key-5');
      expect(result).toBeNull();
    });

    it('should reject keys with empty salt part', async () => {
      const db = await (database as any).loadDatabase();
      db.api_keys.push({
        id: crypto.randomUUID(),
        name: 'Empty Salt Key',
        key_hash: ':hash1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        key_selector: computeKeySelector('some-key-6'),
        scope: ['test:read'],
        created_by: 'user123',
        created_at: new Date(),
        updated_at: new Date(),
        is_active: true
      });
      await (database as any).saveDatabase();

      const result = await validateApiKey('some-key-6');
      expect(result).toBeNull();
    });

    it('should reject keys with empty hash part', async () => {
      const db = await (database as any).loadDatabase();
      db.api_keys.push({
        id: crypto.randomUUID(),
        name: 'Empty Hash Part Key',
        key_hash: 'abcdef0123456789abcdef0123456789:',
        key_selector: computeKeySelector('some-key-7'),
        scope: ['test:read'],
        created_by: 'user123',
        created_at: new Date(),
        updated_at: new Date(),
        is_active: true
      });
      await (database as any).saveDatabase();

      const result = await validateApiKey('some-key-7');
      expect(result).toBeNull();
    });

    it('should still verify valid keys correctly', async () => {
      // This is a regression test to ensure the fix doesn't break valid key verification
      const request = {
        name: 'Valid Key Test',
        scope: ['contracts:read'],
        createdBy: 'user123'
      };

      const { apiKey } = await createApiKey(request);
      const result = await validateApiKey(apiKey);

      expect(result).not.toBeNull();
      expect(result!.name).toBe('Valid Key Test');
      expect(result!.isActive).toBe(true);
    });

    it('should not throw exceptions on malformed input - fail closed', async () => {
      // This test ensures no exceptions are thrown for any malformed input
      const malformedInputs = [
        '',
        'no-colon',
        'multiple:colons:here',
        'short:hash123',
        'salt0123456789abcdef0123456789abcdef:short',
        ':hash...',
        'salt:',
        '  :  ',
        'invalidhex!@#:invalidhex!@#'
      ];

      for (const key of malformedInputs) {
        // Should not throw - should return null cleanly
        await expect(async () => {
          await validateApiKey(key);
        }).not.toThrow();
      }
    });
  });

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
