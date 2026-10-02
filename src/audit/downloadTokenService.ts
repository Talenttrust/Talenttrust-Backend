/**
 * @module audit/downloadTokenService
 * @description Issues, verifies, and revokes short-lived, tenant-scoped,
 * single-use download tokens for audit export artifacts.
 *
 * ## Token lifecycle
 *   1. `POST /api/v1/audit/export/token` — caller supplies filters; the
 *      service materialises the export file and issues a JWT bound to that
 *      artifact.
 *   2. `GET /api/v1/audit/export/download/:token` — the JWT is verified
 *      (signature, expiry, tenant, reuse) and the file is streamed once.
 *
 * ## Security decisions (documented for PR reviewers)
 *
 * - **Algorithm pin**: HS256 only, using the existing `JWT_VERIFY_OPTIONS`
 *   / `JWT_ALLOWED_ALGORITHMS` allowlist from `auth/jwtConfig`. The same
 *   `JWT_SECRET` is used so operators only manage one secret.
 *
 * - **Short TTL**: tokens expire after `AUDIT_DOWNLOAD_TOKEN_TTL_SECONDS`
 *   (default 900 s = 15 min). This limits the window in which an intercepted
 *   token can be replayed, even without revocation.
 *
 * - **One-time use**: after the first successful download the `jti` is
 *   atomically marked used in SQLite. Subsequent requests with the same
 *   token receive 410 Gone.
 *
 * - **Tenant isolation**: the JWT payload carries `tenantId`; every DB
 *   lookup is scoped to `(jti, tenantId)`. A valid token for tenant A
 *   cannot be used by tenant B, even if tenant B somehow obtains the raw
 *   JWT string.
 *
 * - **Artifact binding**: the JWT payload carries `artifactId` (the
 *   export file name). If the file no longer exists on disk the handler
 *   returns 410 Gone with `code: "artifact_deleted"`.
 *
 * - **No secret leakage**: the JWT payload contains only `sub` (requesterId),
 *   `jti`, `tenantId`, `artifactId`, `iat`, and `exp`. No export filters,
 *   no user credentials, no internal paths are embedded.
 */

import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { JWT_ALLOWED_ALGORITHMS, JWT_VERIFY_OPTIONS } from '../auth/jwtConfig';
import type { DownloadTokenStore } from './downloadTokenStore';

/** Claims embedded in a download token JWT. */
export interface DownloadTokenPayload {
  /** JWT ID — matches the primary key in `audit_download_tokens`. */
  jti: string;
  /** Subject: the user/service that requested the export. */
  sub: string;
  /** Tenant the token belongs to; verified on every use. */
  tenantId: string;
  /** Export artifact file name; verified at download time. */
  artifactId: string;
  /** Standard issued-at (seconds since epoch). */
  iat: number;
  /** Standard expiry (seconds since epoch). */
  exp: number;
}

export interface IssueTokenOptions {
  requesterId: string;
  tenantId: string;
  artifactId: string;
  /** Seconds until expiry. Defaults to AUDIT_DOWNLOAD_TOKEN_TTL_SECONDS env var or 900. */
  ttlSeconds?: number;
}

export interface VerifyTokenResult {
  payload: DownloadTokenPayload;
}

/**
 * Canonical error codes for download-token failures.
 * Consumers (the route handler) map these to HTTP status codes and
 * structured error responses without leaking internal details.
 */
export type DownloadTokenErrorCode =
  | 'token_expired'
  | 'token_reused'
  | 'token_revoked'
  | 'tenant_mismatch'
  | 'token_invalid';

export class DownloadTokenError extends Error {
  constructor(
    public readonly code: DownloadTokenErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DownloadTokenError';
  }
}

function getSecret(): string {
  const secret = process.env['JWT_SECRET'];
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is not set');
  }
  return secret;
}

function getDefaultTtl(): number {
  const raw = process.env['AUDIT_DOWNLOAD_TOKEN_TTL_SECONDS'];
  if (raw) {
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 900; // 15 minutes
}

export class DownloadTokenService {
  constructor(private readonly store: DownloadTokenStore) {}

  /**
   * Issues a new download token JWT.
   *
   * The token is persisted in the store immediately so that revocation and
   * one-time-use checks can be enforced before the token is consumed.
   *
   * @returns The signed JWT string.
   */
  issue(options: IssueTokenOptions): string {
    const jti = uuidv4();
    const ttl = options.ttlSeconds ?? getDefaultTtl();
    const now = Math.floor(Date.now() / 1000);
    const exp = now + ttl;

    const payload: Omit<DownloadTokenPayload, 'iat' | 'exp'> & {
      iat: number;
      exp: number;
    } = {
      jti,
      sub: options.requesterId,
      tenantId: options.tenantId,
      artifactId: options.artifactId,
      iat: now,
      exp,
    };

    // Persist the token record before signing so there is no window in which
    // a signed token exists without a corresponding DB row.
    this.store.insert({
      jti,
      tenantId: options.tenantId,
      requesterId: options.requesterId,
      artifactId: options.artifactId,
      issuedAt: new Date(now * 1000).toISOString(),
      expiresAt: new Date(exp * 1000).toISOString(),
    });

    // Sign with HS256 (the only allowed algorithm — see JWT_SIGN_ALGORITHMS).
    const token = jwt.sign(payload, getSecret(), {
      algorithm: JWT_ALLOWED_ALGORITHMS[0],
      // iat and exp are already set in the payload; noTimestamp prevents
      // jsonwebtoken from overwriting iat with the current time.
      noTimestamp: true,
    });

    return token;
  }

  /**
   * Verifies a JWT string and returns the decoded payload.
   *
   * This method is "read-only" — it does NOT mark the token as used.
   * Call {@link consume} to atomically verify and mark used in one step.
   *
   * Throws {@link DownloadTokenError} for all token-level failures so the
   * caller can map to a structured HTTP error without leaking internals.
   *
   * @param rawToken  The raw JWT string from the request URL parameter.
   * @param tenantId  The tenant ID derived from the authenticated request
   *                  context (from the JWT session, not the download token).
   */
  verify(rawToken: string, tenantId: string): VerifyTokenResult {
    // 1. Verify JWT signature and standard claims (exp, iat).
    let decoded: DownloadTokenPayload;
    try {
      decoded = jwt.verify(rawToken, getSecret(), {
        ...JWT_VERIFY_OPTIONS,
      }) as DownloadTokenPayload;
    } catch (err) {
      if (err instanceof jwt.TokenExpiredError) {
        throw new DownloadTokenError('token_expired', 'Download token has expired');
      }
      throw new DownloadTokenError('token_invalid', 'Download token is invalid or tampered');
    }

    // 2. Tenant isolation — reject cross-tenant token use.
    if (decoded.tenantId !== tenantId) {
      throw new DownloadTokenError('tenant_mismatch', 'Download token does not belong to this tenant');
    }

    // 3. Check the DB record for revocation and reuse.
    const row = this.store.findByJti(decoded.jti, tenantId);
    if (!row) {
      // Token was signed but no DB row — should not happen in normal flow;
      // treat as invalid rather than expired to avoid information leakage.
      throw new DownloadTokenError('token_invalid', 'Download token record not found');
    }

    if (row.revoked_at !== null) {
      throw new DownloadTokenError('token_revoked', 'Download token has been revoked');
    }

    if (row.used_at !== null) {
      throw new DownloadTokenError('token_reused', 'Download token has already been used');
    }

    return { payload: decoded };
  }

  /**
   * Verifies a token AND atomically marks it as used.
   *
   * Returns the payload on success. Throws {@link DownloadTokenError} for
   * all failure cases — the caller must NOT stream any content if this
   * throws.
   *
   * The one-time-use guarantee: `markUsed` uses a conditional UPDATE
   * (WHERE used_at IS NULL AND revoked_at IS NULL) so even if two
   * concurrent requests arrive with the same token, only one will see
   * `changes > 0` and succeed; the other will fail with `token_reused`.
   */
  consume(rawToken: string, tenantId: string): VerifyTokenResult {
    // First verify (reads the row).
    const result = this.verify(rawToken, tenantId);

    // Then atomically mark used.
    const marked = this.store.markUsed(result.payload.jti, tenantId);
    if (!marked) {
      // Between verify() and markUsed() another request consumed the token.
      throw new DownloadTokenError('token_reused', 'Download token has already been used');
    }

    return result;
  }

  /**
   * Revokes a token identified by its JTI, scoped to a tenant.
   * Returns `true` if the token was revoked, `false` if not found or
   * already revoked.
   */
  revoke(jti: string, tenantId: string): boolean {
    return this.store.revoke(jti, tenantId);
  }
}
