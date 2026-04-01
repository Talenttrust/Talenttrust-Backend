import { AppConfig } from '../config';
import { ChaosPolicy } from '../chaos/chaosPolicy';
import { Contract, ContractsPayload } from '../types/contracts';

export class DependencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DependencyError';
  }
}

/**
 * Fetches contracts from an upstream dependency and can inject outages for resilience testing.
 */
export class ContractsClient {
  constructor(
    private readonly config: Pick<AppConfig, 'upstreamContractsUrl' | 'upstreamTimeoutMs'>,
    private readonly chaosPolicy: ChaosPolicy,
  ) {}

  async getContracts(): Promise<Contract[]> {
    const chaosResult = this.chaosPolicy.decide('contracts');
    if (chaosResult === 'error') {
      throw new DependencyError('Injected dependency failure');
    }

    if (chaosResult === 'timeout') {
      throw new DependencyError('Injected dependency timeout');
    }

    return this.fetchContracts();
  }

  private async fetchContracts(): Promise<Contract[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.upstreamTimeoutMs);

    try {
      const response = await fetch(this.config.upstreamContractsUrl, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        throw new DependencyError('Upstream returned non-success response');
      }

      const payload = (await response.json()) as ContractsPayload;
      if (!Array.isArray(payload?.contracts)) {
        throw new DependencyError('Upstream payload validation failed');
      }

      return payload.contracts;
    } catch (error) {
      if (error instanceof DependencyError) {
        throw error;
      }

      throw new DependencyError('Upstream dependency unavailable');
    } finally {
      clearTimeout(timeout);
    }
  }
}
