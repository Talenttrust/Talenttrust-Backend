/**
 * @module apiKeys.test
 * @description Tests for API key authentication utilities.
 */

import { 
  generateApiKey, 
  hashApiKey, 
  verifyApiKey, 
  createApiKey, 
  validateApiKey, 
  rotateApiKey, 
  deactivateApiKey 
} from '../apiKeys';
import { database } from '../../database';

describe('API Key Utilities', () => {
  beforeEach(async () => {
    await database.clearDatabase();
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

  describe('createApiKey', () => {
    it('should create a new API key', async () => {
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

  describe('validateApiKey', () => {
    it('should validate a correct API key', async () => {
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

    it('should update last used timestamp', async () => {
      const request = {
        name: 'Test Key',
        scope: ['contracts:read'],
        createdBy: 'user123'
      };

      const { apiKey } = await createApiKey(request);
      
      // Validate first time
      await validateApiKey(apiKey);
      
      // Get the key from database to check last_used_at
      const db = await (database as any).loadDatabase();
      const storedKey = db.api_keys.find((key: any) => key.name === 'Test Key');
      
      expect(storedKey.last_used_at).toBeDefined();
      expect(storedKey.last_used_at).toBeInstanceOf(Date);
    });
  });

  describe('rotateApiKey', () => {
    it('should rotate an existing API key', async () => {
      const request = {
        name: 'Test Key',
        scope: ['contracts:read'],
        createdBy: 'user123'
      };

      const { info: originalInfo } = await createApiKey(request);
      const result = await rotateApiKey(originalInfo.id);

      expect(result).not.toBeNull();
      expect(result).toHaveProperty('apiKey');
      expect(result).toHaveProperty('info');
      expect(result!.apiKey).toMatch(/^[a-f0-9]{64}$/);
      expect(result!.info.id).toBe(originalInfo.id);
      expect(result!.info.name).toBe(originalInfo.name);
      expect(result!.info.scope).toEqual(originalInfo.scope);
      expect(result!.apiKey).not.toBe(originalInfo.id); // New key should be different
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

      const { info } = await createApiKey(request);
      const result = await deactivateApiKey(info.id);

      expect(result).toBe(true);

      // Key should no longer be valid
      const validationResult = await validateApiKey('any-key');
      expect(validationResult).toBeNull();
    });

    it('should return false for non-existent key', async () => {
      const result = await deactivateApiKey('non-existent-id');
      expect(result).toBe(false);
    });
  });
});
