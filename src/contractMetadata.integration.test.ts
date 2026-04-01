import request from 'supertest';
import express from 'express';
import { database } from './database';
import { contractMetadataRoutes } from './modules/contractMetadata/contractMetadata.routes';

describe('Contract Metadata Integration Tests', () => {
  let app: express.Application;
  let contractId: string;
  let userId: string;
  let metadataId: string;

  beforeAll(async () => {
    // Setup test app
    app = express();
    app.use(express.json());
    app.use('/api/v1', contractMetadataRoutes);

    // Clear database
    await database.clearDatabase();

    // Create test user
    const user = await database.createUser({
      email: 'test@example.com',
      role: 'user'
    });
    userId = user.id;

    // Create test contract
    const contract = await database.createContract({
      created_by: userId
    });
    contractId = contract.id;
  });

  afterAll(async () => {
    // Cleanup
    await database.clearDatabase();
  });

  describe('POST /api/v1/contracts/:contractId/metadata', () => {
    it('should create metadata successfully', async () => {
      const response = await request(app)
        .post(`/api/v1/contracts/${contractId}/metadata`)
        .set('Authorization', 'Bearer demo-user-token')
        .send({
          key: 'test-key',
          value: 'test-value',
          data_type: 'string',
          is_sensitive: false
        });

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        contract_id: contractId,
        key: 'test-key',
        value: 'test-value',
        data_type: 'string',
        is_sensitive: false,
        created_by: 'demo-user-id'
      });
      expect(response.body.id).toBeDefined();
      metadataId = response.body.id;
    });

    it('should return 401 for unauthenticated request', async () => {
      const response = await request(app)
        .post(`/api/v1/contracts/${contractId}/metadata`)
        .send({
          key: 'test-key-2',
          value: 'test-value-2'
        });

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('Authentication required');
    });

    it('should return 400 for non-existent contract', async () => {
      const response = await request(app)
        .post('/api/v1/contracts/non-existent/metadata')
        .set('Authorization', 'Bearer demo-user-token')
        .send({
          key: 'test-key',
          value: 'test-value'
        });

      expect(response.status).toBe(400);
    });

    it('should return 409 for duplicate key', async () => {
      const response = await request(app)
        .post(`/api/v1/contracts/${contractId}/metadata`)
        .set('Authorization', 'Bearer demo-user-token')
        .send({
          key: 'test-key', // Same key as first test
          value: 'different-value'
        });

      expect(response.status).toBe(409);
      expect(response.body.error).toBe('Metadata key already exists for this contract');
    });

    it('should return 400 for invalid data', async () => {
      const response = await request(app)
        .post(`/api/v1/contracts/${contractId}/metadata`)
        .set('Authorization', 'Bearer demo-user-token')
        .send({
          key: '', // Invalid: empty key
          value: 'test-value'
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
    });
  });

  describe('GET /api/v1/contracts/:contractId/metadata', () => {
    it('should return paginated metadata list', async () => {
      const response = await request(app)
        .get(`/api/v1/contracts/${contractId}/metadata`)
        .set('Authorization', 'Bearer demo-user-token');

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        total: 1,
        page: 1,
        limit: 20
      });
      expect(response.body.records).toHaveLength(1);
      expect(response.body.records[0].key).toBe('test-key');
    });

    it('should support pagination', async () => {
      // Create additional metadata
      for (let i = 0; i < 5; i++) {
        await request(app)
          .post(`/api/v1/contracts/${contractId}/metadata`)
          .set('Authorization', 'Bearer demo-user-token')
          .send({
            key: `test-key-${i}`,
            value: `test-value-${i}`
          });
      }

      const response = await request(app)
        .get(`/api/v1/contracts/${contractId}/metadata?page=1&limit=3`)
        .set('Authorization', 'Bearer demo-user-token');

      expect(response.status).toBe(200);
      expect(response.body.total).toBe(6); // 1 original + 5 new
      expect(response.body.page).toBe(1);
      expect(response.body.limit).toBe(3);
      expect(response.body.records).toHaveLength(3);
    });

    it('should filter by key', async () => {
      const response = await request(app)
        .get(`/api/v1/contracts/${contractId}/metadata?key=test-key-0`)
        .set('Authorization', 'Bearer demo-user-token');

      expect(response.status).toBe(200);
      expect(response.body.records).toHaveLength(1);
      expect(response.body.records[0].key).toBe('test-key-0');
    });

    it('should filter by data_type', async () => {
      // Create a metadata with different data type
      await request(app)
        .post(`/api/v1/contracts/${contractId}/metadata`)
        .set('Authorization', 'Bearer demo-user-token')
        .send({
          key: 'number-key',
          value: '123',
          data_type: 'number'
        });

      const response = await request(app)
        .get(`/api/v1/contracts/${contractId}/metadata?data_type=number`)
        .set('Authorization', 'Bearer demo-user-token');

      expect(response.status).toBe(200);
      expect(response.body.records).toHaveLength(1);
      expect(response.body.records[0].data_type).toBe('number');
    });
  });

  describe('GET /api/v1/contracts/:contractId/metadata/:id', () => {
    it('should return single metadata record', async () => {
      const response = await request(app)
        .get(`/api/v1/contracts/${contractId}/metadata/${metadataId}`)
        .set('Authorization', 'Bearer demo-user-token');

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(metadataId);
      expect(response.body.key).toBe('test-key');
    });

    it('should return 400 for non-existent metadata', async () => {
      const response = await request(app)
        .get(`/api/v1/contracts/${contractId}/metadata/non-existent`)
        .set('Authorization', 'Bearer demo-user-token');

      expect(response.status).toBe(400);
    });
  });

  describe('PATCH /api/v1/contracts/:contractId/metadata/:id', () => {
    it('should update metadata successfully', async () => {
      const response = await request(app)
        .patch(`/api/v1/contracts/${contractId}/metadata/${metadataId}`)
        .set('Authorization', 'Bearer demo-user-token')
        .send({
          value: 'updated-value',
          is_sensitive: true
        });

      expect(response.status).toBe(200);
      expect(response.body.value).toBe('updated-value');
      expect(response.body.is_sensitive).toBe(true);
      expect(response.body.updated_by).toBe('demo-user-id');
    });

    it('should return 400 for immutable field updates', async () => {
      const response = await request(app)
        .patch(`/api/v1/contracts/${contractId}/metadata/${metadataId}`)
        .set('Authorization', 'Bearer demo-user-token')
        .send({
          key: 'new-key' // Immutable field
        });

      expect(response.status).toBe(400);
    });

    it('should return 400 for non-existent metadata', async () => {
      const response = await request(app)
        .patch(`/api/v1/contracts/${contractId}/metadata/non-existent`)
        .set('Authorization', 'Bearer demo-user-token')
        .send({
          value: 'updated-value'
        });

      expect(response.status).toBe(400);
    });
  });

  describe('DELETE /api/v1/contracts/:contractId/metadata/:id', () => {
    it('should delete metadata successfully', async () => {
      const response = await request(app)
        .delete(`/api/v1/contracts/${contractId}/metadata/${metadataId}`)
        .set('Authorization', 'Bearer demo-user-token');

      expect(response.status).toBe(204);
    });

    it('should be idempotent - deleting already deleted record returns 204', async () => {
      const response = await request(app)
        .delete(`/api/v1/contracts/${contractId}/metadata/${metadataId}`)
        .set('Authorization', 'Bearer demo-user-token');

      expect(response.status).toBe(204);
    });

    it('should not appear in list after deletion', async () => {
      const response = await request(app)
        .get(`/api/v1/contracts/${contractId}/metadata`)
        .set('Authorization', 'Bearer demo-user-token');

      const deletedRecord = response.body.records.find((r: any) => r.id === metadataId);
      expect(deletedRecord).toBeUndefined();
    });
  });

  describe('Sensitive Data Masking', () => {
    let sensitiveId: string;

    beforeAll(async () => {
      // Create sensitive metadata as regular user
      const response = await request(app)
        .post(`/api/v1/contracts/${contractId}/metadata`)
        .set('Authorization', 'Bearer demo-user-token')
        .send({
          key: 'sensitive-key',
          value: 'secret-value',
          is_sensitive: true
        });
      sensitiveId = response.body.id;
    });

    it('should mask sensitive data for non-owners', async () => {
      // Create a different user
      const otherUser = await database.createUser({
        email: 'other@example.com',
        role: 'user'
      });

      // Create a contract owned by other user
      const otherContract = await database.createContract({
        created_by: otherUser.id
      });

      // Create sensitive metadata for other contract
      const sensitiveResponse = await request(app)
        .post(`/api/v1/contracts/${otherContract.id}/metadata`)
        .set('Authorization', `Bearer ${otherUser.id}`)
        .send({
          key: 'other-sensitive',
          value: 'other-secret',
          is_sensitive: true
        });

      // Try to access as demo user (should be masked)
      const response = await request(app)
        .get(`/api/v1/contracts/${otherContract.id}/metadata/${sensitiveResponse.body.id}`)
        .set('Authorization', 'Bearer demo-user-token');

      expect(response.status).toBe(200);
      expect(response.body.value).toBe('***REDACTED***');
    });

    it('should not mask sensitive data for owners', async () => {
      const response = await request(app)
        .get(`/api/v1/contracts/${contractId}/metadata/${sensitiveId}`)
        .set('Authorization', 'Bearer demo-user-token');

      expect(response.status).toBe(200);
      expect(response.body.value).toBe('secret-value');
    });

    it('should not mask sensitive data for admins', async () => {
      const response = await request(app)
        .get(`/api/v1/contracts/${contractId}/metadata/${sensitiveId}`)
        .set('Authorization', 'Bearer demo-admin-token');

      expect(response.status).toBe(200);
      expect(response.body.value).toBe('secret-value');
    });
  });
});
