import { ChaosPolicy } from '../chaos/chaosPolicy';
import { ContractsClient, DependencyError } from './contractsClient';
import { circuitBreakerRegistry } from '../circuit-breaker/registry';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const defaultConfig = {
  upstreamContractsUrl: 'http://upstream/contracts',
  upstreamTimeoutMs: 500,
  circuitBreaker: { failureThreshold: 5, successThreshold: 1, timeoutMs: 30_000 },
};

const offChaos = new ChaosPolicy({ chaosMode: 'off', chaosTargets: [], chaosProbability: 0 });

describe('ContractsClient', () => {
  let mockRequest: jest.Mock;

  beforeEach(() => {
    circuitBreakerRegistry.clear();
    mockRequest = jest.fn();
    mockedAxios.create.mockReturnValue({
      request: mockRequest,
    } as any);
    mockedAxios.isCancel = jest.fn().mockReturnValue(false) as any;
    mockedAxios.isAxiosError = jest.fn().mockReturnValue(false) as any;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('returns contracts from upstream payload', async () => {
    mockRequest.mockResolvedValue({
      data: { contracts: [{ id: 'ct_1', status: 'open' }] },
    });

    const client = new ContractsClient(defaultConfig, offChaos);
    await expect(client.getContracts()).resolves.toEqual([{ id: 'ct_1', status: 'open' }]);
  });

  it('throws when chaos policy injects timeout', async () => {
    const client = new ContractsClient(
      defaultConfig,
      new ChaosPolicy({ chaosMode: 'timeout', chaosTargets: ['contracts'], chaosProbability: 0 }),
    );

    await expect(client.getContracts()).rejects.toBeInstanceOf(DependencyError);
  });

  it('throws when upstream payload is invalid', async () => {
    mockRequest.mockResolvedValue({ data: { items: [] } });

    const client = new ContractsClient(defaultConfig, offChaos);
    await expect(client.getContracts()).rejects.toBeInstanceOf(DependencyError);
  });

  it('throws DependencyError when circuit breaker is open', async () => {
    // Trip the breaker by registering it with threshold 1 then failing once
    circuitBreakerRegistry.getOrCreate('contracts', { failureThreshold: 1 });
    circuitBreakerRegistry.reset('contracts'); // ensure clean state
    const breaker = circuitBreakerRegistry.getOrCreate('contracts');

    mockRequest.mockRejectedValue(new Error('upstream down'));
    mockedAxios.isAxiosError = jest.fn().mockReturnValue(false) as any;

    const client = new ContractsClient(
      { ...defaultConfig, circuitBreaker: { failureThreshold: 1, successThreshold: 1, timeoutMs: 30_000 } },
      offChaos,
    );

    // First call trips the breaker
    await expect(client.getContracts()).rejects.toBeInstanceOf(DependencyError);
    expect(breaker.getState()).toBe('OPEN');

    // Second call is rejected by the open circuit
    await expect(client.getContracts()).rejects.toBeInstanceOf(DependencyError);
  });
});
