import { AddressInfo } from 'net';
import { createApp } from './app';
import { AppConfig } from './config';
import { AppError } from './errors/appError';
import { Contract } from './types/contracts';

const config: AppConfig = {
  port: 0,
};

describe('Error handling integration', () => {
  async function request(
    path: string,
    init?: RequestInit,
    provider?: { listContracts: () => Promise<Contract[]> },
  ) {
    const app = createApp({
      config,
      contractsProvider: provider,
    });

    const server = app.listen(0);
    const { port } = server.address() as AddressInfo;

    try {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
      const body = (await response.json()) as {
        error?: {
          code: string;
          message: string;
          requestId: string;
        };
      };
      return { status: response.status, body, requestId: response.headers.get('x-request-id') };
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

  it('returns 404 with a consistent error shape for unknown routes', async () => {
    const result = await request('/unknown');
    const error = result.body.error;

    expect(result.status).toBe(404);
    expect(error).toBeDefined();
    expect(error?.code).toBe('not_found');
    expect(error?.message).toContain('Route not found');
    expect(typeof error?.requestId).toBe('string');
    expect(result.requestId).toBe(error?.requestId);
  });

  it('returns 400 validation_error with a consistent shape', async () => {
    const result = await request('/api/v1/contracts/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: '' }),
    });

    expect(result.status).toBe(400);
    expect(result.body).toEqual({
      error: {
        code: 'validation_error',
        message: 'Field "id" must be a non-empty string',
        requestId: expect.any(String),
      },
    });
  });

  it('returns 400 invalid_json when payload is malformed', async () => {
    const result = await request('/api/v1/contracts/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"id":',
    });

    expect(result.status).toBe(400);
    expect(result.body).toEqual({
      error: {
        code: 'invalid_json',
        message: 'Malformed JSON payload',
        requestId: expect.any(String),
      },
    });
  });

  it('returns 503 dependency_unavailable for expected dependency failures', async () => {
    const result = await request(
      '/api/v1/contracts',
      undefined,
      {
        listContracts: async () => {
          throw new AppError(503, 'dependency_unavailable', 'Contracts upstream unavailable');
        },
      },
    );

    expect(result.status).toBe(503);
    expect(result.body).toEqual({
      error: {
        code: 'dependency_unavailable',
        message: 'Contracts upstream unavailable',
        requestId: expect.any(String),
      },
    });
  });

  it('returns 500 internal_error without leaking internal details', async () => {
    const result = await request(
      '/api/v1/contracts',
      undefined,
      {
        listContracts: async () => {
          throw new Error('database credentials exposed');
        },
      },
    );

    expect(result.status).toBe(500);
    expect(result.body).toEqual({
      error: {
        code: 'internal_error',
        message: 'An unexpected error occurred',
        requestId: expect.any(String),
      },
    });
  });
});
