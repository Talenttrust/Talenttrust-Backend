import request from 'supertest';

describe('index server bootstrap', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    jest.resetModules();
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('exports an app instance without auto-starting in test mode', async () => {
    const { app } = await import('./index');

    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
  });

  it('starts and stops the server on an ephemeral port', async () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const { startServer } = await import('./index');

    const server = startServer(0);

    await new Promise<void>((resolve, reject) => {
      server.on('listening', resolve);
      server.on('error', reject);
    });

    expect(server.address()).not.toBeNull();

    await new Promise<void>((resolve, reject) => {
      server.close((error?: Error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    consoleSpy.mockRestore();
  });
});
