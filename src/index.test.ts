import { type AddressInfo } from 'net';

import request from 'supertest';

import { startServer } from './index';

describe('server bootstrap', () => {
  it('starts and stops cleanly', async () => {
    const server = startServer(0);

    await new Promise<void>((resolve) => server.once('listening', () => resolve()));

    const address = server.address() as AddressInfo;
    const response = await request(`http://127.0.0.1:${address.port}`).get('/health');

    expect(response.status).toBe(200);
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
});
