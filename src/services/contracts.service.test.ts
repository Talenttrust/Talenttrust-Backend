import { ContractsService } from './contracts.service';
import { SorobanService } from './soroban.service';

// Mock the SorobanService to isolate tests
jest.mock('./soroban.service');

describe('ContractsService', () => {
  let contractsService: ContractsService;
  let mockSorobanService: jest.Mocked<SorobanService>;

  beforeEach(() => {
    mockSorobanService = new SorobanService() as jest.Mocked<SorobanService>;

    // In our implementation, ContractsService instantiates its own SorobanService.
    // By mocking the module, instances will be mocked automatically.
    contractsService = new ContractsService();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getAllContracts', () => {
    it('should return an empty array initially', async () => {
      const contracts = await contractsService.getAllContracts();
      expect(contracts).toEqual([]);
    });
  });

  describe('createContract', () => {
    it('should create a contract and call SorobanService.prepareEscrow', async () => {
      const contractData = {
        title: 'Build a frontend',
        description: 'React TS development',
        budget: 500
      };

      const result = await contractsService.createContract(contractData);

      expect(result).toMatchObject({
        title: 'Build a frontend',
        description: 'React TS development',
        budget: 500,
        status: 'PENDING'
      });
      expect(result.id).toBeDefined();
      expect(result.createdAt).toBeDefined();

      // Check if the mock was called correctly
      const mockPrepareEscrow = SorobanService.prototype.prepareEscrow as jest.Mock;
      expect(mockPrepareEscrow).toHaveBeenCalledWith(result.id, 500);
    });
  });
});
