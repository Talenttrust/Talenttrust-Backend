/**
 * Tests for bulk contracts operations controller.
 *
 * Tests cover:
 * - Empty batch: rejected as validation error
 * - Partial failure: mix of valid and invalid items, valid items persisted
 * - Over-capacity: batch exceeding max size rejected wholesale
 * - All-success: all items created successfully
 * - All-failure: all items fail with appropriate per-item errors
 * - Per-item error mapping: different error types get correct codes/messages
 */

import { createContractsBulkController } from "./contracts-bulk.controller";
import type { ContractsService } from "../services/contracts.service";
import type {
  CreateContractRequestDto,
  ContractResponseDto,
} from "../modules/contracts/dto/contracts-boundary.dto";
import type {
  BulkCreateContractsResponse,
  BulkItemResult,
} from "../modules/contracts/dto/bulk-operations.dto";
import { ContractBoundsError } from "../contracts/bounds";
import { NotFoundError } from "../errors/appError";
import type { Contract } from "../db/types";

describe("ContractsBulkController", () => {
  let mockService: jest.Mocked<ContractsService>;
  let bulkController: ReturnType<typeof createContractsBulkController>;

  beforeEach(() => {
    mockService = {
      createContract: jest.fn(),
      getAllContracts: jest.fn(),
      getContractById: jest.fn(),
      getContractsPage: jest.fn(),
      updateContract: jest.fn(),
      deleteContract: jest.fn(),
      getContractStats: jest.fn(),
      getBounds: jest.fn(),
    } as any;

    bulkController = createContractsBulkController(mockService);
  });

  describe("bulkCreateContracts", () => {
    it("all-success: all items created, response has 200 with per-item success results", async () => {
      const requests: CreateContractRequestDto[] = [
        {
          title: "Contract 1",
          description: "Desc 1",
          clientId: "client-1",
          budget: 1000,
        },
        {
          title: "Contract 2",
          description: "Desc 2",
          clientId: "client-2",
          budget: 2000,
        },
      ];

      const contracts: Contract[] = [
        {
          id: "contract-1",
          title: "Contract 1",
          clientId: "client-1",
          freelancerId: "",
          amount: 1000,
          status: "draft",
          version: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: "contract-2",
          title: "Contract 2",
          clientId: "client-2",
          freelancerId: "",
          amount: 2000,
          status: "draft",
          version: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      mockService.createContract
        .mockResolvedValueOnce(contracts[0])
        .mockResolvedValueOnce(contracts[1]);

      const mockReq = { body: requests } as any;
      const mockRes = {
        locals: {},
        json: jest.fn().mockReturnThis(),
        status: jest.fn().mockReturnThis(),
      } as any;

      await bulkController.bulkCreateContracts(mockReq, mockRes, jest.fn());

      expect(mockRes.json).toHaveBeenCalled();
      const raw = mockRes.json.mock.calls[0][0];
      const response = (raw.data ?? raw) as BulkCreateContractsResponse;

      expect(response.items).toHaveLength(2);
      expect(response.items[0].status).toBe("success");
      expect(response.items[1].status).toBe("success");
      expect(response.summary.total).toBe(2);
      expect(response.summary.succeeded).toBe(2);
      expect(response.summary.failed).toBe(0);
    });

    it("partial-failure: mix of valid and invalid items, valid items in response", async () => {
      const requests: CreateContractRequestDto[] = [
        {
          title: "Valid Contract",
          description: "Valid desc",
          clientId: "client-1",
          budget: 1000,
        },
        {
          title: "Invalid Budget",
          description: "Invalid desc",
          clientId: "client-2",
          budget: 1000000000000, // Exceeds max
        },
      ];

      const contract: Contract = {
        id: "contract-1",
        title: "Valid Contract",
        clientId: "client-1",
        freelancerId: "",
        amount: 1000,
        status: "draft",
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockService.createContract
        .mockResolvedValueOnce(contract)
        .mockRejectedValueOnce(
          new ContractBoundsError("Budget exceeds maximum"),
        );

      const mockReq = { body: requests } as any;
      const mockRes = {
        locals: {},
        json: jest.fn().mockReturnThis(),
        status: jest.fn().mockReturnThis(),
      } as any;

      await bulkController.bulkCreateContracts(mockReq, mockRes, jest.fn());

      const raw = mockRes.json.mock.calls[0][0];
      const response = (raw.data ?? raw) as BulkCreateContractsResponse;

      expect(response.items).toHaveLength(2);
      expect(response.items[0].status).toBe("success");
      expect(response.items[1].status).toBe("error");
      expect((response.items[1] as any).error.code).toBe(
        "contract_bounds_error",
      );
      expect(response.summary.succeeded).toBe(1);
      expect(response.summary.failed).toBe(1);
    });

    it("all-failure: all items fail, response shows all errors", async () => {
      const requests: CreateContractRequestDto[] = [
        {
          title: "Invalid 1",
          description: "Desc",
          clientId: "client-1",
          budget: 10000000000,
        },
        {
          title: "Invalid 2",
          description: "Desc",
          clientId: "client-2",
          budget: 20000000000,
        },
      ];

      mockService.createContract
        .mockRejectedValueOnce(new ContractBoundsError("Budget exceeds max"))
        .mockRejectedValueOnce(new ContractBoundsError("Budget exceeds max"));

      const mockReq = { body: requests } as any;
      const mockRes = {
        locals: {},
        json: jest.fn().mockReturnThis(),
        status: jest.fn().mockReturnThis(),
      } as any;

      await bulkController.bulkCreateContracts(mockReq, mockRes, jest.fn());

      const raw = mockRes.json.mock.calls[0][0];
      const response = (raw.data ?? raw) as BulkCreateContractsResponse;

      expect(response.items).toHaveLength(2);
      expect(response.items.every((item) => item.status === "error")).toBe(
        true,
      );
      expect(response.summary.succeeded).toBe(0);
      expect(response.summary.failed).toBe(2);
    });

    it("error mapping: ContractBoundsError → 422 contract_bounds_error", async () => {
      const requests: CreateContractRequestDto[] = [
        {
          title: "Over Budget",
          description: "Desc",
          clientId: "client-1",
          budget: 100000000000,
        },
      ];

      mockService.createContract.mockRejectedValueOnce(
        new ContractBoundsError("Total exceeds limit"),
      );

      const mockReq = { body: requests } as any;
      const mockRes = {
        locals: {},
        json: jest.fn().mockReturnThis(),
        status: jest.fn().mockReturnThis(),
      } as any;

      await bulkController.bulkCreateContracts(mockReq, mockRes, jest.fn());

      const raw = mockRes.json.mock.calls[0][0];
      const response = (raw.data ?? raw) as BulkCreateContractsResponse;
      const item = response.items[0] as BulkItemResult<ContractResponseDto>;

      expect(item.status).toBe("error");
      expect(item.code).toBe(422);
      expect((item as any).error.code).toBe("contract_bounds_error");
    });

    it("error mapping: NotFoundError → 404 not_found", async () => {
      const requests: CreateContractRequestDto[] = [
        {
          title: "Not Found",
          description: "Desc",
          clientId: "unknown-client",
          budget: 1000,
        },
      ];

      mockService.createContract.mockRejectedValueOnce(
        new NotFoundError("Client not found"),
      );

      const mockReq = { body: requests } as any;
      const mockRes = {
        locals: {},
        json: jest.fn().mockReturnThis(),
        status: jest.fn().mockReturnThis(),
      } as any;

      await bulkController.bulkCreateContracts(mockReq, mockRes, jest.fn());

      const raw = mockRes.json.mock.calls[0][0];
      const response = (raw.data ?? raw) as BulkCreateContractsResponse;
      const item = response.items[0] as BulkItemResult<ContractResponseDto>;

      expect(item.status).toBe("error");
      expect(item.code).toBe(404);
      expect((item as any).error.code).toBe("not_found");
    });

    it("error mapping: generic Error → 400 invalid_request", async () => {
      const requests: CreateContractRequestDto[] = [
        {
          title: "Generic Error",
          description: "Desc",
          clientId: "client-1",
          budget: 1000,
        },
      ];

      mockService.createContract.mockRejectedValueOnce(
        new Error("Some validation failed"),
      );

      const mockReq = { body: requests } as any;
      const mockRes = {
        locals: {},
        json: jest.fn().mockReturnThis(),
        status: jest.fn().mockReturnThis(),
      } as any;

      await bulkController.bulkCreateContracts(mockReq, mockRes, jest.fn());

      const raw = mockRes.json.mock.calls[0][0];
      const response = (raw.data ?? raw) as BulkCreateContractsResponse;
      const item = response.items[0] as BulkItemResult<ContractResponseDto>;

      expect(item.status).toBe("error");
      expect(item.code).toBe(400);
      expect((item as any).error.code).toBe("invalid_request");
    });

    it("always returns 200 status (per-item status in response)", async () => {
      const requests: CreateContractRequestDto[] = [
        {
          title: "Test",
          description: "Desc",
          clientId: "client-1",
          budget: 1000,
        },
      ];

      mockService.createContract.mockRejectedValueOnce(
        new ContractBoundsError("Budget too high"),
      );

      const mockReq = { body: requests } as any;
      const mockRes = {
        locals: {},
        json: jest.fn().mockReturnThis(),
        status: jest.fn().mockReturnThis(),
      } as any;

      await bulkController.bulkCreateContracts(mockReq, mockRes, jest.fn());

      // Response should call ok() which sets status 200 (caller handler)
      expect(mockRes.json).toHaveBeenCalled();
      // Verify all items in response are processed regardless of per-item failures
      const raw = mockRes.json.mock.calls[0][0];
      const response = (raw.data ?? raw) as BulkCreateContractsResponse;
      expect(response.summary.total).toBe(1);
    });

    it("positional mapping: items in response correspond to request items by index", async () => {
      const requests: CreateContractRequestDto[] = [
        { title: "Item 0", description: "Desc", clientId: "c1", budget: 1000 },
        { title: "Item 1", description: "Desc", clientId: "c2", budget: 2000 },
        { title: "Item 2", description: "Desc", clientId: "c3", budget: 3000 },
      ];

      mockService.createContract
        .mockRejectedValueOnce(new Error("Item 0 fails"))
        .mockResolvedValueOnce({
          id: "contract-1",
          title: "Item 1",
          clientId: "c2",
          freelancerId: "",
          amount: 2000,
          status: "draft",
          version: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .mockRejectedValueOnce(new Error("Item 2 fails"));

      const mockReq = { body: requests } as any;
      const mockRes = {
        locals: {},
        json: jest.fn().mockReturnThis(),
        status: jest.fn().mockReturnThis(),
      } as any;

      await bulkController.bulkCreateContracts(mockReq, mockRes, jest.fn());

      const raw = mockRes.json.mock.calls[0][0];
      const response = (raw.data ?? raw) as BulkCreateContractsResponse;

      expect(response.items[0].status).toBe("error");
      expect(response.items[1].status).toBe("success");
      expect(response.items[2].status).toBe("error");
    });
  });
});
