import axios from 'axios';
import { ChaosPolicy } from '../chaos/chaosPolicy';
import { DependencyError, UpstreamHttpClient } from './upstreamHttpClient';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('UpstreamHttpClient', () => {
  let chaosPolicy: ChaosPolicy;
  let mockRequest: jest.Mock;

  beforeEach(() => {
    chaosPolicy = new ChaosPolicy({ chaosMode: 'off', chaosTargets: [], chaosProbability: 0 });
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

  it('performs a successful request', async () => {
    mockRequest.mockResolvedValue({ data: { success: true } });

    const client = new UpstreamHttpClient(
      { dependencyName: 'test-dep', baseUrl: 'http://test', timeoutMs: 1000 },
      chaosPolicy
    );

    const result = await client.request({ url: '/path' });
    expect(result).toEqual({ success: true });
    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(mockRequest).toHaveBeenCalledWith(expect.objectContaining({
      url: '/path',
      signal: expect.any(AbortSignal),
    }));
  });

  it('retries on failure according to retryOptions', async () => {
    const error = new Error('Network Error');
    (mockedAxios.isAxiosError as unknown as jest.Mock).mockReturnValue(true);

    mockRequest
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ data: { success: true } });

    const client = new UpstreamHttpClient(
      {
        dependencyName: 'test-dep',
        baseUrl: 'http://test',
        timeoutMs: 5000,
        retryOptions: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 50 }
      },
      chaosPolicy
    );

    const result = await client.request({ url: '/path' });
    expect(result).toEqual({ success: true });
    expect(mockRequest).toHaveBeenCalledTimes(3);
  });

  it('throws DependencyError when chaos policy injects timeout', async () => {
    chaosPolicy = new ChaosPolicy({ chaosMode: 'timeout', chaosTargets: ['test-dep'], chaosProbability: 0 });

    const client = new UpstreamHttpClient(
      { dependencyName: 'test-dep', baseUrl: 'http://test', timeoutMs: 1000 },
      chaosPolicy
    );

    await expect(client.request({ url: '/path' })).rejects.toThrow(DependencyError);
    await expect(client.request({ url: '/path' })).rejects.toThrow('Injected dependency timeout');
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('throws DependencyError when chaos policy injects error', async () => {
    chaosPolicy = new ChaosPolicy({ chaosMode: 'error', chaosTargets: ['test-dep'], chaosProbability: 0 });

    const client = new UpstreamHttpClient(
      { dependencyName: 'test-dep', baseUrl: 'http://test', timeoutMs: 1000 },
      chaosPolicy
    );

    await expect(client.request({ url: '/path' })).rejects.toThrow(DependencyError);
    await expect(client.request({ url: '/path' })).rejects.toThrow('Injected dependency failure');
  });

  it('throws DependencyError when upstream fails consistently', async () => {
    const error = new Error('Network Error');
    (mockedAxios.isAxiosError as unknown as jest.Mock).mockReturnValue(true);

    mockRequest.mockRejectedValue(error);

    const client = new UpstreamHttpClient(
      {
        dependencyName: 'test-dep',
        baseUrl: 'http://test',
        timeoutMs: 5000,
        retryOptions: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 50 }
      },
      chaosPolicy
    );

    await expect(client.request({ url: '/path' })).rejects.toThrow(DependencyError);
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });
});
