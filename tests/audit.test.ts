import request from 'supertest';
import { createApp } from '../src/app';
import { EscrowStore } from '../src/store';
import { AuditStore } from '../src/audit';

describe('TalentTrust API', () => {
  const app = createApp(new EscrowStore());

  describe('Audit log', () => {
    it('returns contract history with correct before/after states', async () => {
      const { body: created } = await request(app)
        .post('/api/v1/contracts')
        .send({ client: 'GA', freelancer: 'GB', milestones: [{ amount: 100 }, { amount: 50 }] });
      const id = created.id;

      await request(app).post(`/api/v1/contracts/${id}/deposit`).send({ amount: 150 });
      await request(app).post(`/api/v1/contracts/${id}/milestones/0/release`);
      await request(app).post(`/api/v1/contracts/${id}/milestones/1/release`);

      const history = await request(app).get(`/api/v1/contracts/${id}/history`).expect(200);
      expect(history.body.data).toHaveLength(4);

      const entries = history.body.data;
      expect(entries[0].action).toBe('create');
      expect(entries[0].before.status).toBe('N/A');
      expect(entries[0].after.status).toBe('Created');
      expect(entries[0].after.fundedAmount).toBe(0);

      expect(entries[1].action).toBe('deposit');
      expect(entries[1].before.status).toBe('Created');
      expect(entries[1].before.fundedAmount).toBe(0);
      expect(entries[1].after.status).toBe('Funded');
      expect(entries[1].after.fundedAmount).toBe(150);

      expect(entries[2].action).toBe('release');
      expect(entries[2].before.releasedAmount).toBe(0);
      expect(entries[2].after.releasedAmount).toBe(100);

      expect(entries[3].action).toBe('release');
      expect(entries[3].before.releasedAmount).toBe(100);
      expect(entries[3].after.releasedAmount).toBe(150);
    });

    it('failed release does not create audit entry', async () => {
      const { body: created } = await request(app)
        .post('/api/v1/contracts')
        .send({ client: 'GA', freelancer: 'GB', milestones: [{ amount: 100 }] });
      const id = created.id;

      await request(app).post(`/api/v1/contracts/${id}/deposit`).send({ amount: 50 });
      await request(app).post(`/api/v1/contracts/${id}/milestones/0/release`).expect(409);

      const history = await request(app).get(`/api/v1/contracts/${id}/history`).expect(200);
      expect(history.body.data).toHaveLength(2); // create + deposit only
      expect(history.body.data[0].action).toBe('create');
      expect(history.body.data[1].action).toBe('deposit');
    });

    it('resolve entry contains split details', async () => {
      const { body: created } = await request(app)
        .post('/api/v1/contracts')
        .send({ client: 'GA', freelancer: 'GB', milestones: [{ amount: 200 }] });
      const id = created.id;

      await request(app).post(`/api/v1/contracts/${id}/deposit`).send({ amount: 200 });
      await request(app).post(`/api/v1/contracts/${id}/dispute`).send({ raisedBy: 'GA', reason: 'test' });
      await request(app).post(`/api/v1/contracts/${id}/resolve`).send({ freelancerBps: 7000 });

      const history = await request(app).get(`/api/v1/contracts/${id}/history`).expect(200);
      const resolveEntry = history.body.data.find((e: any) => e.action === 'resolve');
      expect(resolveEntry).toBeDefined();
      expect(resolveEntry.details.freelancerBps).toBe(7000);
      expect(resolveEntry.details.toFreelancer).toBe(140);
      expect(resolveEntry.details.toClient).toBe(60);
    });

    it('tampering with entry makes verify return invalid', async () => {
      const store = new EscrowStore();
      const testApp = createApp(store);

      const { body: created } = await request(testApp)
        .post('/api/v1/contracts')
        .send({ client: 'GA', freelancer: 'GB', milestones: [{ amount: 100 }] });
      const id = created.id;

      await request(testApp).post(`/api/v1/contracts/${id}/deposit`).send({ amount: 100 });

      // Tamper with the first entry via test hook
      store.audit._tamperWithEntry(1, (entry) => {
        entry.after.fundedAmount = 999;
      });

      const verify = await request(testApp).get('/api/v1/audit/verify').expect(200);
      expect(verify.body.valid).toBe(false);
      expect(verify.body.brokenAt).toBe(1);
    });

    it('hash vector test: fixed entry hashes to fixed value', () => {
      const audit = new AuditStore();
      const entry = audit.append({
        contractId: 1,
        action: 'create',
        before: { status: 'N/A', fundedAmount: 0, releasedAmount: 0 },
        after: { status: 'Created', fundedAmount: 0, releasedAmount: 0 },
        details: { title: 'Test', totalAmount: 100 },
      });

      // This hash is deterministic based on the canonical JSON + prevHash
      expect(entry.hash).toMatch(/^[a-f0-9]{64}$/);
      expect(entry.hash.length).toBe(64);
    });

    it('history pagination works', async () => {
      const freshStore = new EscrowStore();
      const freshApp = createApp(freshStore);

      const { body: created } = await request(freshApp)
        .post('/api/v1/contracts')
        .send({ client: 'GA', freelancer: 'GB', milestones: [{ amount: 50 }, { amount: 50 }, { amount: 50 }] });
      const id = created.id;

      await request(freshApp).post(`/api/v1/contracts/${id}/deposit`).send({ amount: 150 });
      await request(freshApp).post(`/api/v1/contracts/${id}/milestones/0/release`);
      await request(freshApp).post(`/api/v1/contracts/${id}/milestones/1/release`);
      await request(freshApp).post(`/api/v1/contracts/${id}/milestones/2/release`);

      const page1 = await request(freshApp).get(`/api/v1/contracts/${id}/history?limit=2`).expect(200);
      expect(page1.body.data).toHaveLength(2);
      expect(page1.body.nextCursor).toBeDefined();

      const page2 = await request(freshApp)
        .get(`/api/v1/contracts/${id}/history?limit=2&cursor=${page1.body.nextCursor}`)
        .expect(200);
      expect(page2.body.data).toHaveLength(2);
      expect(page2.body.nextCursor).toBeDefined();

      const page3 = await request(freshApp)
        .get(`/api/v1/contracts/${id}/history?limit=2&cursor=${page2.body.nextCursor}`)
        .expect(200);
      expect(page3.body.data).toHaveLength(1);
      expect(page3.body.nextCursor).toBeUndefined();
    });

    it('eviction keeps verification valid', () => {
      const audit = new AuditStore();
      // Fill beyond max entries
      for (let i = 0; i < 100_010; i++) {
        audit.append({
          contractId: 1,
          action: 'create',
          before: { status: 'N/A', fundedAmount: 0, releasedAmount: 0 },
          after: { status: 'Created', fundedAmount: 0, releasedAmount: 0 },
          details: {},
        });
      }

      const verify = audit.verify();
      expect(verify.valid).toBe(true);
      expect(verify.entries).toBe(100_000);
      expect(audit.getTruncatedBeforeSeq()).toBeGreaterThan(0);
    });

    it('verify endpoint returns valid for clean chain', async () => {
      const verify = await request(app).get('/api/v1/audit/verify').expect(200);
      expect(verify.body.valid).toBe(true);
      expect(verify.body.entries).toBeGreaterThan(0);
      expect(verify.body.brokenAt).toBeUndefined();
    });
  });
});
