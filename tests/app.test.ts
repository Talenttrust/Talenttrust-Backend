import request from 'supertest';
import { createApp } from '../src/app';
import { EscrowStore } from '../src/store';

describe('TalentTrust API', () => {
  const app = createApp(new EscrowStore());

  it('serves health and root', async () => {
    const h = await request(app).get('/health');
    expect(h.status).toBe(200);
    expect(h.body.status).toBe('ok');
    const root = await request(app).get('/');
    expect(root.status).toBe(200);
    expect(root.body.endpoints.length).toBeGreaterThan(5);
  });

  it('serves docs and openapi', async () => {
    expect((await request(app).get('/docs')).status).toBe(200);
    const spec = await request(app).get('/openapi.json');
    expect(spec.body.openapi).toBe('3.0.3');
  });

  it('runs the escrow lifecycle', async () => {
    const created = await request(app)
      .post('/api/v1/contracts')
      .send({ client: 'GA', freelancer: 'GB', milestones: [{ amount: 100 }, { amount: 50 }] });
    expect(created.status).toBe(201);
    const id = created.body.id;
    expect((await request(app).post(`/api/v1/contracts/${id}/deposit`).send({ amount: 150 })).body.status).toBe(
      'Funded',
    );
    await request(app).post(`/api/v1/contracts/${id}/milestones/0/release`).expect(200);
    const done = await request(app).post(`/api/v1/contracts/${id}/milestones/1/release`).expect(200);
    expect(done.body.status).toBe('Completed');
    const rep = await request(app).post(`/api/v1/contracts/${id}/reputation`).send({ rating: 4 }).expect(200);
    expect(rep.body.averageRating).toBe(4);
  });

  it('rejects invalid input and unknown routes', async () => {
    await request(app).post('/api/v1/contracts').send({ client: 'GA', freelancer: 'GA', milestones: [1] }).expect(400);
    await request(app).get('/api/v1/contracts/999').expect(404);
    await request(app).get('/nope').expect(404);
  });

  it('handles disputes', async () => {
    const { body } = await request(app)
      .post('/api/v1/contracts')
      .send({ client: 'GC', freelancer: 'GD', milestones: [{ amount: 200 }] });
    await request(app).post(`/api/v1/contracts/${body.id}/deposit`).send({ amount: 200 });
    await request(app).post(`/api/v1/contracts/${body.id}/dispute`).send({ raisedBy: 'GX' }).expect(403);
    await request(app).post(`/api/v1/contracts/${body.id}/dispute`).send({ raisedBy: 'GD', reason: 'late' }).expect(200);
    const r = await request(app).post(`/api/v1/contracts/${body.id}/resolve`).send({ freelancerBps: 5000 }).expect(200);
    expect(r.body.releasedAmount).toBe(100);
    expect(r.body.status).toBe('Resolved');
  });

  describe('Contract emergency pause and operator override (PauseGuard)', () => {
    it('asserts guarded route list matches contract functions that call require_not_paused', async () => {
      const { CONTRACT_GUARDED_FUNCTIONS, GUARDED_ROUTES } = await import('../src/pauseGuard');
      // Contract functions calling require_not_paused:
      // create_contract (lib.rs#L197), deposit_funds (lib.rs#L241), release_milestone (lib.rs#L275),
      // open_dispute (lib.rs#L312), cancel_contract (lib.rs#L355)
      expect(CONTRACT_GUARDED_FUNCTIONS).toEqual([
        'create_contract',
        'deposit_funds',
        'release_milestone',
        'open_dispute',
        'cancel_contract',
      ]);
      expect(GUARDED_ROUTES.length).toBe(CONTRACT_GUARDED_FUNCTIONS.length);
    });

    it('blocks the 5 guarded routes with 503 while paused: true; resolve and reputation still succeed', async () => {
      const { PauseGuard } = await import('../src/pauseGuard');
      const fakeReader = jest.fn().mockResolvedValue(true);
      const pauseGuard = new PauseGuard({ rpcReader: fakeReader, ttlMs: 10000 });
      const testStore = new EscrowStore();

      // Seed a contract directly so we can test endpoints on it
      const c = testStore.create({
        client: 'GCLIENT',
        freelancer: 'GFREELANCER',
        milestones: [{ amount: 500 }],
      });
      // Fund it directly in the store for testing release/resolve/dispute
      testStore.deposit(c.id, 500);

      const pausedApp = createApp({ store: testStore, pauseGuard });

      // 1. POST /contracts (create_contract)
      const resCreate = await request(pausedApp)
        .post('/api/v1/contracts')
        .send({ client: 'GA', freelancer: 'GB', milestones: [{ amount: 100 }] });
      expect(resCreate.status).toBe(503);
      expect(resCreate.header['retry-after']).toBe('60');
      expect(resCreate.body).toEqual({
        error: 'contract_paused',
        message: 'Contract mutations are currently paused',
        source: 'chain',
        contractError: { name: 'Paused', code: 4 },
      });

      // 2. POST /contracts/:id/deposit (deposit_funds)
      const resDeposit = await request(pausedApp)
        .post(`/api/v1/contracts/${c.id}/deposit`)
        .send({ amount: 100 });
      expect(resDeposit.status).toBe(503);
      expect(resDeposit.header['retry-after']).toBe('60');
      expect(resDeposit.body.error).toBe('contract_paused');
      expect(resDeposit.body.contractError).toEqual({ name: 'Paused', code: 4 });

      // 3. POST /contracts/:id/milestones/:index/release (release_milestone)
      const resRelease = await request(pausedApp)
        .post(`/api/v1/contracts/${c.id}/milestones/0/release`);
      expect(resRelease.status).toBe(503);
      expect(resRelease.header['retry-after']).toBe('60');
      expect(resRelease.body.error).toBe('contract_paused');

      // 4. POST /contracts/:id/dispute (open_dispute)
      const resDispute = await request(pausedApp)
        .post(`/api/v1/contracts/${c.id}/dispute`)
        .send({ raisedBy: 'GCLIENT', reason: 'pause test' });
      expect(resDispute.status).toBe(503);
      expect(resDispute.header['retry-after']).toBe('60');
      expect(resDispute.body.error).toBe('contract_paused');

      // 5. POST /contracts/:id/cancel (cancel_contract)
      const resCancel = await request(pausedApp)
        .post(`/api/v1/contracts/${c.id}/cancel`);
      expect(resCancel.status).toBe(503);
      expect(resCancel.header['retry-after']).toBe('60');
      expect(resCancel.body.error).toBe('contract_paused');

      // Verify unpaused operations succeed:
      // resolve dispute is allowed while paused
      testStore.openDispute(c.id, 'GCLIENT', 'dispute test');
      const resResolve = await request(pausedApp)
        .post(`/api/v1/contracts/${c.id}/resolve`)
        .send({ freelancerBps: 5000 });
      expect(resResolve.status).toBe(200);

      // reputation rating is allowed while paused on completed contract
      const comp = testStore.create({
        client: 'GCLIENT2',
        freelancer: 'GFREELANCER2',
        milestones: [{ amount: 100 }],
      });
      testStore.deposit(comp.id, 100);
      testStore.release(comp.id, 0); // now status: Completed
      const resRep = await request(pausedApp)
        .post(`/api/v1/contracts/${comp.id}/reputation`)
        .send({ rating: 5 });
      expect(resRep.status).toBe(200);
    });

    it('API_PAUSED=true operator override blocks immediately without calling RPC', async () => {
      const { PauseGuard } = await import('../src/pauseGuard');
      const originalEnv = process.env.API_PAUSED;
      try {
        process.env.API_PAUSED = 'true';
        const fakeReader = jest.fn();
        const pauseGuard = new PauseGuard({ rpcReader: fakeReader });
        const appWithEnv = createApp({ pauseGuard });

        const res = await request(appWithEnv).post('/api/v1/contracts').send({});
        expect(res.status).toBe(503);
        expect(res.body.source).toBe('env');
        expect(res.body.contractError).toEqual({ name: 'Paused', code: 4 });
        expect(fakeReader).not.toHaveBeenCalled();

        // Check health & chain report paused with env source
        const health = await request(appWithEnv).get('/health');
        expect(health.body.paused).toBe(true);
        expect(health.body.pauseSource).toBe('env');

        const chain = await request(appWithEnv).get('/api/v1/chain');
        expect(chain.body.paused).toBe(true);
        expect(chain.body.pauseSource).toBe('env');
      } finally {
        if (originalEnv === undefined) {
          delete process.env.API_PAUSED;
        } else {
          process.env.API_PAUSED = originalEnv;
        }
      }
    });

    it('caches pause check for TTL duration (only 1 RPC call per TTL)', async () => {
      const { PauseGuard } = await import('../src/pauseGuard');
      const fakeReader = jest.fn().mockResolvedValue(false);
      const pauseGuard = new PauseGuard({ rpcReader: fakeReader, ttlMs: 1000 });

      const status1 = await pauseGuard.isPaused();
      expect(status1.paused).toBe(false);
      expect(fakeReader).toHaveBeenCalledTimes(1);

      // Immediate second call should use cache
      const status2 = await pauseGuard.isPaused();
      expect(status2.paused).toBe(false);
      expect(fakeReader).toHaveBeenCalledTimes(1);

      // Advance clock past TTL
      const now = Date.now();
      const realDateNow = Date.now;
      try {
        Date.now = () => now + 1500;
        const status3 = await pauseGuard.isPaused();
        expect(status3.paused).toBe(false);
        expect(fakeReader).toHaveBeenCalledTimes(2);
      } finally {
        Date.now = realDateNow;
      }
    });

    it('handles fail-open mode when RPC reader throws', async () => {
      const { PauseGuard } = await import('../src/pauseGuard');
      const failingReader = jest.fn().mockRejectedValue(new Error('RPC connection timeout'));
      const pauseGuard = new PauseGuard({ rpcReader: failingReader, failMode: 'open' });

      const status = await pauseGuard.isPaused();
      expect(status.paused).toBe(false);
      expect(status.source).toBe('none');
    });

    it('handles fail-closed mode when RPC reader throws', async () => {
      const { PauseGuard } = await import('../src/pauseGuard');
      const failingReader = jest.fn().mockRejectedValue(new Error('RPC connection timeout'));
      const pauseGuard = new PauseGuard({ rpcReader: failingReader, failMode: 'closed' });

      const status = await pauseGuard.isPaused();
      expect(status.paused).toBe(true);
      expect(status.source).toBe('chain');

      const appFailClosed = createApp({ pauseGuard });
      const res = await request(appFailClosed).post('/api/v1/contracts').send({});
      expect(res.status).toBe(503);
      expect(res.body.contractError).toEqual({ name: 'Paused', code: 4 });
    });
  });
});

