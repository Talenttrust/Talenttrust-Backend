import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { createApp } from '../src/app';
import { EscrowStore } from '../src/store';
import { profileSigningMessage } from '../src/auth/profiles';

// Helper: build a store seeded with N contracts for bulk tests.
function seededStore(n: number): EscrowStore {
  const s = new EscrowStore();
  for (let i = 0; i < n; i++) {
    s.create({
      title: `Engagement ${i}`,
      client: `GC${i.toString().padStart(5, '0')}`,
      freelancer: `GF${i.toString().padStart(5, '0')}`,
      milestones: Array.from({ length: 5 }, (_, j) => ({ title: `M${j}`, amount: 100 + j })),
    });
  }
  return s;
}

describe('TalentTrust API', () => {
  const app = createApp(new EscrowStore());

  it('serves health and root', async () => {
    const h = await request(app).get('health');
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

  it('supports two-sided reviews on a completed contract', async () => {
    const created = await request(app)
      .post('/api/v1/contracts')
      .send({ client: 'GREVCLIENT', freelancer: 'GREVFREELANCER', milestones: [{ amount: 100 }] });
    const id = created.body.id;
    await request(app).post(`/api/v1/contracts/${id}/deposit`).send({ amount: 100 }).expect(200);
    await request(app).post(`/api/v1/contracts/${id}/milestones/0/release`).expect(200);

    const c2f = await request(app)
      .post(`/api/v1/contracts/${id}/reviews`)
      .send({ reviewer: 'GREVCLIENT', rating: 5, comment: '  Clear scope, fast payment  ' })
      .expect(201);
    expect(c2f.body.role).toBe('client_to_freelancer');
    expect(c2f.body.comment).toBe('Clear scope, fast payment');

    const f2c = await request(app)
      .post(`/api/v1/contracts/${id}/reviews`)
      .send({ reviewer: 'GREVFREELANCER', rating: 4 })
      .expect(201);
    expect(f2c.body.role).toBe('freelancer_to_client');

    await request(app)
      .post(`/api/v1/contracts/${id}/reviews`)
      .send({ reviewer: 'GREVCLIENT', rating: 3 })
      .expect(409);
    await request(app)
      .post(`/api/v1/contracts/${id}/reviews`)
      .send({ reviewer: 'GSTRANGER', rating: 3 })
      .expect(403);

    const clientRep = await request(app).get('/api/v1/reputation/GREVCLIENT').expect(200);
    expect(clientRep.body.asClient.completedContracts).toBe(1);
    expect(clientRep.body.asClient.averageRating).toBe(4);

    const feed = await request(app).get('/api/v1/reputation/GREVCLIENT/reviews').expect(200);
    expect(feed.body.reviews.length).toBe(1);
    expect(feed.body.reviews[0].role).toBe('freelancer_to_client');
  });

  it('rejects reviews on non-completed contracts and validates comments', async () => {
    const created = await request(app)
      .post('/api/v1/contracts')
      .send({ client: 'GREVCLIENT2', freelancer: 'GREVFREELANCER2', milestones: [{ amount: 100 }] });
    const id = created.body.id;
    await request(app)
      .post(`/api/v1/contracts/${id}/reviews`)
      .send({ reviewer: 'GREVCLIENT2', rating: 5 })
      .expect(409);
    await request(app).post(`/api/v1/contracts/${id}/deposit`).send({ amount: 100 }).expect(200);
    await request(app)
      .post(`/api/v1/contracts/${id}/reviews`)
      .send({ reviewer: 'GREVCLIENT2', rating: 5 })
      .expect(409);
    await request(app).post(`/api/v1/contracts/${id}/milestones/0/release`).expect(200);
    await request(app)
      .post(`/api/v1/contracts/${id}/reviews`)
      .send({ reviewer: 'GREVCLIENT2', rating: 5, comment: 'x'.repeat(1001) })
      .expect(400);
    await request(app)
      .post(`/api/v1/contracts/${id}/reviews`)
      .send({ reviewer: 'GREVCLIENT2', rating: 5, comment: 'bad\u0007char' })
      .expect(400);
  });

  it('marks reviews of resolved contracts as disputed', async () => {
    const { body } = await request(app)
      .post('/api/v1/contracts')
      .send({ client: 'GREVCLIENT3', freelancer: 'GREVFREELANCER3', milestones: [{ amount: 200 }] });
    await request(app).post(`/api/v1/contracts/${body.id}/deposit`).send({ amount: 200 }).expect(200);
    await request(app)
      .post(`/api/v1/contracts/${body.id}/dispute`)
      .send({ raisedBy: 'GREVFREELANCER3', reason: 'late' })
      .expect(200);
    await request(app).post(`/api/v1/contracts/${body.id}/resolve`).send({ freelancerBps: 5000 }).expect(200);
    const review = await request(app)
      .post(`/api/v1/contracts/${body.id}/reviews`)
      .send({ reviewer: 'GREVCLIENT3', rating: 2 })
      .expect(201);
    expect(review.body.context).toBe('disputed');
  });

  it('keeps the reputation endpoint backward compatible with reviews', async () => {
    const created = await request(app)
      .post('/api/v1/contracts')
      .send({ client: 'GREVCLIENT4', freelancer: 'GREVFREELANCER4', milestones: [{ amount: 100 }] });
    const id = created.body.id;
    await request(app).post(`/api/v1/contracts/${id}/deposit`).send({ amount: 100 }).expect(200);
    await request(app).post(`/api/v1/contracts/${id}/milestones/0/release`).expect(200);
    const rep = await request(app).post(`/api/v1/contracts/${id}/reputation`).send({ rating: 5 }).expect(200);
    expect(rep.body.averageRating).toBe(5);
    await request(app)
      .post(`/api/v1/contracts/${id}/reviews`)
      .send({ reviewer: 'GREVCLIENT4', rating: 5 })
      .expect(409);
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

  describe('profiles', () => {
    const keypack = () => Keypair.random();
    const sign = (keypair: Keypair, address: string, nonce: number, profile: unknown) =>
      keypair.sign(Buffer.from(profileSigningMessage(address, nonce, profile as any))).toString('base64');

    it('rejects invalid addresses', async () => {
      await request(app).get('/api/v1/profiles/not-an-address').expect(400);
    });

    it('returns 404 for unknown profiles', async () => {
      const keypair = keypack();
      await request(app).get(`/api/v1/profiles/${keypair.publicKey()}`).expect(404);
    });

    it('accepts a valid signed update and returns it via GET', async () => {
      const keypair = keypack();
      const address = keypair.publicKey();
      const profile = {
        displayName: 'Ada',
        bio: 'Builds things.',
        skills: ['rust', 'typescript'],
        links: { website: 'https://ada.dev', github: 'https://github.com/ada' },
      };
      const nonce = 1;
      const signature = sign(keypair, address, nonce, profile);
      const put = await request(app)
        .put(`/api/v1/profiles/${address}`)
        .send({ profile, nonce, signature })
        .expect(200);
      expect(put.body.displayName).toBe('Ada');
      expect(put.body.nonce).toBe(1);
      const get = await request(app).get(`/api/v1/profiles/${address}`).expect(200);
      expect(get.body.displayName).toBe('Ada');
      expect(get.body.reputation).toBeDefined();
    });

    it('rejects a signature from a different key', async () => {
      const owner = keypack();
      const other = keypack();
      const profile = { displayName: 'Mallie', skills: [] };
      const signature = sign(other, owner.publicKey(), 1, profile);
      await request(app)
        .put(`/api/v1/profiles/${owner.publicKey()}`)
        .send({ profile, nonce: 1, signature })
        .expect(401);
    });

    it('rejects a tampered profile after signing', async () => {
      const keypair = keypack();
      const address = keypair.publicKey();
      const profile = { displayName: 'Ada', skills: ['rust'] };
      const signature = sign(keypair, address, 1, profile);
      const tampered = { ...profile, displayName: 'Evil' };
      await request(app)
        .put(`/api/v1/profiles/${address}`)
        .send({ profile: tampered, nonce: 1, signature })
        .expect(401);
    });

    it('rejects a replayed nonce and accepts an increasing one', async () => {
      const keypair = keypack();
      const address = keypair.publicKey();
      const profile = { displayName: 'Ada', skills: ['rust'] };
      const sig1 = sign(keypair, address, 1, profile);
      await request(app)
        .put(`/api/v1/profiles/${address}`)
        .send({ profile, nonce: 1, signature: sig1 })
        .expect(200);
      await request(app)
        .put(`/api/v1/profiles/${address}`)
        .send({ profile, nonce: 1, signature: sig1 })
        .expect(409);
      const profile2 = { displayName: 'Ada', skills: ['rust', 'go'] };
      const sig2 = sign(keypair, address, 2, profile2);
      const up = await request(app)
        .put(`/api/v1/profiles/${address}`)
        .send({ profile: profile2, nonce: 2, signature: sig2 })
        .expect(200);
      expect(up.body.nonce).toBe(2);
    });

    it('validates profile fields', async () => {
      const keypair = keypack();
      const address = keypair.publicKey();
      const bad = [
        { displayName: '', skills: [] },
        { displayName: 'x'.repeat(61), skills: [] },
        { displayName: 'A', bio: 'x'.repeat(1001), skills: [] },
        { displayName: 'A', skills: Array.from({ length: 21 }, () => 'x') },
        { displayName: 'A', skills: ['x'.repeat(31)] },
        { displayName: 'A', skills: ['Rust'] },
        { displayName: 'A', skills: [], links: { website: 'http://example.org' } },
        { displayName: 'A', skills: [], links: { github: 'javascript:alert(1)' } },
      ];
      for (const profile of bad) {
        const signature = sign(keypair, address, 1, profile);
        await request(app)
          .put(`/api/v1/profiles/${address}`)
          .send({ profile, nonce: 1, signature })
          .expect(400);
      }
    });
  });
});
