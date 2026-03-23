import { ApiError } from './errors/ApiError';
import { ContractService } from './services/contract-service';

describe('ContractService', () => {
  it('lists contracts without mutating the internal store', () => {
    const service = new ContractService([
      {
        id: 'ctr-1',
        title: 'One',
        clientId: 'client-1',
        freelancerId: 'free-1',
        budget: 10,
        currency: 'USDC',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    const listed = service.listContracts();
    listed.push({
      id: 'ctr-2',
      title: 'Two',
      clientId: 'client-2',
      freelancerId: 'free-2',
      budget: 20,
      currency: 'USDC',
      createdAt: '2026-01-02T00:00:00.000Z',
    });

    expect(service.listContracts()).toHaveLength(1);
  });

  it('gets contracts by id', () => {
    const service = new ContractService([
      {
        id: 'ctr-lookup',
        title: 'Lookup',
        clientId: 'client-1',
        freelancerId: 'free-1',
        budget: 10,
        currency: 'USDC',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    expect(service.getContractById('ctr-lookup')?.title).toBe('Lookup');
    expect(service.getContractById('missing')).toBeUndefined();
  });

  it('creates contracts and stores them', () => {
    const service = new ContractService();
    const created = service.createContract({
      title: 'Create',
      clientId: 'client-1',
      freelancerId: 'free-1',
      budget: 99,
      currency: 'USDC',
    });

    expect(created.id).toBeDefined();
    expect(service.listContracts()).toHaveLength(1);
  });

  it('throws ApiError for self-dealing participants', () => {
    const service = new ContractService();

    expect(() =>
      service.createContract({
        title: 'Invalid',
        clientId: 'same',
        freelancerId: 'same',
        budget: 99,
        currency: 'USDC',
      }),
    ).toThrow(ApiError);
  });

  it('throws ApiError for duplicates', () => {
    const service = new ContractService([
      {
        id: 'ctr-existing',
        title: 'Duplicate',
        clientId: 'client-1',
        freelancerId: 'free-1',
        budget: 99,
        currency: 'USDC',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    expect(() =>
      service.createContract({
        title: 'Duplicate',
        clientId: 'client-1',
        freelancerId: 'free-1',
        budget: 99,
        currency: 'USDC',
      }),
    ).toThrow(ApiError);
  });
});
