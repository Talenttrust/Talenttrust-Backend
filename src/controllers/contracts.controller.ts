import { Request, Response, NextFunction } from 'express';
import { ContractsService } from '../services/contracts.service';
import { ContractRepository } from '../repositories/contractRepository';
import { getDb } from '../db/database';
import { CreateContractDto, UpdateContractDto } from '../modules/contracts/dto/contract.dto';
import { CONTRACT_BOUNDS, ContractBoundsError } from '../contracts/bounds';
import { NotFoundError } from '../errors/appError';
import { parsePaginationQuery, applyPagination } from '../utils/pagination';

const contractsService = new ContractsService(new ContractRepository(getDb()));

/**
 * Standard API response envelope for consistent responses
 */
interface ApiResponse<T = any> {
  status: 'success' | 'error';
  data?: T;
  message?: string;
  error?: string;
}

interface ContractIdParams {
  id: string;
}

/**
 * Presentation layer for Contracts.
 * Handles HTTP requests, extracts parameters, and formulates responses.
 * Delegates core logic to the ContractsService.
 */
export class ContractsController {

  /**
   * GET /api/v1/contracts
   * Fetch a paginated list of escrow contracts.
   */
  public static async getContracts(req: Request, res: Response, next: NextFunction) {
    try {
      const pagination = parsePaginationQuery((req.query ?? {}) as Record<string, unknown>);
      if (!pagination.ok) {
        const requestId = typeof res.locals.requestId === 'string' ? res.locals.requestId : 'unknown';
        res.status(400).json({
          error: {
            code: 'bad_request',
            message: pagination.error,
            requestId,
          },
        });
        return;
      }

      const allContracts = await contractsService.getAllContracts();
      const { page, limit, offset } = pagination.value;
      const pageItems = applyPagination(allContracts, { page, limit, offset });
      const total = allContracts.length;

      res.status(200).json({
        status: 'success',
        data: pageItems,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/v1/contracts/:id
   * Fetch a single contract by ID (includes version field).
   */
  public static async getContractById(req: Request, res: Response, next: NextFunction) {
    try {
      const contract = await contractsService.getContractById(req.params.id!);
      if (!contract) {
        throw new NotFoundError('The requested resource was not found');
      }
      res.status(200).json({ status: 'success', data: contract });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/v1/contracts
   * Create a new contract
   */
  public static async createContract(req: Request, res: Response, next: NextFunction) {
    try {
      const data: CreateContractDto = req.body;
      const newContract = await contractsService.createContract(data);
      
      const response: ApiResponse = {
        status: 'success',
        data: newContract,
        message: 'Contract created successfully',
      };
      
      res.status(201).json(response);
    } catch (error) {
      if (error instanceof ContractBoundsError) {
        res.status(422).json({ status: 'error', message: error.message });
        return;
      }
      next(error);
    }
  }

  /**
   * PATCH /api/v1/contracts/:id
   * Update an existing contract
   */
  public static async updateContract(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params as unknown as ContractIdParams;
      const updateData: UpdateContractDto = req.body;
      
      const updatedContract = await contractsService.updateContract(id, updateData);
      
      const response: ApiResponse = {
        status: 'success',
        data: updatedContract,
        message: 'Contract updated successfully',
      };
      
      res.status(200).json(response);
    } catch (error) {
      if (error instanceof ContractBoundsError) {
        res.status(422).json({ status: 'error', message: error.message });
        return;
      }
      next(error);
    }
  }

  /**
   * DELETE /api/v1/contracts/:id
   * Delete a contract
   */
  public static async deleteContract(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params as unknown as ContractIdParams;
      await contractsService.deleteContract(id);
      
      const response: ApiResponse = {
        status: 'success',
        message: 'Contract deleted successfully',
      };
      
      res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/v1/contracts/stats
   * Get contract statistics
   */
  public static async getContractStats(req: Request, res: Response, next: NextFunction) {
    try {
      const stats = await contractsService.getContractStats();
      
      const response: ApiResponse = {
        status: 'success',
        data: stats,
      };
      
      res.status(200).json(response);
    } catch (error) {
      if (error instanceof ContractBoundsError) {
        const requestId = typeof res.locals.requestId === 'string' ? res.locals.requestId : 'unknown';
        res.status(422).json({
          error: {
            code: 'bad_request',
            message: error.message,
            requestId,
          },
        });
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
    res.status(200).json({ status: 'success', data: CONTRACT_BOUNDS });
  }
}
