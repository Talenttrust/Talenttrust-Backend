import Database from "better-sqlite3";
import {
  Migration,
  computeMigrationChecksum,
  runMigrations,
  getLatestSchemaVersion,
} from "./migrations";

describe("runMigrations", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("creates schema_version records with checksums for clean apply", () => {
    runMigrations(db);

    const rows = db
      .prepare<[], { version: number; checksum: string }>(
        "SELECT version, checksum FROM schema_version ORDER BY version ASC"
      )
      .all();

    expect(rows.map((row) => row.version)).toEqual(
      Array.from({ length: getLatestSchemaVersion() }, (_, index) => index + 1),
    );
    expect(rows.every((row) => /^[a-f0-9]{64}$/.test(row.checksum))).toBe(true);
  });

  it("enforces a unique index on the normalized (trimmed + lowercased) email", () => {
    runMigrations(db);

    db.prepare(
      `INSERT INTO users (id, username, email, role, created_at)
       VALUES ('u1', 'alice', 'alice@example.com', 'client', '2026-01-01T00:00:00.000Z')`
    ).run();

    expect(() =>
      db
        .prepare(
          `INSERT INTO users (id, username, email, role, created_at)
           VALUES ('u2', 'alice2', '  Alice@Example.COM  ', 'client', '2026-01-01T00:00:00.000Z')`
        )
        .run()
    ).toThrow();
  });

  it("is idempotent when run multiple times", () => {
    runMigrations(db);
    runMigrations(db);

    const row = db
      .prepare<[], { total: number }>(
        "SELECT COUNT(*) AS total FROM schema_version"
      )
      .get();

    expect(row?.total).toBe(getLatestSchemaVersion());
  });

  it("supports existing databases by applying only missing versions", () => {
    db.exec(`
      CREATE TABLE users (
        id          TEXT    PRIMARY KEY,
        username    TEXT    NOT NULL UNIQUE,
        email       TEXT    NOT NULL UNIQUE,
        role        TEXT    NOT NULL DEFAULT 'client'
                            CHECK (role IN ('client', 'freelancer', 'both')),
        created_at  TEXT    NOT NULL
      );

      CREATE TABLE contracts (
        id            TEXT    PRIMARY KEY,
        title         TEXT    NOT NULL,
        client_id     TEXT    NOT NULL REFERENCES users(id),
        freelancer_id TEXT    NOT NULL REFERENCES users(id),
        amount        INTEGER NOT NULL CHECK (amount >= 0),
        status        TEXT    NOT NULL DEFAULT 'draft'
                              CHECK (status IN (
                                'draft', 'active', 'completed', 'disputed', 'cancelled'
                              )),
        created_at    TEXT    NOT NULL
      );
    `);

    runMigrations(db);

    const columns = db.pragma("table_info(contracts)") as Array<{ name: string }>;
    expect(columns.some((column) => column.name === "version")).toBe(true);

    const row = db
      .prepare<[number], { version: number }>(
        "SELECT version FROM schema_version WHERE version = ?"
      )
      .get(2);

    expect(row?.version).toBe(2);
  });

  it("upgrades legacy up.toString checksums when checksumSource is introduced", () => {
    const migrations: Migration[] = [
      {
        version: 1,
        name: "create_demo_table",
        checksumSource: "CREATE TABLE demo (id INTEGER PRIMARY KEY);",
        up: (migrationDb) => {
          migrationDb.exec("CREATE TABLE demo (id INTEGER PRIMARY KEY);");
        },
      },
    ];

    const legacyMigrations: Migration[] = [
      {
        version: 1,
        name: "create_demo_table",
        up: migrations[0]!.up,
      },
    ];

    runMigrations(db, legacyMigrations);

    const legacyRow = db
      .prepare<[], { checksum: string }>(
        "SELECT checksum FROM schema_version WHERE version = 1"
      )
      .get();

    runMigrations(db, migrations);

    const upgradedRow = db
      .prepare<[], { checksum: string }>(
        "SELECT checksum FROM schema_version WHERE version = 1"
      )
      .get();

    expect(upgradedRow?.checksum).toBe(computeMigrationChecksum(migrations[0]!));
    expect(upgradedRow?.checksum).not.toBe(legacyRow?.checksum);
  });

  it("backfills checksums for existing schema_version rows that predate checksum tracking", () => {
    const migrations: Migration[] = [
      {
        version: 1,
        name: "create_legacy_table",
        up: (migrationDb) => {
          migrationDb.exec("CREATE TABLE legacy (id INTEGER PRIMARY KEY);");
        },
      },
    ];

    db.exec(`
      CREATE TABLE schema_version (
        version     INTEGER PRIMARY KEY,
        name        TEXT    NOT NULL,
        applied_at  TEXT    NOT NULL
      );

      INSERT INTO schema_version (version, name, applied_at)
      VALUES (1, 'create_legacy_table', '2026-05-27T00:00:00.000Z');
    `);

    runMigrations(db, migrations);

    const row = db
      .prepare<[], { checksum: string }>(
        "SELECT checksum FROM schema_version WHERE version = 1"
      )
      .get();

    expect(row?.checksum).toBe(computeMigrationChecksum(migrations[0]!));
  });

  it("aborts when an applied migration checksum no longer matches", () => {
    const originalMigrations: Migration[] = [
      {
        version: 1,
        name: "create_demo_table",
        up: (migrationDb) => {
          migrationDb.exec("CREATE TABLE demo (id INTEGER PRIMARY KEY);");
        },
      },
    ];
    const tamperedMigrations: Migration[] = [
      {
        version: 1,
        name: "create_demo_table",
        up: (migrationDb) => {
          migrationDb.exec("CREATE TABLE demo (id INTEGER PRIMARY KEY, name TEXT);");
        },
      },
    ];

    runMigrations(db, originalMigrations);

    expect(() => runMigrations(db, tamperedMigrations)).toThrow(
      "Applied migration 1 checksum mismatch"
    );
  });

  it("aborts when an applied migration name no longer matches", () => {
    const originalMigrations: Migration[] = [
      {
        version: 1,
        name: "create_demo_table",
        up: (migrationDb) => {
          migrationDb.exec("CREATE TABLE demo (id INTEGER PRIMARY KEY);");
        },
      },
    ];
    const renamedMigrations: Migration[] = [
      {
        ...originalMigrations[0]!,
        name: "renamed_demo_table",
      },
    ];

    runMigrations(db, originalMigrations);

    expect(() => runMigrations(db, renamedMigrations)).toThrow(
      "Applied migration 1 name mismatch"
    );
  });

  it("aborts when applied migrations are missing from the migration list", () => {
    const migrations: Migration[] = [
      {
        version: 1,
        name: "create_demo_table",
        up: (migrationDb) => {
          migrationDb.exec("CREATE TABLE demo (id INTEGER PRIMARY KEY);");
        },
      },
    ];

    runMigrations(db, migrations);

    expect(() => runMigrations(db, [])).toThrow(
      "Applied migration 1 (create_demo_table) is not present"
    );
  });

  it("rejects reordered migration lists before applying them", () => {
    const reorderedMigrations: Migration[] = [
      {
        version: 2,
        name: "second",
        up: () => undefined,
      },
      {
        version: 1,
        name: "first",
        up: () => undefined,
      },
    ];

    expect(() => runMigrations(db, reorderedMigrations)).toThrow(
      "Invalid migration sequence: expected version 1, got 2"
    );
  });

  it("rolls back a failed mid-migration write and does not record it", () => {
    const testMigrations: Migration[] = [
      {
        version: 1,
        name: "create_demo_table",
        up: (migrationDb) => {
          migrationDb.exec("CREATE TABLE demo (id INTEGER PRIMARY KEY);");
        },
      },
      {
        version: 2,
        name: "fail_after_partial_write",
        up: (migrationDb) => {
          migrationDb.exec("INSERT INTO demo (id) VALUES (1);");
          throw new Error("migration failed");
        },
      },
    ];

    expect(() => runMigrations(db, testMigrations)).toThrow("migration failed");

    const versions = db
      .prepare<[], { version: number }>(
        "SELECT version FROM schema_version ORDER BY version ASC"
      )
      .all()
      .map((row) => row.version);
    expect(versions).toEqual([1]);

    const row = db
      .prepare<[], { total: number }>("SELECT COUNT(*) AS total FROM demo")
      .get();
    expect(row?.total).toBe(0);
  });
});
