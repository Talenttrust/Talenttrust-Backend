import { AddressInfo } from 'net';
import { createApp } from './app';

describe('health', () => {
  it('returns service health metadata', async () => {
    const app = createApp({
      config: { port: 0 },
    });

    const server = app.listen(0);
    const { port } = server.address() as AddressInfo;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({ status: 'ok', service: 'talenttrust-backend' });
      expect(response.headers.get('x-request-id')).toEqual(expect.any(String));
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
  });
});
