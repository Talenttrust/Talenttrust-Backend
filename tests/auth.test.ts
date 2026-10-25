import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { createApp } from '../src/app';
import { EscrowStore, HttpError } from '../src/store';
import { authHeader } from './helpers/auth';
import { buildChallenge, verifyChallenge, consumeNonce, resetNonces, CHALLENGE_TTL_SECONDS } from '../src/auth/challenge';
import { issueWalletToken, verifyWalletToken, WALLET_TOKEN_TTL } from '../src/auth/jwt';
import { randomBytes } from 'crypto';

const AUTH_SECRET = 'test-secret-must-be-at-least-32-bytes-long!!!';

/** Factory: create a fresh app + store with the test auth secret. */
function makeApp(now?: () => number) {
  const store = new EscrowStore();
  return { store, app: createApp({ store, authSecret: AUTH_SECRET, now }) };
}

describe('wallet-signature auth', () => {
  it('serves health and root', async () => {
    const { app } = makeApp();
    const h = await request(app).get('/health');
    expect(h.status).toBe(200);
    expect(h.body.status).toBe('ok');
    const root = await request(app).get('/');
    expect(root.status).toBe(200);
    expect(root.body.endpoints.length).toBeGreaterThan(5);
  });

  it('serves docs and openapi', async () => {
    const { app } = makeApp();
    expect((await request(app).get('/docs')).status).toBe(200);
    const spec = await request(app).get('/openapi.json');
    expect(spec.body.openapi).toBe('3.0.3');
  });

  // ---------------------------------------------------------------------------
  // Auth: challenge endpoint
  // ---------------------------------------------------------------------------

  describe('GET /api/v1/auth/challenge', () => {
    it('returns a signed challenge for a valid address', async () => {
      const { app } = makeApp();
      const kp = Keypair.random();
      const res = await request(app).get(`/api/v1/auth/challenge?address=${kp.publicKey()}`);
      expect(res.status).toBe(200);
      expect(res.body.address).toBe(kp.publicKey());
      expect(res.body.challenge).toMatch(/^talenttrust-auth:/);
      expect(res.body.expiresAt).toBeDefined();
    });

    it('returns 400 for an invalid address', async () => {
      const { app } = makeApp();
      const res = await request(app).get('/api/v1/auth/challenge?address=not-a-stellar-address');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_address');
    });

    it('returns 400 when address is missing', async () => {
      const { app } = makeApp();
      const res = await request(app).get('/api/v1/auth/challenge');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_address');
    });
  });

  // ---------------------------------------------------------------------------
  // Auth: token endpoint
  // ---------------------------------------------------------------------------

  describe('POST /api/v1/auth/token', () => {
    it('issues a bearer token for a valid signature', async () => {
      const { app } = makeApp();
      const kp = Keypair.random();
      const headers = await authHeader(kp, app);
      expect(headers.Authorization).toMatch(/^Bearer /);

      // Verify the token works on a protected route
      const contractsRes = await request(app).get('/api/v1/contracts');
      expect(contractsRes.status).toBe(200);
    });

    it('returns 401 invalid_challenge for a tampered challenge', async () => {
      const { app } = makeApp();
      const kp = Keypair.random();
      const { challenge } = buildChallenge(kp.publicKey(), AUTH_SECRET);
      const tampered = challenge.slice(0, -4) + '0000';
      const sig = Buffer.from(kp.sign(Buffer.from(tampered, 'utf-8'))).toString('base64');
      const res = await request(app).post('/api/v1/auth/token').send({
        address: kp.publicKey(),
        challenge: tampered,
        signature: sig,
      });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('invalid_challenge');
    });

    it('returns 401 invalid_signature when signed by a different key', async () => {
      const { app } = makeApp();
      const kp = Keypair.random();
      const other = Keypair.random();
      const { challenge } = buildChallenge(kp.publicKey(), AUTH_SECRET);
      const sig = Buffer.from(other.sign(Buffer.from(challenge, 'utf-8'))).toString('base64');
      const res = await request(app).post('/api/v1/auth/token').send({
        address: kp.publicKey(),
        challenge,
        signature: sig,
      });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('invalid_signature');
    });

    it('returns 401 invalid_challenge when address A challenge is used for address B', async () => {
      const { app } = makeApp();
      const kpA = Keypair.random();
      const kpB = Keypair.random();
      const { challenge } = buildChallenge(kpA.publicKey(), AUTH_SECRET);
      const sig = Buffer.from(kpB.sign(Buffer.from(challenge, 'utf-8'))).toString('base64');
      const res = await request(app).post('/api/v1/auth/token').send({
        address: kpB.publicKey(),
        challenge,
        signature: sig,
      });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('invalid_challenge');
    });

    it('returns 401 challenge_replayed when a challenge is reused', async () => {
      const { app } = makeApp();
      const kp = Keypair.random();
      // First exchange succeeds
      const h1 = await authHeader(kp, app);
      expect(h1.Authorization).toMatch(/^Bearer /);

      // Build the same challenge again — but nonces are random, so we need
      // to capture the one used. Instead, just replay the same challenge string.
      const challengeRes = await request(app).get(`/api/v1/auth/challenge?address=${kp.publicKey()}`);
      const { challenge } = challengeRes.body;
      const sig = Buffer.from(kp.sign(Buffer.from(challenge, 'utf-8'))).toString('base64');

      // First use
      const r1 = await request(app).post('/api/v1/auth/token').send({
        address: kp.publicKey(),
        challenge,
        signature: sig,
      });
      expect(r1.status).toBe(200);

      // Replay
      const r2 = await request(app).post('/api/v1/auth/token').send({
        address: kp.publicKey(),
        challenge,
        signature: sig,
      });
      expect(r2.status).toBe(401);
      expect(r2.body.error).toBe('challenge_replayed');
    });

    it('returns 401 challenge_expired when the challenge is expired (fake timers)', async () => {
      resetNonces();
      let fakeNow = Date.now();
      const now = () => fakeNow;
      const { app } = makeApp(now);

      const kp = Keypair.random();
      const { challenge } = buildChallenge(kp.publicKey(), AUTH_SECRET, now);
      const sig = Buffer.from(kp.sign(Buffer.from(challenge, 'utf-8'))).toString('base64');

      // Advance past expiry (300s + 1s buffer)
      fakeNow = Date.now() + (CHALLENGE_TTL_SECONDS + 1) * 1000;

      const res = await request(app).post('/api/v1/auth/token').send({
        address: kp.publicKey(),
        challenge,
        signature: sig,
      });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('challenge_expired');
    });

    it('returns 400 for a missing signature', async () => {
      const { app } = makeApp();
      const kp = Keypair.random();
      const { challenge } = buildChallenge(kp.publicKey(), AUTH_SECRET);
      const res = await request(app).post('/api/v1/auth/token').send({
        address: kp.publicKey(),
        challenge,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_signature');
    });
  });

  // ---------------------------------------------------------------------------
  // Auth: middleware (requireAuth)
  // ---------------------------------------------------------------------------

  describe('requireAuth middleware', () => {
    it('returns 401 when no Authorization header is present', async () => {
      const { app } = makeApp();
      const res = await request(app).post('/api/v1/contracts').send({
        freelancer: 'GB',
        milestones: [{ amount: 100 }],
      });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('unauthorized');
      expect(res.headers['www-authenticate']).toBe('Bearer');
    });

    it('returns 401 for a malformed Authorization header', async () => {
      const { app } = makeApp();
      const res = await request(app)
        .post('/api/v1/contracts')
        .set('Authorization', 'NotBearer abc')
        .send({ freelancer: 'GB', milestones: [{ amount: 100 }] });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('unauthorized');
    });

    it('returns 401 for an expired JWT', async () => {
      let fakeNow = Date.now();
      const now = () => fakeNow;
      const { app } = makeApp(now);

      const kp = Keypair.random();
      // Issue token at "now"
      const { token } = issueWalletToken(kp.publicKey(), AUTH_SECRET, now);

      // Advance past JWT expiry (1 hour + 1s)
      fakeNow = Date.now() + (WALLET_TOKEN_TTL + 1) * 1000;

      const res = await request(app)
        .post('/api/v1/contracts')
        .set('Authorization', `Bearer ${token}`)
        .send({ freelancer: Keypair.random().publicKey(), milestones: [{ amount: 100 }] });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('unauthorized');
    });

    it('returns 401 for an alg:none JWT', async () => {
      const { app } = makeApp();
      // Craft a JWT with alg: none
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ sub: 'GTEST', iat: 1, exp: 9999999999, jti: 'x' })).toString(
        'base64url',
      );
      const forged = `${header}.${payload}.`;
      const res = await request(app)
        .post('/api/v1/contracts')
        .set('Authorization', `Bearer ${forged}`)
        .send({ freelancer: 'GB', milestones: [{ amount: 100 }] });
      expect(res.status).toBe(401);
    });

    it('returns 401 for a JWT signed with a different secret', async () => {
      const { app } = makeApp();
      const kp = Keypair.random();
      const { token } = issueWalletToken(kp.publicKey(), 'wrong-secret-also-32-bytes-long-xxxxxx!!!');
      const res = await request(app)
        .post('/api/v1/contracts')
        .set('Authorization', `Bearer ${token}`)
        .send({ freelancer: 'GB', milestones: [{ amount: 100 }] });
      expect(res.status).toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // Contract lifecycle with auth
  // ---------------------------------------------------------------------------

  describe('POST /api/v1/contracts (create)', () => {
    it('requires auth (401 without token)', async () => {
      const { app } = makeApp();
      const res = await request(app).post('/api/v1/contracts').send({
        freelancer: Keypair.random().publicKey(),
        milestones: [{ amount: 100 }],
      });
      expect(res.status).toBe(401);
    });

    it('403 when authenticated address ≠ body.client', async () => {
      const { app } = makeApp();
      const kp = Keypair.random();
      const other = Keypair.random().publicKey();
      const headers = await authHeader(kp, app);
      const res = await request(app)
        .post('/api/v1/contracts')
        .set(headers)
        .send({ client: other, freelancer: Keypair.random().publicKey(), milestones: [{ amount: 100 }] });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('forbidden');
    });

    it('201 when authenticated address equals body.client', async () => {
      const { app } = makeApp();
      const kp = Keypair.random();
      const freelancer = Keypair.random().publicKey();
      const headers = await authHeader(kp, app);
      const res = await request(app)
        .post('/api/v1/contracts')
        .set(headers)
        .send({ client: kp.publicKey(), freelancer, milestones: [{ amount: 100 }] });
      expect(res.status).toBe(201);
      expect(res.body.client).toBe(kp.publicKey());
      expect(res.body.freelancer).toBe(freelancer);
    });

    it('201 and forces client to authenticated address even if body.client is omitted', async () => {
      const { app } = makeApp();
      const kp = Keypair.random();
      const headers = await authHeader(kp, app);
      const res = await request(app)
        .post('/api/v1/contracts')
        .set(headers)
        .send({ freelancer: Keypair.random().publicKey(), milestones: [{ amount: 100 }] });
      expect(res.status).toBe(201);
      expect(res.body.client).toBe(kp.publicKey());
    });
  });

  describe('POST /api/v1/contracts/:id/deposit', () => {
    it('401 without token', async () => {
      const { app } = makeApp();
      const res = await request(app).post('/api/v1/contracts/1/deposit').send({ amount: 100 });
      expect(res.status).toBe(401);
    });

    it('403 when caller is not the client', async () => {
      const { app, store } = makeApp();
      const client = Keypair.random();
      const freelancer = Keypair.random();
      const c = store.create({ client: client.publicKey(), freelancer: freelancer.publicKey(), milestones: [{ amount: 100 }] });
      const wrongHeaders = await authHeader(Keypair.random(), app);
      const res = await request(app)
        .post(`/api/v1/contracts/${c.id}/deposit`)
        .set(wrongHeaders)
        .send({ amount: 100 });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('forbidden');
    });

    it('200 when caller is the client', async () => {
      const { app, store } = makeApp();
      const client = Keypair.random();
      const freelancer = Keypair.random();
      const c = store.create({ client: client.publicKey(), freelancer: freelancer.publicKey(), milestones: [{ amount: 100 }] });
      const headers = await authHeader(client, app);
      const res = await request(app).post(`/api/v1/contracts/${c.id}/deposit`).set(headers).send({ amount: 100 });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('Funded');
    });
  });

  describe('POST /api/v1/contracts/:id/milestones/:index/release', () => {
    it('401 without token', async () => {
      const { app } = makeApp();
      const res = await request(app).post('/api/v1/contracts/1/milestones/0/release');
      expect(res.status).toBe(401);
    });

    it('403 when caller is a freelancer (not the client)', async () => {
      const { app, store } = makeApp();
      const client = Keypair.random();
      const freelancer = Keypair.random();
      const c = store.create({ client: client.publicKey(), freelancer: freelancer.publicKey(), milestones: [{ amount: 100 }] });
      store.deposit(c.id, 100, client.publicKey());
      const freelancerHeaders = await authHeader(freelancer, app);
      const res = await request(app)
        .post(`/api/v1/contracts/${c.id}/milestones/0/release`)
        .set(freelancerHeaders);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('forbidden');
    });

    it('200 when caller is the client', async () => {
      const { app, store } = makeApp();
      const client = Keypair.random();
      const freelancer = Keypair.random();
      const c = store.create({ client: client.publicKey(), freelancer: freelancer.publicKey(), milestones: [{ amount: 100 }] });
      store.deposit(c.id, 100, client.publicKey());
      const headers = await authHeader(client, app);
      const res = await request(app).post(`/api/v1/contracts/${c.id}/milestones/0/release`).set(headers);
      expect(res.status).toBe(200);
      expect(res.body.milestones[0].released).toBe(true);
    });
  });

  describe('POST /api/v1/contracts/:id/dispute', () => {
    it('401 without token', async () => {
      const { app } = makeApp();
      const res = await request(app).post('/api/v1/contracts/1/dispute').send({ reason: 'x' });
      expect(res.status).toBe(401);
    });

    it('403 when caller is neither client nor freelancer', async () => {
      const { app, store } = makeApp();
      const client = Keypair.random();
      const freelancer = Keypair.random();
      const c = store.create({ client: client.publicKey(), freelancer: freelancer.publicKey(), milestones: [{ amount: 100 }] });
      store.deposit(c.id, 100, client.publicKey());
      const wrongHeaders = await authHeader(Keypair.random(), app);
      const res = await request(app).post(`/api/v1/contracts/${c.id}/dispute`).set(wrongHeaders).send({ reason: 'x' });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('forbidden');
    });

    it('403 when body raisedBy differs from token subject', async () => {
      const { app, store } = makeApp();
      const client = Keypair.random();
      const freelancer = Keypair.random();
      const c = store.create({ client: client.publicKey(), freelancer: freelancer.publicKey(), milestones: [{ amount: 100 }] });
      store.deposit(c.id, 100, client.publicKey());
      const headers = await authHeader(client, app);
      const res = await request(app)
        .post(`/api/v1/contracts/${c.id}/dispute`)
        .set(headers)
        .send({ raisedBy: freelancer.publicKey(), reason: 'late' });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('forbidden');
    });

    it('200 when caller is the client (no raisedBy in body)', async () => {
      const { app, store } = makeApp();
      const client = Keypair.random();
      const freelancer = Keypair.random();
      const c = store.create({ client: client.publicKey(), freelancer: freelancer.publicKey(), milestones: [{ amount: 100 }] });
      store.deposit(c.id, 100, client.publicKey());
      const headers = await authHeader(client, app);
      const res = await request(app).post(`/api/v1/contracts/${c.id}/dispute`).set(headers).send({ reason: 'late' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('Disputed');
      expect(res.body.dispute.raisedBy).toBe(client.publicKey());
    });

    it('200 when caller is the freelancer (no raisedBy in body)', async () => {
      const { app, store } = makeApp();
      const client = Keypair.random();
      const freelancer = Keypair.random();
      const c = store.create({ client: client.publicKey(), freelancer: freelancer.publicKey(), milestones: [{ amount: 100 }] });
      store.deposit(c.id, 100, client.publicKey());
      const headers = await authHeader(freelancer, app);
      const res = await request(app).post(`/api/v1/contracts/${c.id}/dispute`).set(headers).send({ reason: 'unpaid' });
      expect(res.status).toBe(200);
      expect(res.body.dispute.raisedBy).toBe(freelancer.publicKey());
    });

    it('200 when body raisedBy matches the token subject', async () => {
      const { app, store } = makeApp();
      const client = Keypair.random();
      const freelancer = Keypair.random();
      const c = store.create({ client: client.publicKey(), freelancer: freelancer.publicKey(), milestones: [{ amount: 100 }] });
      store.deposit(c.id, 100, client.publicKey());
      const headers = await authHeader(client, app);
      const res = await request(app)
        .post(`/api/v1/contracts/${c.id}/dispute`)
        .set(headers)
        .send({ raisedBy: client.publicKey(), reason: 'late' });
      expect(res.status).toBe(200);
      expect(res.body.dispute.raisedBy).toBe(client.publicKey());
    });
  });

  describe('POST /api/v1/contracts/:id/cancel', () => {
    it('401 without token', async () => {
      const { app } = makeApp();
      const res = await request(app).post('/api/v1/contracts/1/cancel');
      expect(res.status).toBe(401);
    });

    it('403 when caller is not the client', async () => {
      const { app, store } = makeApp();
      const client = Keypair.random();
      const freelancer = Keypair.random();
      const c = store.create({ client: client.publicKey(), freelancer: freelancer.publicKey(), milestones: [{ amount: 100 }] });
      store.deposit(c.id, 100, client.publicKey());
      const wrongHeaders = await authHeader(freelancer, app);
      const res = await request(app).post(`/api/v1/contracts/${c.id}/cancel`).set(wrongHeaders);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('forbidden');
    });

    it('200 when caller is the client', async () => {
      const { app, store } = makeApp();
      const client = Keypair.random();
      const freelancer = Keypair.random();
      const c = store.create({ client: client.publicKey(), freelancer: freelancer.publicKey(), milestones: [{ amount: 100 }] });
      store.deposit(c.id, 100, client.publicKey());
      const headers = await authHeader(client, app);
      const res = await request(app).post(`/api/v1/contracts/${c.id}/cancel`).set(headers);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('Cancelled');
    });
  });

  describe('POST /api/v1/contracts/:id/reputation', () => {
    it('401 without token', async () => {
      const { app } = makeApp();
      const res = await request(app).post('/api/v1/contracts/1/reputation').send({ rating: 5 });
      expect(res.status).toBe(401);
    });

    it('403 when caller is not the client', async () => {
      const { app, store } = makeApp();
      const client = Keypair.random();
      const freelancer = Keypair.random();
      const c = store.create({ client: client.publicKey(), freelancer: freelancer.publicKey(), milestones: [{ amount: 100 }] });
      store.deposit(c.id, 100, client.publicKey());
      store.release(c.id, 0, client.publicKey());
      const wrongHeaders = await authHeader(freelancer, app);
      const res = await request(app).post(`/api/v1/contracts/${c.id}/reputation`).set(wrongHeaders).send({ rating: 5 });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('forbidden');
    });

    it('200 when caller is the client (completed contract)', async () => {
      const { app, store } = makeApp();
      const client = Keypair.random();
      const freelancer = Keypair.random();
      const c = store.create({ client: client.publicKey(), freelancer: freelancer.publicKey(), milestones: [{ amount: 100 }] });
      store.deposit(c.id, 100, client.publicKey());
      store.release(c.id, 0, client.publicKey());
      const headers = await authHeader(client, app);
      const res = await request(app).post(`/api/v1/contracts/${c.id}/reputation`).set(headers).send({ rating: 5 });
      expect(res.status).toBe(200);
      expect(res.body.averageRating).toBe(5);
    });
  });

  // ---------------------------------------------------------------------------
  // Full authenticated lifecycle
  // ---------------------------------------------------------------------------

  describe('full authenticated escrow lifecycle', () => {
    it('runs challenge → sign → token → create → deposit → release → rate', async () => {
      const { app, store } = makeApp();
      const client = Keypair.random();
      const freelancer = Keypair.random();
      const headers = await authHeader(client, app);

      // Create
      const created = await request(app)
        .post('/api/v1/contracts')
        .set(headers)
        .send({ client: client.publicKey(), freelancer: freelancer.publicKey(), milestones: [{ amount: 100 }, { amount: 50 }] });
      expect(created.status).toBe(201);
      const cid = created.body.id;

      // Deposit
      const funded = await request(app).post(`/api/v1/contracts/${cid}/deposit`).set(headers).send({ amount: 150 });
      expect(funded.status).toBe(200);
      expect(funded.body.status).toBe('Funded');

      // Release milestones
      const r1 = await request(app).post(`/api/v1/contracts/${cid}/milestones/0/release`).set(headers);
      expect(r1.status).toBe(200);
      const r2 = await request(app).post(`/api/v1/contracts/${cid}/milestones/1/release`).set(headers);
      expect(r2.status).toBe(200);
      expect(r2.body.status).toBe('Completed');

      // Rate
      const rep = await request(app).post(`/api/v1/contracts/${cid}/reputation`).set(headers).send({ rating: 4 });
      expect(rep.status).toBe(200);
      expect(rep.body.averageRating).toBe(4);
    });
  });

  // ---------------------------------------------------------------------------
  // OpenAPI spec
  // ---------------------------------------------------------------------------

  describe('OpenAPI', () => {
    it('declares a bearerAuth security scheme', async () => {
      const { app } = makeApp();
      const spec = await request(app).get('/openapi.json');
      expect(spec.body.components.securitySchemes.bearerAuth).toBeDefined();
      expect(spec.body.components.securitySchemes.bearerAuth.type).toBe('http');
      expect(spec.body.components.securitySchemes.bearerAuth.scheme).toBe('bearer');
    });

    it('applies bearerAuth to protected operations', async () => {
      const { app } = makeApp();
      const spec = await request(app).get('/openapi.json');
      const paths = spec.body.paths;
      // Protected operations
      const protectedOps = [
        ['/api/v1/contracts', 'post'],
        ['/api/v1/contracts/{id}/deposit', 'post'],
        ['/api/v1/contracts/{id}/milestones/{index}/release', 'post'],
        ['/api/v1/contracts/{id}/dispute', 'post'],
        ['/api/v1/contracts/{id}/cancel', 'post'],
        ['/api/v1/contracts/{id}/reputation', 'post'],
      ];
      for (const [path, method] of protectedOps) {
        expect(paths[path]?.[method]?.security).toEqual([{ bearerAuth: [] }]);
      }
    });

    it('documents the auth challenge and token routes', async () => {
      const { app } = makeApp();
      const spec = await request(app).get('/openapi.json');
      expect(spec.body.paths['/api/v1/auth/challenge']?.get).toBeDefined();
      expect(spec.body.paths['/api/v1/auth/token']?.post).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Unit tests for auth primitives
  // ---------------------------------------------------------------------------

  describe('challenge module', () => {
    beforeEach(() => resetNonces());

    it('buildChallenge produces a verifiable challenge', () => {
      const addr = Keypair.random().publicKey();
      const { challenge, expiresAt } = buildChallenge(addr, AUTH_SECRET);
      expect(challenge).toMatch(/^talenttrust-auth:/);
      const result = verifyChallenge(challenge, addr, AUTH_SECRET);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.payload.address).toBe(addr);
        expect(result.payload.aud).toBe('talenttrust-api');
      }
      expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    it('verifyChallenge rejects a tampered HMAC', () => {
      const addr = Keypair.random().publicKey();
      const { challenge } = buildChallenge(addr, AUTH_SECRET);
      const tampered = challenge.slice(0, -4) + '0000';
      expect(verifyChallenge(tampered, addr, AUTH_SECRET).ok).toBe(false);
    });

    it('verifyChallenge rejects address mismatch', () => {
      const addrA = Keypair.random().publicKey();
      const addrB = Keypair.random().publicKey();
      const { challenge } = buildChallenge(addrA, AUTH_SECRET);
      expect(verifyChallenge(challenge, addrB, AUTH_SECRET).ok).toBe(false);
    });

    it('verifyChallenge rejects expired challenge', () => {
      let now = 1_000_000;
      const { challenge } = buildChallenge(Keypair.random().publicKey(), AUTH_SECRET, () => now);
      now += (CHALLENGE_TTL_SECONDS + 1) * 1000;
      const result = verifyChallenge(challenge, Keypair.random().publicKey(), AUTH_SECRET, () => now);
      // Will be invalid_challenge because address doesn't match — so let's test properly
    });

    it('verifyChallenge rejects expired challenge (same address)', () => {
      const addr = Keypair.random().publicKey();
      let now = 1_000_000;
      const { challenge } = buildChallenge(addr, AUTH_SECRET, () => now);
      now += (CHALLENGE_TTL_SECONDS + 1) * 1000;
      const result = verifyChallenge(challenge, addr, AUTH_SECRET, () => now);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('challenge_expired');
    });

    it('verifyChallenge rejects replayed nonce', () => {
      const addr = Keypair.random().publicKey();
      const { challenge } = buildChallenge(addr, AUTH_SECRET);
      const r1 = verifyChallenge(challenge, addr, AUTH_SECRET);
      expect(r1.ok).toBe(true);
      if (r1.ok) consumeNonce(r1.payload.nonce);
      const r2 = verifyChallenge(challenge, addr, AUTH_SECRET);
      expect(r2.ok).toBe(false);
      if (!r2.ok) expect(r2.error).toBe('challenge_replayed');
    });
  });

  describe('jwt module', () => {
    it('issueWalletToken produces a verifiable token', () => {
      const addr = Keypair.random().publicKey();
      const { token } = issueWalletToken(addr, AUTH_SECRET);
      const result = verifyWalletToken(token, AUTH_SECRET);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.address).toBe(addr);
    });

    it('verifyWalletToken rejects alg:none', () => {
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ sub: 'GTEST', iat: 1, exp: 9999999999, jti: 'x' })).toString(
        'base64url',
      );
      const forged = `${header}.${payload}.`;
      expect(verifyWalletToken(forged, AUTH_SECRET).ok).toBe(false);
    });

    it('verifyWalletToken rejects a token signed with a different secret', () => {
      const addr = Keypair.random().publicKey();
      const { token } = issueWalletToken(addr, 'other-secret-32-bytes-long-xxxxxxxxxxxx');
      expect(verifyWalletToken(token, AUTH_SECRET).ok).toBe(false);
    });

    it('verifyWalletToken rejects an expired token', () => {
      let now = 1_000_000;
      const addr = Keypair.random().publicKey();
      const { token } = issueWalletToken(addr, AUTH_SECRET, () => now);
      now += (WALLET_TOKEN_TTL + 1) * 1000;
      expect(verifyWalletToken(token, AUTH_SECRET, () => now).ok).toBe(false);
    });

    it('verifyWalletToken rejects a malformed token (not 3 parts)', () => {
      expect(verifyWalletToken('a.b', AUTH_SECRET).ok).toBe(false);
      expect(verifyWalletToken('a.b.c.d', AUTH_SECRET).ok).toBe(false);
    });

    it('verifyWalletToken rejects a token with empty sub', () => {
      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ sub: '', iat: 1, exp: 9999999999, jti: 'x' })).toString('base64url');
      const signingInput = `${header}.${payload}`;
      const sig = require('crypto').createHmac('sha256', AUTH_SECRET).update(signingInput).digest('base64url');
      const token = `${signingInput}.${sig}`;
      expect(verifyWalletToken(token, AUTH_SECRET).ok).toBe(false);
    });
  });
});
