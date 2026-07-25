import { ContractsService } from './contracts.service';
import { SorobanService } from './soroban.service';
import { ContractBoundsError } from '../contracts/bounds';
import { MAX_MILESTONES_PER_CONTRACT, MAX_CONTRACT_AMOUNT_STROOPS } from '../contracts/bounds';
import { InMemoryContractRepository } from '../repositories/contractRepository';
import { CreateContractDto, UpdateContractDto } from '../modules/contracts/dto/contract.dto';

jest.mock('./soroban.service');

describe('ContractsService', () => {
  let contractsService: ContractsService;
  let repository: InMemoryContractRepository;
  let mockSorobanService: jest.Mocked<SorobanService>;

  beforeEach(() => {
    repository = new InMemoryContractRepository();
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

    it('returns contracts in descending createdAt order from the real repository', async () => {
      await contractsService.createContract({
        title: 'First',
        description: 'First contract',
        clientId: '550e8400-e29b-41d4-a716-446655440000',
        budget: 1000,
      });
      await contractsService.createContract({
        title: 'Second',
        description: 'Second contract',
        clientId: '550e8400-e29b-41d4-a716-446655440001',
        budget: 2000,
      });

      const contracts = await contractsService.getAllContracts();
      expect(contracts).toHaveLength(2);
      expect(contracts[0]?.title).toBe('Second');
      expect(contracts[1]?.title).toBe('First');
    });
  });

  describe('getContractsPage', () => {
    it('delegates to the repository page implementation', async () => {
      const fakePage = {
        data: [],
        nextCursor: null,
        hasNextPage: false,
        limit: 10,
      };
      const mockRepository = {
        findPage: jest.fn().mockResolvedValue(fakePage),
      } as any;

      const service = new ContractsService(mockRepository);
      const page = await service.getContractsPage({ limit: 10 });

      expect(page).toBe(fakePage);
      expect(mockRepository.findPage).toHaveBeenCalledWith({ limit: 10 });
    });

    it('uses default empty input when called without arguments', async () => {
      const page = await contractsService.getContractsPage();
      expect(page.data).toEqual([]);
      expect(page.limit).toBe(20);
    });

    it('returns cursor-paginated results from the real repository', async () => {
      await contractsService.createContract({
        title: 'Contract A',
        description: 'First contract',
        clientId: '550e8400-e29b-41d4-a716-446655440000',
        budget: 1000,
      });
      await contractsService.createContract({
        title: 'Contract B',
        description: 'Second contract',
        clientId: '550e8400-e29b-41d4-a716-446655440001',
        budget: 2000,
      });

      const page = await contractsService.getContractsPage({ limit: 1 });
      expect(page.data).toHaveLength(1);
      expect(page.hasNextPage).toBe(true);
      expect(page.limit).toBe(1);
    });
  });

  describe('getAllContracts', () => {
    it('delegates to the repository findAll implementation', async () => {
      const fakeContracts = [{ id: '1' }, { id: '2' }];
      const mockRepository = {
        findAll: jest.fn().mockResolvedValue(fakeContracts),
      } as any;

      const service = new ContractsService(mockRepository);
      const contracts = await service.getAllContracts();

      expect(contracts).toBe(fakeContracts);
      expect(mockRepository.findAll).toHaveBeenCalled();
    });
  });

  describe('getContractById', () => {
    it('delegates to the repository findById implementation', async () => {
      const fakeContract = { id: 'abc' };
      const mockRepository = {
        findById: jest.fn().mockResolvedValue(fakeContract),
      } as any;

      const service = new ContractsService(mockRepository);
      const contract = await service.getContractById('abc');

      expect(contract).toBe(fakeContract);
      expect(mockRepository.findById).toHaveBeenCalledWith('abc');
    });

    it('returns undefined for a non-existent id from the real repository', async () => {
      const contract = await contractsService.getContractById('non-existent-id');
      expect(contract).toBeUndefined();
    });
  });

  describe('createContract', () => {
    it('creates a contract and delegates to the repository create implementation', async () => {
      const contractData: CreateContractDto = {
        title: 'Repo-backed contract',
        description: 'Test create delegate',
        clientId: '550e8400-e29b-41d4-a716-446655440000',
        budget: 1000,
      };

      const fakeContract = {
        id: 'abc',
        title: contractData.title,
        clientId: contractData.clientId,
        freelancerId: '',
        amount: contractData.budget,
        status: 'draft',
        version: 0,
        createdAt: new Date().toISOString(),
      };

      const mockRepository = {
        create: jest.fn().mockReturnValue(fakeContract),
      } as any;
      const service = new ContractsService(mockRepository);
      const mockSorobanService = { prepareEscrow: jest.fn().mockResolvedValue(undefined) } as any;
      (service as any).sorobanService = mockSorobanService;

      const result = await service.createContract(contractData);

      expect(result).toBe(fakeContract);
      expect(mockRepository.create).toHaveBeenCalledWith({
        title: contractData.title,
        clientId: contractData.clientId,
        freelancerId: '',
        amount: contractData.budget,
        status: 'draft',
      });
      expect(mockSorobanService.prepareEscrow).toHaveBeenCalledWith(fakeContract.id, contractData.budget);
    });
  });

  describe('updateContract', () => {
    it('delegates to the repository updateWithVersion implementation', async () => {
      const fakeUpdatedContract = {
        id: 'abc',
        title: 'updated',
        clientId: 'client',
        freelancerId: 'freelancer',
        amount: 1000,
        status: 'active',
        version: 1,
        createdAt: new Date().toISOString(),
      };
      const mockRepository = {
        updateWithVersion: jest.fn().mockReturnValue(fakeUpdatedContract),
      } as any;
      const service = new ContractsService(mockRepository);

      const result = await service.updateContract('abc', {
        version: 0,
        title: 'updated',
      });

      expect(result).toBe(fakeUpdatedContract);
      expect(mockRepository.updateWithVersion).toHaveBeenCalledWith('abc', { title: 'updated' }, 0);
    });
  });

  describe('deleteContract', () => {
    it('delegates to the repository delete implementation and throws when missing', async () => {
      const mockRepository = {
        delete: jest.fn().mockReturnValue(false),
      } as any;
      const service = new ContractsService(mockRepository);

      await expect(service.deleteContract('missing')).rejects.toThrow(/not found/);
      expect(mockRepository.delete).toHaveBeenCalledWith('missing');
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

    it('persists budget (amount) when provided', async () => {
      const created = await contractsService.createContract({
        title: 'Budget test',
        description: 'Test budget update',
        clientId: '550e8400-e29b-41d4-a716-446655440000',
        budget: 1000,
      });

      const updated = await contractsService.updateContract(created.id, {
        version: 0,
        budget: 5000,
      });

      expect(updated.amount).toBe(5000);
    });

    it('persists freelancerId when provided', async () => {
      const created = await contractsService.createContract({
        title: 'Freelancer test',
        description: 'Test freelancer update',
        clientId: '550e8400-e29b-41d4-a716-446655440000',
        budget: 1000,
      });

      const freelancerId = '550e8400-e29b-41d4-a716-446655440001';
      const updated = await contractsService.updateContract(created.id, {
        version: 0,
        freelancerId,
      });

      expect(updated.freelancerId).toBe(freelancerId);
    });

    it('throws ContractBoundsError when updated budget exceeds cap', async () => {
      const created = await contractsService.createContract({
        title: 'Bounds test',
        description: 'Test bounds violation',
        clientId: '550e8400-e29b-41d4-a716-446655440000',
        budget: 1000,
      });

      await expect(
        contractsService.updateContract(created.id, {
          version: 0,
          budget: MAX_CONTRACT_AMOUNT_STROOPS + 1,
        })
      ).rejects.toThrow(ContractBoundsError);
    });

    it('throws ContractBoundsError when updated milestones exceed cap', async () => {
      const created = await contractsService.createContract({
        title: 'Milestones test',
        description: 'Test milestone bounds',
        clientId: '550e8400-e29b-41d4-a716-446655440000',
        budget: 1000,
      });

      const milestones = Array.from({ length: MAX_MILESTONES_PER_CONTRACT + 1 }, (_, i) => ({
        title: `M${i}`,
        description: `D${i}`,
        amount: 1,
        completed: false,
      }));

      await expect(
        contractsService.updateContract(created.id, { version: 0, milestones })
      ).rejects.toThrow(ContractBoundsError);
    });

    it('throws an error for empty patch (no-op update)', async () => {
      const created = await contractsService.createContract({
        title: 'No-op test',
        description: 'Testing empty patch',
        clientId: '550e8400-e29b-41d4-a716-446655440000',
        budget: 1000,
      });

      await expect(
        contractsService.updateContract(created.id, { version: 0 })
      ).rejects.toThrow(/field/i);
    });

    it('should throw error when updating non-existent contract', async () => {
      const updateData: UpdateContractDto = {
        version: 0,
        title: 'Updated Contract',
      };

      await expect(contractsService.updateContract('non-existent-id', updateData)).rejects.toThrow();
    });

    it('throws VersionConflictError when version is stale', async () => {
      const created = await contractsService.createContract({
        title: 'Version conflict test',
        description: 'Testing OCC',
        clientId: '550e8400-e29b-41d4-a716-446655440000',
        budget: 1000,
      });

      await contractsService.updateContract(created.id, { version: 0, title: 'First update' });

      await expect(
        contractsService.updateContract(created.id, { version: 0, title: 'Stale update' }),
      ).rejects.toThrow(/Version conflict/);
    });

    it('throws MissingVersionError when version is undefined', async () => {
      const created = await contractsService.createContract({
        title: 'No version test',
        description: 'Missing version',
        clientId: '550e8400-e29b-41d4-a716-446655440000',
        budget: 1000,
      });

      await expect(
        contractsService.updateContract(created.id, { title: 'No version' } as unknown as UpdateContractDto),
      ).rejects.toThrow(/version field is required/i);
    });

    it('throws InvalidVersionError when version is negative', async () => {
      const created = await contractsService.createContract({
        title: 'Negative version test',
        description: 'Negative version',
        clientId: '550e8400-e29b-41d4-a716-446655440000',
        budget: 1000,
      });

      await expect(
        contractsService.updateContract(created.id, { version: -1, title: 'Negative' }),
      ).rejects.toThrow(/non-negative integer/i);
    });

    it('throws InvalidVersionError when version is non-integer', async () => {
      const created = await contractsService.createContract({
        title: 'Float version test',
        description: 'Float version',
        clientId: '550e8400-e29b-41d4-a716-446655440000',
        budget: 1000,
      });

      await expect(
        contractsService.updateContract(created.id, { version: 1.5, title: 'Float' }),
      ).rejects.toThrow(/non-negative integer/i);
    });
  });

  describe('getBounds', () => {
    it('returns policy bounds', () => {
      const bounds = contractsService.getBounds();
      expect(bounds).toHaveProperty('maxMilestones');
      expect(bounds).toHaveProperty('maxAmount');
    });
  });

  describe('InMemoryContractRepository', () => {
    it('findByClientId returns matching contracts', async () => {
      const c1 = await contractsService.createContract({
        title: 'C1',
        description: 'First',
        clientId: 'client-a',
        budget: 100,
      });
      await contractsService.createContract({
        title: 'C2',
        description: 'Second',
        clientId: 'client-b',
        budget: 200,
      });
      const results = await repository.findByClientId('client-a');
      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe(c1.id);
    });

    it('create with only required fields uses defaults', async () => {
      const contract = await repository.create({
        title: 'Minimal',
        clientId: 'client-x',
        amount: 500,
      });
      expect(contract.status).toBe('draft');
      expect(contract.freelancerId).toBe('');
      expect(contract.version).toBe(0);
    });

    it('findAll with timestamp collisions uses insertion order tie-break', async () => {
      jest.useFakeTimers({ advanceTimers: true });
      const now = new Date('2024-06-01T12:00:00.000Z');
      jest.setSystemTime(now);

      const c1 = await repository.create({ title: 'SameTs-A', clientId: 'c', amount: 100 });
      const c2 = await repository.create({ title: 'SameTs-B', clientId: 'c', amount: 200 });

      jest.useRealTimers();

      const all = await repository.findAll();
      expect(all).toHaveLength(2);
      // Most recently inserted first (c2 before c1)
      expect(all[0]!.id).toBe(c2.id);
      expect(all[1]!.id).toBe(c1.id);
    });

    it('findPage with cursor returns subsequent page', async () => {
      jest.useFakeTimers({ advanceTimers: true });
      jest.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
      await repository.create({ title: 'A', clientId: 'c', amount: 100 });
      jest.setSystemTime(new Date('2024-01-01T00:00:01.000Z'));
      await repository.create({ title: 'B', clientId: 'c', amount: 200 });
      jest.setSystemTime(new Date('2024-01-01T00:00:02.000Z'));
      await repository.create({ title: 'C', clientId: 'c', amount: 300 });
      jest.useRealTimers();

      const page1 = await repository.findPage({ limit: 2 });
      expect(page1.data).toHaveLength(2);
      expect(page1.hasNextPage).toBe(true);
      expect(page1.nextCursor).not.toBeNull();

      const page2 = await repository.findPage({ limit: 2, cursor: page1.nextCursor! });
      expect(page2.data).toHaveLength(1);
      expect(page2.hasNextPage).toBe(false);
      expect(page2.nextCursor).toBeNull();
    });

    it('clear removes all contracts', async () => {
      await contractsService.createContract({
        title: 'Clear test', description: 'd', clientId: '550e8400-e29b-41d4-a716-446655440000', budget: 100,
      });
      expect(await repository.findAll()).toHaveLength(1);
      repository.clear();
      expect(await repository.findAll()).toHaveLength(0);
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
