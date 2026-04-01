import { ChaosPolicy } from '../chaos/chaosPolicy';
import { ContractsClient, DependencyError } from './contractsClient';

describe('ContractsClient', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('returns contracts from upstream payload', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ contracts: [{ id: 'ct_1', status: 'open' }] }),
    } as unknown as Response);

    const client = new ContractsClient(
      { upstreamContractsUrl: 'http://upstream/contracts', upstreamTimeoutMs: 500 },
      new ChaosPolicy({ chaosMode: 'off', chaosTargets: [], chaosProbability: 0 }),
    );

    await expect(client.getContracts()).resolves.toEqual([{ id: 'ct_1', status: 'open' }]);
  });

  it('throws when chaos policy injects timeout', async () => {
    const client = new ContractsClient(
      { upstreamContractsUrl: 'http://upstream/contracts', upstreamTimeoutMs: 500 },
      new ChaosPolicy({ chaosMode: 'timeout', chaosTargets: ['contracts'], chaosProbability: 0 }),
    );

    await expect(client.getContracts()).rejects.toBeInstanceOf(DependencyError);
  });

  it('throws when upstream payload is invalid', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [] }),
    } as unknown as Response);

    const client = new ContractsClient(
      { upstreamContractsUrl: 'http://upstream/contracts', upstreamTimeoutMs: 500 },
      new ChaosPolicy({ chaosMode: 'off', chaosTargets: [], chaosProbability: 0 }),
    );

    await expect(client.getContracts()).rejects.toBeInstanceOf(DependencyError);
  });
});
