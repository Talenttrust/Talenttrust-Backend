import Database from "better-sqlite3";
import { Migration, runMigrations, getLatestSchemaVersion } from "./migrations";

describe("runMigrations", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("creates schema_version records for applied migrations", () => {
    runMigrations(db);

    const rows = db
      .prepare<[], { version: number }>(
        "SELECT version FROM schema_version ORDER BY version ASC"
      )
      .all();

    expect(rows.map((row) => row.version)).toEqual([1, 2]);
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

  it("rolls back a failed migration and does not record it", () => {
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
