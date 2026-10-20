import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { createApp } from '../src/app';
import { EscrowStore } from '../src/store';
import { profileSigningMessage } from '../src/profiles';

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

    it('reproduces the committed signing-message test vector', () => {
      const msg = profileSigningMessage('GBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 1, {
        displayName: 'Ada',
        skills: ['rust'],
      } as any);
      expect(msg).toBe(
        'talenttrust-profile:v1:' +
          'GBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:1:' +
          'PLACEHOLDER_CORRECT_SHA256_HEX',
      );
    });

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

    it('searches by skill sorted by reputation and paginates', async () => {
      const make = async (skills: string[], rating: number) => {
        const keypair = keypack();
        const address = keypair.publicKey();
        const profile = { displayName: 'Profile', skills };
        const signature = sign(keypair, address, 1, profile);
        await request(app)
          .put(`/api/v1/profiles/${address}`)
          .send({ profile, nonce: 1, signature })
          .expect(200);
        if (rating > 0) {
          const created = await request(app)
            .post('/api/v1/contracts')
            .send({ client: address, freelancer: address, milestones: [{ amount: 100 }] });
          const id = created.body.id;
          await request(app).post(`/api/v1/contracts/${id}/deposit`).send({ amount: 100 });
          await request(app).post(`/api/v1/contracts/${id}/milestones/0/release`).expect(200);
          await request(app).post(`/api/v1/contracts/${id}/reputation`).send({ rating }).expect(200);
        }
        return address;
      };
      const low = await make(['solidity'], 2);
      const high = await make(['solidity'], 5);
      const mid = await make(['solidity'], 4);
      const page1 = await request(app).get('/api/v1/profiles?skill=solidity&limit=2').expect(200);
      expect(page1.body.profiles.map((p: any) => p.address)).toEqual([high, mid]);
      expect(page1.body.nextCursor).toBeTruthy();
      const page2 = await request(app)
        .get(`/api/v1/profiles?skill=solidity&limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`)
        .expect(200);
      expect(page2.body.profiles.map((p: any) => p.address)).toEqual([low]);
    });

    it('expands= parties with profiles', async () => {
      const client = keypack();
      const freelancer = keypack();
      const cprofile = { displayName: 'Client', skills: [] };
      const fprofile = { displayName: 'Freelancer', skills: ['rust'] };
      await request(app)
        .put(`/api/v1/profiles/${client.publicKey()}`)
        .send({ profile: cprofile, nonce: 1, signature: sign(client, client.publicKey(), 1, cprofile) })
        .expect(200);
      await request(app)
        .put(`/api/v1/profiles/${freelancer.publicKey()}`)
        .send({ profile: fprofile, nonce: 1, signature: sign(freelancer, freelancer.publicKey(), 1, fprofile) })
        .expect(200);
      const created = await request(app)
        .post('/api/v1/contracts')
        .send({
          client: client.publicKey(),
          freelancer: freelancer.publicKey(),
          milestones: [{ amount: 100 }],
        })
        .expect(201);
      const get = await request(app)
        .get(`/api/v1/contracts/${created.body.id}?expand=parties`)
        .expect(200);
      expect(get.body.clientProfile.displayName).toBe('Client');
      expect(get.body.freelancerProfile.displayName).toBe('Freelancer');
      const unknown = await request(app)
        .post('/api/v1/contracts')
        .send({ client: 'GA', freelancer: 'GB', milestones: [{ amount: 100 }] })
        .expect(201);
      const get2 = await request(app)
        .get(`/api/v1/contracts/${unknown.body.id}?expand=parties`)
        .expect(200);
      expect(get2.body.clientProfile).toBeNull();
      expect(get2.body.freelancerProfile).toBeNull();
    });
  });
});
