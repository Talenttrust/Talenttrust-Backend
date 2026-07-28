import express from 'express';
import request from 'supertest';
import { createEventsRouter } from './events.routes';
import { EventAuditService, InMemoryEventAuditRepository } from '../repository/eventAuditRepository';

describe('Event ingestion routes', () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/v1', createEventsRouter(new EventAuditService(new InMemoryEventAuditRepository())));
  });

  const validEvent = {
    contractId: 'contract-123',
    eventId: 'event-1',
    sequence: 1,
    timestamp: new Date().toISOString(),
    type: 'CONTRACT_CREATED',
    payload: {
      title: 'New contract',
      amount: 100,
    },
  };

  it('accepts a valid event with 202', async () => {
    const response = await request(app).post('/api/v1/events').send(validEvent);

    expect(response.status).toBe(202);
    expect(response.body).toEqual(
      expect.objectContaining({
        status: 'success',
        data: expect.objectContaining({ status: 'accepted', deduplicationKey: expect.any(String) }),
      }),
    );
  });

  it('returns duplicate when the same event is submitted again', async () => {
    await request(app).post('/api/v1/events').send(validEvent);
    const duplicateResponse = await request(app).post('/api/v1/events').send(validEvent);

    expect(duplicateResponse.status).toBe(200);
    expect(duplicateResponse.body).toEqual(
      expect.objectContaining({
        status: 'success',
        data: expect.objectContaining({ status: 'duplicate', deduplicationKey: expect.any(String) }),
      }),
    );
  });

  it('returns 400 for invalid event payload', async () => {
    const response = await request(app).post('/api/v1/events').send({ invalid: 'payload' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual(
      expect.objectContaining({
        status: 'error',
        error: expect.objectContaining({ code: 'invalid_event_payload' }),
      }),
    );
  });

  it('validates payload without processing on /events/validate', async () => {
    const response = await request(app).post('/api/v1/events/validate').send(validEvent);

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.objectContaining({
        status: 'success',
        data: expect.objectContaining({ valid: true, event: expect.objectContaining({ contractId: 'contract-123' }) }),
      }),
    );
  });

  it('reports statistics at /events/stats', async () => {
    await request(app).post('/api/v1/events').send(validEvent);
    const response = await request(app).get('/api/v1/events/stats');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.objectContaining({
        status: 'success',
        data: expect.objectContaining({ total: 1, accepted: 1, rejected: 0, duplicates: 0 }),
      }),
    );
  });

  it('returns contract history at /contracts/:contractId/history', async () => {
    await request(app).post('/api/v1/events').send(validEvent);
    const response = await request(app).get(`/api/v1/contracts/${validEvent.contractId}/history`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.objectContaining({
        status: 'success',
        data: expect.any(Array),
      }),
    );
    expect(response.body.data[0]).toEqual(expect.objectContaining({ contractId: validEvent.contractId }));
  });
});
