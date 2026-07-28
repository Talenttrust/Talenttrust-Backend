import { ContractsService } from './contracts.service';
import { ContractCacheService } from './contractCache.service';
import { InMemoryContractRepository } from '../repositories/contractRepository';
import { SorobanService } from './soroban.service';

jest.mock('./soroban.service');

describe('ContractsService with cache integration', () => {
  let service: ContractsService;
  let repository: InMemoryContractRepository;
  let cache: ContractCacheService;
  let mockSorobanService: jest.Mocked<SorobanService>;

  beforeEach(() => {
    repository = new InMemoryContractRepository();
    cache = new ContractCacheService({ ttlMs: 60000, swrMs: 0, maxEntries: 100 });
    service = new ContractsService(repository as any, cache);
    mockSorobanService = new SorobanService() as jest.Mocked<SorobanService>;
    (service as any).sorobanService = mockSorobanService;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('read caching', () => {
    it('getContractById caches the result on first read', async () => {
      const contract = await service.createContract({
        title: 'Cache Test',
        description: 'Testing caching',
        clientId: 'client-1',
        budget: 1000,
      });

      const spy = jest.spyOn(repository, 'findById');

      const first = await service.getContractById(contract.id);
      expect(first?.id).toBe(contract.id);
      expect(spy).toHaveBeenCalledTimes(1);

      const second = await service.getContractById(contract.id);
      expect(second?.id).toBe(contract.id);
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('getAllContracts caches the result on first read', async () => {
      await service.createContract({ title: 'A', description: 'd', clientId: 'c1', budget: 100 });
      await service.createContract({ title: 'B', description: 'd', clientId: 'c2', budget: 200 });

      const spy = jest.spyOn(repository, 'findAll');

      const first = await service.getAllContracts();
      expect(first).toHaveLength(2);
      expect(spy).toHaveBeenCalledTimes(1);

      const second = await service.getAllContracts();
      expect(second).toHaveLength(2);
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  describe('write invalidation', () => {
    it('createContract invalidates the list cache', async () => {
      const contract = await service.createContract({
        title: 'First',
        description: 'd',
        clientId: 'c1',
        budget: 100,
      });

      const listSpy = jest.spyOn(repository, 'findAll');

      await service.getAllContracts();
      expect(listSpy).toHaveBeenCalledTimes(1);

      await service.createContract({
        title: 'Second',
        description: 'd',
        clientId: 'c2',
        budget: 200,
      });

      await service.getAllContracts();
      expect(listSpy).toHaveBeenCalledTimes(2);
    });

    it('updateContract invalidates the contract and list caches', async () => {
      const contract = await service.createContract({
        title: 'Original',
        description: 'd',
        clientId: 'c1',
        budget: 100,
      });

      const findByIdSpy = jest.spyOn(repository, 'findById');
      const findAllSpy = jest.spyOn(repository, 'findAll');

      await service.getContractById(contract.id);
      await service.getAllContracts();
      expect(findByIdSpy).toHaveBeenCalledTimes(1);
      expect(findAllSpy).toHaveBeenCalledTimes(1);

      await service.updateContract(contract.id, { version: 0, title: 'Updated' });

      await service.getContractById(contract.id);
      await service.getAllContracts();
      expect(findByIdSpy).toHaveBeenCalledTimes(2);
      expect(findAllSpy).toHaveBeenCalledTimes(2);
    });

    it('deleteContract invalidates the contract and list caches', async () => {
      const contract = await service.createContract({
        title: 'To Delete',
        description: 'd',
        clientId: 'c1',
        budget: 100,
      });

      const findByIdSpy = jest.spyOn(repository, 'findById');

      await service.getContractById(contract.id);
      expect(findByIdSpy).toHaveBeenCalledTimes(1);

      await service.deleteContract(contract.id);

      await service.getContractById(contract.id);
      expect(findByIdSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('cold cache fallback', () => {
    it('works without cache (null cache)', async () => {
      const noCacheService = new ContractsService(repository as any);
      (noCacheService as any).sorobanService = mockSorobanService;

      const contract = await noCacheService.createContract({
        title: 'No Cache',
        description: 'd',
        clientId: 'c1',
        budget: 100,
      });

      const findByIdSpy = jest.spyOn(repository, 'findById');

      await noCacheService.getContractById(contract.id);
      await noCacheService.getContractById(contract.id);

      expect(findByIdSpy).toHaveBeenCalledTimes(2);
    });

    it('getAllContracts works without cache', async () => {
      const noCacheService = new ContractsService(repository as any);
      (noCacheService as any).sorobanService = mockSorobanService;

      await noCacheService.createContract({ title: 'A', description: 'd', clientId: 'c1', budget: 100 });

      const findAllSpy = jest.spyOn(repository, 'findAll');

      const result = await noCacheService.getAllContracts();
      expect(result).toHaveLength(1);
      expect(findAllSpy).toHaveBeenCalled();
    });
  });
});
