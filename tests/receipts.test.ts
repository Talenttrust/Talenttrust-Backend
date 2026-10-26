import request from 'supertest';
import * as jose from 'jose';
import crypto from 'crypto';
import { Keypair } from '@stellar/stellar-sdk';
import { createApp } from '../src/app';
import { EscrowStore } from '../src/store';
import { account } from './helpers/addresses';
import {
  ReceiptManager,
  canonicalJSON,
  hashContractState,
  verifyReceipt,
} from '../src/receipts';

describe('Server-signed Escrow Receipts (Issue #1604)', () => {
  const keypair = Keypair.random();
  const secret = keypair.secret();
  const manager = new ReceiptManager(secret);
  let app: ReturnType<typeof createApp>;
  let store: EscrowStore;

  beforeEach(() => {
    store = new EscrowStore().seed();
    app = createApp(store, manager);
  });

  describe('Canonical JSON & Hashing Test Vectors', () => {
    it('sorts keys deterministically and matches known test vector', () => {
      const obj1 = { b: 2, a: 1, c: { y: 'bar', x: 'foo' } };
      const obj2 = { c: { x: 'foo', y: 'bar' }, a: 1, b: 2 };

      expect(canonicalJSON(obj1)).toBe('{"a":1,"b":2,"c":{"x":"foo","y":"bar"}}');
      expect(canonicalJSON(obj1)).toBe(canonicalJSON(obj2));

      // Test vector validation
      const expectedHash = crypto
        .createHash('sha256')
        .update('{"a":1,"b":2,"c":{"x":"foo","y":"bar"}}', 'utf8')
        .digest('hex');
      expect(hashContractState(obj1)).toBe(expectedHash);
    });

    it('handles arrays, nulls, and primitives correctly in canonical JSON', () => {
      const complex = {
        z: null,
        arr: [3, 2, { b: 'x', a: 'y' }],
        flag: true,
        count: 0,
      };
      const canon = canonicalJSON(complex);
      expect(canon).toBe('{"arr":[3,2,{"a":"y","b":"x"}],"count":0,"flag":true,"z":null}');
    });
  });

  describe('Published Keys (/.well-known/talenttrust-receipts.json)', () => {
    it('serves published keys in JWK and Stellar format', async () => {
      const res = await request(app).get('/.well-known/talenttrust-receipts.json').expect(200);
      expect(res.body.keys).toBeDefined();
      expect(Array.isArray(res.body.keys)).toBe(true);
      expect(res.body.keys.length).toBeGreaterThan(0);

      const k = res.body.keys[0];
      expect(k.kid).toBe(manager.kid);
      expect(k.alg).toBe('EdDSA');
      expect(k.publicKey).toBe(keypair.publicKey());
      expect(k.jwk).toEqual({
        kty: 'OKP',
        crv: 'Ed25519',
        x: Buffer.from(keypair.rawPublicKey()).toString('base64url'),
      });
    });
  });

  describe('Receipt Issuance & JOSE Interop', () => {
    it('issues a detached JWS receipt that verifies with published key and standard JOSE library', async () => {
      const res = await request(app).get('/api/v1/contracts/1/receipt').expect(200);
      expect(res.body.receipt).toBeDefined();
      const jws = res.body.receipt;

      // 1. Verify with internal pure helper
      const localResult = verifyReceipt(jws, manager.publicKey);
      expect(localResult.valid).toBe(true);
      expect(localResult.contractId).toBe(1);
      expect(localResult.kid).toBe(manager.kid);

      // 2. Interop test: verify with standard JOSE library (jose.compactVerify)
      const published = manager.getPublishedKeys().keys[0];
      const importedKey = await jose.importJWK(published.jwk, 'EdDSA');
      const verified = await jose.compactVerify(jws, importedKey);
      const parsed = JSON.parse(new TextDecoder().decode(verified.payload));

      expect(parsed.contract).toBeDefined();
      expect(parsed.contract.id).toBe(1);
      expect(parsed.contractHash).toBe(hashContractState(parsed.contract));
      expect(parsed.iat).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    });

    it('fails verification if a single payload byte is flipped (tamper resistance)', async () => {
      const res = await request(app).get('/api/v1/contracts/1/receipt').expect(200);
      const jws: string = res.body.receipt;
      const [header, payload, sig] = jws.split('.');

      // Tamper payload byte
      const payloadBuf = Buffer.from(payload, 'base64url');
      payloadBuf[0] ^= 0xff; // Flip bits in first byte
      const tamperedJws = `${header}.${payloadBuf.toString('base64url')}.${sig}`;

      const result = verifyReceipt(tamperedJws, manager.publicKey);
      expect(result.valid).toBe(false);
    });

    it('fails verification if receipt is signed by an unauthorized external key', async () => {
      const otherKeypair = Keypair.random();
      const otherManager = new ReceiptManager(otherKeypair.secret());
      const contract = store.get(1);
      const rogueJws = otherManager.issueReceipt(contract as any, 'http://localhost:3000');

      // Verify against official manager public key
      const result = verifyReceipt(rogueJws, manager.publicKey);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('verification failed');
    });
  });

  describe('Mutation Responses with ?receipt=true Header', () => {
    it('attaches Receipt header on POST /contracts when ?receipt=true', async () => {
      const res = await request(app)
        .post('/api/v1/contracts?receipt=true')
        .send({
          client: account('GC_RECEIPT_CLIENT'),
          freelancer: account('GD_RECEIPT_FREELANCER'),
          milestones: [{ amount: 500 }],
        })
        .expect(201);

      expect(res.headers['receipt']).toBeDefined();
      const receipt = res.headers['receipt'];
      const v = verifyReceipt(receipt, manager.publicKey);
      expect(v.valid).toBe(true);
      expect(v.contractId).toBe(res.body.id);
    });

    it('attaches Receipt header on state mutations (deposit, release, dispute, cancel, reputation) when ?receipt=true', async () => {
      const created = await request(app)
        .post('/api/v1/contracts')
        .send({ client: account('GA'), freelancer: account('GB'), milestones: [{ amount: 100 }] });
      const cid = created.body.id;

      // Deposit with receipt=true
      const dep = await request(app)
        .post(`/api/v1/contracts/${cid}/deposit?receipt=true`)
        .send({ amount: 100 })
        .expect(200);
      expect(dep.headers['receipt']).toBeDefined();
      const depReceipt = verifyReceipt(dep.headers['receipt'], manager.publicKey);
      expect(depReceipt.valid).toBe(true);
      expect(depReceipt.contract?.status).toBe('Funded');

      // Release with receipt=true
      const rel = await request(app)
        .post(`/api/v1/contracts/${cid}/milestones/0/release?receipt=true`)
        .expect(200);
      expect(rel.headers['receipt']).toBeDefined();
      const relReceipt = verifyReceipt(rel.headers['receipt'], manager.publicKey);
      expect(relReceipt.valid).toBe(true);
      expect(relReceipt.contract?.status).toBe('Completed');

      // Reputation with receipt=true
      const rep = await request(app)
        .post(`/api/v1/contracts/${cid}/reputation?receipt=true`)
        .send({ rating: 5 })
        .expect(200);
      expect(rep.headers['receipt']).toBeDefined();
    });

    it('does not attach Receipt header when ?receipt=true is omitted', async () => {
      const res = await request(app)
        .post('/api/v1/contracts')
        .send({ client: account('GA'), freelancer: account('GB'), milestones: [{ amount: 50 }] })
        .expect(201);
      expect(res.headers['receipt']).toBeUndefined();
    });
  });

  describe('Receipt Verification Endpoint (POST /api/v1/receipts/verify)', () => {
    it('verifies valid receipt and confirms matchesCurrent = true', async () => {
      const r = await request(app).get('/api/v1/contracts/1/receipt').expect(200);
      const verifyRes = await request(app)
        .post('/api/v1/receipts/verify')
        .send({ receipt: r.body.receipt })
        .expect(200);

      expect(verifyRes.body).toEqual({
        valid: true,
        kid: manager.kid,
        iat: expect.any(Number),
        contractId: 1,
        matchesCurrent: true,
      });
    });

    it('flags matchesCurrent = false after a later deposit/mutation updates the state', async () => {
      // 1. Create a fresh contract in Created state
      const created = await request(app)
        .post('/api/v1/contracts')
        .send({ client: account('G_MATCH_CLIENT'), freelancer: account('G_MATCH_FREELANCER'), milestones: [{ amount: 500 }] })
        .expect(201);
      const cid = created.body.id;

      // 2. Get receipt of initial Created state
      const initialReceipt = (await request(app).get(`/api/v1/contracts/${cid}/receipt`).expect(200)).body.receipt;

      // 3. Mutate contract by depositing
      await request(app).post(`/api/v1/contracts/${cid}/deposit`).send({ amount: 500 }).expect(200);

      // 4. Verify old receipt — signature is still valid, but state is historical
      const checkRes = await request(app)
        .post('/api/v1/receipts/verify')
        .send({ receipt: initialReceipt })
        .expect(200);

      expect(checkRes.body.valid).toBe(true);
      expect(checkRes.body.matchesCurrent).toBe(false);
    });

    it('returns valid = false for tampered or invalid receipt string', async () => {
      const r = await request(app).get('/api/v1/contracts/1/receipt').expect(200);
      const tampered = r.body.receipt + 'tamper';

      const verifyRes = await request(app)
        .post('/api/v1/receipts/verify')
        .send({ receipt: tampered })
        .expect(200);

      expect(verifyRes.body.valid).toBe(false);
      expect(verifyRes.body.matchesCurrent).toBe(false);
    });

    it('rejects missing or non-string receipt with 400', async () => {
      await request(app).post('/api/v1/receipts/verify').send({}).expect(400);
      await request(app).post('/api/v1/receipts/verify').send({ receipt: 12345 }).expect(400);
    });
  });

  describe('Security & Secrets Protection', () => {
    it('never exposes RECEIPT_SIGNING_SECRET in any endpoint response or logs', async () => {
      const root = await request(app).get('/');
      expect(JSON.stringify(root.body)).not.toContain(secret);

      const health = await request(app).get('/health');
      expect(JSON.stringify(health.body)).not.toContain(secret);

      const keys = await request(app).get('/.well-known/talenttrust-receipts.json');
      expect(JSON.stringify(keys.body)).not.toContain(secret);

      const openapiRes = await request(app).get('/openapi.json');
      expect(JSON.stringify(openapiRes.body)).not.toContain(secret);

      const receiptRes = await request(app).get('/api/v1/contracts/1/receipt');
      expect(JSON.stringify(receiptRes.body)).not.toContain(secret);
    });
  });
});
