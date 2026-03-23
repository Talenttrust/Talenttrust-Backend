import request from 'supertest';

import { createApp } from './app';
import type { CacheStore } from './cache/cache-store';
import type { ContractServicePort } from './services/contract-service';

describe('TalentTrust API integration', () => {
  it('boots the app in test mode without side effects', async () => {
    const app = createApp();
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok', service: 'talenttrust-backend' });
  });

  it('returns seeded contracts from the list endpoint', async () => {
    const app = createApp({
      seedContracts: [
        {
          id: 'ctr-123',
          title: 'Website build',
          clientId: 'client-1',
          freelancerId: 'freelancer-1',
          budget: 5000,
          currency: 'USDC',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });

    const response = await request(app).get('/api/v1/contracts');

    expect(response.status).toBe(200);
    expect(response.body.contracts).toHaveLength(1);
    expect(response.body.contracts[0].id).toBe('ctr-123');
  });

  it('returns contract detail for an existing contract', async () => {
    const app = createApp({
      seedContracts: [
        {
          id: 'ctr-abc',
          title: 'Audit trail setup',
          clientId: 'client-a',
          freelancerId: 'freelancer-b',
          budget: 2500,
          currency: 'USDC',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });

    const response = await request(app).get('/api/v1/contracts/ctr-abc');

    expect(response.status).toBe(200);
    expect(response.body.contract.id).toBe('ctr-abc');
  });

  it('creates a contract successfully', async () => {
    const app = createApp();

    const response = await request(app).post('/api/v1/contracts').send({
      title: 'Design sprint',
      clientId: 'client-7',
      freelancerId: 'freelancer-9',
      budget: 1200,
      currency: 'USDC',
    });

    expect(response.status).toBe(201);
    expect(response.body.contract.title).toBe('Design sprint');
    expect(response.body.contract.id).toBeDefined();
  });

  it('rejects malformed JSON bodies', async () => {
    const app = createApp();

    const response = await request(app)
      .post('/api/v1/contracts')
      .set('Content-Type', 'application/json')
      .send('{"title":');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'Malformed JSON request body.' });
  });

  it('rejects missing required fields', async () => {
    const app = createApp();

    const response = await request(app).post('/api/v1/contracts').send({
      title: 'Missing fields',
      clientId: 'client-1',
    });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: 'title, clientId, freelancerId, budget, and currency are required.',
    });
  });

  it('rejects invalid budget values', async () => {
    const app = createApp();

    const response = await request(app).post('/api/v1/contracts').send({
      title: 'Bad budget',
      clientId: 'client-1',
      freelancerId: 'freelancer-1',
      budget: 0,
      currency: 'USDC',
    });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'budget must be a positive number.' });
  });

  it('prevents cross-role misuse when client and freelancer are the same', async () => {
    const app = createApp();

    const response = await request(app).post('/api/v1/contracts').send({
      title: 'Self dealing',
      clientId: 'same-user',
      freelancerId: 'same-user',
      budget: 500,
      currency: 'USDC',
    });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      error: 'Client and freelancer must be different accounts.',
    });
  });

  it('rejects duplicate contract creation for the same participants and title', async () => {
    const app = createApp({
      seedContracts: [
        {
          id: 'ctr-existing',
          title: 'Roadmap sprint',
          clientId: 'client-dup',
          freelancerId: 'freelancer-dup',
          budget: 800,
          currency: 'USDC',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });

    const response = await request(app).post('/api/v1/contracts').send({
      title: 'Roadmap sprint',
      clientId: 'client-dup',
      freelancerId: 'freelancer-dup',
      budget: 800,
      currency: 'USDC',
    });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: 'A contract with the same participants and title already exists.',
    });
  });

  it('returns 404 for unknown contracts', async () => {
    const app = createApp();

    const response = await request(app).get('/api/v1/contracts/ctr-missing');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Contract not found.' });
  });

  it('returns 400 for invalid contract identifiers', async () => {
    const app = createApp();

    const response = await request(app).get('/api/v1/contracts/%24');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'Contract id is invalid.' });
  });

  it('returns 404 for unknown routes', async () => {
    const app = createApp();
    const response = await request(app).get('/api/v1/missing');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Route not found.' });
  });

  it('returns 404 for unsupported methods under current router behavior', async () => {
    const app = createApp();
    const response = await request(app).delete('/api/v1/contracts');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Route not found.' });
  });

  it('sanitizes unexpected internal errors', async () => {
    const app = createApp({ enableTestRoutes: true });
    const response = await request(app).get('/__test__/error');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Internal server error.' });
  });

  it('caches repeated contract list requests through the API', async () => {
    const source: ContractServicePort = {
      listContracts: jest.fn(() => [
        {
          id: 'ctr-cache',
          title: 'Cached list',
          clientId: 'client-1',
          freelancerId: 'freelancer-1',
          budget: 900,
          currency: 'USDC',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ]),
      getContractById: jest.fn(),
      createContract: jest.fn(),
    };

    const app = createApp({ contractService: source, cacheConfig: { enabled: true, ttlSeconds: 30, maxItems: 10 } });

    await request(app).get('/api/v1/contracts');
    await request(app).get('/api/v1/contracts');

    expect(source.listContracts).toHaveBeenCalledTimes(1);
  });

  it('invalidates the cached list after contract creation', async () => {
    const createdContracts: Array<{ id: string; title: string; clientId: string; freelancerId: string; budget: number; currency: string; createdAt: string }> = [];
    const source: ContractServicePort = {
      listContracts: jest.fn(() => [...createdContracts]),
      getContractById: jest.fn((id: string) => createdContracts.find((contract) => contract.id === id)),
      createContract: jest.fn((input) => {
        const created = {
          id: 'ctr-new',
          ...input,
          createdAt: '2026-01-01T00:00:00.000Z',
        };
        createdContracts.push(created);
        return created;
      }),
    };

    const app = createApp({ contractService: source, cacheConfig: { enabled: true, ttlSeconds: 30, maxItems: 10 } });

    const first = await request(app).get('/api/v1/contracts');
    expect(first.body.contracts).toHaveLength(0);

    await request(app).post('/api/v1/contracts').send({
      title: 'Invalidate me',
      clientId: 'client-1',
      freelancerId: 'freelancer-2',
      budget: 200,
      currency: 'USDC',
    });

    const second = await request(app).get('/api/v1/contracts');
    expect(second.body.contracts).toHaveLength(1);
    expect(source.listContracts).toHaveBeenCalledTimes(2);
  });

  it('falls back to source data when cache reads fail', async () => {
    const source: ContractServicePort = {
      listContracts: jest.fn(() => []),
      getContractById: jest.fn(() => ({
        id: 'ctr-fallback',
        title: 'Fallback',
        clientId: 'client-1',
        freelancerId: 'freelancer-1',
        budget: 50,
        currency: 'USDC',
        createdAt: '2026-01-01T00:00:00.000Z',
      })),
      createContract: jest.fn(),
    };
    const failingCache: CacheStore = {
      get: () => {
        throw new Error('cache read failed');
      },
      set: () => {
        throw new Error('cache write failed');
      },
      delete: jest.fn(),
      clear: jest.fn(),
    };

    const app = createApp({
      contractService: source,
      cacheStore: failingCache,
      cacheConfig: { enabled: true, ttlSeconds: 30, maxItems: 10 },
    });

    const response = await request(app).get('/api/v1/contracts/ctr-fallback');

    expect(response.status).toBe(200);
    expect(response.body.contract.id).toBe('ctr-fallback');
    expect(source.getContractById).toHaveBeenCalledTimes(1);
  });

  it('bypasses cache when disabled', async () => {
    const source: ContractServicePort = {
      listContracts: jest.fn(() => []),
      getContractById: jest.fn(),
      createContract: jest.fn(),
    };

    const app = createApp({
      contractService: source,
      cacheConfig: { enabled: false, ttlSeconds: 30, maxItems: 10 },
    });

    await request(app).get('/api/v1/contracts');
    await request(app).get('/api/v1/contracts');

    expect(source.listContracts).toHaveBeenCalledTimes(2);
  });
});
