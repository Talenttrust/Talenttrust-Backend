/**
 * Route-level soft-delete coverage for disputes endpoints.
 */
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

jest.mock('../middleware/authorization', () => ({
  requireAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
  requirePermission: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

jest.mock('../config/features', () => ({
  features: {
    get disputesEnabled() {
      return true;
    },
  },
}));

import { createDisputesRouter } from './disputes.routes';
import {
  disputesService,
  DISPUTES_SOFT_DELETE_RETENTION_DAYS_ENV,
} from '../services/disputes.service';
import { Logger } from '../logger';

const silentLogger = new Logger();
jest.spyOn(silentLogger as any, 'log').mockImplementation(() => undefined);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/disputes', createDisputesRouter({ log: silentLogger }));
  return app;
}

describe('disputes routes soft-delete', () => {
  beforeEach(() => {
    disputesService.clearStore();
    delete process.env[DISPUTES_SOFT_DELETE_RETENTION_DAYS_ENV];
  });

  afterEach(() => {
    disputesService.clearStore();
    delete process.env[DISPUTES_SOFT_DELETE_RETENTION_DAYS_ENV];
  });

  it('DELETE soft-deletes; GET list hides; restore brings it back', async () => {
    const app = buildApp();
    const createRes = await request(app)
      .post('/api/v1/disputes')
      .send({ contractId: 'c-1', reason: 'late payment' });
    expect(createRes.status).toBe(201);
    const id = createRes.body.dispute.id as string;

    const del = await request(app).delete(`/api/v1/disputes/${id}`);
    expect(del.status).toBe(200);
    expect(del.body.dispute.deletedAt).toBeTruthy();

    const list = await request(app).get('/api/v1/disputes');
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(0);

    const getGone = await request(app).get(`/api/v1/disputes/${id}`);
    expect(getGone.status).toBe(404);

    const restore = await request(app).post(`/api/v1/disputes/${id}/restore`);
    expect(restore.status).toBe(200);
    expect(restore.body.data.dispute.deletedAt).toBeNull();

    const listAfter = await request(app).get('/api/v1/disputes');
    expect(listAfter.body.total).toBe(1);
  });

  it('restore past retention returns 410', async () => {
    process.env[DISPUTES_SOFT_DELETE_RETENTION_DAYS_ENV] = '30';
    const app = buildApp();
    const created = disputesService.createDispute({ contractId: 'c' });
    disputesService.softDeleteDispute(
      created.id,
      new Date('2020-01-01T00:00:00.000Z'),
    );

    const restore = await request(app).post(`/api/v1/disputes/${created.id}/restore`);
    expect(restore.status).toBe(410);
    expect(restore.body.error.code).toBe('soft_delete_retention_expired');
  });

  it('DELETE unknown dispute returns 404', async () => {
    const app = buildApp();
    const res = await request(app).delete('/api/v1/disputes/missing-id');
    expect(res.status).toBe(404);
  });
});
