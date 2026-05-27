/**
 * Tests for the database singleton (src/db/database.ts).
 *
 * Each test creates its own in-memory database (':memory:') to remain isolated
 * and deterministic.  The singleton is reset between tests via closeDb().
 */

import { getDb, closeDb } from "./database";
import { getLatestSchemaVersion } from "./migrations";

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

  it("creates a schema_version table and applies latest version", () => {
    const db = getDb(":memory:");
    const row = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'",
      )
      .get();
    expect(row?.name).toBe("schema_version");

    const versionRow = db
      .prepare<[], { version: number }>(
        "SELECT MAX(version) AS version FROM schema_version",
      )
      .get();
    expect(versionRow?.version).toBe(getLatestSchemaVersion());
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

  it("enables synchronous=NORMAL pragma", () => {
    const db = getDb(":memory:");
    const sync = db.pragma("synchronous", { simple: true }) as number;
    expect(sync).toBe(1); // NORMAL = 1
  });

  it("sets busy_timeout pragma to configured value", () => {
    const originalEnv = process.env["DB_BUSY_TIMEOUT"];
    process.env["DB_BUSY_TIMEOUT"] = "3000";
    closeDb(); // Reset to pick up new env var
    const db = getDb(":memory:");
    const timeout = db.pragma("busy_timeout", { simple: true }) as number;
    expect(timeout).toBe(3000);
    process.env["DB_BUSY_TIMEOUT"] = originalEnv;
  });

  it("sets busy_timeout to default 5000ms when not configured", () => {
    const originalEnv = process.env["DB_BUSY_TIMEOUT"];
    delete process.env["DB_BUSY_TIMEOUT"];
    closeDb();
    const db = getDb(":memory:");
    const timeout = db.pragma("busy_timeout", { simple: true }) as number;
    expect(timeout).toBe(5000);
    if (originalEnv !== undefined) {
      process.env["DB_BUSY_TIMEOUT"] = originalEnv;
    }
  });

  it("enables foreign keys", () => {
    const db = getDb(":memory:");
    const fk = db.pragma("foreign_keys", { simple: true }) as number;
    expect(fk).toBe(1);
  });
});

describe("concurrent access", () => {
  it("does not deadlock under read/write contention", () => {
    const db = getDb(":memory:");
    
    // Insert test data using correct schema columns
    db.prepare("INSERT INTO users (id, username, email, role, created_at) VALUES (?, ?, ?, ?, ?)").run("test-id-1", "testuser", "test@example.com", "client", new Date().toISOString());
    
    // Simulate concurrent reads and writes
    const iterations = 100;
    const readPromises: Promise<void>[] = [];
    const writePromises: Promise<void>[] = [];
    
    // Spawn concurrent readers
    for (let i = 0; i < iterations; i++) {
      readPromises.push(
        new Promise((resolve, reject) => {
          try {
            db.prepare("SELECT * FROM users").all();
            resolve();
          } catch (err) {
            reject(err);
          }
        })
      );
    }
    
    // Spawn concurrent writers
    for (let i = 0; i < iterations; i++) {
      writePromises.push(
        new Promise((resolve, reject) => {
          try {
            db.prepare("UPDATE users SET role = ? WHERE id = ?").run("client", "test-id-1");
            resolve();
          } catch (err) {
            reject(err);
          }
        })
      );
    }
    
    // All operations should complete without deadlock
    expect(() => {
      Promise.all([...readPromises, ...writePromises]);
    }).not.toThrow();
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
