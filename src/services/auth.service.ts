/**
 * @module services/auth
 * @description Authentication service: registration, login, and refresh-token rotation.
 *
 * Security notes:
 * - Passwords are hashed with scrypt (Node built-in, no extra dependency).
 * - timingSafeEqual is used for all secret comparisons to prevent timing attacks.
 * - Refresh tokens are stored as SHA-256 hashes; the raw token is never persisted.
 * - All error paths return the same generic message to prevent user-enumeration.
 * - JWTs are signed with HS256, payload shape: { sub, email, role }. The
 *   signing algorithm is sourced from `JWT_SIGN_ALGORITHMS` in
 *   `auth/jwtConfig.ts` so a future rotation is a one-file edit.
 * - All verification on the auth path passes the centralized `JWT_VERIFY_OPTIONS`
 *   allowlist, which pins the accepted signature algorithms to HS256. This
 *   blocks `alg: none`, HS/RS confusion, and any future algorithm the
 *   platform might be tricked into honouring. The allowlist lives in
 *   `auth/jwtConfig.ts` so a single edit governs every verifier.
 */

import { randomBytes, scryptSync, timingSafeEqual, createHash } from "crypto";
import jwt from "jsonwebtoken";
import Database from "better-sqlite3";
import { JWT_VERIFY_OPTIONS, JWT_SIGN_ALGORITHMS } from "../auth/jwtConfig";
import { normalizeEmail } from "../repositories/userRepository";

const SCRYPT_KEYLEN = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const ACCESS_TOKEN_TTL = "15m";
const REFRESH_TOKEN_TTL = "7d";
const REFRESH_TOKEN_BYTES = 32;

/** JWT payload shape expected by requireAuth. */
export interface TokenPayload {
  sub: string;
  email: string;
  role: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

interface UserAuthRow {
  id: string;
  username: string;
  email: string;
  role: string;
  password_hash: string | null;
  refresh_token_hash: string | null;
}

function getSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not configured");
  return secret;
}

/**
 * Hashes a password using scrypt with a random salt.
 * Output format: `<hex-salt>:<hex-hash>`
 */
function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
  return `${salt}:${hash.toString("hex")}`;
}

/**
 * Verifies a password against a stored scrypt hash (constant-time).
 */
function verifyPassword(password: string, stored: string): boolean {
  const [salt, hashHex] = stored.split(":");
  if (!salt || !hashHex) return false;
  const storedBuf = Buffer.from(hashHex, "hex");
  const candidate = scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
  return storedBuf.length === candidate.length && timingSafeEqual(storedBuf, candidate);
}

/** SHA-256 hash of a raw refresh token for storage. */
function hashRefreshToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function issueTokens(user: { id: string; email: string; role: string }): AuthTokens {
  const payload: TokenPayload = { sub: user.id, email: user.email, role: user.role };
  const secret = getSecret();
  // Sign with HS256 (the only algorithm accepted by JWT_VERIFY_OPTIONS).
  // Using a typed constant here makes a future algorithm change a single
  // edit in `auth/jwtConfig.ts`.
  const accessToken = jwt.sign(payload, secret, {
    algorithm: JWT_SIGN_ALGORITHMS[0],
    expiresIn: ACCESS_TOKEN_TTL,
  });
  const rawRefresh = randomBytes(REFRESH_TOKEN_BYTES).toString("hex");
  const refreshToken = jwt.sign({ sub: user.id, tok: rawRefresh }, secret, {
    algorithm: JWT_SIGN_ALGORITHMS[0],
    expiresIn: REFRESH_TOKEN_TTL,
  });
  return { accessToken, refreshToken };
}

export class AuthService {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Registers a new user with a hashed password.
   *
   * @param email    - Email address, normalised (trimmed + lowercased) internally.
   * @param password - Plaintext password (min 8 chars enforced by Zod schema).
   * @param username - Display name.
   * @param role     - User role (default: 'client').
   * @returns Issued access + refresh tokens.
   * @throws Error with `duplicate_email` code when the email is already taken.
   */
  async register(
    email: string,
    password: string,
    username: string,
    role = "client"
  ): Promise<AuthTokens> {
    const normalised = normalizeEmail(email);
    const existing = this.db
      .prepare<[string], { id: string }>("SELECT id FROM users WHERE email = ?")
      .get(normalised);
    if (existing) {
      const err = new Error("An account with that email already exists.");
      (err as NodeJS.ErrnoException).code = "duplicate_email";
      throw err;
    }

    const passwordHash = hashPassword(password);
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    this.db
      .prepare<[string, string, string, string, string, string]>(
        `INSERT INTO users (id, username, email, role, password_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, username, normalised, role, passwordHash, createdAt);

    const tokens = issueTokens({ id, email: normalised, role });
    this.db
      .prepare<[string, string]>("UPDATE users SET refresh_token_hash = ? WHERE id = ?")
      .run(hashRefreshToken(tokens.refreshToken), id);

    return tokens;
  }

  /**
   * Authenticates a user by email/password and returns tokens.
   *
   * Uses a constant-time compare for passwords and always returns the same
   * generic error to prevent user-enumeration.
   *
   * @param email    - User's email address.
   * @param password - Plaintext password.
   * @returns Issued access + refresh tokens.
   * @throws Error with `invalid_credentials` code on any auth failure.
   */
  async login(email: string, password: string): Promise<AuthTokens> {
    const normalised = normalizeEmail(email);
    const row = this.db
      .prepare<[string], UserAuthRow>(
        "SELECT id, username, email, role, password_hash, refresh_token_hash FROM users WHERE email = ?"
      )
      .get(normalised);

    // Always hash even on "not found" to maintain constant-time behaviour
    const storedHash = row?.password_hash ?? `${"a".repeat(32)}:${"b".repeat(128)}`;
    const valid = verifyPassword(password, storedHash);

    if (!row || !valid) {
      const err = new Error("Authentication failed.");
      (err as NodeJS.ErrnoException).code = "invalid_credentials";
      throw err;
    }

    const tokens = issueTokens(row);
    this.db
      .prepare<[string, string]>("UPDATE users SET refresh_token_hash = ? WHERE id = ?")
      .run(hashRefreshToken(tokens.refreshToken), row.id);

    return tokens;
  }

  /**
   * Rotates a refresh token.
   *
   * Validates the JWT signature + expiry, then performs a constant-time hash
   * comparison against the stored hash. On success the old token is invalidated
   * and a fresh pair is issued.
   *
   * @param refreshToken - The raw refresh JWT presented by the client.
   * @returns New access + refresh token pair.
   * @throws Error with `invalid_refresh_token` code on any failure.
   */
  async refresh(refreshToken: string): Promise<AuthTokens> {
    const invalidErr = (): never => {
      const err = new Error("Invalid or expired refresh token.");
      (err as NodeJS.ErrnoException).code = "invalid_refresh_token";
      throw err;
    };

    let decoded: jwt.JwtPayload;
    try {
      // Use the centralized JWT_VERIFY_OPTIONS so this verifier agrees
      // with the rest of the auth path on exactly which signature
      // algorithms are accepted. The allowlist is sourced from
      // `auth/jwtConfig.ts` to make a future edit (e.g. rotating to
      // RS256) a one-file change.
      decoded = jwt.verify(refreshToken, getSecret(), JWT_VERIFY_OPTIONS) as jwt.JwtPayload;
    } catch {
      invalidErr();
    }

    const userId = decoded!.sub;
    if (!userId) invalidErr();

    const row = this.db
      .prepare<[string], UserAuthRow>(
        "SELECT id, email, role, refresh_token_hash FROM users WHERE id = ?"
      )
      .get(userId!);

    if (!row || !row.refresh_token_hash) invalidErr();

    const incoming = Buffer.from(hashRefreshToken(refreshToken), "hex");
    const stored = Buffer.from(row!.refresh_token_hash!, "hex");
    if (incoming.length !== stored.length || !timingSafeEqual(incoming, stored)) {
      invalidErr();
    }

    // Revoke current token immediately (rotation)
    this.db
      .prepare<[string]>("UPDATE users SET refresh_token_hash = NULL WHERE id = ?")
      .run(userId!);

    const tokens = issueTokens(row!);
    this.db
      .prepare<[string, string]>("UPDATE users SET refresh_token_hash = ? WHERE id = ?")
      .run(hashRefreshToken(tokens.refreshToken), row!.id);

    return tokens;
  }

  /**
   * Revokes the refresh token for the given user (logout).
   */
  logout(userId: string): void {
    this.db
      .prepare<[string]>("UPDATE users SET refresh_token_hash = NULL WHERE id = ?")
      .run(userId);
  }
}
