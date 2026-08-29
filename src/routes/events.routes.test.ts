import express from 'express';
import request from 'supertest';
import { createEventsRouter } from './events.routes';
import { EventAuditService, InMemoryEventAuditRepository } from '../repository/eventAuditRepository';
import { FinalityEvaluator } from '../finality/finalityEvaluator';
import { createFinalityPolicy } from '../finality/policy';

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

describe('Event ingestion routes — finality', () => {
  const policy = createFinalityPolicy(
    { depths: { stellar: 1, soroban: 3 }, defaultDepth: 6 },
    'test',
  );

  let head: number;
  let service: EventAuditService;
  let app: express.Application;

  beforeEach(() => {
    head = 100;
    const evaluator = new FinalityEvaluator(policy, async () => head);
    service = new EventAuditService(new InMemoryEventAuditRepository(), console, evaluator);
    app = express();
    app.use(express.json());
    app.use('/api/v1', createEventsRouter(service));
  });

  const onChainRelease = {
    contractId: 'contract-9',
    eventId: 'release-1',
    sequence: 1,
    timestamp: new Date().toISOString(),
    type: 'MILESTONE_RELEASED',
    payload: { milestoneId: 'm-1', amount: 100 },
    network: 'soroban',
    ledger: 98,
  };

  it('accepts an on-chain release but hides it from public history until finality', async () => {
    const ingest = await request(app).post('/api/v1/events').send(onChainRelease);
    expect(ingest.status).toBe(202);
    expect(ingest.body.data.status).toBe('accepted');

    const history = await request(app).get(`/api/v1/contracts/${onChainRelease.contractId}/history`);
    expect(history.status).toBe(200);
    // head 100, ledger 98 -> 3 confirmations == depth 3 -> finalized at the exact boundary.
    expect(history.body.data).toHaveLength(1);
    expect(history.body.data[0].eventId).toBe('release-1');
  });

  it('exposes a release only after the promotion sweep advances the head', async () => {
    const pendingRelease = { ...onChainRelease, eventId: 'release-2', sequence: 2, ledger: 99 };
    await request(app).post('/api/v1/events').send(pendingRelease);

    // head 100, ledger 99 -> 2 confirmations < 3 -> hidden.
    let history = await request(app).get(`/api/v1/contracts/${onChainRelease.contractId}/history`);
    expect(history.body.data).toHaveLength(0);

    head = 101; // 3 confirmations == depth 3
    await service.promoteProvisionalEvents('soroban');

    history = await request(app).get(`/api/v1/contracts/${onChainRelease.contractId}/history`);
    expect(history.body.data).toHaveLength(1);
    expect(history.body.data[0].eventId).toBe('release-2');
    expect(history.body.data[0].finalityStatus).toBe('finalized');
  });

  it('exposes off-chain events immediately (no finality risk)', async () => {
    const offChain = { ...onChainRelease, eventId: 'release-3', sequence: 3, network: undefined, ledger: undefined };
    await request(app).post('/api/v1/events').send(offChain);

    const history = await request(app).get(`/api/v1/contracts/${onChainRelease.contractId}/history`);
    expect(history.body.data).toHaveLength(1);
    expect(history.body.data[0].eventId).toBe('release-3');
  });

  it('rejects events with a present-but-invalid ledger (fail-closed)', async () => {
    const bad = { ...onChainRelease, ledger: -5 };
    const response = await request(app).post('/api/v1/events').send(bad);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid_event_payload');
  });
});
