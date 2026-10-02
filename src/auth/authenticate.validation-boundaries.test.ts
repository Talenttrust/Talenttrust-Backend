/**
 * @file src/auth/authenticate.validation-boundaries.test.ts
 *
 * Focused tests for the validation boundaries defined in
 * `src/auth/authenticate.ts` (issue #1411).
 *
 * Structure:
 *   - Accepted input      — well-formed credentials for every role.
 *   - Rejected input      — each `TokenRejectionReason`, asserted exactly.
 *   - Duplicate submits   — a comma-joined second credential must not
 *                           authenticate as the first.
 *   - Boundary values     — the exact `MAX_*` edges, in both directions.
 *   - Regression          — the specific inputs that authenticated before this
 *                           change, each pinned so it cannot come back.
 *
 * Every rejection is asserted on `validateToken`'s reason code rather than on a
 * 401 body, so a test fails if the *cause* changes even when the status does
 * not. The middleware tests then assert that every reason collapses to a 401,
 * that `next()` is never called on rejection, and that `req.user` is never
 * written on the failure path.
 */

import {
  MAX_TOKEN_LENGTH,
  MAX_USER_ID_LENGTH,
  authenticateMiddleware,
  createToken,
  decodeToken,
  parseBearerHeader,
  validateToken,
  type AuthenticatedRequest,
  type TokenRejectionReason,
} from './authenticate';
import { VALID_ROLES } from './roles';
import type { NextFunction, Response } from 'express';

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Minimal express doubles; only the members the middleware touches. */
function mockRes(): { res: Response; status: jest.Mock; json: jest.Mock } {
  const res: Partial<Response> = {};
  const status = jest.fn().mockReturnValue(res);
  const json = jest.fn().mockReturnValue(res);
  res.status = status as unknown as Response['status'];
  res.json = json as unknown as Response['json'];
  return { res: res as Response, status, json };
}

function runMiddleware(headers: Record<string, unknown>) {
  const req = { headers, path: '/protected' } as unknown as AuthenticatedRequest;
  const { res, status, json } = mockRes();
  const next = jest.fn() as NextFunction;
  authenticateMiddleware(req, res, next);
  return { req, status, json, next };
}

/** base64-encode an arbitrary JSON value, bypassing `createToken`. */
function forge(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

/** Assert that `token` is refused for exactly `reason`. */
function expectReason(token: string, reason: TokenRejectionReason): void {
  const result = validateToken(token);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('unreachable');
  expect(result.reason).toBe(reason);
  // `decodeToken` collapses every reason to null — its documented contract.
  expect(decodeToken(token)).toBeNull();
}

// ─── accepted input ───────────────────────────────────────────────────────────

describe('accepted input', () => {
  it('accepts a canonical token for every role in the allowlist', () => {
    for (const role of VALID_ROLES) {
      expect(decodeToken(createToken(`user-${role}`, role))).toEqual({
        userId: `user-${role}`,
        role,
      });
    }
  });

  it('accepts the identifier shapes the system actually issues', () => {
    // randomUUID (src/repositories/userRepository.ts) and the u<N> / prefixed
    // forms used by fixtures.
    const ids = [
      '550e8400-e29b-41d4-a716-446655440000',
      'u1',
      'jwt-user',
      'user.client@example.com',
      'a',
      'A_b.c:d-e',
    ];
    for (const userId of ids) {
      expect(decodeToken(createToken(userId, 'client'))).toEqual({ userId, role: 'client' });
    }
  });

  it('keeps the Authorization header grammar working for a canonical header', () => {
    const token = createToken('u42', 'client');
    expect(parseBearerHeader(`Bearer ${token}`)).toBe(token);
  });

  it('authenticates and forwards the request for a valid token', () => {
    const { req, status, next } = runMiddleware({
      authorization: `Bearer ${createToken('u42', 'client')}`,
    });
    expect(req.user).toEqual({ userId: 'u42', role: 'client' });
    expect(next).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
  });
});

// ─── rejected input ───────────────────────────────────────────────────────────

describe('rejected input — header grammar (VB-1)', () => {
  const token = createToken('u1', 'admin');
  const malformed = [
    ['missing header', undefined],
    ['empty string', ''],
    ['wrong scheme', 'Basic abc123'],
    ['lowercase scheme', `bearer ${token}`],
    ['no space after scheme', `Bearer${token}`],
    ['tab instead of space', `Bearer\t${token}`],
    ['leading space', ` Bearer ${token}`],
    ['two spaces after scheme', `Bearer  ${token}`],
    ['two spaces after scheme (value case)', `Bearer  ${token}`],
    ['bare scheme', 'Bearer'],
    ['scheme only with trailing space', 'Bearer '],
  ] as const;

  for (const [name, header] of malformed) {
    it(`rejects ${name}`, () => {
      expect(parseBearerHeader(header)).toBeNull();
      expect(runMiddleware({ authorization: header }).status).toHaveBeenCalledWith(401);
    });
  }

  it('rejects a non-string header value', () => {
    // Express types `authorization` as string|undefined, but a header that
    // arrives as an array must not be coerced into a usable credential.
    expect(parseBearerHeader([`Bearer ${token}`])).toBeNull();
  });

  it('maps a missing header and a malformed header to distinct reasons', () => {
    const missing = runMiddleware({});
    expect(missing.status).toHaveBeenCalledWith(401);
    expect(missing.json).toHaveBeenCalledWith({
      error: 'Missing or invalid Authorization header',
    });

    const wrongScheme = runMiddleware({ authorization: 'Basic abc123' });
    expect(wrongScheme.status).toHaveBeenCalledWith(401);
    expect(wrongScheme.json).toHaveBeenCalledWith({
      error: 'Missing or invalid Authorization header',
    });
  });
});

describe('rejected input — credential encoding (VB-2)', () => {
  const token = createToken('u1', 'admin');

  it('rejects characters outside the standard base64 alphabet', () => {
    expectReason(`${token}!!!`, 'token_not_base64');
    expectReason(`${token},`, 'token_not_base64');
    expectReason(`${token} `, 'token_not_base64');
    expectReason(`${token}\r\n`, 'token_not_base64');
    expectReason(`${token}\t`, 'token_not_base64');
  });

  it('rejects the base64url alphabet', () => {
    // A credential whose standard-alphabet encoding contains + or /, rewritten
    // to the url-safe alphabet. base64url is not the accepted encoding.
    let withSpecials = '';
    for (let i = 0; i < 4000 && withSpecials === ''; i += 1) {
      const candidate = Buffer.from(
        JSON.stringify({ userId: 'u'.repeat(i) + 'ÿþ', role: 'admin' }),
      ).toString('base64');
      if (/[+/]/.test(candidate)) withSpecials = candidate;
    }
    expect(withSpecials).not.toBe('');
    expect(validateToken(withSpecials).ok).toBe(false);
    expectReason(withSpecials.replace(/\+/g, '-').replace(/\//g, '_'), 'token_not_base64');
  });

  it('rejects a length that is not a multiple of four', () => {
    expectReason(token.slice(0, -1), 'token_not_base64');
  });

  it('rejects malformed padding', () => {
    expectReason(`${token.slice(0, -1)}=`, 'token_not_base64');
  });

  it('rejects the unpadded spelling of a padded token', () => {
    const padded = forge({ userId: 'abc', role: 'admin' });
    expect(padded.endsWith('==')).toBe(true);
    expect(validateToken(padded).ok).toBe(true);
    // Node decodes both to identical bytes, so only the round-trip pins this.
    expectReason(padded.replace(/=+$/, ''), 'token_not_base64');
  });
});

describe('rejected input — size bounds (VB-3)', () => {
  it('rejects a credential one character over MAX_TOKEN_LENGTH', () => {
    expectReason('A'.repeat(MAX_TOKEN_LENGTH + 1), 'token_too_long');
  });

  it('rejects on length alone, before the alphabet is examined', () => {
    // Ordering matters: an oversized credential must be refused on size, so
    // the cost of inspecting it does not scale with its length.
    expectReason('!'.repeat(MAX_TOKEN_LENGTH * 100), 'token_too_long');
  });

  it('admits a credential at exactly MAX_TOKEN_LENGTH past the size gate', () => {
    // At the cap the size gate must NOT fire — the value is then refused by
    // the content rules instead, which proves the gate boundary is exact.
    expectReason('A'.repeat(MAX_TOKEN_LENGTH), 'token_not_json');
  });
});

describe('rejected input — payload shape and claims (VB-4, VB-5, VB-6)', () => {
  it('rejects decoded bytes that are not JSON', () => {
    expectReason(Buffer.from('just a string').toString('base64'), 'token_not_json');
    expectReason(Buffer.from('{"userId":').toString('base64'), 'token_not_json');
  });

  it('rejects JSON that is not a plain object', () => {
    expectReason(forge([1, 2, 3]), 'token_not_object');
    expectReason(forge(123), 'token_not_object');
    expectReason(forge('a string'), 'token_not_object');
    expectReason(forge(null), 'token_not_object');
    expectReason(forge(true), 'token_not_object');
  });

  it('rejects a missing userId', () => {
    expectReason(forge({ role: 'admin' }), 'user_id_missing');
  });

  it('rejects an invalid userId', () => {
    expectReason(forge({ userId: '', role: 'admin' }), 'user_id_invalid');
    expectReason(forge({ userId: 123, role: 'admin' }), 'user_id_invalid');
    expectReason(forge({ userId: null, role: 'admin' }), 'user_id_invalid');
    expectReason(forge({ userId: ['u1'], role: 'admin' }), 'user_id_invalid');
    expectReason(forge({ userId: { $ne: null }, role: 'admin' }), 'user_id_invalid');
  });

  it('rejects a userId containing control characters (audit log injection)', () => {
    // These previously authenticated and would be written verbatim into audit
    // records by protectedEndpointAuditMiddleware.
    expectReason(forge({ userId: 'u1\r\nrole=admin', role: 'client' }), 'user_id_invalid');
    expectReason(forge({ userId: 'u1\nforged-entry', role: 'client' }), 'user_id_invalid');
    expectReason(forge({ userId: 'u1\u0000null', role: 'client' }), 'user_id_invalid');
    expectReason(forge({ userId: 'u1\u001b[2J', role: 'client' }), 'user_id_invalid');
  });

  it('rejects a userId containing whitespace or shell/JSON metacharacters', () => {
    expectReason(forge({ userId: 'u 1', role: 'client' }), 'user_id_invalid');
    expectReason(forge({ userId: ' u1', role: 'client' }), 'user_id_invalid');
    expectReason(forge({ userId: 'u1 ', role: 'client' }), 'user_id_invalid');
    expectReason(forge({ userId: 'u"1', role: 'client' }), 'user_id_invalid');
    expectReason(forge({ userId: "u'1", role: 'client' }), 'user_id_invalid');
    expectReason(forge({ userId: 'u\\1', role: 'client' }), 'user_id_invalid');
  });

  it('rejects a missing role', () => {
    expectReason(forge({ userId: 'u1' }), 'role_missing');
  });

  it('rejects a role outside the allowlist', () => {
    for (const role of ['superuser', 'Admin', 'ADMIN', ' admin', 'admin ', '', 1, null, ['admin']]) {
      expectReason(forge({ userId: 'u1', role }), 'role_invalid');
    }
  });

  it('never lets an unrecognised role reach req.user', () => {
    const { req, next } = runMiddleware({
      authorization: `Bearer ${forge({ userId: 'u1', role: 'hacker' })}`,
    });
    expect(next).not.toHaveBeenCalled();
    expect(req.user).toBeUndefined();
  });
});

// ─── duplicate submissions ────────────────────────────────────────────────────

describe('duplicate submissions', () => {
  const token = createToken('u1', 'admin');

  it('rejects a comma-joined second credential rather than using the first', () => {
    // RFC 7230 §3.2.2 — a repeated field arrives joined by ", ". Authenticating
    // the first element means an attacker who can append to the header gets a
    // credential nobody issued.
    const joined = `Bearer ${token}, Bearer ${token}`;
    expect(parseBearerHeader(joined)).toBeNull();

    const { req, status, next } = runMiddleware({ authorization: joined });
    expect(status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
    expect(req.user).toBeUndefined();
  });

  it('rejects a duplicated credential whose second element is garbage', () => {
    // Previously the trailing element decoded to junk bytes appended to the
    // JSON text; where it happened to decode to clean JSON the request
    // authenticated.
    const { status, next } = runMiddleware({
      authorization: `Bearer ${token}, Bearer ###`,
    });
    expect(status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('is deterministic across repeated submissions of the same header', () => {
    const headers = [
      `Bearer ${token}`,
      `Bearer ${token},`,
      `Bearer ${token}, Bearer ${token}`,
      `Bearer ${token} `,
      `Bearer ${token}!!!`,
    ];
    const verdicts = headers.map(h => runMiddleware({ authorization: h }).status.mock.calls[0]?.[0]);
    // Only the canonical header authenticates; every alias is a 401.
    expect(verdicts).toEqual([undefined, 401, 401, 401, 401]);
  });

  it('authenticates the same token consistently on repeat requests', () => {
    const header = `Bearer ${createToken('u1', 'admin')}`;
    for (let i = 0; i < 5; i += 1) {
      const { req, status, next } = runMiddleware({ authorization: header });
      expect(req.user).toEqual({ userId: 'u1', role: 'admin' });
      expect(next).toHaveBeenCalledTimes(1);
      expect(status).not.toHaveBeenCalled();
    }
  });
});

// ─── boundary values ──────────────────────────────────────────────────────────

describe('boundary values', () => {
  it('accepts userId at exactly MAX_USER_ID_LENGTH and rejects one more', () => {
    const atLimit = 'a'.repeat(MAX_USER_ID_LENGTH);
    expect(decodeToken(createToken(atLimit, 'admin'))).toEqual({
      userId: atLimit,
      role: 'admin',
    });

    const overLimit = 'a'.repeat(MAX_USER_ID_LENGTH + 1);
    expectReason(forge({ userId: overLimit, role: 'admin' }), 'user_id_invalid');
    expect(() => createToken(overLimit, 'admin')).toThrow(TypeError);
  });

  it('rejects an empty token and an empty userId', () => {
    expectReason('', 'empty_token');
    expectReason(forge({ userId: '', role: 'admin' }), 'user_id_invalid');
  });

  it('treats a token one character below MAX_TOKEN_LENGTH as too long only when over', () => {
    expectReason('A'.repeat(MAX_TOKEN_LENGTH), 'token_not_base64');
    expectReason('A'.repeat(MAX_TOKEN_LENGTH + 1), 'token_too_long');
  });

  it('rejects non-string tokens without throwing', () => {
    for (const value of [null, undefined, 42, {}, [], Buffer.from('x')]) {
      const result = validateToken(value);
      expect(result.ok).toBe(false);
    }
  });
});

// ─── regressions ──────────────────────────────────────────────────────────────

describe('regressions — inputs that authenticated before this change', () => {
  const token = createToken('u1', 'admin');

  it.each([
    ['trailing garbage', `Bearer ${token}!!!`],
    ['trailing comma', `Bearer ${token},`],
    ['trailing space', `Bearer ${token} `],
    ['trailing CRLF', `Bearer ${token}\r\n`],
    ['leading space in the credential', `Bearer  ${token}`],
    ['two spaces after the scheme', `Bearer  ${token}`],
  ])('no longer authenticates: %s', (_label, header) => {
    const { req, status, next } = runMiddleware({ authorization: header });
    expect(status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
    expect(req.user).toBeUndefined();
  });

  it('does not authenticate a role inherited from Object.prototype', () => {
    // Prototype pollution anywhere in the process previously promoted a token
    // carrying no role field at all to administrator.
    Object.prototype.role = 'admin';
    try {
      const noRole = forge({ userId: 'u1' });
      expectReason(noRole, 'role_missing');

      const { status, next, req } = runMiddleware({ authorization: `Bearer ${noRole}` });
      expect(status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
      expect(req.user).toBeUndefined();
    } finally {
      delete (Object.prototype as { role?: unknown }).role;
    }
  });

  it('does not authenticate a userId inherited from Object.prototype', () => {
    Object.prototype.userId = 'ghost';
    try {
      expectReason(forge({ role: 'admin' }), 'user_id_missing');
    } finally {
      delete (Object.prototype as { userId?: unknown }).userId;
    }
  });

  it('does not project unexpected payload fields into req.user', () => {
    // Extra claims must not reach the audit trail via req.user.
    const smuggled = forge({ userId: 'u1', role: 'client', isAdmin: true, sub: 'root' });
    const { req } = runMiddleware({ authorization: `Bearer ${smuggled}` });
    expect(req.user).toEqual({ userId: 'u1', role: 'client' });
    expect(Object.keys(req.user as object).sort()).toEqual(['role', 'userId']);
  });

  it('createToken refuses to mint a token the decoder would reject', () => {
    expect(() => createToken('', 'admin')).toThrow(TypeError);
    expect(() => createToken('u1', 'superuser' as never)).toThrow(TypeError);
    expect(() => createToken('u1\r\nforged', 'admin')).toThrow(TypeError);
    expect(() => createToken('a'.repeat(MAX_USER_ID_LENGTH + 1), 'admin')).toThrow(TypeError);
  });

  it('never writes req.user on the rejection path', () => {
    for (const header of [undefined, 'Basic x', `Bearer ${token},`, `Bearer !!!`]) {
      const { req, status } = runMiddleware({ authorization: header });
      expect(req.user).toBeUndefined();
      expect(status).toHaveBeenCalledWith(401);
    }
  });
});
