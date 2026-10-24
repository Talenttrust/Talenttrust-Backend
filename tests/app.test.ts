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

  describe('dispute evidence', () => {
    const newDispute = async (client: string, freelancer: string, amount = 100) => {
      const { body } = await request(app)
        .post('/api/v1/contracts')
        .send({ client, freelancer, milestones: [{ amount }] });
      await request(app).post(`/api/v1/contracts/${body.id}/deposit`).send({ amount });
      await request(app)
        .post(`/api/v1/contracts/${body.id}/dispute`)
        .send({ raisedBy: client, reason: 'dispute' })
        .expect(200);
      return { id: body.id as string, client, freelancer };
    };

    it('accepts each kind with valid fields', async () => {
      const { id, client, freelancer } = await newDispute('GE', 'GF');
      const text = await request(app)
        .post(`/api/v1/contracts/${id}/dispute/evidence`)
        .send({ submittedBy: client, kind: 'text', text: '  hello world ' });
      expect(text.status).toBe(201);
      expect(text.body.kind).toBe('text');
      expect(text.body.text).toBe('hello world');
      const link = await request(app)
        .post(`/api/v1/contracts/${id}/dispute/evidence`)
        .send({ submittedBy: freelancer, kind: 'link', url: 'https://example.org/report' });
      expect(link.status).toBe(201);
      const hash = 'a'.repeat(64);
      const file = await request(app)
        .post(`/api/v1/contracts/${id}/dispute/evidence`)
        .send({ submittedBy: client, kind: 'file_hash', sha256: hash, fileName: 'evidence.pdf' });
      expect(file.status).toBe(201);
      expect(file.body.sha256).toBe(hash);
    });

    it('rejects invalid combinations', async () => {
      const { id, client } = await newDispute('GG', 'GH');
      const post = (payload: Record<string, unknown>) =>
        request(app).post(`/api/v1/contracts/${id}/dispute/evidence`).send(payload);
      await post({ submittedBy: client, kind: 'text' }).expect(400);
      await post({ submittedBy: client, kind: 'text', text: 'x'.repeat(4001) }).expect(400);
      await post({ submittedBy: client, kind: 'link' }).expect(400);
      await post({ submittedBy: client, kind: 'link', url: 'http://example.org' }).expect(400);
      await post({ submittedBy: client, kind: 'file_hash', sha256: 'z'.repeat(64) }).expect(400);
      await post({ submittedBy: client, kind: 'file_hash', sha256: 'a'.repeat(64), fileName: 'x'.repeat(201) }).expect(400);
      await post({ submittedBy: client, kind: 'other' }).expect(400);
    });

    it('rejects control characters', async () => {
      const { id, client } = await newDispute('GJ', 'GK');
      await request(app)
        .post(`/api/v1/contracts/${id}/dispute/evidence`)
        .send({ submittedBy: client, kind: 'text', text: 'bad' + String.fromCharCode(1) + 'char' })
        .expect(400);
    });

    it('enforces party and state rules', async () => {
      const { id, client } = await newDispute('GL', 'GM');
      await request(app)
        .post(`/api/v1/contracts/${id}/dispute/evidence`)
        .send({ submittedBy: 'GX', kind: 'text', text: 'hi' })
        .expect(403);

      const other = await request(app)
        .post('/api/v1/contracts')
        .send({ client: 'GN', freelancer: 'GO', milestones: [{ amount: 100 }] });
      await request(app)
        .post(`/api/v1/contracts/${other.body.id}/dispute/evidence`)
        .send({ submittedBy: 'GN', kind: 'text', text: 'hi' })
        .expect(409);
    });

    it('limits to 20 per party', async () => {
      const { id, client, freelancer } = await newDispute('GP', 'GQ');
      for (let i = 0; i < 20; i++) {
        await request(app)
          .post(`/api/v1/contracts/${id}/dispute/evidence`)
          .send({ submittedBy: client, kind: 'text', text: `item ${i}` })
          .expect(201);
      }
      await request(app)
        .post(`/api/v1/contracts/${id}/dispute/evidence`)
        .send({ submittedBy: client, kind: 'text', text: 'over' })
        .expect(409);
      await request(app)
        .post(`/api/v1/contracts/${id}/dispute/evidence`)
        .send({ submittedBy: freelancer, kind: 'text', text: 'ok' })
        .expect(201);
    });

    it('returns ordered items and a deterministic digest', async () => {
      const { id, client, freelancer } = await newDispute('GR', 'GS');
      await request(app)
        .post(`/api/v1/contracts/${id}/dispute/evidence`)
        .send({ submittedBy: client, kind: 'text', text: 'first' })
        .expect(201);
      await request(app)
        .post(`/api/v1/contracts/${id}/dispute/evidence`)
        .send({ submittedBy: freelancer, kind: 'link', url: 'https://example.org/a' })
        .expect(201);
      const list = await request(app).get(`/api/v1/contracts/${id}/dispute/evidence`).expect(200);
      expect(list.body.data.length).toBe(2);
      expect(list.body.data[0].text).toBe('first');
      expect(typeof list.body.digest).toBe('string');
      expect(list.body.digest.length).toBe(64);
      const again = await request(app).get(`/api/v1/contracts/${id}/dispute/evidence`).expect(200);
      expect(again.body.digest).toBe(list.body.digest);
    });

    it('seals the digest on resolve and blocks further submissions', async () => {
      const { id, client } = await newDispute('GT', 'GU');
      await request(app)
        .post(`/api/v1/contracts/${id}/dispute/evidence`)
        .send({ submittedBy: client, kind: 'text', text: 'seal me' })
        .expect(201);
      const before = await request(app).get(`/api/v1/contracts/${id}/dispute/evidence`).expect(200);
      const digest = before.body.digest as string;
      await request(app).post(`/api/v1/contracts/${id}/resolve`).send({ freelancerBps: 5000 }).expect(200);
      const after = await request(app).get(`/api/v1/contracts/${id}`).expect(200);
      expect(after.body.dispute.evidenceDigest).toBe(digest);
      await request(app)
        .post(`/api/v1/contracts/${id}/dispute/evidence`)
        .send({ submittedBy: client, kind: 'text', text: 'late' })
        .expect(409);
    });

    it('includes evidenceCount on contract get', async () => {
      const { id, client } = await newDispute('GV', 'GW');
      await request(app)
        .post(`/api/v1/contracts/${id}/dispute/evidence`)
        .send({ submittedBy: client, kind: 'text', text: 'one' })
        .expect(201);
      const got = await request(app).get(`/api/v1/contracts/${id}`).expect(200);
      expect(got.body.dispute.evidenceCount).toBe(1);
    });
  });
});
