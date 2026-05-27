import axios, { AxiosRequestConfig } from 'axios';
import { ChaosPolicy } from '../chaos/chaosPolicy';
import { RetryOptions, withRetry } from '../utils/retry';

export class DependencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DependencyError';
  }
}



export interface UpstreamClientConfig {
  dependencyName: string;
  baseUrl: string;
  timeoutMs: number;
  retryOptions?: RetryOptions;
}

/**
 * A shared HTTP client wrapper for upstream dependencies.
 * Provides resilient features such as:
 * - Exponential backoff with jitter (via withRetry)
 * - Global timeout budget across all retries
 * - Integration with chaos testing hooks
 */
export class UpstreamHttpClient {
  private readonly client;

  constructor(
    private readonly config: UpstreamClientConfig,
    private readonly chaosPolicy: ChaosPolicy,
  ) {
    this.client = axios.create({
      baseURL: this.config.baseUrl,
    });
  }

  /**
   * Executes an HTTP request with retries, timeout budget, and chaos injection.
   */
  async request<T>(requestConfig: AxiosRequestConfig): Promise<T> {
    const chaosResult = this.chaosPolicy.decide(this.config.dependencyName);
    if (chaosResult === 'error') {
      throw new DependencyError('Injected dependency failure');
    }

    if (chaosResult === 'timeout') {
      throw new DependencyError('Injected dependency timeout');
    }

    const controller = new AbortController();
    const globalTimeout = setTimeout(() => {
      controller.abort();
    }, this.config.timeoutMs);

    try {
      return await withRetry(async () => {
        try {
          const response = await this.client.request<T>({
            ...requestConfig,
            signal: controller.signal,
          });

          return response.data;
        } catch (error) {
          if (axios.isCancel(error)) {
            throw new DependencyError('Upstream dependency timeout');
          }
          if (axios.isAxiosError(error) && error.response) {
            throw new DependencyError('Upstream returned non-success response');
          }
          throw error;
        }
      }, {
        ...this.config.retryOptions,
        isRetryable: (error: unknown) => {
          if (error instanceof DependencyError && error.message === 'Upstream dependency timeout') {
            return false;
          }
          if (this.config.retryOptions?.isRetryable) {
            return this.config.retryOptions.isRetryable(error);
          }
          return true;
        }
      });
    } catch (error) {
      if (error instanceof DependencyError) {
        throw error;
      }
      throw new DependencyError('Upstream dependency unavailable');
    } finally {
      clearTimeout(globalTimeout);
    }
  }

  async get<T>(url: string, config?: Omit<AxiosRequestConfig, 'url' | 'method'>): Promise<T> {
    return this.request<T>({ ...config, method: 'GET', url });
  }

  async post<T>(url: string, data?: any, config?: Omit<AxiosRequestConfig, 'url' | 'method' | 'data'>): Promise<T> {
    return this.request<T>({ ...config, method: 'POST', url, data });
  }
}
