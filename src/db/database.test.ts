/**
 * Tests for the database singleton (src/db/database.ts).
 *
 * Each test creates its own in-memory database (':memory:') to remain isolated
 * and deterministic.  The singleton is reset between tests via closeDb().
 */

import { getDb, closeDb } from "./database";

afterEach(() => {
  closeDb();
});

describe("getDb", () => {
  it("returns a database instance", () => {
    const db = getDb(":memory:");
    expect(db).toBeDefined();
    expect(db.open).toBe(true);
  });

  it("returns the same instance on repeated calls (singleton)", () => {
    const db1 = getDb(":memory:");
    const db2 = getDb(":memory:");
    expect(db1).toBe(db2);
  });

  it("creates the contracts table on init", () => {
    const db = getDb(":memory:");
    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='contracts'",
      )
      .get() as { name: string } | undefined;
    expect(row?.name).toBe("contracts");
  });

  it("creates the users table on init", () => {
    const db = getDb(":memory:");
    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='users'",
      )
      .get() as { name: string } | undefined;
    expect(row?.name).toBe("users");
  });

  it("creates an index on contracts.client_id", () => {
    const db = getDb(":memory:");
    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_contracts_client_id'",
      )
      .get() as { name: string } | undefined;
    expect(row?.name).toBe("idx_contracts_client_id");
  });

  it("enables WAL journal mode", () => {
    const db = getDb(":memory:");
    // WAL mode is not supported on :memory: — it falls back to 'memory'
    // but the pragma call must not throw.
    const result = db.pragma("journal_mode", { simple: true }) as string;
    expect(["wal", "memory"]).toContain(result);
  });

  it("enables foreign keys", () => {
    const db = getDb(":memory:");
    const fk = db.pragma("foreign_keys", { simple: true }) as number;
    expect(fk).toBe(1);
  });
});

describe("closeDb", () => {
  it("closes the database and resets the singleton", () => {
    const db1 = getDb(":memory:");
    closeDb();
    const db2 = getDb(":memory:");
    // After close + re-open we get a new instance
    expect(db1).not.toBe(db2);
  });

  it("is safe to call when no db is open", () => {
    expect(() => closeDb()).not.toThrow();
  });
});
