import { createHash, timingSafeEqual } from 'crypto';

/**
 * Compare two secrets without leaking their contents or lengths.
 *
 * Both values are hashed with SHA-256 before `timingSafeEqual`, so the
 * compare always runs on 32-byte digests. A wrong-length input therefore
 * takes the same path as wrong content. Empty, missing, and non-string
 * inputs never match, including empty compared with empty.
 */
export function secureEqual(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = createHash('sha256').update(a, 'utf8').digest();
  const right = createHash('sha256').update(b, 'utf8').digest();
  // Length is checked only after the digest compare. Unequal inputs,
  // including different lengths and empty vs non-empty, return here.
  return timingSafeEqual(left, right) && a.length > 0 && b.length > 0;
}

const BEARER_PREFIX = 'Bearer ';

/**
 * Parse a non-empty credential from an `Authorization: Bearer <token>` header.
 *
 * The scheme is case-sensitive and requires a single space, which is the
 * form the admin, metrics, and webhook checks already require. The returned
 * token is the remainder of the header and may itself contain spaces.
 * Missing, malformed, and empty values return undefined.
 */
export function bearerToken(header: string | null | undefined): string | undefined {
  if (typeof header !== 'string' || !header.startsWith(BEARER_PREFIX)) return undefined;
  const token = header.slice(BEARER_PREFIX.length);
  return token.length > 0 ? token : undefined;
}
