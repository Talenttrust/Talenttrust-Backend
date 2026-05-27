import { AddressInfo } from 'net';
import { createApp } from './app';

/**
 * Exercises the live Express app wiring for the contracts list endpoint
 * (matches ContractsController + ContractsService behavior).
 */
describe('Contracts API integration (live app factory)', () => {
  it('GET /api/v1/contracts returns success envelope', async () => {
    const app = createApp();
    const server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/contracts`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual(
        expect.objectContaining({ status: 'success', data: expect.anything() }),
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err?: Error) => (err ? reject(err) : resolve()));
      });
    }
  });
});
