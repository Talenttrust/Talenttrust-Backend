/**
 * @module auth/revocation
 * @description Bounded, in-memory revocation list for wallet JWTs keyed by `jti`.
 *
 * Each entry lives only until the revoked token would have expired anyway, so
 * the list never grows beyond the set of still-valid revoked tokens. A hard
 * capacity bound evicts the least recently revoked entry first (LRU) so a flood
 * of logouts cannot exhaust memory.
 *
 * @security The list is per process: on a multi-instance or serverless
 * deployment a token revoked on one instance is still accepted by the others
 * until it expires. Use short token lifetimes or a shared store if that matters.
 */

export const DEFAULT_REVOCATION_CAPACITY = 10_000;

export interface TokenRevocationListOptions {
  /** Maximum number of revoked jtis kept at once (default 10 000). */
  capacity?: number;
  /** Injectable clock (epoch ms); defaults to Date.now. */
  now?: () => number;
}

export class TokenRevocationList {
  /** jti -> expiry (epoch ms). Map iteration order doubles as the LRU order. */
  private readonly entries = new Map<string, number>();
  private readonly capacity: number;
  private readonly now: () => number;

  constructor(options: TokenRevocationListOptions = {}) {
    this.capacity = Math.max(1, options.capacity ?? DEFAULT_REVOCATION_CAPACITY);
    this.now = options.now ?? Date.now;
  }

  /** Revoke `jti` until `expiresAtMs`; a token that has already expired is not stored. */
  revoke(jti: string, expiresAtMs: number): void {
    this.prune();
    if (expiresAtMs <= this.now()) return;
    this.entries.delete(jti);
    this.entries.set(jti, expiresAtMs);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }

  /** True while `jti` is revoked and its token has not yet expired. */
  isRevoked(jti: string): boolean {
    const expiresAt = this.entries.get(jti);
    if (expiresAt === undefined) return false;
    if (expiresAt <= this.now()) {
      this.entries.delete(jti);
      return false;
    }
    return true;
  }

  /** Number of live revocation entries (expired entries are pruned first). */
  get size(): number {
    this.prune();
    return this.entries.size;
  }

  private prune(): void {
    const now = this.now();
    for (const [jti, expiresAt] of this.entries) {
      if (expiresAt <= now) this.entries.delete(jti);
    }
  }
}
