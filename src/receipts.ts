import crypto from 'crypto';
import { Keypair } from '@stellar/stellar-sdk';

export interface ReceiptHeader {
  alg: 'EdDSA';
  kid: string;
  typ: 'tt-receipt+jws';
}

export interface ReceiptPayload {
  iss: string;
  iat: number;
  contract: Record<string, unknown>;
  contractHash: string;
}

export interface JwkKey {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
  [key: string]: unknown;
}

export interface PublishedKey {
  kid: string;
  alg: 'EdDSA';
  publicKey: string;
  jwk: JwkKey;
}

export interface VerifyReceiptResult {
  valid: boolean;
  kid?: string;
  iat?: number;
  contractId?: number;
  contract?: Record<string, unknown>;
  contractHash?: string;
  error?: string;
}

/**
 * Deterministically serialize a value to canonical JSON.
 * - Keys sorted alphabetically.
 * - Primitives formatted consistently.
 */
export function canonicalJSON(val: unknown): string {
  if (val === null || typeof val !== 'object') {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    // Like JSON.stringify: undefined array entries serialise as null.
    return '[' + val.map((v) => (v === undefined ? 'null' : canonicalJSON(v))).join(',') + ']';
  }
  const obj = val as Record<string, unknown>;
  // Like JSON.stringify: drop undefined-valued keys, so a contract hashes the
  // same before and after a JSON round-trip (e.g. `dispute: undefined`).
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJSON(obj[k])).join(',') + '}';
}

export function hashContractState(contract: unknown): string {
  const canonical = canonicalJSON(contract);
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function base64urlEncode(buf: Buffer | string): string {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'utf8');
  return b.toString('base64url');
}

function base64urlDecode(str: string): Buffer {
  return Buffer.from(str, 'base64url');
}

export class ReceiptManager {
  private keypair: Keypair;
  public readonly kid: string;
  public readonly publicKey: string;
  public readonly jwk: JwkKey;

  constructor(secretSeed?: string) {
    if (secretSeed) {
      try {
        this.keypair = Keypair.fromSecret(secretSeed);
      } catch (err) {
        throw new Error(`Invalid RECEIPT_SIGNING_SECRET: ${(err as Error).message}`);
      }
    } else {
      console.warn('[receipts] RECEIPT_SIGNING_SECRET not set; generated ephemeral ed25519 key for process');
      this.keypair = Keypair.random();
    }

    this.publicKey = this.keypair.publicKey();
    const rawPub = Buffer.from(this.keypair.rawPublicKey());
    this.kid = `tt-key-${crypto.createHash('sha256').update(rawPub).digest('hex').slice(0, 12)}`;
    this.jwk = {
      kty: 'OKP',
      crv: 'Ed25519',
      x: rawPub.toString('base64url'),
    };
  }

  getPublishedKeys(): { keys: PublishedKey[] } {
    return {
      keys: [
        {
          kid: this.kid,
          alg: 'EdDSA',
          publicKey: this.publicKey,
          jwk: this.jwk,
        },
      ],
    };
  }

  issueReceipt(contract: Record<string, unknown>, iss: string): string {
    const contractHash = hashContractState(contract);
    const header: ReceiptHeader = {
      alg: 'EdDSA',
      kid: this.kid,
      typ: 'tt-receipt+jws',
    };
    const payload: ReceiptPayload = {
      iss,
      iat: Math.floor(Date.now() / 1000),
      contract,
      contractHash,
    };

    const b64Header = base64urlEncode(JSON.stringify(header));
    const b64Payload = base64urlEncode(JSON.stringify(payload));
    const signingInput = Buffer.from(`${b64Header}.${b64Payload}`, 'utf8');

    const signature = this.keypair.sign(signingInput);
    const b64Signature = base64urlEncode(Buffer.from(signature));

    return `${b64Header}.${b64Payload}.${b64Signature}`;
  }
}

/**
 * Pure verification helper for offline verification.
 * Verifies compact JWS against either a Stellar G... public key or raw ed25519 public key.
 */
export function verifyReceipt(jws: string, expectedPublicKey?: string): VerifyReceiptResult {
  if (typeof jws !== 'string' || !jws.includes('.')) {
    return { valid: false, error: 'Malformed JWS receipt string' };
  }

  const parts = jws.split('.');
  if (parts.length !== 3) {
    return { valid: false, error: 'JWS must have 3 parts separated by dots' };
  }

  const [b64Header, b64Payload, b64Sig] = parts;

  let header: ReceiptHeader;
  let payload: ReceiptPayload;

  try {
    header = JSON.parse(base64urlDecode(b64Header).toString('utf8'));
    payload = JSON.parse(base64urlDecode(b64Payload).toString('utf8'));
  } catch (e) {
    return { valid: false, error: 'Invalid JWS header or payload encoding' };
  }

  if (header.alg !== 'EdDSA' || header.typ !== 'tt-receipt+jws') {
    return { valid: false, error: 'Unsupported JWS header algorithm or type' };
  }

  if (!payload || typeof payload !== 'object' || !payload.contract) {
    return { valid: false, error: 'JWS payload missing contract object' };
  }

  const computedHash = hashContractState(payload.contract);
  if (payload.contractHash !== computedHash) {
    return { valid: false, error: 'Contract hash in payload does not match computed canonical hash' };
  }

  const signingInput = Buffer.from(`${b64Header}.${b64Payload}`, 'utf8');
  let signature: Buffer;
  try {
    signature = base64urlDecode(b64Sig);
  } catch {
    return { valid: false, error: 'Invalid base64url signature' };
  }

  if (signature.length !== 64) {
    return { valid: false, error: 'Ed25519 signature must be exactly 64 bytes' };
  }

  if (expectedPublicKey) {
    try {
      const verifier = Keypair.fromPublicKey(expectedPublicKey);
      const isOk = verifier.verify(signingInput, signature);
      if (!isOk) {
        return { valid: false, error: 'Ed25519 signature verification failed' };
      }
    } catch (e) {
      return { valid: false, error: `Invalid public key: ${(e as Error).message}` };
    }
  }

  const rawContract = payload.contract as { id?: number | string };
  const contractId = rawContract.id !== undefined ? Number(rawContract.id) : undefined;

  return {
    valid: true,
    kid: header.kid,
    iat: payload.iat,
    contractId,
    contract: payload.contract,
    contractHash: payload.contractHash,
  };
}
