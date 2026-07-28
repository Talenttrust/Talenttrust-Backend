process.env.JWT_SECRET = 'contractmetadata-test-secret';

import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import { database } from './database';
import { contractMetadataRoutes } from './modules/contractMetadata/contractMetadata.routes';

const SECRET = process.env.JWT_SECRET as string;

const ADMIN_USER_ID = 'admin-user-id-0001';
const CLIENT_USER_ID = 'client-user-id-0001';

function makeToken(role: string, sub = 'user-1'): string {
  return jwt.sign({ sub, email: `${sub}@test.com`, role }, SECRET, { expiresIn: '1h' }) as string;
}

const adminToken = () => makeToken('admin', ADMIN_USER_ID);
const clientToken = () => makeToken('client', CLIENT_USER_ID);

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

describe('Contract Metadata Integration Tests', () => {
  let app: express.Application;
  let contractId: string;
  let metadataId: string;

  beforeAll(async () => {
    app = express();
    app.use(express.json());
    app.use('/api/v1', contractMetadataRoutes);

    await database.clearDatabase();

    await database.createUser({
      email: 'admin@test.com',
      role: 'admin'
    });

    const contract = await database.createContract({
      created_by: ADMIN_USER_ID
    });
    contractId = contract.id;
  });

  afterAll(async () => {
    await database.clearDatabase();
  });

  describe('Authorization', () => {
    it('returns 401 without Authorization header', async () => {
      const response = await request(app)
        .post(`/api/v1/contracts/${contractId}/metadata`)
        .send({ key: 'test', value: 'test' });
      expect(response.status).toBe(401);
      expect(response.body.error).toMatchObject({ code: 'unauthorized' });
      expect(response.body.error).toHaveProperty('message');
      expect(response.body.error).toHaveProperty('requestId');
    });

    it('returns 401 for invalid token', async () => {
      const response = await request(app)
        .post(`/api/v1/contracts/${contractId}/metadata`)
        .set('Authorization', 'Bearer invalid-token')
        .send({ key: 'test', value: 'test' });
      expect(response.status).toBe(401);
    });

    it('returns 401 for token with unrecognised role', async () => {
      const badRoleToken = jwt.sign(
        { sub: 'u1', email: 'u1@test.com', role: 'superadmin' },
        SECRET,
        { expiresIn: '1h' }
      );
      const response = await request(app)
        .get(`/api/v1/contracts/${contractId}/metadata`)
        .set('Authorization', `Bearer ${badRoleToken}`);
      expect(response.status).toBe(401);
    });

    it('returns 403 for client (contracts:update is ownOnly without owner resolver)', async () => {
      const response = await request(app)
        .post(`/api/v1/contracts/${contractId}/metadata`)
        .set(auth(clientToken()))
        .send({ key: 'test-key', value: 'test-value' });
      expect(response.status).toBe(403);
      expect(response.body.error).toMatchObject({ code: 'forbidden' });
    });
  });

  describe('POST /api/v1/contracts/:contractId/metadata', () => {
    it('should create metadata successfully as admin', async () => {
      const response = await request(app)
        .post(`/api/v1/contracts/${contractId}/metadata`)
        .set(auth(adminToken()))
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
        created_by: ADMIN_USER_ID
      });
      expect(response.body.id).toBeDefined();
      metadataId = response.body.id;
    });

    it('should return 400 for non-existent contract', async () => {
      const response = await request(app)
        .post('/api/v1/contracts/00000000-0000-0000-0000-000000000000/metadata')
        .set(auth(adminToken()))
        .send({
          key: 'test-key',
          value: 'test-value'
        });

      expect(response.status).toBe(400);
    });

    it('should return 409 for duplicate key', async () => {
      const response = await request(app)
        .post(`/api/v1/contracts/${contractId}/metadata`)
        .set(auth(adminToken()))
        .send({
          key: 'test-key',
          value: 'different-value'
        });

      expect(response.status).toBe(409);
      expect(response.body.error).toBe('Metadata key already exists for this contract');
    });

    it('should return 400 for invalid data', async () => {
      const response = await request(app)
        .post(`/api/v1/contracts/${contractId}/metadata`)
        .set(auth(adminToken()))
        .send({
          key: '',
          value: 'test-value'
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toMatchObject({ code: 'validation_error' });
    });
  });

  describe('GET /api/v1/contracts/:contractId/metadata', () => {
    it('should return paginated metadata list', async () => {
      const response = await request(app)
        .get(`/api/v1/contracts/${contractId}/metadata`)
        .set(auth(adminToken()));

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
      for (let i = 0; i < 5; i++) {
        await request(app)
          .post(`/api/v1/contracts/${contractId}/metadata`)
          .set(auth(adminToken()))
          .send({
            key: `test-key-${i}`,
            value: `test-value-${i}`
          });
      }

      const response = await request(app)
        .get(`/api/v1/contracts/${contractId}/metadata?page=1&limit=3`)
        .set(auth(adminToken()));

      expect(response.status).toBe(200);
      expect(response.body.total).toBe(6);
      expect(response.body.page).toBe(1);
      expect(response.body.limit).toBe(3);
      expect(response.body.records).toHaveLength(3);
    });

    it('should filter by key', async () => {
      const response = await request(app)
        .get(`/api/v1/contracts/${contractId}/metadata?key=test-key-0`)
        .set(auth(adminToken()));

      expect(response.status).toBe(200);
      expect(response.body.records).toHaveLength(1);
      expect(response.body.records[0].key).toBe('test-key-0');
    });

    it('should filter by data_type', async () => {
      await request(app)
        .post(`/api/v1/contracts/${contractId}/metadata`)
        .set(auth(adminToken()))
        .send({
          key: 'number-key',
          value: '123',
          data_type: 'number'
        });

      const response = await request(app)
        .get(`/api/v1/contracts/${contractId}/metadata?data_type=number`)
        .set(auth(adminToken()));

      expect(response.status).toBe(200);
      expect(response.body.records).toHaveLength(1);
      expect(response.body.records[0].data_type).toBe('number');
    });
  });

  describe('GET /api/v1/contracts/:contractId/metadata/:id', () => {
    it('should return single metadata record', async () => {
      const response = await request(app)
        .get(`/api/v1/contracts/${contractId}/metadata/${metadataId}`)
        .set(auth(adminToken()));

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(metadataId);
      expect(response.body.key).toBe('test-key');
    });

    it('should return 400 for non-existent metadata', async () => {
      const response = await request(app)
        .get(`/api/v1/contracts/${contractId}/metadata/00000000-0000-0000-0000-000000000000`)
        .set(auth(adminToken()));

      expect(response.status).toBe(400);
    });
  });

  describe('PATCH /api/v1/contracts/:contractId/metadata/:id', () => {
    it('should update metadata successfully', async () => {
      const response = await request(app)
        .patch(`/api/v1/contracts/${contractId}/metadata/${metadataId}`)
        .set(auth(adminToken()))
        .send({
          value: 'updated-value',
          is_sensitive: true
        });

      expect(response.status).toBe(200);
      expect(response.body.value).toBe('updated-value');
      expect(response.body.is_sensitive).toBe(true);
      expect(response.body.updated_by).toBe(ADMIN_USER_ID);
    });

    it('should return 400 for immutable field updates', async () => {
      const response = await request(app)
        .patch(`/api/v1/contracts/${contractId}/metadata/${metadataId}`)
        .set(auth(adminToken()))
        .send({
          key: 'new-key'
        });

      expect(response.status).toBe(400);
    });

    it('should return 400 for non-existent metadata', async () => {
      const response = await request(app)
        .patch(`/api/v1/contracts/${contractId}/metadata/00000000-0000-0000-0000-000000000000`)
        .set(auth(adminToken()))
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
        .set(auth(adminToken()));

      expect(response.status).toBe(204);
    });

    it('should be idempotent - deleting already deleted record returns 204', async () => {
      const response = await request(app)
        .delete(`/api/v1/contracts/${contractId}/metadata/${metadataId}`)
        .set(auth(adminToken()));

      expect(response.status).toBe(204);
    });

    it('should not appear in list after deletion', async () => {
      const response = await request(app)
        .get(`/api/v1/contracts/${contractId}/metadata`)
        .set(auth(adminToken()));

      const deletedRecord = response.body.records.find((r: any) => r.id === metadataId);
      expect(deletedRecord).toBeUndefined();
    });
  });

  describe('Sensitive Data Masking', () => {
    let sensitiveId: string;

    beforeAll(async () => {
      const response = await request(app)
        .post(`/api/v1/contracts/${contractId}/metadata`)
        .set(auth(adminToken()))
        .send({
          key: 'sensitive-key',
          value: 'secret-value',
          is_sensitive: true
        });
      sensitiveId = response.body.id;
    });

    it('should not mask sensitive data for owners (admin creator)', async () => {
      const response = await request(app)
        .get(`/api/v1/contracts/${contractId}/metadata/${sensitiveId}`)
        .set(auth(adminToken()));

      expect(response.status).toBe(200);
      expect(response.body.value).toBe('secret-value');
    });

    it('should not mask sensitive data for admins', async () => {
      const response = await request(app)
        .get(`/api/v1/contracts/${contractId}/metadata/${sensitiveId}`)
        .set(auth(adminToken()));

      expect(response.status).toBe(200);
      expect(response.body.value).toBe('secret-value');
    });
  });
});
