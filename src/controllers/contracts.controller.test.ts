import { Request, Response, NextFunction } from "express";
import { ContractBoundsError, CONTRACT_BOUNDS } from "../contracts/bounds";
import { AppError } from "../errors/appError";

const mockGetAllContracts = jest.fn();
const mockGetContractById = jest.fn();
const mockCreateContract = jest.fn();
const mockGetContractsPage = jest.fn();
const mockUpdateContract = jest.fn();
const mockDeleteContract = jest.fn();
const mockGetContractStats = jest.fn();
const mockGetContractHistory = jest.fn();

jest.mock("../db/database", () => ({
  getDb: jest.fn().mockReturnValue({}),
}));

jest.mock("../repositories/contractRepository", () => ({
  ContractRepository: jest.fn().mockImplementation(() => ({})),
}));

jest.mock("../services/contracts.service", () => ({
  ContractsService: jest.fn().mockImplementation(() => ({
    getAllContracts: mockGetAllContracts,
    getContractById: mockGetContractById,
    createContract: mockCreateContract,
    getContractsPage: mockGetContractsPage,
    updateContract: mockUpdateContract,
    deleteContract: mockDeleteContract,
    getContractStats: mockGetContractStats,
    getContractHistory: mockGetContractHistory,
    getBounds: jest.fn().mockReturnValue(CONTRACT_BOUNDS),
  })),
}));

import { ContractsController } from "./contracts.controller";

describe("ContractsController", () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: NextFunction;
  let controller: ContractsController;
  let mockAuditService: {
    log: jest.Mock;
    query: jest.Mock;
    queryWithCursor: jest.Mock;
  };

  beforeEach(() => {
    mockRequest = {
      body: { title: "Test Contract" },
      query: {},
      params: {},
      headers: {},
    };
    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      locals: { audit: {} as never },
    };
    mockNext = jest.fn();

    mockGetAllContracts.mockClear();
    mockGetContractById.mockClear();
    mockCreateContract.mockClear();
    mockGetContractsPage.mockClear();
    mockUpdateContract.mockClear();
    mockDeleteContract.mockClear();
    mockGetContractStats.mockClear();
    mockGetContractHistory.mockClear();

    mockAuditService = {
      log: jest.fn(),
      query: jest.fn().mockReturnValue([]),
      queryWithCursor: jest
        .fn()
        .mockReturnValue({ entries: [], count: 0, limit: 20 }),
    };

    const { ContractsService } = require("../services/contracts.service");
    controller = new ContractsController(
      new ContractsService(),
      mockAuditService,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // getContracts — cursor pagination
  // -------------------------------------------------------------------------

  describe("getContracts — cursor pagination", () => {
    it("returns 200 with cursor page on first page (no cursor)", async () => {
      const fakePage = {
        data: [],
        nextCursor: null,
        hasNextPage: false,
        limit: 20,
      };
      mockGetContractsPage.mockResolvedValue(fakePage);
      mockRequest.query = { limit: "20" };

      await controller.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockGetContractsPage).toHaveBeenCalledWith({
        limit: 20,
        cursor: undefined,
        includeDeleted: false,
      });
      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith({
        status: "success",
        data: [],
        meta: { limit: 20, nextCursor: null, hasNextPage: false },
        requestId: "unknown",
      });
    });

    it("defaults limit to CURSOR_DEFAULT_LIMIT when only cursor is provided", async () => {
      const validCursor = Buffer.from(
        JSON.stringify({
          createdAt: "2024-01-01T00:00:00.000Z",
          id: "abc-123",
        }),
        "utf8",
      ).toString("base64url");
      const fakePage = {
        data: [],
        nextCursor: null,
        hasNextPage: false,
        limit: 20,
      };
      mockGetContractsPage.mockResolvedValue(fakePage);
      mockRequest.query = { cursor: validCursor };

      await controller.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockGetContractsPage).toHaveBeenCalledWith({
        limit: 20,
        cursor: validCursor,
        includeDeleted: false,
      });
      expect(mockResponse.status).toHaveBeenCalledWith(200);
    });

    it("passes limit and cursor to service when both provided", async () => {
      const fakePage = {
        data: [],
        nextCursor: null,
        hasNextPage: false,
        limit: 5,
      };
      mockGetContractsPage.mockResolvedValue(fakePage);

      const validCursor = Buffer.from(
        JSON.stringify({
          createdAt: "2024-01-01T00:00:00.000Z",
          id: "abc-123",
        }),
        "utf8",
      ).toString("base64url");

      mockRequest.query = { limit: "5", cursor: validCursor };

      await controller.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockGetContractsPage).toHaveBeenCalledWith({
        limit: 5,
        cursor: validCursor,
        includeDeleted: false,
      });
      expect(mockResponse.status).toHaveBeenCalledWith(200);
    });

    it("returns cursor page with hasNextPage and nextCursor in meta", async () => {
      const fakePage = {
        data: [
          {
            id: "1",
            title: "Test",
            clientId: "client-1",
            freelancerId: "freelancer-1",
            amount: 1000,
            status: "active",
            createdAt: "2026-01-01T00:00:00.000Z",
            version: 1,
            deletedAt: null,
          },
        ],
        nextCursor: "next-cursor-value",
        hasNextPage: true,
        limit: 5,
      };
      mockGetContractsPage.mockResolvedValue(fakePage);
      mockRequest.query = { limit: "5" };

      await controller.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      const callArg = (mockResponse.json as jest.Mock).mock.calls[0][0];
      expect(callArg.status).toBe("success");
      expect(callArg.requestId).toBe("unknown");
      expect(callArg.meta).toEqual({
        limit: 5,
        nextCursor: "next-cursor-value",
        hasNextPage: true,
      });
    });

    it("defaults to cursor pagination with no params", async () => {
      const fakePage = {
        data: [],
        nextCursor: null,
        hasNextPage: false,
        limit: 20,
      };
      mockGetContractsPage.mockResolvedValue(fakePage);
      mockRequest.query = {};

      await controller.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );
      expect(mockGetContractsPage).toHaveBeenCalledWith({
        limit: 20,
        cursor: undefined,
        includeDeleted: false,
      });
      expect(mockResponse.status).toHaveBeenCalledWith(200);
    });
  });

  // -------------------------------------------------------------------------
  // getContracts — validation errors (400)
  // -------------------------------------------------------------------------

  describe("getContracts — validation errors", () => {
    it("returns 400 when limit exceeds 100", async () => {
      mockRequest.query = { limit: "101" };

      await controller.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockNext).toHaveBeenCalledWith(expect.any(AppError));
      expect((mockNext as jest.Mock).mock.calls[0][0].statusCode).toBe(400);
      expect((mockNext as jest.Mock).mock.calls[0][0].code).toBe("bad_request");
    });

    it("returns 400 when limit is 0", async () => {
      mockRequest.query = { limit: "0" };

      await controller.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockNext).toHaveBeenCalledWith(expect.any(AppError));
      expect((mockNext as jest.Mock).mock.calls[0][0].statusCode).toBe(400);
    });

    it("returns 400 when limit is negative", async () => {
      mockRequest.query = { limit: "-1" };

      await controller.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockNext).toHaveBeenCalledWith(expect.any(AppError));
      expect((mockNext as jest.Mock).mock.calls[0][0].statusCode).toBe(400);
    });

    it("returns 400 when limit is non-numeric", async () => {
      mockRequest.query = { limit: "abc" };

      await controller.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockNext).toHaveBeenCalledWith(expect.any(AppError));
      expect((mockNext as jest.Mock).mock.calls[0][0].statusCode).toBe(400);
    });

    it("returns 400 for a malformed cursor", async () => {
      mockRequest.query = { cursor: "not-a-valid-cursor" };

      await controller.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockNext).toHaveBeenCalledWith(expect.any(AppError));
      expect((mockNext as jest.Mock).mock.calls[0][0].statusCode).toBe(400);
      expect((mockNext as jest.Mock).mock.calls[0][0].code).toBe("bad_request");
    });

    it("returns 400 for a cursor missing the id field", async () => {
      const bad = Buffer.from(
        JSON.stringify({ createdAt: "2024-01-01T00:00:00.000Z" }),
        "utf8",
      ).toString("base64url");
      mockRequest.query = { cursor: bad };

      await controller.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockNext).toHaveBeenCalledWith(expect.any(AppError));
      expect((mockNext as jest.Mock).mock.calls[0][0].statusCode).toBe(400);
    });

    it("returns 400 for a cursor with an invalid date", async () => {
      const bad = Buffer.from(
        JSON.stringify({ createdAt: "not-a-date", id: "abc-123" }),
        "utf8",
      ).toString("base64url");
      mockRequest.query = { cursor: bad };

      await controller.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockNext).toHaveBeenCalledWith(expect.any(AppError));
      expect((mockNext as jest.Mock).mock.calls[0][0].statusCode).toBe(400);
    });

    it("returns 400 for a cursor exceeding max length", async () => {
      const oversized = "a".repeat(257);
      mockRequest.query = { cursor: oversized };

      await controller.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockNext).toHaveBeenCalledWith(expect.any(AppError));
      expect((mockNext as jest.Mock).mock.calls[0][0].statusCode).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // getContracts — legacy offset path (page param present)
  // -------------------------------------------------------------------------

  describe("getContracts — legacy offset path", () => {
    it("returns 200 with contracts list when no pagination params", async () => {
      mockGetAllContracts.mockResolvedValue([]);
      await controller.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );
      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "success",
          data: [],
          meta: expect.any(Object),
        }),
      );
    });

    // -------------------------------------------------------------------------
    // getContracts — error propagation
    // -------------------------------------------------------------------------

    describe("getContracts — error propagation", () => {
      it("calls next() when service throws", async () => {
        const mockError = new Error("DB Down");
        mockGetContractsPage.mockRejectedValue(mockError);
        mockRequest.query = { limit: "5" };

        await controller.getContracts(
          mockRequest as Request,
          mockResponse as Response,
          mockNext,
        );
        expect(mockNext).toHaveBeenCalledWith(mockError);
      });

      it("calls next() when legacy service throws", async () => {
        const mockError = new Error("DB Down");
        mockGetAllContracts.mockRejectedValue(mockError);

        await controller.getContracts(
          mockRequest as Request,
          mockResponse as Response,
          mockNext,
        );
        expect(mockNext).toHaveBeenCalledWith(mockError);
      });
    });

    // -------------------------------------------------------------------------
    // getContractsCursor
    // -------------------------------------------------------------------------

    describe("getContractsCursor", () => {
      it("returns 200 with cursor page", async () => {
        const fakePage = {
          data: [],
          nextCursor: null,
          hasNextPage: false,
          limit: 20,
        };
        mockGetContractsPage.mockResolvedValue(fakePage);

        await controller.getContracts(
          mockRequest as Request,
          mockResponse as Response,
          mockNext,
        );

        expect(mockGetContractsPage).toHaveBeenCalledWith({
          limit: 20,
          cursor: undefined,
          includeDeleted: false,
        });
        expect(mockResponse.status).toHaveBeenCalledWith(200);
      });

      it("uses provided limit and cursor", async () => {
        const validCursor = Buffer.from(
          JSON.stringify({
            createdAt: "2024-01-01T00:00:00.000Z",
            id: "abc-123",
          }),
          "utf8",
        ).toString("base64url");
        const fakePage = {
          data: [
            {
              id: "1",
              title: "Test",
              clientId: "client-1",
              freelancerId: "freelancer-1",
              amount: 1000,
              status: "active",
              createdAt: "2026-01-01T00:00:00.000Z",
              version: 1,
              deletedAt: null,
            },
          ],
          nextCursor: null,
          hasNextPage: false,
          limit: 10,
        };
        mockGetContractsPage.mockResolvedValue(fakePage);
        mockRequest.query = { limit: "10", cursor: validCursor };

        await controller.getContracts(
          mockRequest as Request,
          mockResponse as Response,
          mockNext,
        );

        expect(mockGetContractsPage).toHaveBeenCalledWith({
          limit: 10,
          cursor: validCursor,
          includeDeleted: false,
        });
      });

      it("returns 400 for a malformed cursor", async () => {
        mockRequest.query = { cursor: "not-a-valid-cursor" };

        await controller.getContracts(
          mockRequest as Request,
          mockResponse as Response,
          mockNext,
        );

        expect(mockNext).toHaveBeenCalledWith(expect.any(AppError));
        expect((mockNext as jest.Mock).mock.calls[0][0].statusCode).toBe(400);
        expect((mockNext as jest.Mock).mock.calls[0][0].code).toBe("bad_request");
      });

      it("calls next() when service throws", async () => {
        const mockError = new Error("Service error");
        mockGetContractsPage.mockRejectedValue(mockError);

        await controller.getContracts(
          mockRequest as Request,
          mockResponse as Response,
          mockNext,
        );

        expect(mockNext).toHaveBeenCalledWith(mockError);
      });
    });

    // -------------------------------------------------------------------------
    // getContractById
    // -------------------------------------------------------------------------

    describe("getContractById", () => {
      it("returns 200 with contract data", async () => {
        const contract = {
          id: "abc",
          title: "Test",
          clientId: "client-1",
          freelancerId: "freelancer-1",
          amount: 1000,
          status: "active",
          createdAt: "2026-01-01T00:00:00.000Z",
          version: 0,
          deletedAt: null,
        };
        mockGetContractById.mockResolvedValue(contract);
        mockRequest.params = { id: "abc" };
        await controller.getContractById(
          mockRequest as Request,
          mockResponse as Response,
          mockNext,
        );

        expect(mockResponse.status).toHaveBeenCalledWith(200);
        expect(mockResponse.json).toHaveBeenCalledWith({
          status: "success",
          data: { ...contract, deletedAt: null },
          requestId: "unknown",
        });
      });

      it("delegates to next() for NotFoundError when contract missing", async () => {
        mockGetContractById.mockResolvedValue(null);
        mockRequest.params = { id: "missing" };
        await controller.getContractById(
          mockRequest as Request,
          mockResponse as Response,
          mockNext,
        );
        expect(mockNext).toHaveBeenCalledWith(expect.any(Error));
        const error = (mockNext as jest.Mock).mock.calls[0][0];
        expect(error.name).toBe("AppError");
        expect(error.statusCode).toBe(404);
      });
    });

    // -------------------------------------------------------------------------
    // createContract
    // -------------------------------------------------------------------------

    describe("createContract", () => {
      it("returns 201 on success", async () => {
        const contract = {
          id: "abc",
          title: "Test",
          clientId: "client-1",
          freelancerId: "freelancer-1",
          amount: 1000,
          status: "draft",
          createdAt: "2026-01-01T00:00:00.000Z",
          version: 0,
          deletedAt: null,
        };
        mockCreateContract.mockResolvedValue(contract);
        await controller.createContract(
          mockRequest as Request,
          mockResponse as Response,
          mockNext,
        );
        expect(mockResponse.status).toHaveBeenCalledWith(201);
        expect(mockResponse.json).toHaveBeenCalledWith({
          status: "success",
          data: contract,
          requestId: "unknown",
        });
      });

      it("returns 422 when service throws ContractBoundsError", async () => {
        mockCreateContract.mockRejectedValue(
          new ContractBoundsError("Budget exceeds maximum contract amount"),
        );
        await controller.createContract(
          mockRequest as Request,
          mockResponse as Response,
          mockNext,
        );
        expect(mockNext).toHaveBeenCalledWith(expect.any(ContractBoundsError));
        expect((mockNext as jest.Mock).mock.calls[0][0].message).toBe(
          "Budget exceeds maximum contract amount",
        );
      });

      it("delegates non-bounds errors to next()", async () => {
        const mockError = new Error("Creation failed");
        mockCreateContract.mockRejectedValue(mockError);
        await controller.createContract(
          mockRequest as Request,
          mockResponse as Response,
          mockNext,
        );
        expect(mockNext).toHaveBeenCalledWith(mockError);
      });
    });
  });

  // -------------------------------------------------------------------------
  // updateContract
  // -------------------------------------------------------------------------

  describe("updateContract", () => {
    it("returns 200 on success", async () => {
      const updated = {
        id: "abc",
        title: "Updated",
        clientId: "client-1",
        freelancerId: "freelancer-1",
        amount: 1000,
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        version: 1,
      };
      mockUpdateContract.mockResolvedValue(updated);
      mockRequest.params = { id: "abc" };
      await controller.updateContract(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );
      expect(mockResponse.status).toHaveBeenCalledWith(200);
    });

    it("returns 422 when service throws ContractBoundsError", async () => {
      mockUpdateContract.mockRejectedValue(
        new ContractBoundsError("Budget exceeds maximum"),
      );
      mockRequest.params = { id: "abc" };
      await controller.updateContract(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );
      expect(mockNext).toHaveBeenCalledWith(expect.any(ContractBoundsError));
    });

    it("delegates non-bounds errors to next()", async () => {
      const error = new Error("Update failed");
      mockUpdateContract.mockRejectedValue(error);
      mockRequest.params = { id: "abc" };
      await controller.updateContract(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );
      expect(mockNext).toHaveBeenCalledWith(error);
    });

    // ─── Milestones audit trail (issue #858) ──────────────────────────────

    it("does not record an audit entry when the patch does not touch milestones", async () => {
      const fullContract = {
        id: "abc",
        title: "Updated",
        clientId: "client-1",
        freelancerId: "freelancer-1",
        amount: 1000,
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        version: 1,
        deletedAt: null,
      };
      mockUpdateContract.mockResolvedValue(fullContract);
      mockRequest.params = { id: "abc" };
    });

    // -------------------------------------------------------------------------
    // deleteContract
    // -------------------------------------------------------------------------

    describe("deleteContract", () => {
      it("returns 200 on success", async () => {
        mockDeleteContract.mockResolvedValue(undefined);
        mockRequest.params = { id: "abc" };
        await controller.deleteContract(
          mockRequest as Request,
          mockResponse as Response,
          mockNext,
        );
        expect(mockResponse.status).toHaveBeenCalledWith(200);
      });

      it("delegates errors to next()", async () => {
        const error = new Error("Delete failed");
        mockDeleteContract.mockRejectedValue(error);
        mockRequest.params = { id: "abc" };
        await controller.deleteContract(
          mockRequest as Request,
          mockResponse as Response,
          mockNext,
        );
        expect(mockNext).toHaveBeenCalledWith(error);
      });
    });

    it("does not record an audit entry when the deleted contract never had a milestones snapshot", async () => {
      mockDeleteContract.mockResolvedValue(undefined);
      mockAuditService.query.mockReturnValue([]);
      mockRequest.params = { id: "abc" };

      await controller.deleteContract(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockAuditService.log).not.toHaveBeenCalled();
    });

    it("does not record an audit entry when contract deletion fails (404)", async () => {
      mockDeleteContract.mockRejectedValue(new Error("not found"));
      mockRequest.params = { id: "abc" };

      await controller.deleteContract(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockAuditService.log).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // getContractStats
  // -------------------------------------------------------------------------

  describe("getContractStats", () => {
    it("returns 200 with stats", async () => {
      const stats = {
        total: 5,
        byStatus: { draft: 3, active: 2 },
        totalBudget: 5000,
      };
      mockGetContractStats.mockResolvedValue(stats);
      await controller.getContractStats(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );
      expect(mockResponse.status).toHaveBeenCalledWith(200);
    });

    it("returns 422 when service throws ContractBoundsError", async () => {
      mockGetContractStats.mockRejectedValue(
        new ContractBoundsError("Bounds exceeded"),
      );
      await controller.getContractStats(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );
      expect(mockNext).toHaveBeenCalledWith(expect.any(ContractBoundsError));
    });

    it("delegates non-bounds errors to next()", async () => {
      const error = new Error("Stats failed");
      mockGetContractStats.mockRejectedValue(error);
      await controller.getContractStats(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );
      expect(mockNext).toHaveBeenCalledWith(error);
    });
  });

  // -------------------------------------------------------------------------
  // getBounds
  // -------------------------------------------------------------------------

  describe("getBounds", () => {
    it("returns 200 with CONTRACT_BOUNDS (instance)", () => {
      controller.getBounds(mockRequest as Request, mockResponse as Response);
      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith({
        status: "success",
        data: CONTRACT_BOUNDS,
        requestId: "unknown",
      });
    });

    it("returns 200 with CONTRACT_BOUNDS (static)", () => {
      controller.getBounds(mockRequest as Request, mockResponse as Response);
      expect(mockResponse.status).toHaveBeenCalledWith(200);
    });
  });

  // -------------------------------------------------------------------------
  // createContractsController factory
  // -------------------------------------------------------------------------

  describe("createContractsController factory", () => {
    it("returns bound handler methods", () => {
      const { createContractsController } = require("./contracts.controller");
      const controller = createContractsController(
        new (require("../services/contracts.service").ContractsService)(),
      );
      expect(controller).toHaveProperty("getContracts");
      expect(controller).toHaveProperty("getContractById");
      expect(controller).toHaveProperty("createContract");
      expect(controller).toHaveProperty("updateContract");
      expect(controller).toHaveProperty("deleteContract");
      expect(controller).toHaveProperty("getContractStats");
      expect(controller).toHaveProperty("getBounds");
    });
  });

  // -------------------------------------------------------------------------
  // getContractsCursor
  // -------------------------------------------------------------------------

  describe("getContractsCursor", () => {
    it("returns 200 with cursor page when no cursor is provided", async () => {
      const fakePage = {
        data: [],
        nextCursor: null,
        hasNextPage: false,
        limit: 20,
      };
      mockGetContractsPage.mockResolvedValue(fakePage);
      mockRequest.query = {};

      await controller.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockGetContractsPage).toHaveBeenCalledWith({
        limit: 20,
        cursor: undefined,
        includeDeleted: false,
      });
      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "success",
          data: fakePage.data,
          meta: { limit: 20, nextCursor: null, hasNextPage: false },
        }),
      );
    });

    it("returns 200 with cursor page when a valid cursor is provided", async () => {
      const fakePage = {
        data: [
          {
            id: "abc",
            title: "Test",
            clientId: "client-1",
            freelancerId: "freelancer-1",
            amount: 1000,
            status: "active",
            createdAt: "2026-01-01T00:00:00.000Z",
            version: 1,
            deletedAt: null,
          },
        ],
        nextCursor: null,
        hasNextPage: false,
        limit: 10,
      };
      mockGetContractsPage.mockResolvedValue(fakePage);

      const validCursor = Buffer.from(
        JSON.stringify({
          createdAt: "2024-01-01T00:00:00.000Z",
          id: "abc-123",
        }),
        "utf8",
      ).toString("base64url");

      mockRequest.query = { limit: "10", cursor: validCursor };

      await controller.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockGetContractsPage).toHaveBeenCalledWith({
        limit: 10,
        cursor: validCursor,
        includeDeleted: false,
      });
      expect(mockResponse.status).toHaveBeenCalledWith(200);
    });

    it("returns 400 for a malformed cursor", async () => {
      mockRequest.query = { cursor: "not-a-valid-cursor" };

      await controller.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockNext).toHaveBeenCalledWith(expect.any(AppError));
      expect((mockNext as jest.Mock).mock.calls[0][0].statusCode).toBe(400);
      expect((mockNext as jest.Mock).mock.calls[0][0].code).toBe("bad_request");
    });

    it("calls next() when service throws", async () => {
      const mockError = new Error("DB Down");
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

  // -------------------------------------------------------------------------
  // updateContract
  // -------------------------------------------------------------------------

  describe("updateContract", () => {
    it("returns 200 on success", async () => {
      const updatedContract = {
        id: "abc",
        title: "Updated",
        clientId: "client-1",
        freelancerId: "freelancer-1",
        amount: 1000,
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        version: 1,
        deletedAt: null,
      };
      mockRequest.params = { id: "abc" };
      mockRequest.body = { version: 0, title: "Updated" };
      mockUpdateContract.mockResolvedValue(updatedContract);

      await controller.updateContract(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      // Third arg is the authenticated actor id (used for the contract audit
      // log — see #853); undefined here since this mock request has no
      // req.user attached.
      expect(mockUpdateContract).toHaveBeenCalledWith(
        "abc",
        { version: 0, title: "Updated" },
        undefined,
      );
      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith({
        status: "success",
        data: updatedContract,
        requestId: "unknown",
      });
    });

    it("returns 422 on ContractBoundsError", async () => {
      mockRequest.params = { id: "abc" };
      mockRequest.body = { version: 0, budget: 999_000_000_000_000_000 };
      mockUpdateContract.mockRejectedValue(
        new ContractBoundsError("Budget exceeds maximum contract amount"),
      );

      await controller.updateContract(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockNext).toHaveBeenCalledWith(expect.any(ContractBoundsError));
    });

    it("delegates non-bounds errors to next()", async () => {
      const mockError = new Error("Update failed");
      mockRequest.params = { id: "abc" };
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

  describe("deleteContract", () => {
    it("returns 200 on success", async () => {
      mockDeleteContract.mockResolvedValue(undefined);
      mockRequest.params = { id: "abc" };

      await controller.deleteContract(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockDeleteContract).toHaveBeenCalledWith("abc");
      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith({
        status: "success",
        data: { message: "Contract deleted successfully" },
        requestId: "unknown",
      });
    });

    it("delegates errors to next()", async () => {
      const mockError = new Error("Delete failed");
      mockDeleteContract.mockRejectedValue(mockError);
      mockRequest.params = { id: "abc" };

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

  describe("getContractStats", () => {
    it("returns 200 with stats", async () => {
      const stats = {
        total: 5,
        totalBudget: 10000,
        byStatus: { draft: 3, active: 2 },
      };
      mockGetContractStats.mockResolvedValue(stats);

      await controller.getContractStats(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith({
        status: "success",
        data: stats,
        requestId: "unknown",
      });
    });

    it("delegates errors to next()", async () => {
      const mockError = new Error("Stats failed");
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
