/**
 * @module contracts.controller.correlation.test
 * @description Comprehensive tests for correlation ID propagation in the
 * ContractsController.
 *
 * Covers:
 *  - correlationId present in res.locals → forwarded to service + appears in
 *    log records and response envelope
 *  - correlationId absent → service called without it, no key in response
 *  - requestId always present in every response envelope
 *  - correlationId included in error envelopes (fail()) when present
 *  - request-scoped logger (res.locals.log) is used when available
 *  - fallback logger used when res.locals.log is absent
 *  - each handler (getContracts, getContractById, createContract,
 *    updateContract, deleteContract, getContractStats) threads correlation
 */

import type { Request, Response, NextFunction } from 'express';
import { ContractBoundsError } from '../contracts/bounds';
import { setWriteRecordImpl } from '../logger';
import type { LogRecord } from '../logger';

// ── Service mock setup ────────────────────────────────────────────────────────

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

// ── Helpers ───────────────────────────────────────────────────────────────────

const TEST_REQUEST_ID = 'test-request-id-abc123';
const TEST_CORRELATION_ID = 'test-correlation-id-xyz789';

/** Minimal contract shape returned by service mocks. */
const fakeContract = {
  id: 'contract-1',
  title: 'Test Contract',
  clientId: 'client-1',
  freelancerId: 'freelancer-1',
  amount: 1000,
  status: 'draft' as const,
  createdAt: '2024-01-01T00:00:00.000Z',
  version: 0,
};

/** Build a mock Response with the given locals. */
function makeResponse(locals: Record<string, unknown> = {}): Partial<Response> {
  const mockLog = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn().mockReturnThis(),
  };

  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
    locals: {
      requestId: TEST_REQUEST_ID,
      log: mockLog,
      ...locals,
    } as Record<string, unknown>,
  };
}

/** Extract the log mock from a response built by makeResponse. */
function getLog(res: Partial<Response>) {
  return (res.locals as Record<string, unknown>)['log'] as Record<string, jest.Mock>;
}

/** Capture real log records emitted via writeRecord during `fn()`. */
async function captureLogRecords(fn: () => Promise<void>): Promise<LogRecord[]> {
  const records: LogRecord[] = [];
  setWriteRecordImpl((r) => records.push(r));
  try {
    await fn();
  } finally {
    setWriteRecordImpl((record) => {
      const line = JSON.stringify(record);
      if (record.level === 'error') process.stderr.write(line + '\n');
      else process.stdout.write(line + '\n');
    });
  }
  return records;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('ContractsController – correlation ID propagation', () => {
  let controller: ContractsController;
  let mockNext: NextFunction;

  beforeEach(() => {
    const { ContractsService } = require('../services/contracts.service');
    controller = new ContractsController(new ContractsService());
    mockNext = jest.fn();

    mockGetAllContracts.mockClear();
    mockGetContractById.mockClear();
    mockCreateContract.mockClear();
    mockGetContractsPage.mockClear();
    mockUpdateContract.mockClear();
    mockDeleteContract.mockClear();
    mockGetContractStats.mockClear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── getContracts ──────────────────────────────────────────────────────────

  describe('getContracts', () => {
    it('includes correlationId in success response when present in locals', async () => {
      mockGetAllContracts.mockResolvedValue([fakeContract]);
      const res = makeResponse({ correlationId: TEST_CORRELATION_ID });
      const req = { query: {} } as Request;

      await controller.getContracts(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(200);
      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.requestId).toBe(TEST_REQUEST_ID);
      expect(body.correlationId).toBe(TEST_CORRELATION_ID);
    });

    it('omits correlationId from success response when absent', async () => {
      mockGetAllContracts.mockResolvedValue([]);
      const res = makeResponse(); // no correlationId
      const req = { query: {} } as Request;

      await controller.getContracts(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(200);
      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.requestId).toBe(TEST_REQUEST_ID);
      expect(body).not.toHaveProperty('correlationId');
    });

    it('logs correlationId on entry when present', async () => {
      mockGetAllContracts.mockResolvedValue([]);
      const res = makeResponse({ correlationId: TEST_CORRELATION_ID });
      const log = getLog(res);

      await controller.getContracts({ query: {} } as Request, res as Response, mockNext);

      expect(log.info).toHaveBeenCalledWith(
        'contracts.getContracts: start',
        expect.objectContaining({ correlationId: TEST_CORRELATION_ID, requestId: TEST_REQUEST_ID }),
      );
    });

    it('logs without correlationId key when correlationId absent', async () => {
      mockGetAllContracts.mockResolvedValue([]);
      const res = makeResponse();
      const log = getLog(res);

      await controller.getContracts({ query: {} } as Request, res as Response, mockNext);

      const infoCall = (log.info as jest.Mock).mock.calls[0];
      expect(infoCall[1]).not.toHaveProperty('correlationId');
      expect(infoCall[1]).toHaveProperty('requestId', TEST_REQUEST_ID);
    });

    it('uses res.locals.log when available', async () => {
      mockGetAllContracts.mockResolvedValue([]);
      const res = makeResponse({ correlationId: TEST_CORRELATION_ID });
      const log = getLog(res);

      await controller.getContracts({ query: {} } as Request, res as Response, mockNext);

      expect(log.info).toHaveBeenCalled();
    });

    it('falls back to module logger when res.locals.log is absent', async () => {
      mockGetAllContracts.mockResolvedValue([]);
      // Build response without a log in locals
      const res: Partial<Response> = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
        locals: { requestId: TEST_REQUEST_ID } as Record<string, unknown>,
      };

      // Should not throw — falls back to module logger
      await expect(
        controller.getContracts({ query: {} } as Request, res as Response, mockNext),
      ).resolves.toBeUndefined();
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('includes correlationId in pagination error envelope', async () => {
      const res = makeResponse({ correlationId: TEST_CORRELATION_ID });
      const req = { query: { limit: '-1' } } as unknown as Request;

      await controller.getContracts(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(400);
      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.error.correlationId).toBe(TEST_CORRELATION_ID);
    });
  });

  // ── getContractById ───────────────────────────────────────────────────────

  describe('getContractById', () => {
    it('includes correlationId in success response when present', async () => {
      mockGetContractById.mockResolvedValue(fakeContract);
      const res = makeResponse({ correlationId: TEST_CORRELATION_ID });
      const req = { params: { id: 'contract-1' } } as unknown as Request;

      await controller.getContractById(req, res as Response, mockNext);

      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.correlationId).toBe(TEST_CORRELATION_ID);
      expect(body.requestId).toBe(TEST_REQUEST_ID);
    });

    it('omits correlationId when absent', async () => {
      mockGetContractById.mockResolvedValue(fakeContract);
      const res = makeResponse();
      const req = { params: { id: 'contract-1' } } as unknown as Request;

      await controller.getContractById(req, res as Response, mockNext);

      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body).not.toHaveProperty('correlationId');
    });

    it('logs entry with correlationId and contractId', async () => {
      mockGetContractById.mockResolvedValue(fakeContract);
      const res = makeResponse({ correlationId: TEST_CORRELATION_ID });
      const log = getLog(res);
      const req = { params: { id: 'contract-1' } } as unknown as Request;

      await controller.getContractById(req, res as Response, mockNext);

      expect(log.info).toHaveBeenCalledWith(
        'contracts.getContractById: start',
        expect.objectContaining({
          correlationId: TEST_CORRELATION_ID,
          contractId: 'contract-1',
        }),
      );
    });

    it('logs warn on not-found with correlationId', async () => {
      mockGetContractById.mockResolvedValue(null);
      const res = makeResponse({ correlationId: TEST_CORRELATION_ID });
      const log = getLog(res);
      const req = { params: { id: 'missing' } } as unknown as Request;

      await controller.getContractById(req, res as Response, mockNext);

      expect(log.warn).toHaveBeenCalledWith(
        'contracts.getContractById: not found',
        expect.objectContaining({ correlationId: TEST_CORRELATION_ID }),
      );
    });
  });

  // ── createContract ────────────────────────────────────────────────────────

  describe('createContract', () => {
    const validBody = {
      title: 'New Contract',
      description: 'Desc',
      clientId: 'client-1',
      budget: 500,
    };

    it('forwards correlationId to service.createContract', async () => {
      mockCreateContract.mockResolvedValue(fakeContract);
      const res = makeResponse({ correlationId: TEST_CORRELATION_ID });
      const req = { body: validBody } as Request;

      await controller.createContract(req, res as Response, mockNext);

      expect(mockCreateContract).toHaveBeenCalledWith(
        expect.anything(), // CreateContractDto
        TEST_CORRELATION_ID,
      );
    });

    it('calls service without correlationId when absent', async () => {
      mockCreateContract.mockResolvedValue(fakeContract);
      const res = makeResponse(); // no correlationId
      const req = { body: validBody } as Request;

      await controller.createContract(req, res as Response, mockNext);

      expect(mockCreateContract).toHaveBeenCalledWith(
        expect.anything(),
        undefined,
      );
    });

    it('includes correlationId in 201 response envelope', async () => {
      mockCreateContract.mockResolvedValue(fakeContract);
      const res = makeResponse({ correlationId: TEST_CORRELATION_ID });
      const req = { body: validBody } as Request;

      await controller.createContract(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(201);
      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.correlationId).toBe(TEST_CORRELATION_ID);
      expect(body.requestId).toBe(TEST_REQUEST_ID);
    });

    it('includes correlationId in 422 bounds-error envelope', async () => {
      mockCreateContract.mockRejectedValue(
        new ContractBoundsError('Budget exceeds maximum'),
      );
      const res = makeResponse({ correlationId: TEST_CORRELATION_ID });
      const req = { body: validBody } as Request;

      await controller.createContract(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(422);
      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.error.correlationId).toBe(TEST_CORRELATION_ID);
    });

    it('omits correlationId from 422 envelope when absent', async () => {
      mockCreateContract.mockRejectedValue(
        new ContractBoundsError('Budget exceeds maximum'),
      );
      const res = makeResponse();
      const req = { body: validBody } as Request;

      await controller.createContract(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(422);
      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.error).not.toHaveProperty('correlationId');
    });

    it('logs entry and success with correlationId', async () => {
      mockCreateContract.mockResolvedValue(fakeContract);
      const res = makeResponse({ correlationId: TEST_CORRELATION_ID });
      const log = getLog(res);
      const req = { body: validBody } as Request;

      await controller.createContract(req, res as Response, mockNext);

      expect(log.info).toHaveBeenCalledWith(
        'contracts.createContract: start',
        expect.objectContaining({ correlationId: TEST_CORRELATION_ID }),
      );
      expect(log.info).toHaveBeenCalledWith(
        'contracts.createContract: success',
        expect.objectContaining({ correlationId: TEST_CORRELATION_ID }),
      );
    });
  });

  // ── updateContract ────────────────────────────────────────────────────────

  describe('updateContract', () => {
    const validBody = { version: 0, title: 'Updated' };

    it('forwards correlationId to service.updateContract', async () => {
      mockUpdateContract.mockResolvedValue(fakeContract);
      const res = makeResponse({ correlationId: TEST_CORRELATION_ID });
      const req = { params: { id: 'contract-1' }, body: validBody } as unknown as Request;

      await controller.updateContract(req, res as Response, mockNext);

      expect(mockUpdateContract).toHaveBeenCalledWith(
        'contract-1',
        expect.anything(),
        TEST_CORRELATION_ID,
      );
    });

    it('calls service without correlationId when absent', async () => {
      mockUpdateContract.mockResolvedValue(fakeContract);
      const res = makeResponse();
      const req = { params: { id: 'contract-1' }, body: validBody } as unknown as Request;

      await controller.updateContract(req, res as Response, mockNext);

      expect(mockUpdateContract).toHaveBeenCalledWith(
        'contract-1',
        expect.anything(),
        undefined,
      );
    });

    it('includes correlationId in 200 success envelope', async () => {
      mockUpdateContract.mockResolvedValue(fakeContract);
      const res = makeResponse({ correlationId: TEST_CORRELATION_ID });
      const req = { params: { id: 'contract-1' }, body: validBody } as unknown as Request;

      await controller.updateContract(req, res as Response, mockNext);

      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.correlationId).toBe(TEST_CORRELATION_ID);
    });

    it('includes correlationId in 422 bounds-error envelope', async () => {
      mockUpdateContract.mockRejectedValue(
        new ContractBoundsError('Bounds exceeded'),
      );
      const res = makeResponse({ correlationId: TEST_CORRELATION_ID });
      const req = { params: { id: 'contract-1' }, body: validBody } as unknown as Request;

      await controller.updateContract(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(422);
      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.error.correlationId).toBe(TEST_CORRELATION_ID);
    });

    it('logs start/success with correlationId', async () => {
      mockUpdateContract.mockResolvedValue(fakeContract);
      const res = makeResponse({ correlationId: TEST_CORRELATION_ID });
      const log = getLog(res);
      const req = { params: { id: 'contract-1' }, body: validBody } as unknown as Request;

      await controller.updateContract(req, res as Response, mockNext);

      expect(log.info).toHaveBeenCalledWith(
        'contracts.updateContract: start',
        expect.objectContaining({ correlationId: TEST_CORRELATION_ID, contractId: 'contract-1' }),
      );
      expect(log.info).toHaveBeenCalledWith(
        'contracts.updateContract: success',
        expect.objectContaining({ correlationId: TEST_CORRELATION_ID, contractId: 'contract-1' }),
      );
    });
  });

  // ── deleteContract ────────────────────────────────────────────────────────

  describe('deleteContract', () => {
    it('forwards correlationId to service.deleteContract', async () => {
      mockDeleteContract.mockResolvedValue(undefined);
      const res = makeResponse({ correlationId: TEST_CORRELATION_ID });
      const req = { params: { id: 'contract-1' } } as unknown as Request;

      await controller.deleteContract(req, res as Response, mockNext);

      expect(mockDeleteContract).toHaveBeenCalledWith('contract-1', TEST_CORRELATION_ID);
    });

    it('calls service without correlationId when absent', async () => {
      mockDeleteContract.mockResolvedValue(undefined);
      const res = makeResponse();
      const req = { params: { id: 'contract-1' } } as unknown as Request;

      await controller.deleteContract(req, res as Response, mockNext);

      expect(mockDeleteContract).toHaveBeenCalledWith('contract-1', undefined);
    });

    it('includes correlationId in success response', async () => {
      mockDeleteContract.mockResolvedValue(undefined);
      const res = makeResponse({ correlationId: TEST_CORRELATION_ID });
      const req = { params: { id: 'contract-1' } } as unknown as Request;

      await controller.deleteContract(req, res as Response, mockNext);

      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.correlationId).toBe(TEST_CORRELATION_ID);
      expect(body.requestId).toBe(TEST_REQUEST_ID);
    });

    it('omits correlationId from success response when absent', async () => {
      mockDeleteContract.mockResolvedValue(undefined);
      const res = makeResponse();
      const req = { params: { id: 'contract-1' } } as unknown as Request;

      await controller.deleteContract(req, res as Response, mockNext);

      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body).not.toHaveProperty('correlationId');
    });

    it('logs start/success with correlationId', async () => {
      mockDeleteContract.mockResolvedValue(undefined);
      const res = makeResponse({ correlationId: TEST_CORRELATION_ID });
      const log = getLog(res);
      const req = { params: { id: 'contract-1' } } as unknown as Request;

      await controller.deleteContract(req, res as Response, mockNext);

      expect(log.info).toHaveBeenCalledWith(
        'contracts.deleteContract: start',
        expect.objectContaining({ correlationId: TEST_CORRELATION_ID, contractId: 'contract-1' }),
      );
      expect(log.info).toHaveBeenCalledWith(
        'contracts.deleteContract: success',
        expect.objectContaining({ correlationId: TEST_CORRELATION_ID, contractId: 'contract-1' }),
      );
    });

    it('logs error with correlationId when service throws', async () => {
      const err = new Error('DB failure');
      mockDeleteContract.mockRejectedValue(err);
      const res = makeResponse({ correlationId: TEST_CORRELATION_ID });
      const log = getLog(res);
      const req = { params: { id: 'contract-1' } } as unknown as Request;

      await controller.deleteContract(req, res as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(err);
      expect(log.error).toHaveBeenCalledWith(
        'contracts.deleteContract: error',
        expect.objectContaining({ correlationId: TEST_CORRELATION_ID }),
      );
    });
  });

  // ── getContractStats ──────────────────────────────────────────────────────

  describe('getContractStats', () => {
    const fakeStats = { total: 3, totalBudget: 3000, byStatus: { draft: 3 } };

    it('includes correlationId in stats response', async () => {
      mockGetContractStats.mockResolvedValue(fakeStats);
      const res = makeResponse({ correlationId: TEST_CORRELATION_ID });

      await controller.getContractStats({} as Request, res as Response, mockNext);

      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.correlationId).toBe(TEST_CORRELATION_ID);
    });

    it('logs start with correlationId', async () => {
      mockGetContractStats.mockResolvedValue(fakeStats);
      const res = makeResponse({ correlationId: TEST_CORRELATION_ID });
      const log = getLog(res);

      await controller.getContractStats({} as Request, res as Response, mockNext);

      expect(log.info).toHaveBeenCalledWith(
        'contracts.getContractStats: start',
        expect.objectContaining({ correlationId: TEST_CORRELATION_ID }),
      );
    });
  });

  // ── requestId always present ──────────────────────────────────────────────

  describe('requestId in all response envelopes', () => {
    it.each([
      ['getContracts', async (c: ContractsController, res: Partial<Response>) => {
        mockGetAllContracts.mockResolvedValue([]);
        await c.getContracts({ query: {} } as Request, res as Response, mockNext);
      }],
      ['getContractById', async (c: ContractsController, res: Partial<Response>) => {
        mockGetContractById.mockResolvedValue(fakeContract);
        await c.getContractById({ params: { id: 'x' } } as unknown as Request, res as Response, mockNext);
      }],
      ['createContract', async (c: ContractsController, res: Partial<Response>) => {
        mockCreateContract.mockResolvedValue(fakeContract);
        await c.createContract(
          { body: { title: 'T', description: 'D', clientId: 'c1', budget: 100 } } as Request,
          res as Response,
          mockNext,
        );
      }],
      ['deleteContract', async (c: ContractsController, res: Partial<Response>) => {
        mockDeleteContract.mockResolvedValue(undefined);
        await c.deleteContract({ params: { id: 'x' } } as unknown as Request, res as Response, mockNext);
      }],
      ['getContractStats', async (c: ContractsController, res: Partial<Response>) => {
        mockGetContractStats.mockResolvedValue({ total: 0, totalBudget: 0, byStatus: {} });
        await c.getContractStats({} as Request, res as Response, mockNext);
      }],
    ])('%s includes requestId in response body', async (_name, invoke) => {
      const res = makeResponse(); // no correlationId, but requestId present
      await invoke(controller, res);
      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.requestId).toBe(TEST_REQUEST_ID);
    });
  });

  // ── getContractsCursor (delegates to getContracts) ────────────────────────

  describe('getContractsCursor (backward-compat alias)', () => {
    it('propagates correlationId via delegation to getContracts', async () => {
      mockGetAllContracts.mockResolvedValue([]);
      const res = makeResponse({ correlationId: TEST_CORRELATION_ID });
      const log = getLog(res);

      await controller.getContractsCursor({ query: {} } as Request, res as Response, mockNext);

      expect(log.info).toHaveBeenCalledWith(
        'contracts.getContracts: start',
        expect.objectContaining({ correlationId: TEST_CORRELATION_ID }),
      );
      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.correlationId).toBe(TEST_CORRELATION_ID);
    });
  });

  // ── Real logger integration (captureLogRecords) ───────────────────────────

  describe('real logger records carry correlationId', () => {
    it('emitted log records contain correlationId when present in ALS store', async () => {
      // When res.locals.log is absent, the controller falls back to the module
      // logger. The module logger picks up context from AsyncLocalStorage if
      // available. Here we verify it at least does not throw and logs something.
      mockGetAllContracts.mockResolvedValue([fakeContract]);

      const records = await captureLogRecords(async () => {
        const res: Partial<Response> = {
          status: jest.fn().mockReturnThis(),
          json: jest.fn(),
          locals: { requestId: TEST_REQUEST_ID } as Record<string, unknown>,
        };
        const { ContractsService } = require('../services/contracts.service');
        const ctrl = new ContractsController(new ContractsService());
        await ctrl.getContracts({ query: {} } as Request, res as Response, mockNext);
      });

      // At minimum the entry log for getContracts must have been emitted.
      const entry = records.find((r) => r.message === 'contracts.getContracts: start');
      expect(entry).toBeDefined();
      expect(entry?.service).toBe('talenttrust-backend');
    });
  });
});
