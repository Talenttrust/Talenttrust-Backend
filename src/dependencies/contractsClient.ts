import { AppConfig } from '../appConfiguration';
import { ChaosPolicy } from '../chaos/chaosPolicy';
import { circuitBreakerRegistry } from '../circuit-breaker/registry';
import { CircuitOpenError } from '../circuit-breaker/errors';
import { Contract, ContractsPayload } from '../types/contracts';
import { UpstreamHttpClient, DependencyError } from './upstreamHttpClient';

export { DependencyError };

/**
 * Fetches contracts from an upstream dependency and can inject outages for resilience testing.
 * Wraps calls in a circuit breaker to prevent cascading failures.
 */
export class ContractsClient {
  private readonly client: UpstreamHttpClient;

  constructor(
    private readonly config: Pick<AppConfig, 'upstreamContractsUrl' | 'upstreamTimeoutMs' | 'circuitBreaker'>,
    chaosPolicy: ChaosPolicy,
  ) {
    this.client = new UpstreamHttpClient(
      {
        dependencyName: 'contracts',
        baseUrl: this.config.upstreamContractsUrl,
        timeoutMs: this.config.upstreamTimeoutMs,
        retryOptions: { maxAttempts: 3, baseDelayMs: 200, maxDelayMs: 5000 },
      },
      chaosPolicy
    );

    circuitBreakerRegistry.getOrCreate('contracts', {
      failureThreshold: this.config.circuitBreaker.failureThreshold,
      successThreshold: this.config.circuitBreaker.successThreshold,
      timeout: this.config.circuitBreaker.timeoutMs,
    });
  }

  async getContracts(): Promise<Contract[]> {
    const breaker = circuitBreakerRegistry.getOrCreate('contracts');
    try {
      return await breaker.execute(async () => {
        const payload = await this.client.get<ContractsPayload>('', {
          headers: { Accept: 'application/json' }
        });

        if (!payload || !Array.isArray(payload.contracts)) {
          throw new DependencyError('Upstream payload validation failed');
        }

        return payload.contracts;
      });
    } catch (error) {
      if (error instanceof CircuitOpenError) {
        throw new DependencyError(`Circuit breaker open: ${error.message}`);
      }
      if (error instanceof DependencyError) {
        throw error;
      }
      throw new DependencyError('Upstream dependency unavailable');
    }
  }
}
