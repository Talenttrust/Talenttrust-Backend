/**
 * @module audit/downloadTokenStore
 * @description SQLite-backed store for audit export download tokens.
 *
 * Security design:
 * - Each token is bound to a specific tenantId, requesterId, and exportArtifactId.
 * - Tokens expire after a configurable TTL (default: 15 minutes).
 * - One-time use is enforced via an atomic `used_at` column — once a row is
 *   marked used it can never be used again, even under concurrent requests.
 * - Revocation is explicit: a token can be revoked before it is used.
 * - No sensitive payload is stored in the token row; the JWT itself carries
 *   only a stable `jti` which is the primary key here.
 *
 * @security
 * - The `jti` column (token identifier) is a UUID so it carries no guessable
 *   structure and does not expose implementation details.
 * - All SQL uses prepared statements — no string interpolation.
 * - Tenant isolation: every lookup includes `tenant_id` so a token issued to
 *   tenant A cannot be used by tenant B even if it is structurally valid.
 */

import type { Database as DatabaseInstance } from 'better-sqlite3';

export interface DownloadTokenRow {
  jti: string;
  tenant_id: string;
  requester_id: string;
  artifact_id: string;
  issued_at: string;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
}

export interface CreateTokenParams {
  jti: string;
  tenantId: string;
  requesterId: string;
  artifactId: string;
  /** ISO-8601 string, defaults to now */
  issuedAt?: string;
  /** ISO-8601 string – must be after issuedAt */
  expiresAt: string;
}

export interface DownloadTokenStore {
  insert(params: CreateTokenParams): void;
  findByJti(jti: string, tenantId: string): DownloadTokenRow | undefined;
  markUsed(jti: string, tenantId: string): boolean;
  revoke(jti: string, tenantId: string): boolean;
  deleteExpired(): number;
}

/**
 * SQLite-backed implementation of {@link DownloadTokenStore}.
 *
 * Requires the `audit_download_tokens` table to exist (see migration 13).
 */
export class SqliteDownloadTokenStore implements DownloadTokenStore {
  private readonly db: DatabaseInstance;

  constructor(db: DatabaseInstance) {
    this.db = db;
  }

  insert(params: CreateTokenParams): void {
    const issuedAt = params.issuedAt ?? new Date().toISOString();
    this.db
      .prepare<[string, string, string, string, string, string]>(
        `INSERT INTO audit_download_tokens
           (jti, tenant_id, requester_id, artifact_id, issued_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.jti,
        params.tenantId,
        params.requesterId,
        params.artifactId,
        issuedAt,
        params.expiresAt,
      );
  }

  findByJti(jti: string, tenantId: string): DownloadTokenRow | undefined {
    return this.db
      .prepare<[string, string], DownloadTokenRow>(
        `SELECT jti, tenant_id, requester_id, artifact_id,
                issued_at, expires_at, used_at, revoked_at
         FROM audit_download_tokens
         WHERE jti = ? AND tenant_id = ?`,
      )
      .get(jti, tenantId) as DownloadTokenRow | undefined;
  }

  /**
   * Atomically marks a token as used if and only if it is not already used
   * or revoked. Returns `true` when the row was updated (i.e. this is the
   * first and only successful use), `false` otherwise.
   *
   * The WHERE clause guards ensure:
   *   - `used_at IS NULL`  — not already consumed
   *   - `revoked_at IS NULL` — not revoked
   *
   * SQLite serialises writes, so two concurrent requests with the same `jti`
   * will both reach this statement but only one will see `changes > 0`.
   */
  markUsed(jti: string, tenantId: string): boolean {
    const result = this.db
      .prepare<[string, string, string]>(
        `UPDATE audit_download_tokens
         SET    used_at = ?
         WHERE  jti = ?
           AND  tenant_id = ?
           AND  used_at IS NULL
           AND  revoked_at IS NULL`,
      )
      .run(new Date().toISOString(), jti, tenantId);
    return result.changes > 0;
  }

  /**
   * Revokes a token so it can no longer be used, even if it has not expired.
   * Idempotent — revoking an already-revoked token returns `false`.
   */
  revoke(jti: string, tenantId: string): boolean {
    const result = this.db
      .prepare<[string, string, string]>(
        `UPDATE audit_download_tokens
         SET    revoked_at = ?
         WHERE  jti = ?
           AND  tenant_id = ?
           AND  revoked_at IS NULL`,
      )
      .run(new Date().toISOString(), jti, tenantId);
    return result.changes > 0;
  }

  /**
   * Removes all rows whose `expires_at` is in the past.
   * Intended to be called periodically by a maintenance job.
   * @returns The number of rows deleted.
   */
  deleteExpired(): number {
    const result = this.db
      .prepare<[string]>(
        `DELETE FROM audit_download_tokens WHERE expires_at < ?`,
      )
      .run(new Date().toISOString());
    return result.changes;
  }
}
