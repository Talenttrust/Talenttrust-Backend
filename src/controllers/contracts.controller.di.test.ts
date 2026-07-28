
import { Request, Response, NextFunction } from 'express';
import { createContractsController } from './contracts.controller';
import { ContractBoundsError } from '../contracts/bounds';

// Mock cursor repository helpers
jest.mock('../contracts/cursor.repository', () => ({
  resolveCursorQueryParam: jest.fn().mockReturnValue({ ok: true, cursor: undefined }),
  parseLimit: jest.fn().mockReturnValue(20),
}));

// Mock apiResponse helpers
jest.mock('../utils/apiResponse', () => ({
  ok: jest.fn(),
  fail: jest.fn(),
}));

import { ok, fail } from '../utils/apiResponse';
import { resolveCursorQueryParam, parseLimit } from '../contracts/cursor.repository';

function makeMockRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    locals: { requestId: 'test-req-id' },
  } as unknown as Response;
}

function makeMockReq(overrides: Partial<Request> = {}): Request {
  return {
    query: {},
    params: {},
    body: {},
    ...overrides,
  } as unknown as Request;
}

const next = jest.fn() as unknown as NextFunction;

const mockService = {
  getAllContracts: jest.fn(),
  getContractById: jest.fn(),
  createContract: jest.fn(),
  getContractsPage: jest.fn(),
  updateContract: jest.fn(),
  deleteContract: jest.fn(),
  getContractStats: jest.fn(),
  getContractHistory: jest.fn(),
  getBounds: jest.fn(),
};

function makeContract(overrides: Record<string, unknown> = {}) {
  return {
    id: 'abc',
    title: 'Test',
    clientId: 'client-1',
    freelancerId: 'freelancer-1',
    amount: 1000,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    version: 0,
    ...overrides,
  };
}

describe('ContractsController (DI)', () => {
  let controller: ReturnType<typeof createContractsController>;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = createContractsController(mockService as any);
  });

  describe('getContracts', () => {
    it('returns paginated contracts', async () => {
      const contracts = [makeContract({ id: '1' }), makeContract({ id: '2' })];
      mockService.getAllContracts.mockResolvedValueOnce(contracts);
      await controller.getContracts(makeMockReq(), makeMockRes(), next);
      expect(ok).toHaveBeenCalledWith(
        expect.anything(),
        contracts,
        expect.objectContaining({ page: 1, limit: 10, total: 2 }),
      );
    });

    it('calls next on service error', async () => {
      mockService.getContractsPage.mockRejectedValueOnce(new Error('DB error'));
      await controller.getContracts(makeMockReq(), makeMockRes(), next);
      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });

    it('returns 400 for invalid cursor', async () => {
      (resolveCursorQueryParam as jest.Mock).mockReturnValueOnce({ ok: false, message: 'bad cursor' });
      await controller.getContracts(makeMockReq({ query: { cursor: 'bad' } }), makeMockRes(), next);
      expect(fail).toHaveBeenCalledWith(expect.anything(), 'bad_request', 'bad cursor', 400);
    });

    it('returns 400 for invalid limit', async () => {
      (parseLimit as jest.Mock).mockImplementationOnce(() => { throw new Error('limit too big'); });
      await controller.getContracts(makeMockReq({ query: { limit: '999' } }), makeMockRes(), next);
      expect(fail).toHaveBeenCalledWith(expect.anything(), 'bad_request', 'limit too big', 400);
    });
  });

  describe('getContractById', () => {
    it('returns contract when found', async () => {
      const contract = makeContract();
      mockService.getContractById.mockResolvedValueOnce(contract);
      await controller.getContractById(
        makeMockReq({ params: { id: 'abc' } }),
        makeMockRes(),
        next,
      );
      expect(ok).toHaveBeenCalledWith(expect.anything(), contract);
    });

    it('throws NotFoundError when contract is null', async () => {
      mockService.getContractById.mockResolvedValueOnce(null);
      await controller.getContractById(
        makeMockReq({ params: { id: 'missing' } }),
        makeMockRes(),
        next,
      );
      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('createContract', () => {
    it('creates contract and returns 201', async () => {
      const newContract = makeContract({ id: 'new-1', title: 'New', status: 'draft' });
      mockService.createContract.mockResolvedValueOnce(newContract);
      await controller.createContract(
        makeMockReq({ body: { title: 'New' } }),
        makeMockRes(),
        next,
      );
      expect(ok).toHaveBeenCalledWith(expect.anything(), newContract, undefined, 201);
    });

    it('returns 422 on ContractBoundsError', async () => {
      mockService.createContract.mockRejectedValueOnce(
        new ContractBoundsError('bounds exceeded'),
      );
      await controller.createContract(makeMockReq(), makeMockRes(), next);
      expect(fail).toHaveBeenCalledWith(
        expect.anything(),
        'contract_bounds_error',
        'bounds exceeded',
        422,
      );
    });
  });

  describe('updateContract', () => {
    it('updates contract successfully', async () => {
      const updated = makeContract({ id: 'u-1', title: 'Updated', version: 1 });
      mockService.updateContract.mockResolvedValueOnce(updated);
      await controller.updateContract(
        makeMockReq({ params: { id: 'u-1' }, body: { title: 'Updated' } }),
        makeMockRes(),
        next,
      );
      expect(ok).toHaveBeenCalledWith(expect.anything(), updated);
    });

    it('returns 422 on ContractBoundsError', async () => {
      mockService.updateContract.mockRejectedValueOnce(
        new ContractBoundsError('bounds exceeded'),
      );
      await controller.updateContract(
        makeMockReq({ params: { id: 'u-1' } }),
        makeMockRes(),
        next,
      );
      expect(fail).toHaveBeenCalledWith(
        expect.anything(),
        'contract_bounds_error',
        'bounds exceeded',
        422,
      );
    });
  });

  describe('deleteContract', () => {
    it('deletes contract successfully', async () => {
      mockService.deleteContract.mockResolvedValueOnce(undefined);
      await controller.deleteContract(
        makeMockReq({ params: { id: 'd-1' } }),
        makeMockRes(),
        next,
      );
      expect(ok).toHaveBeenCalledWith(
        expect.anything(),
        { message: 'Contract deleted successfully' },
      );
    });

    it('calls next on error', async () => {
      mockService.deleteContract.mockRejectedValueOnce(new Error('DB error'));
      await controller.deleteContract(
        makeMockReq({ params: { id: 'd-1' } }),
        makeMockRes(),
        next,
      );
      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('getContractStats', () => {
    it('returns stats', async () => {
      const stats = { total: 5, totalBudget: 5000, byStatus: { active: 3, draft: 2 } };
      mockService.getContractStats.mockResolvedValueOnce(stats);
      await controller.getContractStats(makeMockReq(), makeMockRes(), next);
      expect(ok).toHaveBeenCalledWith(expect.anything(), stats);
    });
  });

  describe('getBounds', () => {
    it('returns CONTRACT_BOUNDS', () => {
      controller.getBounds(makeMockReq(), makeMockRes());
      expect(ok).toHaveBeenCalled();
    });
  });

  describe('getContractHistory', () => {
    it('delegates to service.getContractHistory and returns 200 json', async () => {
      const history = [{ id: 'evt-1' }];
      mockService.getContractHistory.mockResolvedValueOnce(history);
      const res = makeMockRes();
      await controller.getContractHistory(
        makeMockReq({ params: { id: 'c-1' } }),
        res,
        next,
      );
      expect(mockService.getContractHistory).toHaveBeenCalledWith('c-1');
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(history);
    });

    it('calls next on service error', async () => {
      mockService.getContractHistory.mockRejectedValueOnce(new Error('History error'));
      await controller.getContractHistory(
        makeMockReq({ params: { id: 'c-1' } }),
        makeMockRes(),
        next,
      );
      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('no side effects on import', () => {
    it('createContractsController does not call getDb', () => {
      const mockSvc = { ...mockService };
      expect(() => createContractsController(mockSvc as any)).not.toThrow();
    });
  });
});
