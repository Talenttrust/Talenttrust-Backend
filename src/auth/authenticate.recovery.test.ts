/**
 * @file authenticate.recovery.test.ts
 * @description Failure-recovery tests for the bearer token decoder (issue #1413).
 *
 * `decodeToken` is the only place in the legacy bearer path where untrusted,
 * arbitrarily-shaped input is turned into a payload, so it must be total: every
 * input either produces a complete `TokenPayload` or `null`, and it must never
 * throw. These tests pin that contract for dependency-injected, malformed and
 * adversarial inputs; the middleware behaviour is covered in
 * `authenticate.contract.test.ts`.
 */

import { decodeToken, MAX_TOKEN_LENGTH } from './authenticate';

/** Encodes arbitrary JSON as the base64 token the decoder expects. */
function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64');
}

describe('decodeToken — total, non-throwing recovery', () => {
  it('decodes a well-formed payload (positive control)', () => {
    expect(decodeToken(encode({ userId: 'u1', role: 'freelancer' }))).toEqual({
      userId: 'u1',
      role: 'freelancer',
    });
  });

  it('never throws for non-string input', () => {
    const nonStrings: unknown[] = [undefined, null, 42, true, {}, [], Symbol('t')];
    for (const value of nonStrings) {
      expect(() => decodeToken(value as string)).not.toThrow();
      expect(decodeToken(value as string)).toBeNull();
    }
  });

  it('returns null for an empty token', () => {
    expect(decodeToken('')).toBeNull();
  });

  it('returns null for a token longer than the accepted maximum', () => {
    const oversized = 'A'.repeat(MAX_TOKEN_LENGTH + 1);
    expect(decodeToken(oversized)).toBeNull();
  });

  it('accepts input at the size boundary without short-circuiting on length', () => {
    // Padding the JSON with spaces keeps the decoded document valid while
    // pushing the encoded length up to the boundary.
    const payload = { userId: 'u1', role: 'client' };
    const base = JSON.stringify(payload);
    const padding = ' '.repeat(MAX_TOKEN_LENGTH * 3 / 4 - base.length);
    const token = Buffer.from(base + padding).toString('base64');

    expect(token.length).toBeLessThanOrEqual(MAX_TOKEN_LENGTH);
    expect(decodeToken(token)).toEqual(payload);
  });

  it('returns null for base64 that is not JSON', () => {
    const token = Buffer.from('this is not json').toString('base64');
    expect(decodeToken(token)).toBeNull();
  });

  it('returns null for JSON that is not a plain object', () => {
    const notObjects: unknown[] = [null, [], 'a string', 42, true];
    for (const value of notObjects) {
      expect(decodeToken(encode(value))).toBeNull();
    }
  });

  it('returns null for missing, empty or mistyped fields', () => {
    expect(decodeToken(encode({ role: 'admin' }))).toBeNull();
    expect(decodeToken(encode({ userId: 'u1' }))).toBeNull();
    expect(decodeToken(encode({ userId: '', role: 'admin' }))).toBeNull();
    expect(decodeToken(encode({ userId: 1, role: 'admin' }))).toBeNull();
    expect(decodeToken(encode({ userId: 'u1', role: 42 }))).toBeNull();
  });

  it('returns null for an unknown role', () => {
    expect(decodeToken(encode({ userId: 'u1', role: 'superuser' }))).toBeNull();
    expect(decodeToken(encode({ userId: 'u1', role: '__proto__' }))).toBeNull();
  });

  it('discards extra keys instead of returning them', () => {
    const token = encode({ userId: 'u1', role: 'admin', scope: ['*'], isAdmin: true });
    expect(decodeToken(token)).toEqual({ userId: 'u1', role: 'admin' });
  });

  it('cannot be used to pollute Object.prototype', () => {
    const token = encode({
      userId: 'u1',
      role: 'admin',
      __proto__: { polluted: true },
    });

    const decoded = decodeToken(token);

    expect(decoded).toEqual({ userId: 'u1', role: 'admin' });
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('never throws for a range of adversarial strings', () => {
    const adversarial = [
      '!!!!',
      '%%%%',
      '====',
      'AAAA====',
      Buffer.from('{').toString('base64'),
      Buffer.from('{"userId":"u1","role":').toString('base64'),
      'Bearer token',
      '💥'.repeat(10),
    ];

    for (const token of adversarial) {
      expect(() => decodeToken(token)).not.toThrow();
      expect(decodeToken(token)).toBeNull();
    }
  });
});
