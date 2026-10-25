/**
 * @module tests/helpers/auth
 * @description Test helper for the wallet-signature authentication flow.
 *
 * Usage:
 *   const keypair = Keypair.random();
 *   const headers = await authHeader(keypair, app, authSecret);
 *   // → { Authorization: 'Bearer <token>' }
 */

import { Keypair } from '@stellar/stellar-sdk';
import supertest from 'supertest';
import type { Application } from 'express';

/**
 * Perform the full challenge → sign → token flow for a given keypair.
 *
 * @param keypair    - Stellar keypair to authenticate with.
 * @param app        - Express application under test.
 * @returns          - Object with `Authorization` header ready for supertest.
 *
 * @throws if any step of the flow fails (unexpected response status).
 */
export async function authHeader(
  keypair: Keypair,
  app: Application,
): Promise<{ Authorization: string }> {
  const address = keypair.publicKey();

  // 1. Get challenge
  const challengeRes = await supertest(app)
    .get(`/api/v1/auth/challenge?address=${encodeURIComponent(address)}`);

  if (challengeRes.status !== 200) {
    throw new Error(
      `authHeader: GET /challenge returned ${challengeRes.status}: ${JSON.stringify(challengeRes.body)}`,
    );
  }

  const { challenge } = challengeRes.body as { challenge: string };

  // 2. Sign the challenge (ed25519 signature over the raw UTF-8 bytes)
  const msgBytes = Buffer.from(challenge, 'utf-8');
  const sigBytes = keypair.sign(msgBytes);
  const signature = Buffer.from(sigBytes).toString('base64');

  // 3. Exchange for token
  const tokenRes = await supertest(app)
    .post('/api/v1/auth/token')
    .send({ address, challenge, signature })
    .set('Content-Type', 'application/json');

  if (tokenRes.status !== 200) {
    throw new Error(
      `authHeader: POST /token returned ${tokenRes.status}: ${JSON.stringify(tokenRes.body)}`,
    );
  }

  const { token } = tokenRes.body as { token: string };

  return { Authorization: `Bearer ${token}` };
}
