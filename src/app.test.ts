import type { AddressInfo } from 'node:net';
import { createApp } from './app';
import { InMemorySpanLogger, Tracer } from './tracing/tracer';

describe('app tracing', () => {
  it('emits an api span for /health and returns trace headers', async () => {
    const logger = new InMemorySpanLogger();
    const tracer = new Tracer(logger);
    const { app } = createApp({ tracer });
    const server = app.listen(0);

    try {
      const address = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${address.port}/health`, {
        headers: {
          'x-trace-id': 'trace-health',
          'x-request-id': 'request-health',
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('x-trace-id')).toBe('trace-health');
      expect(response.headers.get('x-request-id')).toBe('request-health');

      const body = await response.json();
      expect(body).toEqual({ status: 'ok', service: 'talenttrust-backend' });

      expect(logger.spans).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            traceId: 'trace-health',
            requestId: 'request-health',
            kind: 'api',
            name: 'GET /health',
            status: 'ok',
          }),
        ]),
      );
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
  });

  it('emits api, db, and rpc spans for /api/v1/contracts', async () => {
    const logger = new InMemorySpanLogger();
    const tracer = new Tracer(logger);
    const { app } = createApp({ tracer });
    const server = app.listen(0);

    try {
      const address = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/contracts`);

      expect(response.status).toBe(200);
      expect(response.headers.get('x-rpc-network')).toBe('testnet');
      expect(response.headers.get('x-rpc-healthy')).toBe('true');
      expect(await response.json()).toEqual({ contracts: [] });

      expect(logger.spans).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'api', name: 'GET /api/v1/contracts' }),
          expect.objectContaining({ kind: 'db', name: 'contracts.repository.list' }),
          expect.objectContaining({
            kind: 'rpc',
            name: 'contracts.rpc.fetch_registry_health',
          }),
        ]),
      );
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
  });
});
