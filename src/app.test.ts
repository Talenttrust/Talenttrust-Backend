import http from 'node:http';
import { AddressInfo } from 'node:net';

import { createApp } from './app';
import { RuntimeConfig } from './config/runtime-config';

interface TestResponse {
  status: number;
  body: unknown;
}

const baseConfig: RuntimeConfig = {
  port: 3001,
  features: {
    contractsApiEnabled: true,
    runtimeConfigEndpointEnabled: false,
  },
};

async function withServer<T>(
  config: RuntimeConfig,
  callback: (server: http.Server) => Promise<T>,
): Promise<T> {
  const app = createApp(config);
  const server = app.listen(0);

  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });

  try {
    return await callback(server);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }
}

async function request(server: http.Server, path: string): Promise<TestResponse> {
  const address = server.address() as AddressInfo;

  return new Promise<TestResponse>((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: address.port,
        path,
        method: 'GET',
      },
      (res) => {
        let data = '';

        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 500,
            body: data.length > 0 ? JSON.parse(data) : undefined,
          });
        });
      },
    );

    req.on('error', reject);
    req.end();
  });
}

describe('createApp', () => {
  it('keeps the health route available regardless of feature flags', async () => {
    await withServer(
      {
        ...baseConfig,
        features: {
          contractsApiEnabled: false,
          runtimeConfigEndpointEnabled: false,
        },
      },
      async (server) => {
        const response = await request(server, '/health');

        expect(response).toEqual({
          status: 200,
          body: { status: 'ok', service: 'talenttrust-backend' },
        });
      },
    );
  });

  it('serves the contracts API when the feature is enabled', async () => {
    await withServer(baseConfig, async (server) => {
      const response = await request(server, '/api/v1/contracts');

      expect(response).toEqual({
        status: 200,
        body: { contracts: [] },
      });
    });
  });

  it('returns a 404 when the contracts API feature is disabled', async () => {
    await withServer(
      {
        ...baseConfig,
        features: {
          ...baseConfig.features,
          contractsApiEnabled: false,
        },
      },
      async (server) => {
        const response = await request(server, '/api/v1/contracts');

        expect(response).toEqual({
          status: 404,
          body: {
            error: 'feature_disabled',
            feature: 'contracts_api',
            message: 'The contracts_api feature is disabled by runtime configuration.',
          },
        });
      },
    );
  });

  it('keeps the runtime config endpoint dark by default', async () => {
    await withServer(baseConfig, async (server) => {
      const response = await request(server, '/api/v1/runtime-config');

      expect(response).toEqual({
        status: 404,
        body: {
          error: 'feature_disabled',
          feature: 'runtime_config_endpoint',
          message:
            'The runtime_config_endpoint feature is disabled by runtime configuration.',
        },
      });
    });
  });

  it('exposes only the public feature snapshot when the endpoint is enabled', async () => {
    await withServer(
      {
        ...baseConfig,
        features: {
          contractsApiEnabled: false,
          runtimeConfigEndpointEnabled: true,
        },
      },
      async (server) => {
        const response = await request(server, '/api/v1/runtime-config');

        expect(response).toEqual({
          status: 200,
          body: {
            service: 'talenttrust-backend',
            features: {
              contractsApiEnabled: false,
              runtimeConfigEndpointEnabled: true,
            },
          },
        });
      },
    );
  });
});
