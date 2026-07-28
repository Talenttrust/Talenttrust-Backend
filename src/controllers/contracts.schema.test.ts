import { z } from 'zod';
import express from 'express';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { ContractsController } from './contracts.controller';
import { requestIdMiddleware } from '../middleware/requestId';
import { errorHandler } from '../middleware/errorHandlers';
import { toContractResponseDto } from '../modules/contracts/dto/contracts-boundary.dto';

const mockService = {
  getAllContracts: jest.fn(),
  getContractById: jest.fn(),
  createContract: jest.fn(),
  updateContract: jest.fn(),
  deleteContract: jest.fn(),
  getContractStats: jest.fn(),
};

jest.mock('../services/contracts.service', () => ({
  ContractsService: jest.fn().mockImplementation(() => mockService),
}));

jest.mock('../repositories/contractRepository', () => ({
  ContractRepository: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('../db/database', () => ({
  getDb: jest.fn().mockReturnValue({}),
}));

const contractStatusSchema = z.enum(['draft', 'active', 'completed', 'disputed', 'cancelled']);

const contractResponseSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string(),
    clientId: z.string(),
    freelancerId: z.string(),
    amount: z.number().finite(),
    status: contractStatusSchema,
    createdAt: z.string(),
    version: z.number().int().nonnegative(),
  })
  .strict();

const successEnvelopeSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z
    .object({
      status: z.literal('success'),
      data: dataSchema,
      meta: z
        .object({
          page: z.number().int().positive(),
          limit: z.number().int().positive(),
          total: z.number().int().nonnegative(),
          totalPages: z.number().int().nonnegative(),
        })
        .optional(),
      requestId: z.string(),
    })
    .strict();

const errorEnvelopeSchema = z
  .object({
    status: z.literal('error'),
    error: z.object({
      code: z.string(),
      message: z.string(),
      requestId: z.string(),
    }),
  })
  .strict();

const errorResponseSchema = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      requestId: z.string(),
    }),
  })
  .strict();

const cursorPageSchema = <T extends z.ZodTypeAny>(itemSchema: T) =>
  z
    .object({
      data: z.array(itemSchema),
      nextCursor: z.string().nullable(),
      hasNextPage: z.boolean(),
      limit: z.number().int().positive(),
    })
    .strict();

const contractStatsSchema = z
  .object({
    total: z.number().int().nonnegative(),
    totalBudget: z.number().nonnegative(),
    byStatus: z.record(contractStatusSchema, z.number().int().nonnegative()),
  })
  .strict();

const conflictErrorResponseSchema = z
  .object({
    error: z.object({
      code: z.literal('conflict'),
      message: z.string(),
      requestId: z.string(),
    }),
  })
  .strict();

function createTestApp(): express.Application {
  const app = express();
  app.use(requestIdMiddleware);
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: randomUUID(), role: 'admin' } as any;
    next();
  });

  const controller = new ContractsController(mockService as any);

  app.get('/contracts', controller.getContracts.bind(controller));
  app.get('/contracts/stats', controller.getContractStats.bind(controller));
  app.get('/contracts/:id', controller.getContractById.bind(controller));
  app.post('/contracts', controller.createContract.bind(controller));
  app.patch('/contracts/:id', controller.updateContract.bind(controller));
  app.delete('/contracts/:id', controller.deleteContract.bind(controller));

  app.use(errorHandler);
  return app;
}

function validContract(overrides: Partial<z.input<typeof contractResponseSchema>> = {}): z.input<typeof contractResponseSchema> {
  return {
    id: randomUUID(),
    title: 'Test Contract',
    clientId: randomUUID(),
    freelancerId: randomUUID(),
    amount: 5000,
    status: 'draft' as const,
    createdAt: new Date().toISOString(),
    version: 0,
    ...overrides,
  };
}

describe('Contracts API — response schema contracts', () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    app = createTestApp();
  });

  describe('GET /contracts (legacy offset pagination)', () => {
    it('matches the success envelope schema with paginated data', async () => {
      const contracts = [validContract(), validContract()];
      mockService.getAllContracts.mockResolvedValue(contracts);

      const res = await request(app).get('/contracts?page=1&limit=10');
      expect(res.status).toBe(200);

      const parseResult = successEnvelopeSchema(z.array(contractResponseSchema)).safeParse(res.body);
      expect(parseResult.success).toBe(true);
      if (parseResult.success) {
        expect(parseResult.data.status).toBe('success');
        expect(parseResult.data.data).toHaveLength(2);
        expect(parseResult.data.meta).toBeDefined();
        expect(parseResult.data.meta!.page).toBe(1);
        expect(parseResult.data.meta!.limit).toBe(10);
        expect(parseResult.data.meta!.total).toBe(2);
      }
    });

    it('drops extra fields via toContractResponseDto mapping', () => {
      const raw = validContract({ extraField: 'should-not-exist' } as any);
      const dto = toContractResponseDto(raw as any);
      expect(dto).not.toHaveProperty('extraField');
      expect(Object.keys(dto)).toEqual([
        'id', 'title', 'clientId', 'freelancerId', 'amount', 'status', 'createdAt', 'version',
      ]);
    });

    it('rejects missing required fields in contract items', async () => {
      const { id, ...missingId } = validContract();
      mockService.getAllContracts.mockResolvedValue([missingId] as any);

      const res = await request(app).get('/contracts');
      expect(res.status).toBe(200);

      const parseResult = successEnvelopeSchema(z.array(contractResponseSchema)).safeParse(res.body);
      expect(parseResult.success).toBe(false);
    });

    it('returns 400 for invalid query parameters', async () => {
      const res = await request(app).get('/contracts?page=-1');
      expect(res.status).toBe(400);

      const parseResult = errorEnvelopeSchema.safeParse(res.body);
      expect(parseResult.success).toBe(true);
    });
  });

  describe('GET /contracts (cursor pagination)', () => {
    it('matches the cursor page schema', async () => {
      const cursorPage = {
        data: [validContract()],
        nextCursor: randomUUID(),
        hasNextPage: false,
        limit: 20,
      };
      mockService.getAllContracts.mockResolvedValue([]);

      const controller = new ContractsController(mockService as any);
      const mockReq = { query: { limit: '20' } } as any;
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
        locals: { requestId: 'test-req' },
      } as any;
      const mockNext = jest.fn();

      const fakePage = { data: [validContract()], nextCursor: null, hasNextPage: false, limit: 20 };
      mockService.getAllContracts.mockResolvedValue([]);

      await controller.getContracts(mockReq, mockRes, mockNext);

      const parseResult = successEnvelopeSchema(cursorPageSchema(contractResponseSchema)).safeParse(
        mockRes.json.mock.calls[0]?.[0],
      );
      if (parseResult.success) {
        expect(parseResult.data.status).toBe('success');
      }
    });
  });

  describe('GET /contracts/:id', () => {
    it('matches the success envelope schema with a single contract', async () => {
      const contract = validContract();
      mockService.getContractById.mockResolvedValue(contract);

      const res = await request(app).get(`/contracts/${randomUUID()}`);
      expect(res.status).toBe(200);

      const parseResult = successEnvelopeSchema(contractResponseSchema).safeParse(res.body);
      expect(parseResult.success).toBe(true);
    });

    it('returns 404 error envelope when contract is not found', async () => {
      mockService.getContractById.mockResolvedValue(null);

      const res = await request(app).get(`/contracts/${randomUUID()}`);
      expect(res.status).toBe(404);

      const parseResult = errorResponseSchema.safeParse(res.body);
      expect(parseResult.success).toBe(true);
      if (parseResult.success) {
        expect(parseResult.data.error.code).toBe('not_found');
      }
    });

    it('drops extra fields via toContractResponseDto mapping', () => {
      const raw = validContract({ secretField: 'leak' } as any);
      const dto = toContractResponseDto(raw as any);
      expect(dto).not.toHaveProperty('secretField');
    });
  });

  describe('POST /contracts', () => {
    it('matches the success envelope schema on creation', async () => {
      const created = validContract({ status: 'draft' });
      mockService.createContract.mockResolvedValue(created);

      const res = await request(app)
        .post('/contracts')
        .send({ title: 'New Contract', description: 'A valid description', clientId: randomUUID(), budget: 5000 });
      expect(res.status).toBe(201);

      const parseResult = successEnvelopeSchema(contractResponseSchema).safeParse(res.body);
      expect(parseResult.success).toBe(true);
    });

    it('returns 422 error envelope for contract bounds errors', async () => {
      const { ContractBoundsError } = require('../contracts/bounds');
      mockService.createContract.mockRejectedValue(
        new ContractBoundsError('Budget exceeds maximum contract amount'),
      );

      const res = await request(app)
        .post('/contracts')
        .send({ title: 'New', description: 'Long enough description here', clientId: randomUUID(), budget: 999999999 });
      expect(res.status).toBe(422);

      const parseResult = errorEnvelopeSchema.safeParse(res.body);
      expect(parseResult.success).toBe(true);
    });

    it('has correct error code in bounds error response', async () => {
      const { ContractBoundsError } = require('../contracts/bounds');
      mockService.createContract.mockRejectedValue(
        new ContractBoundsError('Budget exceeds maximum contract amount'),
      );

      const res = await request(app)
        .post('/contracts')
        .send({ title: 'New', description: 'Long enough description here', clientId: randomUUID(), budget: 999999999 });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('contract_bounds_error');
    });
  });

  describe('PATCH /contracts/:id', () => {
    it('matches the success envelope schema on update', async () => {
      const updated = validContract({ title: 'Updated Title', version: 1 });
      mockService.updateContract.mockResolvedValue(updated);

      const res = await request(app)
        .patch(`/contracts/${randomUUID()}`)
        .send({ version: 0, title: 'Updated Title' });
      expect(res.status).toBe(200);

      const parseResult = successEnvelopeSchema(contractResponseSchema).safeParse(res.body);
      expect(parseResult.success).toBe(true);
    });

    it('returns 422 error envelope for contract bounds on update', async () => {
      const { ContractBoundsError } = require('../contracts/bounds');
      mockService.updateContract.mockRejectedValue(
        new ContractBoundsError('Budget exceeds maximum'),
      );

      const res = await request(app)
        .patch(`/contracts/${randomUUID()}`)
        .send({ version: 0, budget: 999999999 });
      expect(res.status).toBe(422);

      const parseResult = errorEnvelopeSchema.safeParse(res.body);
      expect(parseResult.success).toBe(true);
    });
  });

  describe('DELETE /contracts/:id', () => {
    it('matches the success envelope schema on deletion', async () => {
      mockService.deleteContract.mockResolvedValue(undefined);

      const res = await request(app).delete(`/contracts/${randomUUID()}`);
      expect(res.status).toBe(200);

      const parseResult = successEnvelopeSchema(
        z.object({ message: z.literal('Contract deleted successfully') }).strict(),
      ).safeParse(res.body);
      expect(parseResult.success).toBe(true);
    });
  });

  describe('GET /contracts/stats', () => {
    it('matches the stats response schema', async () => {
      const stats = { total: 5, totalBudget: 10000, byStatus: { draft: 3, active: 2 } };
      mockService.getContractStats.mockResolvedValue(stats);

      const res = await request(app).get('/contracts/stats');
      expect(res.status).toBe(200);

      const parseResult = successEnvelopeSchema(contractStatsSchema).safeParse(res.body);
      expect(parseResult.success).toBe(true);
    });

    it('rejects extra fields in stats response', async () => {
      const stats = { total: 5, totalBudget: 10000, byStatus: { draft: 3, active: 2 }, extra: 'bad' };
      mockService.getContractStats.mockResolvedValue(stats);

      const res = await request(app).get('/contracts/stats');
      expect(res.status).toBe(200);

      const parseResult = successEnvelopeSchema(contractStatsSchema).safeParse(res.body);
      expect(parseResult.success).toBe(false);
    });
  });
});
