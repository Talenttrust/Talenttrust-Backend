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

  describe('POST /api/v1/auth/token', () => {
    it('issues a bearer token for a valid signature', async () => {
      const { app } = makeApp();
      const kp = Keypair.random();
      const headers = await authHeader(kp, app);
      expect(headers.Authorization).toMatch(/^Bearer /);

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
      const h1 = await authHeader(kp, app);
      expect(h1.Authorization).toMatch(/^Bearer /);

      const challengeRes = await request(app).get(`/api/v1/auth/challenge?address=${kp.publicKey()}`);
      const { challenge } = challengeRes.body;
      const sig = Buffer.from(kp.sign(Buffer.from(challenge, 'utf-8'))).toString('base64');

      const r1 = await request(app).post('/api/v1/auth/token').send({
        address: kp.publicKey(),
        challenge,
        signature: sig,
      });
      expect(r1.status).toBe(200);

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
      const { token } = issueWalletToken(kp.publicKey(), AUTH_SECRET, now);

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
    });
  });
});
