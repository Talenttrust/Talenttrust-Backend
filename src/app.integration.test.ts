import { AddressInfo } from 'net';
import { createApp } from './app';
import { AppConfig } from './config';
import { Contract } from './types/contracts';

const baseConfig: AppConfig = {
  port: 0,
  gracefulDegradationEnabled: true,
  upstreamContractsUrl: 'http://upstream/contracts',
  upstreamTimeoutMs: 500,
  chaosMode: 'off',
  chaosTargets: [],
  chaosProbability: 0,
};

describe('Contracts API integration', () => {
  async function requestContracts(
    configOverride: Partial<AppConfig>,
    dependency: { getContracts: () => Promise<Contract[]> },
  ) {
    const app = createApp({
      config: { ...baseConfig, ...configOverride },
      contractsDependency: dependency,
    });

    const server = app.listen(0);
    const { port } = server.address() as AddressInfo;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/contracts`);
      const body = await response.json();
      return { status: response.status, body };
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err?: Error) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });
    }
  }

  it('returns upstream contracts when dependency succeeds', async () => {
    const dependency = {
      getContracts: async () => [{ id: 'ct_1', status: 'active' }],
    };

    const result = await requestContracts({}, dependency);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      contracts: [{ id: 'ct_1', status: 'active' }],
      degraded: false,
      source: 'upstream',
    });
  });

  it('returns graceful fallback when dependency fails and degradation is enabled', async () => {
    const dependency = {
      getContracts: async () => {
        throw new Error('upstream down');
      },
    };

    const result = await requestContracts({ gracefulDegradationEnabled: true }, dependency);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      contracts: [],
      degraded: true,
      source: 'fallback-empty',
      reason: 'upstream_unavailable',
    });
  });

  it('returns 503 when dependency fails and degradation is disabled', async () => {
    const dependency = {
      getContracts: async () => {
        throw new Error('upstream down');
      },
    };

    const result = await requestContracts({ gracefulDegradationEnabled: false }, dependency);
    expect(result.status).toBe(503);
    expect(result.body).toEqual({ error: 'contracts_unavailable' });
  });
});
