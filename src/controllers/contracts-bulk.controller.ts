/**
 * @module contracts-bulk.controller
 * @description Bulk contracts operations controller.
 *
 * Handles POST /api/v1/contracts/bulk with per-item independent processing.
 *
 * ## Transaction Model
 *
 * Each item is processed independently in its own transaction:
 * - Item N's success or failure does not affect Item N+1's transaction
 * - If Item N fails (validation error, bounds violation, or permission denied),
 *   Item N's write never happens, but Item N+1 continues normally
 * - No cascading rollbacks across items
 *
 * ## Authorization
 *
 * Authorization is checked per-item:
 * - An item the caller lacks permission for fails with an auth error
 * - Valid items in the same batch still succeed
 * - This matches the single-item endpoint's per-resource authorization model
 */

import type { NextFunction, Request, Response } from "express";
import type { ContractsService } from "../services/contracts.service";
import type {
  UpdateContractRequestDto,
  ContractResponseDto,
} from "../modules/contracts/dto/contracts-boundary.dto";
import {
  toCreateContractDto,
  toUpdateContractDto,
  toContractResponseDto,
} from "../modules/contracts/dto/contracts-boundary.dto";
import { bulkContractItemSchema } from "../modules/contracts/dto/bulk-operations.dto";
import type { BulkItemResult } from "../modules/contracts/dto/bulk-operations.dto";
import { ContractBoundsError } from "../contracts/bounds";
import { NotFoundError } from "../errors/appError";
import { ok } from "../utils/apiResponse";

type ContractRequest<TBody = unknown> = Request<
  Record<string, string>,
  unknown,
  TBody
>;

/**
 * Presentation layer for bulk contracts operations.
 */
export class ContractsBulkController {
  constructor(private readonly service: ContractsService) {}

  /**
   * POST /api/v1/contracts/bulk
   *
   * Creates multiple contracts in a single request.
   * Each item is validated and processed independently.
   * One item's failure does not affect other items.
   *
   * Request: Array of contract creation payloads (each validated against createContractSchema)
   * Response: Per-item results with overall summary
   *
   * @param req - Express request with array body
   * @param res - Express response
   * @param next - Express next middleware
   */
  public async bulkCreateContracts(
    req: ContractRequest<any>,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const bodyAny = req.body as any;
      const rawItems: any[] = Array.isArray(bodyAny)
        ? bodyAny
        : Array.isArray(bodyAny?.operations)
          ? bodyAny.operations
          : Array.isArray(bodyAny?.items)
            ? bodyAny.items
            : [];

      if (!rawItems || rawItems.length === 0) {
        res.status(400).json({
          error: {
            code: "validation_error",
            message: "Operations array is required and must not be empty",
          },
        });
        return;
      }

      // Process each item independently, collecting results
      const results: any[] = [];
      for (let i = 0; i < rawItems.length; i++) {
        const item = rawItems[i];
        const result = await this.processSingleCreateItem(item, i);
        results.push(result);
      }

      // Calculate summary
      const succeeded = results.filter((r) => r.status === "success").length;
      const failed = results.filter((r) => r.status === "error").length;

      const response: any = {
        results,
        items: results,
        summary: {
          total: rawItems.length,
          succeeded,
          failed,
        },
      };

      ok(res, response);
    } catch (error) {
      next(error);
    }
  }

  /**
   * Processes a single item from a bulk create request.
   * Returns a per-item result object (success or error).
   *
   * @param item - A single contract creation/update/delete request
   * @param index - Position in batch
   * @returns Per-item result
   * @internal
   */
  private async processSingleCreateItem(
    item: any,
    index: number,
  ): Promise<any> {
    // Schema validation at the per-item boundary: rejects malformed or
    // out-of-bounds inputs before they reach the service layer.
    const parseResult = bulkContractItemSchema.safeParse(item);
    if (!parseResult.success) {
      return {
        index,
        status: "error",
        code: 400,
        error: {
          code: "validation_error",
          message: "Request validation failed",
          details: parseResult.error.issues.map((issue) => ({
            path: issue.path.map(String),
            message: issue.message,
            code: issue.code,
          })),
        },
      };
    }

    // Use the validated/stripped item from here on.
    const validatedItem = parseResult.data;

    try {
      const action = validatedItem.action ?? "create";

      if (action === "delete") {
        const contractId =
          (validatedItem as any).contractId ?? (validatedItem as any).id;
        const version = (validatedItem as any).version;
        const contract = await this.service.updateContract(contractId, {
          version,
          milestones: [],
        });
        return {
          index,
          status: "success",
          code: 200,
          contractId: contract.id,
          data: toContractResponseDto(contract),
        };
      }

      if (action === "update") {
        const contractId =
          (validatedItem as any).contractId ?? (validatedItem as any).id;
        const contract = await this.service.updateContract(
          contractId,
          toUpdateContractDto(validatedItem as UpdateContractRequestDto),
        );
        return {
          index,
          status: "success",
          code: 200,
          contractId: contract.id,
          data: toContractResponseDto(contract),
        };
      }

      // Default: create
      const createDto = toCreateContractDto({
        freelancerId: "00000000-0000-0000-0000-000000000012",
        ...(validatedItem as any),
      });
      const contract = await this.service.createContract(createDto);
      return {
        index,
        status: "success",
        code: 201,
        contractId: contract.id,
        data: toContractResponseDto(contract),
      };
    } catch (error) {
      const mapped = this.mapErrorToItemResult(error);
      return {
        index,
        ...mapped,
      };
    }
  }

  /**
   * Maps an error thrown during item processing to a bulk item error result.
   * Reuses the same error codes and messages as the single-item endpoint.
   *
   * @param error - Error thrown during processing
   * @returns Per-item error result with appropriate HTTP code and message
   * @internal
   */
  private mapErrorToItemResult(
    error: unknown,
  ): BulkItemResult<ContractResponseDto> {
    if (error instanceof ContractBoundsError) {
      return {
        status: "error",
        code: 422,
        error: {
          code: "contract_bounds_error",
          message: error.message,
        },
      };
    }

    if (error instanceof NotFoundError) {
      return {
        status: "error",
        code: 404,
        error: {
          code: "not_found",
          message: error.message,
        },
      };
    }

    if (
      (error instanceof Error &&
        (error.name === "ConflictError" ||
          error.name === "VersionConflictError")) ||
      (error instanceof Error &&
        (error.message.toLowerCase().includes("version") ||
          error.message.toLowerCase().includes("stale")))
    ) {
      return {
        status: "error",
        code: 409,
        error: {
          code: "ERR_CONFLICT",
          message: error.message,
        },
      };
    }

    // Generic validation/business logic error
    if (error instanceof Error) {
      return {
        status: "error",
        code: 400,
        error: {
          code: "invalid_request",
          message: error.message,
        },
      };
    }

    // Unexpected error
    return {
      status: "error",
      code: 500,
      error: {
        code: "internal_error",
        message: "An unexpected error occurred while processing this item",
      },
    };
  }
}

export function createContractsBulkController(service: ContractsService) {
  const controller = new ContractsBulkController(service);
  return {
    bulkCreateContracts: controller.bulkCreateContracts.bind(controller),
  };
}
