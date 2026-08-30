import axios, { AxiosRequestConfig } from 'axios';
import { ChaosPolicy } from '../chaos/chaosPolicy';
import { RetryOptions, withRetry } from '../utils/retry';

export class DependencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DependencyError';
  }
}

/**
 * Carries the underlying failure context (transport code, HTTP status,
 * response headers and body) onto a {@link DependencyError} so downstream
 * classification can decide retry semantics. Additive only — the message and
 * type are unchanged, so existing callers that match on either keep working.
 */
function preserveDiagnostics(error: DependencyError, source: unknown): DependencyError {
  if (!source || typeof source !== 'object') return error;
  const src = source as Record<string, any>;
  const target = error as Record<string, any>;
  if (src.code !== undefined) target.code = src.code;
  if (src.name === 'TimeoutError') target.code = 'ETIMEDOUT';
  if (src.response) {
    target.status = src.response.status;
    target.headers = src.response.headers;
    target.responseBody = src.response.data;
  }
  return error;
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
      throw preserveDiagnostics(new DependencyError('Injected dependency timeout'), { code: 'ETIMEDOUT' });
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
            throw preserveDiagnostics(new DependencyError('Upstream returned non-success response'), error);
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
      throw preserveDiagnostics(new DependencyError('Upstream dependency unavailable'), error);
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
