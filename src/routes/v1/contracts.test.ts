/**
 * Contracts v1 Route Tests
 * Unit tests for v1 contract endpoints
 */

import request from 'supertest';
import express from 'express';
import contractsV1 from './contracts';

describe('Contracts v1 Routes', () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/v1/contracts', contractsV1);
  });

  describe('GET /api/v1/contracts', () => {
    it('should return contracts list with v1 format', async () => {
      const response = await request(app).get('/api/v1/contracts');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('version', 'v1');
      expect(response.body).toHaveProperty('contracts');
      expect(Array.isArray(response.body.contracts)).toBe(true);
      expect(response.body).toHaveProperty('message');
    });
  });

  describe('GET /api/v1/contracts/:id', () => {
    it('should return contract by ID', async () => {
      const response = await request(app).get('/api/v1/contracts/test-123');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('version', 'v1');
      expect(response.body).toHaveProperty('contract');
      expect(response.body.contract).toHaveProperty('id', 'test-123');
      expect(response.body.contract).toHaveProperty('status');
      expect(response.body.contract).toHaveProperty('createdAt');
    });

    it('should handle different contract IDs', async () => {
      const response = await request(app).get('/api/v1/contracts/abc-456');

      expect(response.status).toBe(200);
      expect(response.body.contract.id).toBe('abc-456');
    });
  });
});
