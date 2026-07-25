import type { NextFunction, Request, Response } from 'express';
import { CONTRACT_BOUNDS, ContractBoundsError } from '../contracts/bounds';
import { CURSOR_DEFAULT_LIMIT } from '../contracts/cursor.types';
import { NotFoundError } from '../errors/appError';
import {
  CreateContractRequestDto,
  UpdateContractRequestDto,
  toContractResponseDto,
  toCreateContractDto,
  toUpdateContractDto,
} from '../modules/contracts/dto/contracts-boundary.dto';
import { ContractsService } from '../services/contracts.service';
import { fail, ok } from '../utils/apiResponse';
import { applyPagination, parsePaginationQuery } from '../utils/pagination';

type ContractRequest<TBody = unknown> = Request<
  Record<string, string>,
  unknown,
  TBody
>;

/**
 * Presentation layer for contracts. Transport DTOs are mapped explicitly at
 * this boundary so service and persistence types do not leak into handlers.
 */
export class ContractsController {
  constructor(private readonly service: ContractsService) {}

  public async getContracts(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const pagination = parsePaginationQuery(
        (req.query ?? {}) as Record<string, unknown>,
      );
      if (!pagination.ok) {
        fail(res, 'bad_request', pagination.error, 400);
        return;
      }

      const allContracts = await this.service.getAllContracts();
      const { page, limit, offset } = pagination.value;
      const pageItems = applyPagination(allContracts, {
        page,
        limit,
        offset,
      }).map(toContractResponseDto);
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

  public async getContractById(
    req: ContractRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const contract = await this.service.getContractById(req.params.id!);
      if (!contract) {
        throw new NotFoundError('The requested resource was not found');
      }
      ok(res, toContractResponseDto(contract));
    } catch (error) {
      next(error);
    }
  }

  public async createContract(
    req: ContractRequest<CreateContractRequestDto>,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const contract = await this.service.createContract(
        toCreateContractDto(req.body),
      );
      ok(res, toContractResponseDto(contract), undefined, 201);
    } catch (error) {
      if (error instanceof ContractBoundsError) {
        fail(res, 'contract_bounds_error', error.message, 422);
        return;
      }
      next(error);
    }
  }

  public async updateContract(
    req: ContractRequest<UpdateContractRequestDto>,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const contract = await this.service.updateContract(
        req.params.id!,
        toUpdateContractDto(req.body),
      );
      ok(res, toContractResponseDto(contract));
    } catch (error) {
      if (error instanceof ContractBoundsError) {
        fail(res, 'contract_bounds_error', error.message, 422);
        return;
      }
      next(error);
    }
  }

  public async deleteContract(
    req: ContractRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      await this.service.deleteContract(req.params.id!);
      ok(res, { message: 'Contract deleted successfully' });
    } catch (error) {
      next(error);
    }
  }

  public async getContractStats(
    _req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      ok(res, await this.service.getContractStats());
    } catch (error) {
      if (error instanceof ContractBoundsError) {
        fail(res, 'contract_bounds_error', error.message, 422);
        return;
      }
      next(error);
    }
  }

  public getBounds(_req: Request, res: Response): void {
    ok(res, CONTRACT_BOUNDS);
  }
}

export { CURSOR_DEFAULT_LIMIT };

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
