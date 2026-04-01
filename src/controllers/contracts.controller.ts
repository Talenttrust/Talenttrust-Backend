import { Request, Response, NextFunction } from 'express';
import { ContractsService } from '../services/contracts.service';
import { CreateContractDto } from '../modules/contracts/dto/contract.dto';

const contractsService = new ContractsService();

/**
 * @dev Presentation layer for Contracts.
 * Handles HTTP requests, extracts parameters, and formulates responses.
 * Delegates core logic to the ContractsService.
 */
export class ContractsController {
  
  /**
   * GET /api/v1/contracts
   * Fetch a list of all escrow contracts.
   */
  public static async getContracts(req: Request, res: Response, next: NextFunction) {
    try {
      const contracts = await contractsService.getAllContracts();
      res.status(200).json({ status: 'success', data: contracts });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/v1/contracts
   * Create a new escrow contract metadata entry.
   */
  public static async createContract(req: Request, res: Response, next: NextFunction) {
    try {
      const data: CreateContractDto = req.body;
      const newContract = await contractsService.createContract(data);
      res.status(201).json({ status: 'success', data: newContract });
    } catch (error) {
      next(error);
    }
  }
}
