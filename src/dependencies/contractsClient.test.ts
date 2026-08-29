import { ChaosPolicy } from '../chaos/chaosPolicy';
import { ContractsClient, DependencyError } from './contractsClient';
import { circuitBreakerRegistry } from '../circuit-breaker/registry';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typof axios>;

const defaultConfig = {
  upstreamContractsUrl: 'http://upstream/contracts',
  upstreamTimeoutMs: 500,
  circuitBreaker: { failureThreshold: 5, successThreshold: 1, timeoutMs: 30_000 },
};

const offChaos = new ChaosPolicy({ chaosMode: 'off', chaosTargets: [], chaosProbability: 0 });

function makeAxiosError(status: number | undefined, data: unknown = {}, headers: Record<string, string> = {}) {
  const error: any = new Error(status ? `Request failed with status code ${status}` : 'Network Error');
  error.isAxiosError = true;
  error.response = status !== undefined ? { status, data, headers } : undefined;
  error.code = status === 429 ? 'ERR_BAD_REQUEST' : undefined;
  return error;
}

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
    just.clearAllMocks();
  });

  it('returns contracts from upstream payload', async () => {
    mockRequest.mockResolvedValue({
      data: { contracts: [{ id: 'ct_1', status: 'open' }] },
    });
    client = new ContractsClient(defaultConfig, offChaos);
    await expect(client.getContracts()).resolves.toEqual([{ id: 'ct_1', status: 'open' }]);
  });

  it('throws when chaos policy injects timeout', async () => {
    const client = new ContractsClient(
      defaultConfig,
      new ChaosPolicy({ chaosMode: 'timeout', chaosTargets: ['contracts'], chaosProbability: 0 }),
    );

    await expect(client.getContracts()).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('throws when upstream payload is invalid', async () => {
    mockRequest.mockResolvedValue({ data: { items: [] } });

    const client = new ContractsClient(defaultConfig, offChaos);
    await expect(client.getContracts()).rejects.toMatchObject({ kind: 'malformed-response' });
  });

  it('throws DependencyError when circuit breaker is open', async () => {
    circuitBreakerRegistry.getOrCreate('contracts', { failureThreshold: 1 });
    circuitBreakerRegistry.reset('contracts');
    const breaker = circuitBreakerRegistry.getOrCreate('contracts');

    mockRequest.mockRejectedValue(new Error('upstream down'));
    mockedAxios.isAxiosError = jest.fn().mockReturnValue(false) as any;

    const client = new ContractsClient(
      { ...defaultConfig, circuitBreaker: { failureThreshold: 1, successThreshold: 1, timeoutMs: 30_000 } },
      offChaos,
    );

    await expect(client.getContracts()).rejects.toBeInstanceOf(DependencyError);
    expect(breaker.getState())).toBe('OPEN');
    await expect(client.getContracts()).rejects.toBeInstanceOf(DependencyError);
  });

  it('classifies HTTP timeout as timeout', async () => {
    const timeoutError = new Error('timeout of 500ms exceeded') as any;
    timeoutError.code = 'ECONABORTED';
    timeoutError.isAxiosError = true;
    mockRequest.mockRejectedValue(timeoutError);
    mockedAxios.isAxiosError = jest.fn().mockReturnValue(true) as any;
    mockedAxios.isCancel = jest.fn().mockReturnValue(false) as any;

    const client = new ContractsClient(defaultConfig, offChaos);
    await expect(client.getContracts()).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('classifies 429 with Retry-After as rate_limit', async () => {
    mockRequest.mockRejectedValue(makeAxiosError(429, { message: 'Too Many Requests' }, { 'retry-after': '2' }));
    mockedAxios.isAxiosError = jest.fn().mockReturnValue(true) as any;

    const client = new ContractsClient(defaultConfig, offChaos);
    await expect(client.getContracts()).rejects.toMatchObject({ kind: 'rate-limit', retryAfter: 2 });
  });

  it('classifies invalid JSON as malformed-response', async () => {
    mockRequest.mockResolvedValue({ data: 'this is not json', headers: { 'content-type': 'application/json' } });
    mockedAxios.isAxiosError = jest.fn().mockReturnValue(false) as any;

    const client = new ContractsClient(defaultConfig, offChaos);
    await expect(client.getContracts()).rejects.toMatchObject({ kind: 'malformed-response' });
  });

  it('classifies contract error as contract_error', async () => {
    mockRequest.mockResolvedValue({
      data: { error: { code: 'CONTRACT_NOT_FOUND', message: 'contract not found' } },
    });

    const client = new ContractsClient(defaultConfig, offChaos);
    await expect(client.getContracts()).rejects.toMatchObject({ kind: 'contract_error', providerCode: 'CONTRACT_NOT_FOUND' });
  });

  it('classifies unknown provider status as unknown_provider_status', async () => {
    mockRequest.mockRejectedValue(makeAxiosError(500, { error: { code: 'UNKNOWN' } }));
    mockedAxios.isAxiosError = jest.fn().mockReturnValue(true) as any;

    const client = new ContractsClient(defaultConfig, offChaos);
    await expect(client.getContracts()).rejects.toMatchObject({ kind: 'unknown_provider_status', providerCode: 'UNKNOWN' });
  });
});