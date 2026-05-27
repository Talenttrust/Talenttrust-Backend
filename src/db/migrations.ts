import Database from "better-sqlite3";

export interface Migration {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "create_users_and_contracts_schema",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id          TEXT    PRIMARY KEY,
          username    TEXT    NOT NULL UNIQUE,
          email       TEXT    NOT NULL UNIQUE,
          role        TEXT    NOT NULL DEFAULT 'client'
                              CHECK (role IN ('client', 'freelancer', 'both')),
          created_at  TEXT    NOT NULL
        );

        CREATE TABLE IF NOT EXISTS contracts (
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

        CREATE INDEX IF NOT EXISTS idx_contracts_client_id
          ON contracts(client_id);

        CREATE INDEX IF NOT EXISTS idx_contracts_freelancer_id
          ON contracts(freelancer_id);

        CREATE INDEX IF NOT EXISTS idx_contracts_status
          ON contracts(status);
      `);
    },
  },
  {
    version: 2,
    name: "add_contract_version_column",
    up: (db) => {
      const columns = db.pragma("table_info(contracts)") as Array<{ name: string }>;
      const hasVersion = columns.some((col) => col.name === "version");
      if (!hasVersion) {
        db.exec(
          "ALTER TABLE contracts ADD COLUMN version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0)"
        );
      }
    },
  },
];

function ensureMigrationTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version     INTEGER PRIMARY KEY,
      name        TEXT    NOT NULL,
      applied_at  TEXT    NOT NULL
    );
  `);
}

function getAppliedVersions(db: Database.Database): Set<number> {
  const rows = db
    .prepare<[], { version: number }>(
      "SELECT version FROM schema_version ORDER BY version ASC"
    )
    .all();

  return new Set(rows.map((row) => row.version));
}

function assertMigrationsAreValid(migrations: Migration[]): void {
  const sortedVersions = [...migrations.map((m) => m.version)].sort((a, b) => a - b);

  for (let index = 0; index < sortedVersions.length; index += 1) {
    const expectedVersion = index + 1;
    if (sortedVersions[index] !== expectedVersion) {
      throw new Error(
        `Invalid migration sequence: expected version ${expectedVersion}, got ${sortedVersions[index]}`
      );
    }
  }
}

export function runMigrations(
  db: Database.Database,
  migrations: Migration[] = MIGRATIONS
): void {
  assertMigrationsAreValid(migrations);
  ensureMigrationTable(db);

  const appliedVersions = getAppliedVersions(db);
  const insertApplied = db.prepare<[number, string, string]>(
    "INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)"
  );

  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) {
      continue;
    }

    const applyMigration = db.transaction(() => {
      migration.up(db);
      insertApplied.run(
        migration.version,
        migration.name,
        new Date().toISOString()
      );
    });

    applyMigration();
  }
}

export function getLatestSchemaVersion(): number {
  return MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
}
