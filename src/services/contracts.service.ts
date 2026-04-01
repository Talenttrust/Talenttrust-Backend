import { CreateContractDto } from '../modules/contracts/dto/contract.dto';
import { SorobanService } from './soroban.service';

/**
 * @dev Service layer for managing Freelancer Escrow Contracts.
 * Handles business logic, database interactions (mocked for now), 
 * and orchestration with the Soroban smart contract service.
 */
export class ContractsService {
  private sorobanService: SorobanService;
  
  // Mock database
  private contracts: any[] = [];

  constructor() {
    this.sorobanService = new SorobanService();
  }

  /**
   * Retrieves all contracts, optionally syncing with their on-chain state.
   * @returns Array of contract metadata.
   */
  public async getAllContracts() {
    // In a real app, we would fetch from DB and map to on-chain state if necessary.
    return this.contracts;
  }

  /**
   * Creates a new contract off-chain, preparing it for escrow deposit.
   * @param data The contract details conforming to CreateContractDto.
   * @returns The newly created contract object.
   */
  public async createContract(data: CreateContractDto) {
    const newContract = {
      id: crypto.randomUUID(),
      ...data,
      status: 'PENDING',
      createdAt: new Date(),
    };
    
    this.contracts.push(newContract);
    
    // Simulate notifying the Soroban service to prepare the transaction
    await this.sorobanService.prepareEscrow(newContract.id, data.budget);

    return newContract;
  }
}
