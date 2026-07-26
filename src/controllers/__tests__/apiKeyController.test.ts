/**
 * @module apiKeyController.test
 * @description Integration tests for API key controller endpoints.
 */

import request from 'supertest';
import { createApp } from '../../app';
import { createToken } from '../../auth/authenticate';
import { database } from '../../database';
import { validateApiKeyRequestBody } from '../apiKeyController';

describe('API Key Controller', () => {
  let app: any;
  let userToken: string;

  beforeEach(async () => {
    await database.clearDatabase();
    app = createApp();
    userToken = createToken('test-user', 'admin');
  });

  describe('POST /api/v1/api-keys', () => {
    it('should create a new API key', async () => {
      const response = await request(app)
        .post('/api/v1/api-keys')
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          name: 'Test API Key',
          scope: ['contracts:read', 'contracts:create']
        });

      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('message');
      expect(response.body).toHaveProperty('apiKey');
      expect(response.body).toHaveProperty('info');
      expect(response.body.apiKey).toMatch(/^[a-f0-9]{64}$/);
      expect(response.body.info.name).toBe('Test API Key');
      expect(response.body.info.scope).toEqual(['contracts:read', 'contracts:create']);
    });

    it('should validate request body', async () => {
      const response = await request(app)
        .post('/api/v1/api-keys')
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          name: '',
          scope: []
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid request body');
    });

    it('should require authentication', async () => {
      const response = await request(app)
        .post('/api/v1/api-keys')
        .send({
          name: 'Test API Key',
          scope: ['contracts:read']
        });

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/v1/api-keys', () => {
    beforeEach(async () => {
      // Create a test API key
      const { createApiKey } = require('../../auth/apiKeys');
      await createApiKey({
        name: 'Test Key',
        scope: ['contracts:read'],
        createdBy: 'test-user'
      });
    });

    it('should list user API keys', async () => {
      const response = await request(app)
        .get('/api/v1/api-keys')
        .set('Authorization', `Bearer ${userToken}`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('apiKeys');
      expect(response.body).toHaveProperty('total');
      expect(response.body.apiKeys).toHaveLength(1);
      expect(response.body.apiKeys[0].name).toBe('Test Key');
      expect(response.body.apiKeys[0]).not.toHaveProperty('key_hash'); // Sensitive data removed
    });

    it('should require authentication', async () => {
      const response = await request(app)
        .get('/api/v1/api-keys');

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/v1/api-keys/:id', () => {
    let keyId: string;

    beforeEach(async () => {
      const { createApiKey } = require('../../auth/apiKeys');
      const result = await createApiKey({
        name: 'Test Key',
        scope: ['contracts:read'],
        createdBy: 'test-user'
      });
      keyId = result.info.id;
    });

    it('should get API key details', async () => {
      const response = await request(app)
        .get(`/api/v1/api-keys/${keyId}`)
        .set('Authorization', `Bearer ${userToken}`);

      expect(response.status).toBe(200);
      expect(response.body.name).toBe('Test Key');
      expect(response.body.scope).toEqual(['contracts:read']);
      expect(response.body).not.toHaveProperty('key_hash'); // Sensitive data removed
    });

    it('should return 404 for non-existent key', async () => {
      const response = await request(app)
        .get('/api/v1/api-keys/non-existent')
        .set('Authorization', `Bearer ${userToken}`);

      expect(response.status).toBe(404);
    });

    it('should require authentication', async () => {
      const response = await request(app)
        .get(`/api/v1/api-keys/${keyId}`);

      expect(response.status).toBe(401);
    });
  });

  describe('POST /api/v1/api-keys/:id/rotate', () => {
    let keyId: string;

    beforeEach(async () => {
      const { createApiKey } = require('../../auth/apiKeys');
      const result = await createApiKey({
        name: 'Test Key',
        scope: ['contracts:read'],
        createdBy: 'test-user'
      });
      keyId = result.info.id;
    });

    it('should rotate API key', async () => {
      const response = await request(app)
        .post(`/api/v1/api-keys/${keyId}/rotate`)
        .set('Authorization', `Bearer ${userToken}`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('message');
      expect(response.body).toHaveProperty('apiKey');
      expect(response.body).toHaveProperty('info');
      expect(response.body.apiKey).toMatch(/^[a-f0-9]{64}$/);
      expect(response.body.apiKey).not.toBe(keyId); // New key should be different
    });

    it('should return 404 for non-existent key', async () => {
      const response = await request(app)
        .post('/api/v1/api-keys/non-existent/rotate')
        .set('Authorization', `Bearer ${userToken}`);

      expect(response.status).toBe(404);
    });

    it('should require authentication', async () => {
      const response = await request(app)
        .post(`/api/v1/api-keys/${keyId}/rotate`);

      expect(response.status).toBe(401);
    });
  });

  describe('DELETE /api/v1/api-keys/:id', () => {
    let keyId: string;

    beforeEach(async () => {
      const { createApiKey } = require('../../auth/apiKeys');
      const result = await createApiKey({
        name: 'Test Key',
        scope: ['contracts:read'],
        createdBy: 'test-user'
      });
      keyId = result.info.id;
    });

    it('should deactivate API key', async () => {
      const response = await request(app)
        .delete(`/api/v1/api-keys/${keyId}`)
        .set('Authorization', `Bearer ${userToken}`);

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('API key deactivated successfully');
    });

    it('should return 404 for non-existent key', async () => {
      const response = await request(app)
        .delete('/api/v1/api-keys/non-existent')
        .set('Authorization', `Bearer ${userToken}`);

      expect(response.status).toBe(404);
    });

    it('should require authentication', async () => {
      const response = await request(app)
        .delete(`/api/v1/api-keys/${keyId}`);

      expect(response.status).toBe(401);
    });
  });
});

// ─── Unit tests: validateApiKeyRequestBody ────────────────────────────────────
//
// These tests exercise the pure validation function directly so every branch
// is covered without spinning up the HTTP stack.

describe('validateApiKeyRequestBody', () => {
  // ── valid inputs ───────────────────────────────────────────────────────────

  it('returns null for a minimal valid body', () => {
    expect(validateApiKeyRequestBody({ name: 'My Key', scope: ['contracts:read'] })).toBeNull();
  });

  it('returns null when expiresAt is a valid ISO-8601 string', () => {
    expect(
      validateApiKeyRequestBody({
        name: 'Key',
        scope: ['contracts:read'],
        expiresAt: '2030-01-01T00:00:00.000Z',
      }),
    ).toBeNull();
  });

  it('returns null for all supported scope wildcard formats', () => {
    expect(validateApiKeyRequestBody({ name: 'K', scope: ['*'] })).toBeNull();
    expect(validateApiKeyRequestBody({ name: 'K', scope: ['contracts:*'] })).toBeNull();
    expect(validateApiKeyRequestBody({ name: 'K', scope: ['*:read'] })).toBeNull();
    expect(validateApiKeyRequestBody({ name: 'K', scope: ['contracts:read', 'users:write'] })).toBeNull();
  });

  it('returns null for a name exactly at the 100-character limit', () => {
    expect(validateApiKeyRequestBody({ name: 'a'.repeat(100), scope: ['contracts:read'] })).toBeNull();
  });

  it('returns null for a scope array with exactly 20 items', () => {
    const scope = Array.from({ length: 20 }, (_, i) => `resource${i}:read`);
    expect(validateApiKeyRequestBody({ name: 'Key', scope })).toBeNull();
  });

  // ── non-object bodies ──────────────────────────────────────────────────────

  it('returns MISSING_FIELDS for a null body', () => {
    const err = validateApiKeyRequestBody(null);
    expect(err).not.toBeNull();
    expect(err!['code']).toBe('MISSING_FIELDS');
  });

  it('returns MISSING_FIELDS for an array body', () => {
    const err = validateApiKeyRequestBody([{ name: 'k', scope: ['x:y'] }]);
    expect(err).not.toBeNull();
    expect(err!['code']).toBe('MISSING_FIELDS');
  });

  it('returns MISSING_FIELDS for a primitive body', () => {
    const err = validateApiKeyRequestBody('just a string');
    expect(err).not.toBeNull();
    expect(err!['code']).toBe('MISSING_FIELDS');
  });

  // ── unknown fields ─────────────────────────────────────────────────────────

  it('returns UNKNOWN_FIELDS when body contains an extra field', () => {
    const err = validateApiKeyRequestBody({ name: 'Key', scope: ['x:y'], isAdmin: true });
    expect(err).not.toBeNull();
    expect(err!['code']).toBe('UNKNOWN_FIELDS');
    expect((err!['unknownFields'] as string[])).toContain('isAdmin');
  });

  it('returns UNKNOWN_FIELDS for multiple unknown fields', () => {
    const err = validateApiKeyRequestBody({ name: 'Key', scope: ['x:y'], foo: 1, bar: 2 });
    expect(err!['code']).toBe('UNKNOWN_FIELDS');
    expect((err!['unknownFields'] as string[]).sort()).toEqual(['bar', 'foo']);
  });

  // ── name field ─────────────────────────────────────────────────────────────

  it('returns MISSING_FIELDS when name is absent', () => {
    const err = validateApiKeyRequestBody({ scope: ['contracts:read'] });
    expect(err!['code']).toBe('MISSING_FIELDS');
  });

  it('returns MISSING_FIELDS when name is an empty string', () => {
    const err = validateApiKeyRequestBody({ name: '', scope: ['contracts:read'] });
    expect(err!['code']).toBe('MISSING_FIELDS');
  });

  it('returns MISSING_FIELDS when name is whitespace-only', () => {
    const err = validateApiKeyRequestBody({ name: '   ', scope: ['contracts:read'] });
    expect(err!['code']).toBe('MISSING_FIELDS');
  });

  it('returns MISSING_FIELDS when name is a number', () => {
    const err = validateApiKeyRequestBody({ name: 42, scope: ['contracts:read'] });
    expect(err!['code']).toBe('MISSING_FIELDS');
  });

  it('returns MISSING_FIELDS when name is null', () => {
    const err = validateApiKeyRequestBody({ name: null, scope: ['contracts:read'] });
    expect(err!['code']).toBe('MISSING_FIELDS');
  });

  it('returns OUT_OF_RANGE when name exceeds 100 characters', () => {
    const err = validateApiKeyRequestBody({ name: 'a'.repeat(101), scope: ['contracts:read'] });
    expect(err!['code']).toBe('OUT_OF_RANGE');
    expect(err!['maxLength']).toBe(100);
    expect(err!['received']).toBe(101);
  });

  // ── scope field ────────────────────────────────────────────────────────────

  it('returns MISSING_FIELDS when scope is absent', () => {
    const err = validateApiKeyRequestBody({ name: 'Key' });
    expect(err!['code']).toBe('MISSING_FIELDS');
  });

  it('returns MISSING_FIELDS when scope is an empty array', () => {
    const err = validateApiKeyRequestBody({ name: 'Key', scope: [] });
    expect(err!['code']).toBe('MISSING_FIELDS');
  });

  it('returns MISSING_FIELDS when scope is not an array', () => {
    const err = validateApiKeyRequestBody({ name: 'Key', scope: 'contracts:read' });
    expect(err!['code']).toBe('MISSING_FIELDS');
  });

  it('returns MISSING_FIELDS when scope contains a non-string item', () => {
    const err = validateApiKeyRequestBody({ name: 'Key', scope: ['contracts:read', 42] });
    expect(err!['code']).toBe('MISSING_FIELDS');
  });

  it('returns MISSING_FIELDS when scope is null', () => {
    const err = validateApiKeyRequestBody({ name: 'Key', scope: null });
    expect(err!['code']).toBe('MISSING_FIELDS');
  });

  it('returns OUT_OF_RANGE when scope has more than 20 items', () => {
    const scope = Array.from({ length: 21 }, (_, i) => `resource${i}:read`);
    const err = validateApiKeyRequestBody({ name: 'Key', scope });
    expect(err!['code']).toBe('OUT_OF_RANGE');
    expect(err!['maxItems']).toBe(20);
    expect(err!['received']).toBe(21);
  });

  it('returns OUT_OF_RANGE when a scope item exceeds 64 characters', () => {
    const longItem = 'a'.repeat(65);
    const err = validateApiKeyRequestBody({ name: 'Key', scope: [longItem] });
    expect(err!['code']).toBe('OUT_OF_RANGE');
    expect((err!['oversizedItems'] as string[])).toContain(longItem);
  });

  it('returns INVALID_SCOPE for a scope item with wrong format', () => {
    const err = validateApiKeyRequestBody({ name: 'Key', scope: ['BAD_FORMAT'] });
    expect(err!['code']).toBe('INVALID_SCOPE');
    expect((err!['invalidScopes'] as string[])).toContain('BAD_FORMAT');
  });

  it('returns INVALID_SCOPE for a scope item with uppercase characters', () => {
    const err = validateApiKeyRequestBody({ name: 'Key', scope: ['Contracts:Read'] });
    expect(err!['code']).toBe('INVALID_SCOPE');
  });

  it('returns INVALID_SCOPE for a scope item with extra colons', () => {
    const err = validateApiKeyRequestBody({ name: 'Key', scope: ['a:b:c'] });
    expect(err!['code']).toBe('INVALID_SCOPE');
  });

  it('returns INVALID_SCOPE for an empty-resource scope', () => {
    const err = validateApiKeyRequestBody({ name: 'Key', scope: [':read'] });
    expect(err!['code']).toBe('INVALID_SCOPE');
  });

  it('returns INVALID_SCOPE for an empty-action scope', () => {
    const err = validateApiKeyRequestBody({ name: 'Key', scope: ['contracts:'] });
    expect(err!['code']).toBe('INVALID_SCOPE');
  });

  // ── expiresAt field ────────────────────────────────────────────────────────

  it('returns INVALID_DATE when expiresAt is a number', () => {
    const err = validateApiKeyRequestBody({ name: 'Key', scope: ['contracts:read'], expiresAt: 12345 });
    expect(err!['code']).toBe('INVALID_DATE');
  });

  it('returns INVALID_DATE when expiresAt is a non-date string', () => {
    const err = validateApiKeyRequestBody({ name: 'Key', scope: ['contracts:read'], expiresAt: 'not-a-date' });
    expect(err!['code']).toBe('INVALID_DATE');
  });

  it('returns INVALID_DATE when expiresAt is an empty string', () => {
    const err = validateApiKeyRequestBody({ name: 'Key', scope: ['contracts:read'], expiresAt: '' });
    expect(err!['code']).toBe('INVALID_DATE');
  });
});

// ─── Integration: input validation via HTTP ───────────────────────────────────

describe('POST /api/v1/api-keys – input validation (HTTP)', () => {
  let app: any;
  let userToken: string;

  beforeEach(async () => {
    await database.clearDatabase();
    app = createApp();
    userToken = createToken('test-user', 'admin');
  });

  const post = (body: unknown) =>
    request(app)
      .post('/api/v1/api-keys')
      .set('Authorization', `Bearer ${userToken}`)
      .send(body as object);

  it('returns 400 with code UNKNOWN_FIELDS for an unknown field', async () => {
    const res = await post({ name: 'K', scope: ['x:y'], isAdmin: true });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNKNOWN_FIELDS');
    expect(res.body.unknownFields).toContain('isAdmin');
  });

  it('returns 400 with code MISSING_FIELDS when name is absent', async () => {
    const res = await post({ scope: ['contracts:read'] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_FIELDS');
  });

  it('returns 400 with code MISSING_FIELDS when name is empty', async () => {
    const res = await post({ name: '', scope: ['contracts:read'] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_FIELDS');
  });

  it('returns 400 with code OUT_OF_RANGE when name is too long', async () => {
    const res = await post({ name: 'a'.repeat(101), scope: ['contracts:read'] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('OUT_OF_RANGE');
    expect(res.body.maxLength).toBe(100);
  });

  it('returns 400 with code MISSING_FIELDS when scope is absent', async () => {
    const res = await post({ name: 'Key' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_FIELDS');
  });

  it('returns 400 with code MISSING_FIELDS when scope is empty array', async () => {
    const res = await post({ name: 'Key', scope: [] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_FIELDS');
  });

  it('returns 400 with code OUT_OF_RANGE when scope has 21 items', async () => {
    const scope = Array.from({ length: 21 }, (_, i) => `resource${i}:read`);
    const res = await post({ name: 'Key', scope });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('OUT_OF_RANGE');
    expect(res.body.maxItems).toBe(20);
  });

  it('returns 400 with code OUT_OF_RANGE when a scope item is too long', async () => {
    const res = await post({ name: 'Key', scope: ['a'.repeat(65)] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('OUT_OF_RANGE');
  });

  it('returns 400 with code INVALID_SCOPE for a malformed scope item', async () => {
    const res = await post({ name: 'Key', scope: ['BAD_FORMAT'] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SCOPE');
    expect(res.body.invalidScopes).toContain('BAD_FORMAT');
    expect(res.body.validFormats).toBeDefined();
  });

  it('returns 400 with code INVALID_DATE for a non-date expiresAt', async () => {
    const res = await post({ name: 'Key', scope: ['contracts:read'], expiresAt: 'not-a-date' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
  });

  it('accepts a boundary name of exactly 100 characters', async () => {
    const res = await post({ name: 'a'.repeat(100), scope: ['contracts:read'] });
    expect(res.status).toBe(201);
  });

  it('accepts exactly 20 scope items', async () => {
    const scope = Array.from({ length: 20 }, (_, i) => `resource${i}:read`);
    const res = await post({ name: 'Key', scope });
    expect(res.status).toBe(201);
  });

  it('accepts a valid expiresAt ISO-8601 string', async () => {
    const res = await post({ name: 'Key', scope: ['contracts:read'], expiresAt: '2099-12-31T23:59:59.000Z' });
    expect(res.status).toBe(201);
    expect(res.body.info.expiresAt).toBeDefined();
  });

  it('does not echo raw secrets in error responses', async () => {
    const secret = 'super-secret-value';
    const res = await post({ name: 'Key', scope: ['contracts:read'], [secret]: true });
    expect(JSON.stringify(res.body)).not.toContain(secret);
  });
});
