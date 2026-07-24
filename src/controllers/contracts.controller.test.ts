import { Request, Response, NextFunction } from 'express';
import { ContractBoundsError, CONTRACT_BOUNDS } from '../contracts/bounds';

const mockGetAllContracts = jest.fn();
const mockGetContractById = jest.fn();
const mockCreateContract = jest.fn();
const mockGetContractsPage = jest.fn();
const mockUpdateContract = jest.fn();
const mockDeleteContract = jest.fn();
const mockGetContractStats = jest.fn();

jest.mock('../db/database', () => ({
  getDb: jest.fn().mockReturnValue({}),
}));

jest.mock('../repositories/contractRepository', () => ({
  ContractRepository: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('../services/contracts.service', () => ({
  ContractsService: jest.fn().mockImplementation(() => ({
    getAllContracts: mockGetAllContracts,
    getContractById: mockGetContractById,
    createContract: mockCreateContract,
    getContractsPage: mockGetContractsPage,
    updateContract: mockUpdateContract,
    deleteContract: mockDeleteContract,
    getContractStats: mockGetContractStats,
  })),
}));

import { ContractsController } from './contracts.controller';

describe('ContractsController', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: NextFunction;
  let controller: ContractsController;

  beforeEach(() => {
    mockRequest = {
      body: { title: 'Test Contract' },
      query: {},
    };
    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      locals: { audit: {} as never },
    };
    mockNext = jest.fn();
    
    // Clear all mocks
    mockGetAllContracts.mockClear();
    mockGetContractById.mockClear();
    mockCreateContract.mockClear();
    mockGetContractsPage.mockClear();
    mockUpdateContract.mockClear();
    mockDeleteContract.mockClear();
    mockGetContractStats.mockClear();

    // Instantiate controller
    const { ContractsService } = require('../services/contracts.service');
    controller = new ContractsController(new ContractsService());
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // getContracts — happy paths
  // -------------------------------------------------------------------------

  describe('getContracts — success', () => {
    it('returns 200 with cursor page on first page (no cursor)', async () => {
      const fakePage = { data: [], nextCursor: null, hasNextPage: false, limit: 20 };
      mockGetContractsPage.mockResolvedValue(fakePage);
    });
  });

  describe('getContracts', () => {
    it('returns 200 with contracts list', async () => {
      mockGetAllContracts.mockResolvedValue([]);
      await controller.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );
      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith(expect.objectContaining({
        status: 'success',
        data: [],
        meta: expect.any(Object)
      }));
    });

    it('calls next() on error', async () => {
      const mockError = new Error('DB Down');
      mockGetAllContracts.mockRejectedValue(mockError);
      await controller.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockNext).toHaveBeenCalledWith(mockError);
    });

    it('calls next() on error', async () => {
      const mockError = new Error('DB Down');
      mockGetContractsPage.mockRejectedValue(mockError);
      await controller.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );
      expect(mockNext).toHaveBeenCalledWith(mockError);
    });

    it('passes limit and cursor to service when provided', async () => {
      const fakePage = { data: [], nextCursor: null, hasNextPage: false, limit: 5 };
      mockGetContractsPage.mockResolvedValue(fakePage);

      const validCursor = Buffer.from(
        JSON.stringify({ createdAt: '2024-01-01T00:00:00.000Z', id: 'abc-123' }),
        'utf8',
      ).toString('base64url');

      mockRequest.query = { limit: '5', cursor: validCursor };

      await controller.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockGetContractsPage).toHaveBeenCalledWith({
        limit: 5,
        cursor: validCursor,
      });
      expect(mockResponse.status).toHaveBeenCalledWith(200);
    });
  });

  // -------------------------------------------------------------------------
  // getContracts — validation errors (400)
  // -------------------------------------------------------------------------

  describe('getContracts — validation errors', () => {
    it('returns 400 when limit exceeds 100', async () => {
      mockRequest.query = { limit: '101' };

      await controller.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect((mockResponse.json as jest.Mock).mock.calls[0][0]).toMatchObject({
        status: 'error',
      });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('returns 400 when limit is 0', async () => {
      mockRequest.query = { limit: '0' };

      await controller.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockResponse.status).toHaveBeenCalledWith(400);
    });

    it('returns 400 when limit is negative', async () => {
      mockRequest.query = { limit: '-1' };

      await controller.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockResponse.status).toHaveBeenCalledWith(400);
    });

    it('returns 400 for a malformed cursor', async () => {
      mockRequest.query = { cursor: 'not-a-valid-cursor' };

      await controller.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect((mockResponse.json as jest.Mock).mock.calls[0][0]).toMatchObject({
        status: 'error',
      });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('returns 400 for a cursor missing the id field', async () => {
      const bad = Buffer.from(
        JSON.stringify({ createdAt: '2024-01-01T00:00:00.000Z' }),
        'utf8',
      ).toString('base64url');
      mockRequest.query = { cursor: bad };

      await controller.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockResponse.status).toHaveBeenCalledWith(400);
    });
  });

  // -------------------------------------------------------------------------
  // getContracts — error propagation
  // -------------------------------------------------------------------------

  describe('getContracts — error propagation', () => {
    it('calls next() when service throws', async () => {
      const mockError = new Error('DB Down');
      mockGetContractsPage.mockRejectedValue(mockError);
      mockRequest.query = {};

      await controller.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );
      expect(mockNext).toHaveBeenCalledWith(mockError);
    });
  });

  describe('getContractById', () => {
    it('returns 200 with contract data', async () => {
      const contract = { id: 'abc', title: 'Test' };
      mockGetContractById.mockResolvedValue(contract);
      mockRequest.params = { id: 'abc' };
      await controller.getContractById(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith({ status: 'success', data: contract, requestId: 'unknown' });
    });

    it('delegates to next() for NotFoundError when contract missing', async () => {
      mockGetContractById.mockResolvedValue(null);
      mockRequest.params = { id: 'missing' };
      await controller.getContractById(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );
      expect(mockNext).toHaveBeenCalledWith(expect.any(Error));
      const error = (mockNext as jest.Mock).mock.calls[0][0];
      expect(error.name).toBe('AppError');
      expect(error.statusCode).toBe(404);
    });
  });

  describe('createContract', () => {
    it('returns 201 on success', async () => {
      const contract = { id: 'abc', status: 'PENDING' };
      mockCreateContract.mockResolvedValue(contract);
      await controller.createContract(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );
      expect(mockResponse.status).toHaveBeenCalledWith(201);
      expect(mockResponse.json).toHaveBeenCalledWith({
        status: 'success',
        data: contract,
        requestId: 'unknown',
      });
    });

    it('returns 422 when service throws ContractBoundsError', async () => {
      mockCreateContract.mockRejectedValue(
        new ContractBoundsError('Budget exceeds maximum contract amount'),
      );
      await controller.createContract(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );
      expect(mockResponse.status).toHaveBeenCalledWith(422);
      expect(mockResponse.json).toHaveBeenCalledWith({
        status: 'error',
        error: {
          code: 'contract_bounds_error',
          message: 'Budget exceeds maximum contract amount',
          requestId: 'unknown',
        },
      });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('delegates non-bounds errors to next()', async () => {
      const mockError = new Error('Creation failed');
      mockCreateContract.mockRejectedValue(mockError);
      await controller.createContract(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );
      expect(mockNext).toHaveBeenCalledWith(mockError);
    });
  });

  describe('getBounds', () => {
    it('returns 200 with CONTRACT_BOUNDS', () => {
      controller.getBounds(mockRequest as Request, mockResponse as Response);
      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith({
        status: 'success',
        data: CONTRACT_BOUNDS,
        requestId: 'unknown',
      });
    });
  });

  // -------------------------------------------------------------------------
  // getContractsCursor
  // -------------------------------------------------------------------------

  describe('getContractsCursor', () => {
    it('returns 200 with cursor page when no cursor is provided', async () => {
      const fakePage = { data: [], nextCursor: null, hasNextPage: false, limit: 20 };
      mockGetContractsPage.mockResolvedValue(fakePage);
      mockRequest.query = {};

      await controller.getContractsCursor(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockGetContractsPage).toHaveBeenCalledWith({ limit: 20, cursor: undefined });
      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith({
        status: 'success',
        data: fakePage,
      });
    });

    it('returns 200 with cursor page when a valid cursor is provided', async () => {
      const fakePage = { data: [{ id: 'abc' }], nextCursor: null, hasNextPage: false, limit: 10 };
      mockGetContractsPage.mockResolvedValue(fakePage);

      const validCursor = Buffer.from(
        JSON.stringify({ createdAt: '2024-01-01T00:00:00.000Z', id: 'abc-123' }),
        'utf8',
      ).toString('base64url');

      mockRequest.query = { limit: '10', cursor: validCursor };

      await controller.getContractsCursor(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockGetContractsPage).toHaveBeenCalledWith({ limit: 10, cursor: validCursor });
      expect(mockResponse.status).toHaveBeenCalledWith(200);
    });

    it('returns 400 for a malformed cursor', async () => {
      mockRequest.query = { cursor: 'not-a-valid-cursor' };

      await controller.getContractsCursor(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith({
        status: 'error',
        message: expect.stringMatching(/invalid pagination cursor/i),
      });
    });

    it('calls next() when service throws', async () => {
      const mockError = new Error('DB Down');
      mockGetContractsPage.mockRejectedValue(mockError);
      mockRequest.query = {};

      await controller.getContractsCursor(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockNext).toHaveBeenCalledWith(mockError);
    });
  });

  // -------------------------------------------------------------------------
  // updateContract
  // -------------------------------------------------------------------------

  describe('updateContract', () => {
    it('returns 200 on success', async () => {
      const updatedContract = { id: 'abc', title: 'Updated', version: 1 };
      mockRequest.params = { id: 'abc' };
      mockRequest.body = { version: 0, title: 'Updated' };
      mockUpdateContract.mockResolvedValue(updatedContract);

      await controller.updateContract(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockUpdateContract).toHaveBeenCalledWith('abc', { version: 0, title: 'Updated' });
      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith({
        status: 'success',
        data: updatedContract,
        requestId: 'unknown',
      });
    });

    it('returns 422 on ContractBoundsError', async () => {
      mockRequest.params = { id: 'abc' };
      mockRequest.body = { version: 0, budget: 999_000_000_000_000_000 };
      mockUpdateContract.mockRejectedValue(
        new ContractBoundsError('Budget exceeds maximum contract amount'),
      );

      await controller.updateContract(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockResponse.status).toHaveBeenCalledWith(422);
      expect(mockResponse.json).toHaveBeenCalledWith({
        status: 'error',
        error: {
          code: 'contract_bounds_error',
          message: 'Budget exceeds maximum contract amount',
          requestId: 'unknown',
        },
      });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('delegates non-bounds errors to next()', async () => {
      const mockError = new Error('Update failed');
      mockRequest.params = { id: 'abc' };
      mockUpdateContract.mockRejectedValue(mockError);

      await controller.updateContract(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockNext).toHaveBeenCalledWith(mockError);
    });
  });

  // -------------------------------------------------------------------------
  // deleteContract
  // -------------------------------------------------------------------------

  describe('deleteContract', () => {
    it('returns 200 on success', async () => {
      mockDeleteContract.mockResolvedValue(undefined);
      mockRequest.params = { id: 'abc' };

      await controller.deleteContract(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockDeleteContract).toHaveBeenCalledWith('abc');
      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith({
        status: 'success',
        data: { message: 'Contract deleted successfully' },
        requestId: 'unknown',
      });
    });

    it('delegates errors to next()', async () => {
      const mockError = new Error('Delete failed');
      mockDeleteContract.mockRejectedValue(mockError);
      mockRequest.params = { id: 'abc' };

      await controller.deleteContract(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockNext).toHaveBeenCalledWith(mockError);
    });
  });

  // -------------------------------------------------------------------------
  // getContractStats
  // -------------------------------------------------------------------------

  describe('getContractStats', () => {
    it('returns 200 with stats', async () => {
      const stats = { total: 5, totalBudget: 10000, byStatus: { draft: 3, active: 2 } };
      mockGetContractStats.mockResolvedValue(stats);

      await controller.getContractStats(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith({
        status: 'success',
        data: stats,
        requestId: 'unknown',
      });
    });

    it('delegates errors to next()', async () => {
      const mockError = new Error('Stats failed');
      mockGetContractStats.mockRejectedValue(mockError);

      await controller.getContractStats(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockNext).toHaveBeenCalledWith(mockError);
    });
  });
});
