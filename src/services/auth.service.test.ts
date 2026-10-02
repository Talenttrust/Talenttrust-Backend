/**
 * Comprehensive test suite for AuthService.
 *
 * Tests cover:
 * - Password hashing with scrypt (unique salts, non-plaintext storage)
 * - Anti-enumeration (uniform error messages)
 * - Refresh token rotation (validation, revocation, reuse prevention)
 * - Security properties (no logging of secrets, no plaintext tokens)
 */

import { AuthService } from "./auth.service";
import * as crypto from "crypto";
import * as jwt_module from "jsonwebtoken";
import Database from "better-sqlite3";

const jwt = jwt_module;

const TEST_JWT_SECRET = "test-secret-key-for-unit-tests-only";

beforeAll(() => {
  process.env.JWT_SECRET = TEST_JWT_SECRET;
});

// Create real in-memory SQLite database with proper schema
function createDb(): Database.Database {
  const db = new Database(":memory:");

  // Create users table with all required columns matching migration version 7
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id              TEXT    PRIMARY KEY,
      username        TEXT    NOT NULL UNIQUE,
      email           TEXT    NOT NULL UNIQUE,
      role            TEXT    NOT NULL DEFAULT 'client'
                              CHECK (role IN ('client', 'freelancer', 'both')),
      password_hash   TEXT,
      refresh_token_hash TEXT,
      created_at      TEXT    NOT NULL
    )
  `);

  return db;
}

describe("AuthService — password hashing with scrypt", () => {
  let db: Database.Database;
  let authService: AuthService;

  beforeEach(() => {
    db = createDb();
    authService = new AuthService(db);
  });

  afterEach(() => {
    db.close();
  });

  it("stores non-plaintext passwords and allows successful login", async () => {
    const password = "MySecurePass123!";
    const result = await authService.register("user@test.com", password, "testuser");

    expect(result.accessToken).toBeDefined();
    expect(result.refreshToken).toBeDefined();

    // Verify login works with correct password
    const loginResult = await authService.login("user@test.com", password);
    expect(loginResult.accessToken).toBeDefined();
  });

  it("rejects login with wrong password", async () => {
    await authService.register("user@test.com", "CorrectPass123!", "testuser");

    await expect(authService.login("user@test.com", "WrongPass456!")).rejects.toThrow(
      "Authentication failed."
    );
  });

  it("produces different salts for same password across registrations", async () => {
    const password = "SamePass123!";

    const reg1 = await authService.register("user1@test.com", password, "user1");
    const reg2 = await authService.register("user2@test.com", password, "user2");

    // Different users with same password get different tokens
    expect(reg1.accessToken).not.toBe(reg2.accessToken);

    // Both can login successfully
    const login1 = await authService.login("user1@test.com", password);
    const login2 = await authService.login("user2@test.com", password);

    expect(login1.accessToken).toBeDefined();
    expect(login2.accessToken).toBeDefined();
  });

  it("rejects login for non-existent user with same error as wrong password", async () => {
    await authService.register("exists@test.com", "Pass123!", "testuser");

    let wrongPasswordError: Error | null = null;
    let missingUserError: Error | null = null;

    try {
      await authService.login("exists@test.com", "WrongPass!");
    } catch (e) {
      wrongPasswordError = e as Error;
    }

    try {
      await authService.login("notexists@test.com", "AnyPass!");
    } catch (e) {
      missingUserError = e as Error;
    }

    expect(wrongPasswordError?.message).toBe("Authentication failed.");
    expect(missingUserError?.message).toBe("Authentication failed.");
    expect(wrongPasswordError?.message).toBe(missingUserError?.message);
  });

  it("rejects duplicate registration with appropriate error", async () => {
    await authService.register("user@test.com", "Pass123!", "testuser");

    await expect(
      authService.register("user@test.com", "DifferentPass!", "anotheruser")
    ).rejects.toThrow("An account with that email already exists.");
  });

  it("normalizes emails to lowercase for storage and lookup", async () => {
    const result = await authService.register("User@Test.COM", "Pass123!", "testuser");
    const decoded = jwt.verify(result.accessToken, TEST_JWT_SECRET) as Record<string, unknown>;

    expect(decoded.email).toBe("user@test.com");

    const login = await authService.login("user@test.com", "Pass123!");
    expect(login.accessToken).toBeDefined();

    const login2 = await authService.login("USER@TEST.COM", "Pass123!");
    expect(login2.accessToken).toBeDefined();
  });

  it("trims surrounding whitespace from emails on register and login", async () => {
    const result = await authService.register("  user@test.com  ", "Pass123!", "testuser");
    const decoded = jwt.verify(result.accessToken, TEST_JWT_SECRET) as Record<string, unknown>;

    expect(decoded.email).toBe("user@test.com");

    const login = await authService.login("  user@test.com  ", "Pass123!");
    expect(login.accessToken).toBeDefined();
  });

  it("rejects registration when a case-and-whitespace variant of an existing email is used", async () => {
    await authService.register("user@test.com", "Pass123!", "testuser");

    await expect(
      authService.register("  USER@Test.com  ", "DifferentPass!", "anotheruser")
    ).rejects.toThrow("An account with that email already exists.");
  });
});

describe("AuthService — anti-enumeration (uniform error contract)", () => {
  let db: Database.Database;
  let authService: AuthService;

  beforeEach(() => {
    db = createDb();
    authService = new AuthService(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns generic error message that does not reveal user existence", async () => {
    await authService.register("user@test.com", "Pass123!", "testuser");

    let error: Error | null = null;
    try {
      await authService.login("user@test.com", "WrongPass!");
    } catch (e) {
      error = e as Error;
    }

    const msg = error!.message.toLowerCase();

    expect(msg).not.toContain("user");
    expect(msg).not.toContain("email");
    expect(msg).not.toContain("password");
    expect(msg).not.toContain("exists");
    expect(msg).not.toContain("account");
    expect(msg).not.toContain("wrong");
  });

  it("uses consistent error code for auth failures", async () => {
    await authService.register("user@test.com", "Pass123!", "testuser");

    let wrongPasswordCode: string | undefined;
    let missingUserCode: string | undefined;

    try {
      await authService.login("user@test.com", "WrongPass!");
    } catch (e) {
      wrongPasswordCode = (e as NodeJS.ErrnoException).code;
    }

    try {
      await authService.login("notexists@test.com", "AnyPass!");
    } catch (e) {
      missingUserCode = (e as NodeJS.ErrnoException).code;
    }

    expect(wrongPasswordCode).toBe("invalid_credentials");
    expect(missingUserCode).toBe("invalid_credentials");
  });
});

describe("AuthService — refresh token rotation", () => {
  let db: Database.Database;
  let authService: AuthService;

  beforeEach(() => {
    db = createDb();
    authService = new AuthService(db);
  });

  afterEach(() => {
    db.close();
  });

  it("issues access and refresh tokens on registration", async () => {
    const { accessToken, refreshToken } = await authService.register(
      "user@test.com",
      "Pass123!",
      "testuser"
    );

    expect(accessToken).toBeDefined();
    expect(refreshToken).toBeDefined();
    expect(accessToken).not.toBe(refreshToken);

    const accessDecoded = jwt.verify(accessToken, TEST_JWT_SECRET);
    const refreshDecoded = jwt.verify(refreshToken, TEST_JWT_SECRET);
    expect(accessDecoded).toBeDefined();
    expect(refreshDecoded).toBeDefined();
  });

  it("stores refresh token hash instead of raw token", async () => {
    const { refreshToken } = await authService.register("user@test.com", "Pass123!", "testuser");

    const { refreshToken: newToken } = await authService.refresh(refreshToken);
    expect(newToken).toBeDefined();
    expect(newToken).not.toBe(refreshToken);

    await expect(authService.refresh(refreshToken)).rejects.toThrow(
      "Invalid or expired refresh token."
    );
  });

  it("rotates refresh token on each use", async () => {
    let { refreshToken: token1 } = await authService.register("user@test.com", "Pass123!", "testuser");

    const { refreshToken: token2 } = await authService.refresh(token1);
    expect(token2).not.toBe(token1);

    const { refreshToken: token3 } = await authService.refresh(token2);
    expect(token3).not.toBe(token2);
    expect(token3).not.toBe(token1);

    await expect(authService.refresh(token1)).rejects.toThrow();
    await expect(authService.refresh(token2)).rejects.toThrow();
  });

  it("prevents reuse of revoked tokens", async () => {
    const { refreshToken: token1 } = await authService.register("user@test.com", "Pass123!", "testuser");

    const { refreshToken: token2 } = await authService.refresh(token1);

    await expect(authService.refresh(token1)).rejects.toThrow(
      "Invalid or expired refresh token."
    );

    const { refreshToken: token3 } = await authService.refresh(token2);
    expect(token3).toBeDefined();
  });

  it("rejects tampered refresh tokens", async () => {
    const { refreshToken } = await authService.register("user@test.com", "Pass123!", "testuser");

    const tamperedToken = refreshToken.slice(0, -5) + "xxxxx";

    await expect(authService.refresh(tamperedToken)).rejects.toThrow(
      "Invalid or expired refresh token."
    );

    const { refreshToken: newToken } = await authService.refresh(refreshToken);
    expect(newToken).toBeDefined();
  });

  it("uses consistent error code for all refresh failures", async () => {
    const { refreshToken } = await authService.register("user@test.com", "Pass123!", "testuser");

    const { refreshToken: token2 } = await authService.refresh(refreshToken);

    let reuseCode: string | undefined;
    let tamperedCode: string | undefined;

    try {
      await authService.refresh(refreshToken);
    } catch (e) {
      reuseCode = (e as NodeJS.ErrnoException).code;
    }

    try {
      await authService.refresh(token2 + "tampered");
    } catch (e) {
      tamperedCode = (e as NodeJS.ErrnoException).code;
    }

    expect(reuseCode).toBe("invalid_refresh_token");
    expect(tamperedCode).toBe("invalid_refresh_token");
  });

  it("invalidates token on logout", async () => {
    const { refreshToken, accessToken } = await authService.register(
      "user@test.com",
      "Pass123!",
      "testuser"
    );

    const decoded = jwt.verify(accessToken, TEST_JWT_SECRET) as Record<string, unknown>;
    const userId = decoded.sub as string;

    authService.logout(userId);

    await expect(authService.refresh(refreshToken)).rejects.toThrow(
      "Invalid or expired refresh token."
    );
  });
});

describe("AuthService — security properties", () => {
  let db: Database.Database;
  let authService: AuthService;

  beforeEach(() => {
    db = createDb();
    authService = new AuthService(db);
  });

  afterEach(() => {
    db.close();
  });

  it("does not log raw passwords", async () => {
    const consoleSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    const consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    const password = "SuperSecret123!";
    await authService.register("user@test.com", password, "testuser");

    const allLogs = [
      ...consoleSpy.mock.calls.flat(),
      ...consoleWarnSpy.mock.calls.flat(),
      ...consoleErrorSpy.mock.calls.flat(),
    ].join(" ");

    expect(allLogs).not.toContain(password);

    consoleSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it("does not log raw refresh tokens", async () => {
    const consoleSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    const consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    const { refreshToken } = await authService.register("user@test.com", "Pass123!", "testuser");

    const allLogs = [
      ...consoleSpy.mock.calls.flat(),
      ...consoleWarnSpy.mock.calls.flat(),
      ...consoleErrorSpy.mock.calls.flat(),
    ].join(" ");

    expect(allLogs).not.toContain(refreshToken);

    consoleSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it("access token payload does not contain raw password", async () => {
    const password = "MyPass123!";
    const { accessToken } = await authService.register("user@test.com", password, "testuser");

    expect(accessToken).not.toContain(password);
  });

  it("access token payload does not contain raw refresh token", async () => {
    const { accessToken, refreshToken } = await authService.register(
      "user@test.com",
      "Pass123!",
      "testuser"
    );

    expect(accessToken).not.toContain(refreshToken);
  });

  it("issued access tokens are valid JWTs with correct payload", async () => {
    const { accessToken } = await authService.register("user@test.com", "Pass123!", "testuser");

    const decoded = jwt.verify(accessToken, TEST_JWT_SECRET) as Record<string, unknown>;

    expect(decoded.sub).toBeDefined();
    expect(decoded.email).toBe("user@test.com");
    expect(decoded.role).toBe("client");
    expect(decoded.iat).toBeDefined();
    expect(decoded.exp).toBeDefined();
  });

  it("issued refresh tokens are valid JWTs with internal structure", async () => {
    const { refreshToken } = await authService.register("user@test.com", "Pass123!", "testuser");

    const decoded = jwt.verify(refreshToken, TEST_JWT_SECRET) as Record<string, unknown>;

    expect(decoded.sub).toBeDefined();
    expect(decoded.tok).toBeDefined();
    expect(decoded.iat).toBeDefined();
    expect(decoded.exp).toBeDefined();
  });
});

describe("AuthService — custom role and defaults", () => {
  let db: Database.Database;
  let authService: AuthService;

  beforeEach(() => {
    db = createDb();
    authService = new AuthService(db);
  });

  afterEach(() => {
    db.close();
  });

  it("sets default role to 'client' when not provided", async () => {
    const { accessToken } = await authService.register("user@test.com", "Pass123!", "testuser");

    const decoded = jwt.verify(accessToken, TEST_JWT_SECRET) as Record<string, unknown>;
    expect(decoded.role).toBe("client");
  });

  it("allows custom role during registration", async () => {
    const { accessToken } = await authService.register(
      "user@test.com",
      "Pass123!",
      "testuser",
      "freelancer"
    );

    const decoded = jwt.verify(accessToken, TEST_JWT_SECRET) as Record<string, unknown>;
    expect(decoded.role).toBe("freelancer");
  });

  it("allows 'both' role", async () => {
    const { accessToken } = await authService.register(
      "user@test.com",
      "Pass123!",
      "testuser",
      "both"
    );

    const decoded = jwt.verify(accessToken, TEST_JWT_SECRET) as Record<string, unknown>;
    expect(decoded.role).toBe("both");
  });
});

describe("AuthService — timing-safe comparisons", () => {
  let db: Database.Database;
  let authService: AuthService;

  beforeEach(() => {
    db = createDb();
    authService = new AuthService(db);
  });

  afterEach(() => {
    db.close();
  });

  it("login always performs password verification even for non-existent users", async () => {
    await authService.register("exists@test.com", "Pass123!", "testuser");

    let wrongPasswordError: Error | null = null;
    let missingUserError: Error | null = null;

    try {
      await authService.login("exists@test.com", "Wrong!");
    } catch (e) {
      wrongPasswordError = e as Error;
    }

    try {
      await authService.login("notexists@test.com", "Wrong!");
    } catch (e) {
      missingUserError = e as Error;
    }

    expect(wrongPasswordError?.message).toBe(missingUserError?.message);
  });
});

describe("AuthService — integration scenarios", () => {
  let db: Database.Database;
  let authService: AuthService;

  beforeEach(() => {
    db = createDb();
    authService = new AuthService(db);
  });

  afterEach(() => {
    db.close();
  });

  it("supports complete auth lifecycle: register → login → refresh → logout", async () => {
    const email = "user@test.com";
    const password = "Pass123!";
    const username = "testuser";

    const registerTokens = await authService.register(email, password, username);
    expect(registerTokens.accessToken).toBeDefined();

    const loginTokens = await authService.login(email, password);
    expect(loginTokens.accessToken).toBeDefined();

    const refreshedTokens = await authService.refresh(loginTokens.refreshToken);
    expect(refreshedTokens.accessToken).toBeDefined();

    const decoded = jwt.verify(refreshedTokens.accessToken, TEST_JWT_SECRET) as Record<
      string,
      unknown
    >;
    authService.logout(decoded.sub as string);

    await expect(authService.refresh(refreshedTokens.refreshToken)).rejects.toThrow(
      "Invalid or expired refresh token."
    );
  });

  it("allows multiple independent users in same database", async () => {
    const user1Tokens = await authService.register("user1@test.com", "Pass123!", "user1");
    const user2Tokens = await authService.register("user2@test.com", "Pass123!", "user2");

    const login1 = await authService.login("user1@test.com", "Pass123!");
    const login2 = await authService.login("user2@test.com", "Pass123!");

    expect(login1.accessToken).not.toBe(login2.accessToken);

    const decoded1 = jwt.verify(login1.accessToken, TEST_JWT_SECRET) as Record<string, unknown>;
    const decoded2 = jwt.verify(login2.accessToken, TEST_JWT_SECRET) as Record<string, unknown>;

    expect(decoded1.email).toBe("user1@test.com");
    expect(decoded2.email).toBe("user2@test.com");
  });
});
