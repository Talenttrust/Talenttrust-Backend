import { createHash } from "crypto";
import Database from "better-sqlite3";

export interface Migration {
  version: number;
  name: string;
  checksumSource?: string;
  up: (db: Database.Database) => void;
}

interface AppliedMigration {
  version: number;
  name: string;
  checksum: string | null;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "create_users_and_contracts_schema",
    checksumSource: [
      "CREATE TABLE IF NOT EXISTS users (",
      "CREATE TABLE IF NOT EXISTS contracts (",
      "CREATE INDEX IF NOT EXISTS idx_contracts_client_id",
      "CREATE INDEX IF NOT EXISTS idx_contracts_freelancer_id",
      "CREATE INDEX IF NOT EXISTS idx_contracts_status",
    ].join("\n"),
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
    checksumSource: [
      "ALTER TABLE contracts ADD COLUMN version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0)",
    ].join("\n"),
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
  {
    version: 3,
    name: "create_smart_contract_events_table",
    checksumSource: [
      "CREATE TABLE IF NOT EXISTS smart_contract_events (",
      "UNIQUE(contractId, eventType, idempotencyKey)",
    ].join("\n"),
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS smart_contract_events (
          eventId TEXT PRIMARY KEY,
          contractId TEXT NOT NULL,
          eventType TEXT NOT NULL,
          idempotencyKey TEXT,
          payload TEXT,
          timestamp TEXT NOT NULL,
          UNIQUE(contractId, eventType, idempotencyKey)
        );
      `);
    },
  },
  {
    version: 4,
    name: "create_reputation_entries",
    checksumSource: [
      "CREATE TABLE IF NOT EXISTS reputation_entries (",
      "CREATE INDEX IF NOT EXISTS idx_reputation_entries_target_id",
      "CREATE INDEX IF NOT EXISTS idx_reputation_entries_context_id",
    ].join("\n"),
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS reputation_entries (
          id          TEXT    PRIMARY KEY,
          reviewer_id TEXT    NOT NULL REFERENCES users(id),
          target_id   TEXT    NOT NULL REFERENCES users(id),
          rating      INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
          comment     TEXT    CHECK (length(comment) <= 1000),
          context_id  TEXT    NOT NULL REFERENCES contracts(id),
          created_at  TEXT    NOT NULL,
          UNIQUE(reviewer_id, target_id, context_id)
        );

        CREATE INDEX IF NOT EXISTS idx_reputation_entries_target_id
          ON reputation_entries(target_id);

        CREATE INDEX IF NOT EXISTS idx_reputation_entries_context_id
          ON reputation_entries(context_id);
      `);
    },
  },
  {
    version: 5,
    name: "create_transactions_table",
    checksumSource: [
      "CREATE TABLE IF NOT EXISTS transactions (",
    ].join("\n"),
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS transactions (
          hash            TEXT    PRIMARY KEY,
          status          TEXT    NOT NULL,
          receipt         TEXT,
          last_checked_at TEXT,
          retry_count     INTEGER NOT NULL DEFAULT 0
        );
      `);
    },
  },
];

// Version 6: deployment_history table
MIGRATIONS.push({
  version: 6,
  name: "create_deployment_history_table",
  checksumSource: [
    "CREATE TABLE IF NOT EXISTS deployment_history (",
    "CREATE INDEX IF NOT EXISTS idx_deployment_history_env_from",
    "CREATE INDEX IF NOT EXISTS idx_deployment_history_env_to",
  ].join("\n"),
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS deployment_history (
        id TEXT PRIMARY KEY,
        environment_from TEXT NOT NULL,
        environment_to TEXT,
        target_version TEXT NOT NULL,
        promotion_id TEXT,
        rollback_id TEXT,
        initiated_by TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('SUCCESS', 'FAILURE')),
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_deployment_history_env_from ON deployment_history(environment_from);
      CREATE INDEX IF NOT EXISTS idx_deployment_history_env_to ON deployment_history(environment_to);
    `);
  },
});

// Version 7: add password_hash and refresh_token_hash columns for authentication
MIGRATIONS.push({
  version: 7,
  name: "add_auth_columns_to_users",
  checksumSource: [
    "DROP TABLE IF EXISTS users",
    "CREATE TABLE users (password_hash TEXT, refresh_token_hash TEXT)",
    "INSERT INTO users (id, username, email, role, password_hash, refresh_token_hash, created_at)",
  ].join("\n"),
  up: (db) => {
    const columns = db.pragma("table_info(users)") as Array<{ name: string }>;
    const hasPasswordHash = columns.some((col) => col.name === "password_hash");
    const hasRefreshTokenHash = columns.some((col) => col.name === "refresh_token_hash");

    if (!hasPasswordHash || !hasRefreshTokenHash) {
      // Backup existing data
      const users = db.prepare("SELECT * FROM users").all() as Array<Record<string, unknown>>;

      // Drop old table
      db.exec("DROP TABLE IF EXISTS users");

      // Create new table with auth columns
      db.exec(`
        CREATE TABLE users (
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

      // Restore data if it existed
      if (users.length > 0) {
        const insertStmt = db.prepare(`
          INSERT INTO users (id, username, email, role, password_hash, refresh_token_hash, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);

        for (const user of users) {
          insertStmt.run(
            user.id,
            user.username,
            user.email,
            user.role,
            user.password_hash ?? null,
            user.refresh_token_hash ?? null,
            user.created_at
          );
        }
      }
    }
  },
});

// Version 8: retention storage tables for the SqliteStorageProvider
MIGRATIONS.push({
  version: 8,
  name: "create_retention_storage_tables",
  checksumSource: [
    "CREATE TABLE IF NOT EXISTS retention_local (",
    "CREATE TABLE IF NOT EXISTS retention_archive (",
  ].join("\n"),
  up: (db) => {
    // The retention module uses two independent provider instances (local + archive),
    // so we create two physically separate tables rather than a single table with a
    // discriminator column. This keeps each LRU-style operation constrained to its
    // own table and avoids accidental cross-storage-type data leaks.
    const createRetentionTable = (tableName: string): void => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ${tableName} (
          id                    TEXT    PRIMARY KEY,
          entity_type           TEXT    NOT NULL,
          data                  TEXT    NOT NULL,
          classification        TEXT    NOT NULL,
          created_at            TEXT    NOT NULL,
          expires_at            TEXT    NOT NULL,
          archived_at           TEXT,
          archived_location     TEXT,
          is_archived           INTEGER NOT NULL CHECK (is_archived IN (0, 1)),
          retention_policy_id   TEXT,
          metadata              TEXT,
          updated_at            TEXT    NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_${tableName}_entity_type
          ON ${tableName}(entity_type);
        CREATE INDEX IF NOT EXISTS idx_${tableName}_is_archived
          ON ${tableName}(is_archived);
        CREATE INDEX IF NOT EXISTS idx_${tableName}_expires_at
          ON ${tableName}(expires_at);
        CREATE INDEX IF NOT EXISTS idx_${tableName}_created_at
          ON ${tableName}(created_at);
      `);
    };
    createRetentionTable("retention_local");
    createRetentionTable("retention_archive");
  },
});

// Version 9: add started_at to transactions table
MIGRATIONS.push({
  version: 9,
  name: "add_started_at_to_transactions",
  checksumSource: [
    "ALTER TABLE transactions ADD COLUMN started_at TEXT",
  ].join("\n"),
  up: (db) => {
    // Check if the column already exists to prevent errors during repeated migrations
    const columns = db.pragma("table_info(transactions)") as Array<{ name: string }>;
    const hasStartedAt = columns.some((column) => column.name === "started_at");

    if (!hasStartedAt) {
      db.exec("ALTER TABLE transactions ADD COLUMN started_at TEXT");
    }
  },
});

// Version 10: webhook_subscriptions table
MIGRATIONS.push({
  version: 10,
  name: "create_webhook_subscriptions_table",
  checksumSource: [
    "CREATE TABLE IF NOT EXISTS webhook_subscriptions (",
    "CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_consumer",
    "CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_event",
  ].join("\n"),
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS webhook_subscriptions (
        id TEXT PRIMARY KEY,
        consumer_id TEXT,
        url TEXT NOT NULL,
        event_type TEXT NOT NULL,
        secret TEXT,
        active BOOLEAN DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_consumer ON webhook_subscriptions(consumer_id);
      CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_event ON webhook_subscriptions(event_type);
    `);
  },
});

// Version 11: enforce uniqueness on the normalized (trimmed + lowercased) email
MIGRATIONS.push({
  version: 11,
  name: "add_normalized_email_unique_index",
  checksumSource: [
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_normalized ON users (lower(trim(email)))",
  ].join("\n"),
  up: (db) => {
    // Duplicate emails that differ only by surrounding whitespace or letter
    // case must be rejected. A plain UNIQUE(email) constraint compares the raw
    // stored value, so 'alice@example.com' and '  Alice@Example.COM  ' would be
    // treated as distinct. An expression index over lower(trim(email)) makes the
    // normalized form the uniqueness key.
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_normalized
        ON users (lower(trim(email)));
    `);
  },
});

// Version 12: notifications table backing the NotificationRepository
MIGRATIONS.push({
  version: 12,
  name: "create_notifications_table",
  checksumSource: [
    "CREATE TABLE IF NOT EXISTS notifications (",
    "CREATE INDEX IF NOT EXISTS idx_notifications_user_id",
    "CREATE INDEX IF NOT EXISTS idx_notifications_created_at",
  ].join("\n"),
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS notifications (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL,
        title       TEXT NOT NULL,
        message     TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_notifications_user_id
        ON notifications(user_id);
      CREATE INDEX IF NOT EXISTS idx_notifications_created_at
        ON notifications(created_at);
    `);
  },
});

function ensureMigrationTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version     INTEGER PRIMARY KEY,
      name        TEXT    NOT NULL,
      checksum    TEXT,
      applied_at  TEXT    NOT NULL
    );
  `);

  const columns = db.pragma("table_info(schema_version)") as Array<{ name: string }>;
  const hasChecksum = columns.some((column) => column.name === "checksum");

  if (!hasChecksum) {
    db.exec("ALTER TABLE schema_version ADD COLUMN checksum TEXT");
  }
}

function getAppliedMigrations(db: Database.Database): Map<number, AppliedMigration> {
  const rows = db
    .prepare<[], AppliedMigration>(
      "SELECT version, name, checksum FROM schema_version ORDER BY version ASC"
    )
    .all();

  return new Map(rows.map((row) => [row.version, row]));
}

function assertMigrationsAreValid(migrations: Migration[]): void {
  for (let index = 0; index < migrations.length; index += 1) {
    const expectedVersion = index + 1;
    const migration = migrations[index];

    if (migration?.version !== expectedVersion) {
      throw new Error(
        `Invalid migration sequence: expected version ${expectedVersion}, got ${migration?.version}`
      );
    }
  }
}

/**
 * Computes the immutable fingerprint stored for an applied migration.
 *
 * @param migration - Migration definition from the ordered migration list.
 * @returns A SHA-256 checksum over version, name, and a body fingerprint.
 *
 * @remarks
 * Migration checksums intentionally include `up.toString()` so edits to an
 * already-applied migration fail fast on the next database open. Add a new
 * migration instead of changing an existing one.
 *
 * Migrations may opt into a stable `checksumSource` (e.g. a short DDL
 * fingerprint) so that editorial whitespace / commenting changes do not
 * invalidate checksums on existing deployments. When a `checksumSource` is
 * declared, it is preferred over the live `up.toString()` so that the
 * fingerprint matches what is currently stored in production databases.
 */
export function computeMigrationChecksum(migration: Migration): string {
  const source = migration.checksumSource ?? migration.up.toString();
  return createHash("sha256")
    .update(`${migration.version}\n${migration.name}\n${source}`)
    .digest("hex");
}

/**
 * Computes the legacy fingerprint (the value that was stored for a migration
 * before `checksumSource` support was introduced). Used by
 * {@link verifyAppliedMigrations} to detect and upgrade stored rows so that
 * adding a `checksumSource` to a migration does not block startup.
 *
 * Returns `null` when the migration has no `checksumSource` — in that case
 * the legacy and current fingerprints are identical and no upgrade is needed.
 */
export function computeLegacyMigrationChecksum(migration: Migration): string | null {
  if (migration.checksumSource === undefined) {
    return null;
  }
  return createHash("sha256")
    .update(`${migration.version}\n${migration.name}\n${migration.up.toString()}`)
    .digest("hex");
}

function verifyAppliedMigrations(
  db: Database.Database,
  appliedMigrations: Map<number, AppliedMigration>,
  migrations: Migration[]
): void {
  const migrationsByVersion = new Map(migrations.map((migration) => [migration.version, migration]));

  for (const applied of appliedMigrations.values()) {
    const migration = migrationsByVersion.get(applied.version);

    if (!migration) {
      throw new Error(
        `Applied migration ${applied.version} (${applied.name}) is not present in the migration list`
      );
    }

    const expectedChecksum = computeMigrationChecksum(migration);

    if (applied.name !== migration.name) {
      throw new Error(
        `Applied migration ${applied.version} name mismatch: expected ${migration.name}, got ${applied.name}`
      );
    }

    if (applied.checksum === null) {
      // Backfill: row predates checksum tracking
      db.prepare<[string, number]>(
        "UPDATE schema_version SET checksum = ? WHERE version = ?"
      ).run(expectedChecksum, applied.version);
      applied.checksum = expectedChecksum;
      continue;
    }

    if (applied.checksum !== expectedChecksum) {
      // Upgrade path: a migration that newly declares a `checksumSource` will
      // produce a different fingerprint than the legacy `up.toString()` value
      // already stored in production databases. When that is the cause of the
      // mismatch, transparently rewrite the stored row instead of refusing to
      // start, so deployment only requires a one-time automatic upgrade.
      const legacyChecksum = computeLegacyMigrationChecksum(migration);
      if (legacyChecksum !== null && applied.checksum === legacyChecksum) {
        db.prepare<[string, number]>(
          "UPDATE schema_version SET checksum = ? WHERE version = ?"
        ).run(expectedChecksum, applied.version);
        applied.checksum = expectedChecksum;
        continue;
      }

      throw new Error(
        `Applied migration ${applied.version} checksum mismatch; refusing to start`
      );
    }
  }
}

/**
 * Applies pending database migrations after verifying applied checksums.
 *
 * @param db - Open SQLite database handle.
 * @param migrations - Ordered migration definitions, primarily overridden by tests.
 *
 * @remarks
 * The database open path calls this synchronously before serving requests.
 * Applied migrations are verified before pending migrations run. Each pending
 * migration and its `schema_version` insert happen inside one SQLite
 * transaction, so partial DDL/DML is rolled back if the migration throws.
 */
export function runMigrations(
  db: Database.Database,
  migrations: Migration[] = MIGRATIONS
): void {
  assertMigrationsAreValid(migrations);
  ensureMigrationTable(db);

  const appliedMigrations = getAppliedMigrations(db);
  verifyAppliedMigrations(db, appliedMigrations, migrations);

  const insertApplied = db.prepare<[number, string, string, string]>(
    "INSERT INTO schema_version (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)"
  );

  for (const migration of migrations) {
    if (appliedMigrations.has(migration.version)) {
      continue;
    }

    const applyMigration = db.transaction(() => {
      migration.up(db);
      insertApplied.run(
        migration.version,
        migration.name,
        computeMigrationChecksum(migration),
        new Date().toISOString()
      );
    });

    applyMigration();
  }
}

export function getLatestSchemaVersion(): number {
  return MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
}
