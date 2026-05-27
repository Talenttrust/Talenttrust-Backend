import request from 'supertest';
import app from '../../src/index';

describe('API Integration Tests', () => {
  describe('Health Check', () => {
    it('should return health status', async () => {
      const response = await request(app)
        .get('/health')
        .expect(200);
      
      expect(response.body).toHaveProperty('status', 'healthy');
      expect(response.body).toHaveProperty('timestamp');
      expect(response.body).toHaveProperty('version');
    });
  });

  describe('Event Ingestion API', () => {
    const validEvent = {
      contractId: 'contract_123',
      eventId: 'event_456',
      sequence: 1,
      timestamp: Date.now(),
      payload: {
        talentId: 'talent_123',
        action: 'created',
        metadata: { source: 'api' }
      }
    };

    it('should process valid events successfully', async () => {
      const response = await request(app)
        .post('/api/v1/events')
        .send({
          events: [validEvent],
          contractType: 'talent_contract'
        })
        .expect(200);

      expect(response.body).toHaveProperty('processed', 1);
      expect(response.body).toHaveProperty('results');
      expect(response.body).toHaveProperty('summary');
      expect(response.body.results).toHaveLength(1);
      expect(response.body.results[0].status).toBe('accepted');
    });

    it('should reject requests without events array', async () => {
      const response = await request(app)
        .post('/api/v1/events')
        .send({
          contractType: 'talent_contract'
        })
        .expect(400);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('events array is required');
    });

    it('should reject requests without contractType', async () => {
      const response = await request(app)
        .post('/api/v1/events')
        .send({
          events: [validEvent]
        })
        .expect(400);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('contractType is required');
    });

    it('should handle duplicate events correctly', async () => {
      // First submission
      await request(app)
        .post('/api/v1/events')
        .send({
          events: [validEvent],
          contractType: 'talent_contract'
        })
        .expect(200);

      // Duplicate submission
      const response = await request(app)
        .post('/api/v1/events')
        .send({
          events: [validEvent],
          contractType: 'talent_contract'
        })
        .expect(200);

      expect(response.body.results[0].status).toBe('duplicate');
    });

    it('should reject invalid events', async () => {
      const invalidEvent = {
        ...validEvent,
        contractId: '' // Invalid empty contract ID
      };

      const response = await request(app)
        .post('/api/v1/events')
        .send({
          events: [invalidEvent],
          contractType: 'talent_contract'
        })
        .expect(200);

      expect(response.body.results[0].status).toBe('rejected');
      expect(response.body.results[0].reason).toContain('Validation failed');
    });
  });

  describe('Event Validation API', () => {
    const validEvent = {
      contractId: 'contract_123',
      eventId: 'event_456',
      sequence: 1,
      timestamp: Date.now(),
      payload: {
        talentId: 'talent_123',
        action: 'created'
      }
    };

    it('should validate correct events', async () => {
      const response = await request(app)
        .post('/api/v1/events/validate')
        .send({
          event: validEvent,
          contractType: 'talent_contract'
        })
        .expect(200);

      expect(response.body).toHaveProperty('isValid', true);
      expect(response.body).toHaveProperty('errors');
      expect(response.body.errors).toHaveLength(0);
    });

    it('should reject invalid events', async () => {
      const invalidEvent = {
        ...validEvent,
        contractId: ''
      };

      const response = await request(app)
        .post('/api/v1/events/validate')
        .send({
          event: invalidEvent,
          contractType: 'talent_contract'
        })
        .expect(200);

      expect(response.body).toHaveProperty('isValid', false);
      expect(response.body.errors.length).toBeGreaterThan(0);
    });
  });

  describe('Statistics API', () => {
    it('should return processing statistics', async () => {
      const response = await request(app)
        .get('/api/v1/stats')
        .expect(200);

      expect(response.body).toHaveProperty('total');
      expect(response.body).toHaveProperty('accepted');
      expect(response.body).toHaveProperty('rejected');
      expect(response.body).toHaveProperty('duplicates');
      expect(typeof response.body.total).toBe('number');
    });
  });

  describe('Contract History API', () => {
    const contractId = 'test_contract_123';
    const validEvent = {
      contractId,
      eventId: 'event_456',
      sequence: 1,
      timestamp: Date.now(),
      payload: {
        talentId: 'talent_123',
        action: 'created'
      }
    };

    beforeEach(async () => {
      // Add an event for testing
      await request(app)
        .post('/api/v1/events')
        .send({
          events: [validEvent],
          contractType: 'talent_contract'
        });
    });

    it('should return contract event history', async () => {
      const response = await request(app)
        .get(`/api/v1/contracts/${contractId}/history`)
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThan(0);
      expect(response.body[0]).toHaveProperty('contractId', contractId);
    });

    it('should return empty history for non-existent contract', async () => {
      const response = await request(app)
        .get('/api/v1/contracts/non_existent/history')
        .expect(200);

      expect(response.body).toHaveLength(0);
    });
  });
});
