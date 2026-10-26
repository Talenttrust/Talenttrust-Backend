import request from 'supertest';
import { createApp } from '../src/app';
import { EscrowStore } from '../src/store';
import { account } from './helpers/addresses';
import { PauseGuard } from '../src/pauseGuard';

const contract = { client: account('GA'), freelancer: account('GB'), milestones: [{ amount: 100 }] };

describe('pause guard', () => {
  afterEach(() => {
    delete process.env.API_PAUSED;
  });

  it('rejects guarded mutations with 503 contract_paused while paused on-chain', async () => {
    let paused = false;
    const pauseGuard = new PauseGuard({ rpcReader: async () => paused, ttlMs: 0 });
    const store = new EscrowStore();
    const app = createApp({ store, pauseGuard });
    const created = await request(app).post('/api/v1/contracts').send(contract).expect(201);

    paused = true;
    const res = await request(app).post(`/api/v1/contracts/${created.body.id}/deposit`).send({ amount: 100 });
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('60');
    expect(res.body.error).toBe('contract_paused');
    expect(res.body.source).toBe('chain');
    expect(res.body.contractError).toEqual({ name: 'Paused', code: 4 });
    await request(app).post('/api/v1/contracts').send(contract).expect(503);
    expect(store.get(created.body.id).fundedAmountUnits).toBe('0');

    // Reads stay available and report the pause.
    await request(app).get(`/api/v1/contracts/${created.body.id}`).expect(200);
    const chain = await request(app).get('/api/v1/chain').expect(200);
    expect(chain.body).toMatchObject({ paused: true, pauseSource: 'chain' });

    paused = false;
    await request(app).post(`/api/v1/contracts/${created.body.id}/deposit`).send({ amount: 100 }).expect(200);
  });

  it('honours the API_PAUSED operator override without calling RPC', async () => {
    const rpcReader = jest.fn(async () => false);
    const app = createApp({ store: new EscrowStore(), pauseGuard: new PauseGuard({ rpcReader }) });
    process.env.API_PAUSED = 'true';
    const res = await request(app).post('/api/v1/contracts').send(contract);
    expect(res.status).toBe(503);
    expect(res.body.source).toBe('env');
    const health = await request(app).get('/health').expect(200);
    expect(health.body).toMatchObject({ paused: true, pauseSource: 'env' });
    expect(rpcReader).not.toHaveBeenCalled();
  });

  it('fails open or closed on RPC errors as configured', async () => {
    const failing = async () => {
      throw new Error('rpc down');
    };
    const open = createApp({ store: new EscrowStore(), pauseGuard: new PauseGuard({ rpcReader: failing, failMode: 'open' }) });
    await request(open).post('/api/v1/contracts').send(contract).expect(201);
    const closed = createApp({ store: new EscrowStore(), pauseGuard: new PauseGuard({ rpcReader: failing, failMode: 'closed' }) });
    await request(closed).post('/api/v1/contracts').send(contract).expect(503);
  });

  it('caches the chain status and coalesces concurrent checks', async () => {
    const rpcReader = jest.fn(async () => false);
    const guard = new PauseGuard({ rpcReader, ttlMs: 60_000 });
    await Promise.all([guard.isPaused(), guard.isPaused(), guard.isPaused()]);
    await guard.isPaused();
    expect(rpcReader).toHaveBeenCalledTimes(1);
  });
});
