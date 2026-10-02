import type { Request, Response, NextFunction } from 'express';
import {
  createMilestonesSoftDeleteController,
  runMilestonesSoftDeletePurge,
} from './milestones.softdelete.controller';
import {
  milestonesService,
  MILESTONES_SOFT_DELETE_RETENTION_DAYS_ENV,
} from '../services/milestones.service';

function mockRes() {
  const res: Partial<Response> & {
    statusCode: number;
    body: unknown;
    locals: Record<string, unknown>;
  } = {
    statusCode: 200,
    body: undefined,
    locals: { requestId: 'req-test' },
    status(code: number) {
      this.statusCode = code;
      return this as Response;
    },
    json(payload: unknown) {
      this.body = payload;
      return this as Response;
    },
  };
  return res as Response & { statusCode: number; body: any };
}

describe('MilestonesSoftDeleteController', () => {
  const controller = createMilestonesSoftDeleteController();
  const contractId = 'contract-ctrl-1';

  beforeEach(() => {
    milestonesService.clearStore();
    delete process.env[MILESTONES_SOFT_DELETE_RETENTION_DAYS_ENV];
  });

  afterEach(() => {
    milestonesService.clearStore();
    delete process.env[MILESTONES_SOFT_DELETE_RETENTION_DAYS_ENV];
  });

  it('creates and lists milestones; soft-delete hides from default list', () => {
    const createReq = {
      params: { id: contractId },
      body: { title: 'Design', amount: 500 },
    } as unknown as Request;
    const createRes = mockRes();
    controller.create(createReq, createRes, jest.fn());
    expect(createRes.statusCode).toBe(201);
    const milestoneId = createRes.body.data.milestone.id as string;

    const listRes = mockRes();
    controller.list({ params: { id: contractId }, query: {} } as unknown as Request, listRes, jest.fn());
    expect(listRes.body.data.total).toBe(1);

    const delRes = mockRes();
    controller.softDelete(
      { params: { id: contractId, milestoneId } } as unknown as Request,
      delRes,
      jest.fn(),
    );
    expect(delRes.statusCode).toBe(200);
    expect(delRes.body.data.milestone.deletedAt).toBeTruthy();

    const listAfter = mockRes();
    controller.list({ params: { id: contractId }, query: {} } as unknown as Request, listAfter, jest.fn());
    expect(listAfter.body.data.total).toBe(0);
  });

  it('restores within window and rejects after expiry with 410', () => {
    process.env[MILESTONES_SOFT_DELETE_RETENTION_DAYS_ENV] = '30';
    const created = milestonesService.create(contractId, { title: 'A', amount: 1 });
    milestonesService.softDelete(
      contractId,
      created.id,
      new Date('2026-01-01T00:00:00.000Z'),
    );

    // Force restore "now" via service for window check; controller uses Date.now.
    // Simulate within-window by soft-deleting with recent timestamp.
    milestonesService.clearStore();
    const recent = milestonesService.create(contractId, { title: 'B', amount: 1 });
    milestonesService.softDelete(contractId, recent.id);

    const restoreRes = mockRes();
    controller.restore(
      { params: { id: contractId, milestoneId: recent.id } } as unknown as Request,
      restoreRes,
      jest.fn(),
    );
    expect(restoreRes.statusCode).toBe(200);
    expect(restoreRes.body.data.milestone.deletedAt).toBeNull();

    // Past window via service then controller restore
    const expired = milestonesService.create(contractId, { title: 'C', amount: 1 });
    milestonesService.softDelete(
      contractId,
      expired.id,
      new Date('2020-01-01T00:00:00.000Z'),
    );
    const goneRes = mockRes();
    controller.restore(
      { params: { id: contractId, milestoneId: expired.id } } as unknown as Request,
      goneRes,
      jest.fn(),
    );
    expect(goneRes.statusCode).toBe(410);
    expect(goneRes.body.error.code).toBe('soft_delete_retention_expired');
  });

  it('returns 404 for unknown milestone soft-delete', () => {
    const res = mockRes();
    controller.softDelete(
      { params: { id: contractId, milestoneId: 'missing' } } as unknown as Request,
      res,
      jest.fn(),
    );
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 when create payload is incomplete', () => {
    const res = mockRes();
    controller.create(
      { params: { id: contractId }, body: { title: 'x' } } as unknown as Request,
      res,
      jest.fn(),
    );
    expect(res.statusCode).toBe(400);
  });

  it('runMilestonesSoftDeletePurge removes expired soft-deleted milestones', () => {
    process.env[MILESTONES_SOFT_DELETE_RETENTION_DAYS_ENV] = '30';
    const m = milestonesService.create(contractId, { title: 'Old', amount: 1 });
    milestonesService.softDelete(
      contractId,
      m.id,
      new Date('2020-01-01T00:00:00.000Z'),
    );
    expect(runMilestonesSoftDeletePurge(new Date('2026-07-01T00:00:00.000Z'))).toBe(1);
    expect(milestonesService.storeSize()).toBe(0);
  });

  it('forwards unexpected errors to next', () => {
    const next = jest.fn() as NextFunction;
    const spy = jest.spyOn(milestonesService, 'listByContract').mockImplementation(() => {
      throw new Error('boom');
    });
    const res = mockRes();
    controller.list({ params: { id: contractId }, query: {} } as unknown as Request, res, next);
    expect(next).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('maps conflict on double soft-delete and forwards unexpected softDelete/create/restore errors', () => {
    const created = milestonesService.create(contractId, { title: 'X', amount: 1, deadline: '2026-12-01T00:00:00.000Z' });
    milestonesService.softDelete(contractId, created.id);

    const conflictRes = mockRes();
    controller.softDelete(
      { params: { id: contractId, milestoneId: created.id } } as unknown as Request,
      conflictRes,
      jest.fn(),
    );
    expect(conflictRes.statusCode).toBe(409);

    const includeRes = mockRes();
    controller.list(
      { params: { id: contractId }, query: { includeDeleted: 'true' } } as unknown as Request,
      includeRes,
      jest.fn(),
    );
    expect(includeRes.body.data.total).toBe(1);

    for (const method of ['create', 'softDelete', 'restore'] as const) {
      const next = jest.fn() as NextFunction;
      const spyName =
        method === 'create' ? 'create' : method === 'softDelete' ? 'softDelete' : 'restore';
      const spy = jest.spyOn(milestonesService, spyName).mockImplementation(() => {
        throw new Error(`${method}-boom`);
      });
      const res = mockRes();
      if (method === 'create') {
        controller.create(
          { params: { id: contractId }, body: { title: 'Y', amount: 2 } } as unknown as Request,
          res,
          next,
        );
      } else if (method === 'softDelete') {
        controller.softDelete(
          { params: { id: contractId, milestoneId: 'x' } } as unknown as Request,
          res,
          next,
        );
      } else {
        controller.restore(
          { params: { id: contractId, milestoneId: 'x' } } as unknown as Request,
          res,
          next,
        );
      }
      expect(next).toHaveBeenCalled();
      spy.mockRestore();
    }
  });

  it('create with empty body uses defaults and validates title requirement', () => {
    const res = mockRes();
    controller.create(
      { params: { id: contractId }, body: undefined } as unknown as Request,
      res,
      jest.fn(),
    );
    expect(res.statusCode).toBe(400);
  });
});
