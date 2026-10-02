import { ContractsService } from './contracts.service';
import { IContractRepository } from '../repositories/contractRepository';
import { ContractBoundsError, MAX_CONTRACT_AMOUNT_STROOPS, MAX_MILESTONES_PER_CONTRACT } from '../contracts/bounds';

describe('ContractsService Edge Cases Regression', () => {
  let mockRepo: jest.Mocked<IContractRepository>;
  let service: ContractsService;

  beforeEach(() => {
    mockRepo = {
      findAll: jest.fn(),
      findById: jest.fn(),
      findPage: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateWithVersion: jest.fn(),
      delete: jest.fn(),
    } as unknown as jest.Mocked<IContractRepository>;

    service = new ContractsService(mockRepo, true); // milestones enabled
  });

  describe('createContract - regression: malformed budget', () => {
    it('rejects string budget at runtime', async () => {
      await expect(
        service.createContract({
          title: 'Test',
          clientId: 'client1',
          budget: '1000' as any,
        })
      ).rejects.toThrow(ContractBoundsError);
    });

    it('rejects NaN budget', async () => {
      await expect(
        service.createContract({
          title: 'Test',
          clientId: 'client1',
          budget: NaN,
        })
      ).rejects.toThrow(ContractBoundsError);
    });
  });

  describe('createContract - regression: empty and boundary milestones', () => {
    it('accepts zero budget and empty milestones', async () => {
      mockRepo.create.mockResolvedValue({ id: '1' } as any);
      await service.createContract({
        title: 'Test',
        clientId: 'client1',
        budget: 0,
        milestones: [],
      });
      expect(mockRepo.create).toHaveBeenCalled();
    });

    it('rejects milestones that total more than the budget', async () => {
      await expect(
        service.createContract({
          title: 'Test',
          clientId: 'client1',
          budget: 100,
          milestones: [
            { title: 'A', amount: 50 },
            { title: 'B', amount: 51 },
          ],
        })
      ).rejects.toThrow(ContractBoundsError);
    });
  });

  describe('updateContract - regression: bounds validation bug (still-broken case)', () => {
    it('validates budget against bounds properly on update without throwing TypeError', async () => {
      mockRepo.findById.mockResolvedValue({ id: '1', amount: 100, version: 1 } as any);
      mockRepo.updateWithVersion.mockResolvedValue({ id: '1', amount: MAX_CONTRACT_AMOUNT_STROOPS + 1, version: 2 } as any);

      // Previously this crashed with TypeError: Cannot read properties of undefined (reading 'validateBounds')
      await expect(
        service.updateContract('1', { version: 1, budget: MAX_CONTRACT_AMOUNT_STROOPS + 1 })
      ).rejects.toThrow(ContractBoundsError);
    });

    it('validates milestones properly on update', async () => {
      mockRepo.findById.mockResolvedValue({ id: '1', amount: 100, version: 1 } as any);
      
      await expect(
        service.updateContract('1', { 
          version: 1, 
          milestones: Array(MAX_MILESTONES_PER_CONTRACT + 1).fill({ title: 'm', amount: 1 })
        })
      ).rejects.toThrow(ContractBoundsError);
    });
  });
});
