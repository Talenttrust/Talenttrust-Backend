import { ContractsService } from './contracts.service';
import { SorobanService } from './soroban.service';
import { ContractBoundsError } from '../contracts/bounds';
import { MAX_MILESTONES_PER_CONTRACT, MAX_CONTRACT_AMOUNT_STROOPS } from '../contracts/bounds';
import { InMemoryContractsRepository } from '../repositories/contracts.repository';
import { CreateContractDto, UpdateContractDto } from '../modules/contracts/dto/contract.dto';

jest.mock('./soroban.service');

describe('ContractsService', () => {
  let contractsService: ContractsService;
  let repository: InMemoryContractsRepository;
  let mockSorobanService: jest.Mocked<SorobanService>;

  beforeEach(() => {
    repository = new InMemoryContractsRepository();
    contractsService = new ContractsService(repository as any);
    mockSorobanService = new SorobanService() as jest.Mocked<SorobanService>;
    (contractsService as any).sorobanService = mockSorobanService;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getAllContracts', () => {
    it('returns an empty array initially', async () => {
      const contracts = await contractsService.getAllContracts();
      expect(contracts).toEqual([]);
    });
  });

  describe('createContract', () => {
    it('creates a contract and calls SorobanService.prepareEscrow', async () => {
      const contractData: CreateContractDto = {
        title: 'Build a frontend',
        description: 'React TS development',
        clientId: '550e8400-e29b-41d4-a716-446655440000',
        budget: 500,
      };

      const result = await contractsService.createContract(contractData);

      expect(result).toMatchObject({
        title: 'Build a frontend',
        clientId: '550e8400-e29b-41d4-a716-446655440000',
        amount: 500,
        status: 'draft',
      });
      expect(result.id).toBeDefined();
      expect(result.createdAt).toBeDefined();

      expect(mockSorobanService.prepareEscrow).toHaveBeenCalledWith(result.id, 500);
    });

    it('should create a contract with milestones', async () => {
      const contractData: CreateContractDto = {
        title: 'Contract with milestones',
        description: 'A contract with milestones',
        clientId: '550e8400-e29b-41d4-a716-446655440000',
        budget: 2000,
        milestones: [
          {
            title: 'Milestone 1',
            description: 'First milestone',
            amount: 1000,
            completed: false,
          },
          {
            title: 'Milestone 2',
            description: 'Second milestone',
            amount: 1000,
            completed: false,
          },
        ],
      };

      const result = await contractsService.createContract(contractData);
      expect(mockSorobanService.prepareEscrow).toHaveBeenCalledWith(result.id, 2000);
    });

    it('should throw error when milestone amounts exceed budget', async () => {
      const contractData: CreateContractDto = {
        title: 'Invalid contract',
        description: 'Contract with invalid milestones',
        clientId: '550e8400-e29b-41d4-a716-446655440000',
        budget: 1000,
        milestones: [
          {
            title: 'Milestone 1',
            description: 'First milestone',
            amount: 1500,
            completed: false,
          },
        ],
      };

      await expect(contractsService.createContract(contractData)).rejects.toThrow(
        'Total milestone amount exceeds maximum contract amount'
      );
    });

    it('should handle Soroban service errors gracefully', async () => {
      mockSorobanService.prepareEscrow.mockRejectedValue(new Error('Soroban error'));

      const contractData: CreateContractDto = {
        title: 'Test Contract',
        description: 'A test contract',
        clientId: '550e8400-e29b-41d4-a716-446655440000',
        budget: 1000,
      };

      // Should not throw error, just log warning
      const result = await contractsService.createContract(contractData);
      expect(result).toBeDefined();
      expect(result.id).toBeDefined();
    });
  });

  describe('updateContract', () => {
    it('should update an existing contract', async () => {
      const contractData: CreateContractDto = {
        title: 'Original Contract',
        description: 'Original description',
        clientId: '550e8400-e29b-41d4-a716-446655440000',
        budget: 1000,
      };

      const created = await contractsService.createContract(contractData);
      const updateData: UpdateContractDto = {
        version: 0,
        title: 'Updated Contract',
        status: 'active',
      };

      const updated = await contractsService.updateContract(created.id, updateData);

      expect(updated.id).toBe(created.id);
      expect(updated.title).toBe('Updated Contract');
      expect(updated.amount).toBe(created.amount); // amount stays same if not updated
      expect(updated.status).toBe('active');
    });

    it('should throw error when updating non-existent contract', async () => {
      const updateData: UpdateContractDto = {
        version: 0,
        title: 'Updated Contract',
      };

      await expect(contractsService.updateContract('non-existent-id', updateData)).rejects.toThrow();
    });
  });

  describe('deleteContract', () => {
    it('should delete a contract', async () => {
      const contractData: CreateContractDto = {
        title: 'Test Contract',
        description: 'A test contract',
        clientId: '550e8400-e29b-41d4-a716-446655440000',
        budget: 1000,
        status: 'draft',
      };

      const created = await contractsService.createContract(contractData);
      await contractsService.deleteContract(created.id);

      const found = await contractsService.getContractById(created.id);
      expect(found).toBeUndefined();
    });

    it('should throw error when deleting non-existent contract', async () => {
      await expect(contractsService.deleteContract('non-existent-id')).rejects.toThrow(
        'Contract with id non-existent-id not found'
      );
    });
  });

  describe('getContractStats', () => {
    it('should return contract statistics', async () => {
      await contractsService.createContract({
        title: 'Contract 1',
        description: 'First contract',
        clientId: '550e8400-e29b-41d4-a716-446655440000',
        budget: 1000,
        status: 'draft',
      });

      await contractsService.createContract({
        title: 'Contract 2',
        description: 'Second contract',
        clientId: '550e8400-e29b-41d4-a716-446655440001',
        budget: 2000,
        status: 'active',
      });

      const stats = await contractsService.getContractStats();

      expect(stats.total).toBe(2);
      expect(stats.byStatus.draft).toBe(1);
      expect(stats.byStatus.active).toBe(1);
      expect(stats.totalBudget).toBe(3000);
    });

    it('should return zero stats for empty repository', async () => {
      const stats = await contractsService.getContractStats();

      expect(stats.total).toBe(0);
      expect(stats.totalBudget).toBe(0);
    });

    it('throws ContractBoundsError when budget exceeds cap', async () => {
      const contractData = {
        title: 'Big contract',
        description: 'Very large budget',
        clientId: '550e8400-e29b-41d4-a716-446655440000',
        budget: MAX_CONTRACT_AMOUNT_STROOPS + 1,
      };

      await expect(contractsService.createContract(contractData)).rejects.toThrow(
        ContractBoundsError,
      );
    });

    it('throws ContractBoundsError when milestone count exceeds cap', async () => {
      const milestones = Array.from({ length: MAX_MILESTONES_PER_CONTRACT + 1 }, (_, i) => ({
        title: `M${i}`,
        description: `D${i}`,
        amount: 1,
        completed: false,
      }));

      await expect(
        contractsService.createContract({
          title: 'Too many milestones',
          description: 'Exceeds milestone limit',
          clientId: '550e8400-e29b-41d4-a716-446655440000',
          budget: 100,
          milestones,
        }),
      ).rejects.toThrow(ContractBoundsError);
    });

    it('does not persist contract when bounds are violated', async () => {
      await expect(
        contractsService.createContract({
          title: 'Big contract',
          description: 'Over the limit',
          clientId: '550e8400-e29b-41d4-a716-446655440000',
          budget: MAX_CONTRACT_AMOUNT_STROOPS + 1,
        }),
      ).rejects.toThrow(ContractBoundsError);

      const contracts = await contractsService.getAllContracts();
      expect(contracts).toHaveLength(0);
    });
  });
});
