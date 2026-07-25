import { Request, Response, NextFunction } from 'express';
import { ContractsService } from '../services/contracts.service';
import type { CreateContractDto, UpdateContractDto } from '../modules/contracts/dto/contract.dto';

import { CONTRACT_BOUNDS, ContractBoundsError } from '../contracts/bounds';
import { NotFoundError } from '../errors/appError';
import { parsePaginationQuery, applyPagination } from '../utils/pagination';
import { parseLimit, resolveCursorQueryParam } from '../contracts/cursor.repository';
import { CURSOR_DEFAULT_LIMIT } from '../contracts/cursor.types';
import { ok, fail } from '../utils/apiResponse';

interface ContractIdParams {
  id: string;
}

/**
 * Presentation layer for Contracts.
 * Handles HTTP requests, extracts parameters, and formulates responses.
 * Delegates core logic to the injected ContractsService.
 *
 * @remarks Instantiate via `createContractsController(service)` to avoid
 * module-level DB side effects and enable clean unit testing.
 */
export class ContractsController {

  /**
   * GET /api/v1/contracts
   *
   * Supports two pagination modes — both are optional and backward-compatible:
   *
   * **Cursor mode** (preferred, O(log n)):
   *   - `?limit=<n>`  — page size, 1–100 (default 20)
   *   - `?cursor=<s>` — opaque cursor from the previous page's `nextCursor`
   *
   * **Legacy offset mode** (still accepted for backward compatibility):
   *   - `?page=<n>&limit=<n>` — the previous in-memory slice behaviour
   *
   * When `cursor` is present the cursor path is used; otherwise the legacy
   * path is used so existing callers are unaffected.
   *
   * @param req - Express request.  Query params: `limit`, `cursor`.
   * @param res - Express response.
   * @param next - Express next-error handler.
   */

  public async getContractsCursor(req: Request, res: Response, next: NextFunction) {
    try {
      const limit = parseLimit(req.query['limit']);

      const cursorResult = resolveCursorQueryParam(req.query['cursor']);
      if (!cursorResult.ok) {
        res.status(400).json({
          status: 'error',
          message: cursorResult.message,
        });
        return;
      }

      const page = await this.service.getContractsPage({ limit, cursor: cursorResult.cursor });
      res.status(200).json({ status: 'success', data: page });
    } catch (error) {
      next(error);
    }
  }

  /**
   * @param service - Injected ContractsService instance
   */
  constructor(private readonly service: ContractsService) {}

  /**
   * GET /api/v1/contracts
   * Fetch a paginated list of escrow contracts.
   */
  public async getContracts(req: Request, res: Response, next: NextFunction) {
    try {
      if (req.query.cursor !== undefined || (req.query.limit !== undefined && req.query.page === undefined)) {
        const cursorResult = resolveCursorQueryParam(req.query['cursor']);
        if (!cursorResult.ok) {
          res.status(400).json({
            status: 'error',
            message: cursorResult.message,
          });
          return;
        }

        let limit;
        try {
          limit = req.query.limit !== undefined ? parseLimit(req.query.limit) : CURSOR_DEFAULT_LIMIT;
        } catch (err) {
          res.status(400).json({
            status: 'error',
            message: (err as Error).message,
          });
          return;
        }

        const page = await this.service.getContractsPage({ limit, cursor: cursorResult.cursor });
        res.status(200).json({ status: 'success', data: page });
        return;
      }

      const pagination = parsePaginationQuery((req.query ?? {}) as Record<string, unknown>);
      if (!pagination.ok) {
        fail(res, 'bad_request', pagination.error, 400);
        return;
      }

      const allContracts = await this.service.getAllContracts();
      const { page, limit, offset } = pagination.value;
      const pageItems = applyPagination(allContracts, { page, limit, offset });
      const total = allContracts.length;

      ok(res, pageItems, {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/v1/contracts/:id
   * Fetch a single contract by ID.
   */
  public async getContractById(req: Request, res: Response, next: NextFunction) {
    try {
      const contract = await this.service.getContractById(req.params.id!);
      if (!contract) {
        throw new NotFoundError('The requested resource was not found');
      }
      ok(res, contract);
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/v1/contracts
   * Create a new contract.
   */
  public async createContract(req: Request, res: Response, next: NextFunction) {
    try {
      const data: CreateContractDto = req.body;
      const newContract = await this.service.createContract(data);
      ok(res, newContract, undefined, 201);
    } catch (error) {
      if (error instanceof ContractBoundsError) {
        fail(res, 'contract_bounds_error', error.message, 422);
        return;
      }
      next(error);
    }
  }

  /**
   * PATCH /api/v1/contracts/:id
   * Update an existing contract.
   */
  public async updateContract(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params as unknown as ContractIdParams;
      const updateData: UpdateContractDto = req.body;
      const updatedContract = await this.service.updateContract(id, updateData);
      ok(res, updatedContract);
    } catch (error) {
      if (error instanceof ContractBoundsError) {
        fail(res, 'contract_bounds_error', error.message, 422);
        return;
      }
      next(error);
    }
  }

  /**
   * DELETE /api/v1/contracts/:id
   * Delete a contract.
   */
  public async deleteContract(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params as unknown as ContractIdParams;
      await this.service.deleteContract(id);
      ok(res, { message: 'Contract deleted successfully' });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/v1/contracts/stats
   * Get contract statistics.
   */
  public async getContractStats(req: Request, res: Response, next: NextFunction) {
    try {
      const stats = await this.service.getContractStats();
      ok(res, stats);
    } catch (error) {
      if (error instanceof ContractBoundsError) {
        fail(res, 'contract_bounds_error', error.message, 422);
        return;
      }
      next(error);
    }
  }

  /**
   * GET /api/v1/contracts/bounds
   * Returns the enforced per-contract limits for client discovery.
   */
  public static getBounds(_req: Request, res: Response) {
    ok(res, CONTRACT_BOUNDS);
  }

  /**
   * Instance version of getBounds.
   */
  public getBounds(_req: Request, res: Response) {
    ok(res, CONTRACT_BOUNDS);
  }
}

/**
 * Factory function that creates a ContractsController with injected service.
 * Use this in route registration to avoid module-level DB side effects.
 *
 * @param service - ContractsService instance to inject
 * @returns Bound handler methods ready for use in Express routes
 */
export function createContractsController(service: ContractsService) {
  const controller = new ContractsController(service);
  return {
    getContracts: controller.getContracts.bind(controller),
    getContractById: controller.getContractById.bind(controller),
    createContract: controller.createContract.bind(controller),
    updateContract: controller.updateContract.bind(controller),
    deleteContract: controller.deleteContract.bind(controller),
    getContractStats: controller.getContractStats.bind(controller),
    getBounds: controller.getBounds.bind(controller),
  };
}
