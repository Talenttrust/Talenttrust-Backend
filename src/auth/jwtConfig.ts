/**
 * @module auth/jwtConfig
 * @description Centralized JWT verification configuration.
 *
 * All `jsonwebtoken.verify()` calls on the auth path MUST import the
 * options exported from this module. Centralizing the allowlist prevents
 * accidental algorithm-confusion vulnerabilities (alg: none, HS/RS swap)
 * where a downstream consumer forgets to pass an explicit `algorithms`
 * option and the library honours whatever the token header advertises.
 *
 * Today the platform signs every token with HS256 using `JWT_SECRET`. If
 * the signing algorithm ever changes (e.g. RS256 with a JWKS), update
 * this file in one place and every verifier picks up the new allowlist.
 *
 * @security
 * - Tokens whose header `alg` is not in `JWT_ALLOWED_ALGORITHMS` are
 *   rejected before any signature verification happens (jsonwebtoken does
 *   this natively when `algorithms` is passed to `verify`).
 * - `alg: none` tokens are rejected because `'none'` is never in the
 *   allowlist.
 * - Supplying a public RSA key as an HMAC secret (RS256/HS256 confusion)
 *   fails signature verification: the token is HS256-only, so an RS256
 *   token cannot validate against `JWT_SECRET`.
 * - Do NOT export a verifier that omits `algorithms`; the point of this
 *   module is to make the allowlist unavoidable.
 */

/**
 * The exhaustive list of signature algorithms accepted by every
 * `jwt.verify()` call on the auth path. Tokens advertising any other
 * algorithm in their header (including the literal string `"none"`) are
 * rejected with the standard 401 path.
 */
export const JWT_ALLOWED_ALGORITHMS = ["HS256"] as const;

/**
 * Algorithm values accepted when SIGNING tokens (must be a subset of, or
 * equal to, `JWT_ALLOWED_ALGORITHMS`). Used at issuance time so a sign()
 * call cannot accidentally emit a token that verify() will then reject.
 */
export const JWT_SIGN_ALGORITHMS = ["HS256"] as const;

/** A type-level union of every algorithm we accept (currently just HS256). */
export type JwtAllowedAlgorithm = (typeof JWT_ALLOWED_ALGORITHMS)[number];

/**
 * Reusable `jsonwebtoken.verify()` options object. Pass this directly to
 * `jwt.verify(token, secret, JWT_VERIFY_OPTIONS)` so every consumer
 * passes the same, complete, allowlist.
 *
 * The `algorithms` field is typed as a mutable array of `JwtAllowedAlgorithm`
 * because `@types/jsonwebtoken` types the matching field as `Algorithm[]`.
 * We still seal the values at runtime with `Object.freeze` so a future
 * caller cannot silently widen the allowlist.
 */
export const JWT_VERIFY_OPTIONS: { algorithms: JwtAllowedAlgorithm[] } = {
  algorithms: ["HS256"],
};

// Runtime immutability — TypeScript can't enforce this on `const` references,
// so we freeze explicitly to guarantee an errant caller cannot widen the
// allowlist at runtime. This complements the type-level invariant.
Object.freeze(JWT_VERIFY_OPTIONS);
Object.freeze(JWT_VERIFY_OPTIONS.algorithms);
