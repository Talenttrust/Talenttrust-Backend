import type { NextFunction, Request, Response } from "express";
import { CONTRACT_BOUNDS, ContractBoundsError } from "../contracts/bounds";
import {
  parseLimit,
  resolveCursorQueryParam,
} from "../contracts/cursor.repository";
import { CURSOR_DEFAULT_LIMIT } from "../contracts/cursor.types";
import { NotFoundError } from "../errors/appError";
import { SoftDeleteRetentionError } from "../utils/softDelete";
import {
  CreateContractRequestDto,
  UpdateContractRequestDto,
  BulkMilestonesResponseDto,
  toContractResponseDto,
  toCreateContractDto,
  toUpdateContractDto,
} from "../modules/contracts/dto/contracts-boundary.dto";
import {
  assertResponseSchema,
  contractBoundsResponseSchema,
  contractStatsResponseSchema,
  deleteContractResponseSchema,
  ContractBoundsResponse,
  ContractStatsResponse,
  DeleteContractResponse,
} from "../modules/contracts/dto/contract-response.dto";
import { ContractsService } from "../services/contracts.service";
import { createLogger } from "../logger";
import type { MetricsServiceLike } from "../observability/metrics-service";
import { fail, ok } from "../utils/apiResponse";
import { getCorrelationId, getRequestId } from "../utils/correlationId";
import { applyPagination, parsePaginationQuery } from "../utils/pagination";
import type { Logger } from "../logger";

type ContractRequest<TBody = unknown> = Request<
  Record<string, string>,
  unknown,
  TBody
> & { user?: { id: string } };

/**
 * Extract the request-scoped logger from res.locals, falling back to a
 * module-level import so the controller works without middleware in unit tests.
 */
function resolveLogger(res: Response): Logger {
  const log = res.locals["log"] as Logger | undefined;
  if (log) return log;
  // Lazy import avoids a top-level circular-dep risk and keeps unit tests simple.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("../logger").logger as Logger;
}

/**
 * Build a trace context object from res.locals for structured logging.
 * Only includes correlationId when present to keep records clean.
 * Falls back to 'unknown' for requestId so the controller works in unit tests
 * that don't run requestIdMiddleware.
 */
function traceContext(res: Response): Record<string, string> {
  const requestId =
    typeof res.locals["requestId"] === "string"
      ? (res.locals["requestId"] as string)
      : "unknown";
  const ctx: Record<string, string> = { requestId };
  const correlationId = getCorrelationId(res);
  if (correlationId !== undefined) ctx["correlationId"] = correlationId;
  return ctx;
}

/**
 * Presentation layer for contracts. Transport DTOs are mapped explicitly at
 * this boundary so service and persistence types do not leak into handlers.
 *
 * Every handler:
 *  1. Extracts the request-scoped logger (bound to requestId + correlationId)
 *     from res.locals.log — set by requestIdMiddleware.
 *  2. Logs entry/exit/error with the trace context.
 *  3. Forwards the correlationId to service calls so structured logs at the
 *     service layer carry the same trace token.
 */
export class ContractsController {
  private readonly log = createLogger({ controller: "contracts" });

  constructor(
    private readonly service: ContractsService,
    private readonly metrics?: MetricsServiceLike,
  ) {}

  public async getContracts(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const log = resolveLogger(res);
    const ctx = traceContext(res);
    log.info("contracts.getContracts: start", ctx);

    try {
      const query = (req.query ?? {}) as Record<string, unknown>;
      let limit: number;
      try {
        limit = parseLimit(query["limit"]);
      } catch (err) {
        fail(res, "bad_request", (err as Error).message, 400);
        return;
      }

      const cursorResult = resolveCursorQueryParam(query["cursor"]);
      if (!cursorResult.ok) {
        fail(res, "bad_request", (cursorResult as any).message, 400);
        return;
      }

      const includeDeleted = query["includeDeleted"] === "true";
      const page = await this.service.getContractsPage({
        limit,
        cursor: cursorResult.cursor,
        includeDeleted,
      });

      log.info("contracts.getContracts: success", {
        ...ctx,
        count: page.data.length,
      });
      const items = page.data.map(toContractResponseDto);

      log.info('contracts.getContracts: success', { ...ctx, count: items.length });
      ok(res, items, {
        limit: page.limit,
        nextCursor: page.nextCursor,
        hasNextPage: page.hasNextPage,
      });
    } catch (error) {
      next(error);
    }
  }

  public async getContractsCursor(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const query = (req.query ?? {}) as Record<string, unknown>;
      let limit: number;
      try {
        limit = parseLimit(query["limit"]);
      } catch (error) {
        res.status(400).json({
          status: "error",
          message: error instanceof Error ? error.message : "Invalid limit",
        });
        return;
      }

      const cursorResult = resolveCursorQueryParam(query["cursor"]);
      if (!cursorResult.ok) {
        res.status(400).json({
          status: "error",
          message: (cursorResult as any).message,
        });
        return;
      }

      const includeDeleted = query["includeDeleted"] === "true";
      const page = await this.service.getContractsPage({
        limit,
        cursor: cursorResult.cursor,
        includeDeleted,
      });
      res.status(200).json({ status: "success", data: page });
    } catch (error) {
      next(error);
    }
  }

  public async getContractById(
    req: ContractRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const startMs = Date.now();
    const contractId = req.params.id ?? "";
    const includeDeleted = req.query.includeDeleted === "true";
    const requestId =
      typeof res.locals.requestId === "string"
        ? res.locals.requestId
        : undefined;
    const log = this.log.child({ operation: "read", contractId, requestId });

    log.info("Contract read operation started");

    try {
      const contract = await this.service.getContractById(contractId, {
        includeDeleted,
      });
      if (!contract) {
        const durationSeconds = (Date.now() - startMs) / 1000;
        log.warn("Milestone read failed: contract not found");
        this.metrics?.recordMilestoneOperation?.(
          "read",
          "client_error",
          durationSeconds,
          "not_found",
        );
        throw new NotFoundError("The requested resource was not found");
      }

      const durationSeconds = (Date.now() - startMs) / 1000;
      log.info("Milestone read operation succeeded");
      this.metrics?.recordMilestoneOperation?.(
        "read",
        "success",
        durationSeconds,
      );
      ok(res, toContractResponseDto(contract));
    } catch (error) {
      if (error instanceof NotFoundError) {
        // Already recorded — re-throw to let the error handler format the response.
        next(error);
        return;
      }
      const durationSeconds = (Date.now() - startMs) / 1000;
      log.error("Milestone read operation failed with unexpected error", {
        err: error instanceof Error ? error : undefined,
      });
      this.metrics?.recordMilestoneOperation?.(
        "read",
        "server_error",
        durationSeconds,
        "internal_error",
      );
      next(error);
    }
  }

  public async createContract(
    req: ContractRequest<CreateContractRequestDto>,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const startMs = Date.now();
    const requestId =
      typeof res.locals.requestId === "string"
        ? res.locals.requestId
        : undefined;
    const hasMilestones =
      Array.isArray(req.body?.milestones) && req.body.milestones.length > 0;
    const log = this.log.child({
      operation: "create",
      requestId,
      hasMilestones,
    });

    const correlationId = getCorrelationId(res);
    log.info("Milestone create operation started");

    try {
      const contract = await this.service.createContract(
        toCreateContractDto(req.body),
        correlationId,
      );

      const durationSeconds = (Date.now() - startMs) / 1000;
      log.info("Milestone create operation succeeded");
      this.metrics?.recordMilestoneOperation?.(
        "create",
        "success",
        durationSeconds,
      );
      ok(res, toContractResponseDto(contract), undefined, 201);
    } catch (error) {
      const durationSeconds = (Date.now() - startMs) / 1000;
      if (error instanceof ContractBoundsError) {
        log.warn("Milestone create rejected: contract bounds violation", {
          errorMessage: error.message,
        });
        this.metrics?.recordMilestoneOperation?.(
          "create",
          "client_error",
          durationSeconds,
          "contract_bounds_error",
        );
        fail(res, "contract_bounds_error", error.message, 422);
        return;
      }
      log.error("Milestone create operation failed with unexpected error", {
        err: error instanceof Error ? error : undefined,
      });
      this.metrics?.recordMilestoneOperation?.(
        "create",
        "server_error",
        durationSeconds,
        "internal_error",
      );
      next(error);
    }
  }

  public async updateContract(
    req: ContractRequest<UpdateContractRequestDto>,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const startMs = Date.now();
    const contractId = req.params.id ?? "";
    const requestId =
      typeof res.locals.requestId === "string"
        ? res.locals.requestId
        : undefined;
    const hasMilestones =
      Array.isArray(req.body?.milestones) && req.body.milestones.length > 0;
    const log = this.log.child({
      operation: "update",
      contractId,
      requestId,
      hasMilestones,
    });

    const correlationId = getCorrelationId(res);
    log.info("Milestone update operation started");

    try {
      const contract = await this.service.updateContract(
        contractId,
        toUpdateContractDto(req.body),
        correlationId,
      );

      const durationSeconds = (Date.now() - startMs) / 1000;
      log.info("Milestone update operation succeeded");
      this.metrics?.recordMilestoneOperation?.(
        "update",
        "success",
        durationSeconds,
      );
      ok(res, toContractResponseDto(contract));
    } catch (error) {
      const durationSeconds = (Date.now() - startMs) / 1000;
      if (error instanceof ContractBoundsError) {
        log.warn("Milestone update rejected: contract bounds violation", {
          errorMessage: error.message,
        });
        this.metrics?.recordMilestoneOperation?.(
          "update",
          "client_error",
          durationSeconds,
          "contract_bounds_error",
        );
        fail(res, "contract_bounds_error", error.message, 422);
        return;
      }
      if (error instanceof NotFoundError) {
        log.warn("Milestone update failed: contract not found");
        this.metrics?.recordMilestoneOperation?.(
          "update",
          "client_error",
          durationSeconds,
          "not_found",
        );
        next(error);
        return;
      }
      log.error("Milestone update operation failed with unexpected error", {
        err: error instanceof Error ? error : undefined,
      });
      this.metrics?.recordMilestoneOperation?.(
        "update",
        "server_error",
        durationSeconds,
        "internal_error",
      );
      next(error);
    }
  }

  public async deleteContract(
    req: ContractRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const log = resolveLogger(res);
    const ctx = traceContext(res);
    const correlationId = getCorrelationId(res);
    const id = req.params.id!;
    log.info("contracts.deleteContract: start", { ...ctx, contractId: id });

    try {
      await this.service.deleteContract(req.params.id!);
      ok(
        res,
        assertResponseSchema<DeleteContractResponse>(
          deleteContractResponseSchema,
          { message: "Contract deleted successfully" },
          "DeleteContract",
        ),
      );
    } catch (error) {
      log.error("contracts.deleteContract: error", {
        ...ctx,
        contractId: id,
        err: error as Error,
      });
      next(error);
    }
  }

  public async restoreContract(
    req: ContractRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const log = resolveLogger(res);
    const ctx = traceContext(res);
    const correlationId = getCorrelationId(res);
    const id = req.params.id!;
    log.info("contracts.restoreContract: start", { ...ctx, contractId: id });

    try {
      const restored = await this.service.restoreContract(id, correlationId);
      ok(res, toContractResponseDto(restored));
    } catch (error) {
      if (error instanceof SoftDeleteRetentionError) {
        fail(res, error.code, error.message, error.statusCode);
        return;
      }
      log.error("contracts.restoreContract: error", {
        ...ctx,
        contractId: id,
        err: error as Error,
      });
      next(error);
    }
  }

  public async getContractStats(
    _req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const log = resolveLogger(res);
    const ctx = traceContext(res);
    log.info("contracts.getContractStats: start", ctx);

    try {
      const stats = await this.service.getContractStats();
      ok(
        res,
        assertResponseSchema<ContractStatsResponse>(
          contractStatsResponseSchema,
          stats,
          "ContractStats",
        ),
      );
    } catch (error) {
      if (error instanceof ContractBoundsError) {
        fail(res, "contract_bounds_error", error.message, 422);
        return;
      }
      log.error("contracts.getContractStats: error", {
        ...ctx,
        err: error as Error,
      });
      next(error);
    }
  }

  public getBounds(_req: Request, res: Response): void {
    ok(
      res,
      assertResponseSchema<ContractBoundsResponse>(
        contractBoundsResponseSchema,
        CONTRACT_BOUNDS,
        "ContractBounds",
      ),
    );
  }
}

export { CURSOR_DEFAULT_LIMIT };

export function createContractsController(
  service: ContractsService,
  metrics?: MetricsServiceLike,
) {
  const controller = new ContractsController(service, metrics);
  return {
    getContracts: controller.getContracts.bind(controller),
    getContractsCursor: controller.getContractsCursor.bind(controller),
    getContractById: controller.getContractById.bind(controller),
    createContract: controller.createContract.bind(controller),
    updateContract: controller.updateContract.bind(controller),
    deleteContract: controller.deleteContract.bind(controller),
    restoreContract: controller.restoreContract.bind(controller),
    getContractStats: controller.getContractStats.bind(controller),
    getBounds: controller.getBounds.bind(controller),
  };
}

/**
 * Maintenance entrypoint: purge soft-deleted contracts past the retention window.
 * Intended for cron / scheduled tasks.
 */
export async function runContractsSoftDeletePurge(
  service?: ContractsService,
  now: Date = new Date(),
): Promise<number> {
  if (service) {
    return service.purgeExpiredContracts(now);
  }
  const { ContractRepository } = require("../repositories/contractRepository");
  const { getDb } = require("../db/database");
  const db = getDb();
  const repo = new ContractRepository(db);
  const contractsService = new ContractsService(repo);
  return contractsService.purgeExpiredContracts(now);
}
