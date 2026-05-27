# Database Integration Layer

> Reference documentation for the TalentTrust persistence layer.

## Overview

TalentTrust uses **SQLite** (via [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3)) as its embedded relational database. The database is opened as a singleton on application startup and all writes go through typed repository classes.

SQLite was chosen because:

- No external service is required — the database is a single file on disk.
- `better-sqlite3` provides a synchronous, zero-latency API that integrates naturally with Express.
- Tests use an in-memory database (`:memory:`) for full isolation and speed.
- The repository abstraction makes swapping to PostgreSQL straightforward in future.

---

## Configuration

| Environment variable | Default          | Description                                   |
| -------------------- | ---------------- | --------------------------------------------- |
| `DB_PATH`            | `talenttrust.db` | Absolute or relative path to the SQLite file. |

Set `DB_PATH=:memory:` to use an **in-memory** database (data is lost on process exit).

---

## Schema

### `users`

| Column       | Type | Constraints                                         |
| ------------ | ---- | --------------------------------------------------- |
| `id`         | TEXT | PRIMARY KEY (UUID v4)                               |
| `username`   | TEXT | NOT NULL, UNIQUE                                    |
| `email`      | TEXT | NOT NULL, UNIQUE                                    |
| `role`       | TEXT | NOT NULL, CHECK IN ('client', 'freelancer', 'both') |
| `created_at` | TEXT | NOT NULL (ISO-8601)                                 |

### `contracts`

| Column          | Type    | Constraints                                                              |
| --------------- | ------- | ------------------------------------------------------------------------ |
| `id`            | TEXT    | PRIMARY KEY (UUID v4)                                                    |
| `title`         | TEXT    | NOT NULL                                                                 |
| `client_id`     | TEXT    | NOT NULL, REFERENCES users(id)                                           |
| `freelancer_id` | TEXT    | NOT NULL, REFERENCES users(id)                                           |
| `amount`        | INTEGER | NOT NULL, CHECK >= 0 (stored in stroops; 1 XLM = 10,000,000 stroops)     |
| `status`        | TEXT    | NOT NULL, CHECK IN ('draft','active','completed','disputed','cancelled') |
| `version`       | INTEGER | NOT NULL, default `0`, CHECK >= 0 (optimistic concurrency control)        |
| `created_at`    | TEXT    | NOT NULL (ISO-8601)                                                      |

**Indexes**: `idx_contracts_client_id`, `idx_contracts_freelancer_id`, `idx_contracts_status`.

---

## Repository API

### `ContractRepository`

```ts
import { ContractRepository } from "./repositories/contractRepository";
const repo = new ContractRepository(getDb());
```

| Method           | Signature                              | Description                                 |
| ---------------- | -------------------------------------- | ------------------------------------------- |
| `findAll`        | `() → Contract[]`                      | All contracts, newest first                 |
| `findById`       | `(id: string) → Contract \| undefined` | Single contract by UUID                     |
| `findByClientId` | `(clientId: string) → Contract[]`      | Contracts for a client                      |
| `create`         | `(data) → Contract`                    | Insert a new contract                       |
| `updateStatus`   | `(id, status) → Contract \| undefined` | Change status field                         |
| `delete`         | `(id: string) → boolean`               | Remove contract; returns false if not found |

### `UserRepository`

```ts
import { UserRepository } from "./repositories/userRepository";
const repo = new UserRepository(getDb());
```

| Method        | Signature                             | Description                               |
| ------------- | ------------------------------------- | ----------------------------------------- |
| `findAll`     | `() → User[]`                         | All users, newest first                   |
| `findById`    | `(id: string) → User \| undefined`    | Single user by UUID                       |
| `findByEmail` | `(email: string) → User \| undefined` | Lookup by email                           |
| `create`      | `(data) → User`                       | Insert a new user                         |
| `delete`      | `(id: string) → boolean`              | Remove user; throws if FK contracts exist |

---

## Migrations

Schema migrations run automatically on startup via `runMigrations()` in `src/db/migrations.ts`.

### Versioning model

- `schema_version` table tracks each applied migration version (`INTEGER PRIMARY KEY`) and timestamp.
- Migrations are ordered, immutable, and sequential (`1..N`).
- Startup applies only missing versions, making reruns idempotent and safe for repeated deploys.

### Safety guarantees

- Each migration runs inside a SQLite transaction.
- If a migration throws, SQLite rolls back that migration's partial changes.
- Failed migrations are not recorded in `schema_version`, so recovery is deterministic.

### Rollback plan

- For urgent rollback to previous app code, restore a DB snapshot made before deployment.
- Because migrations are additive and idempotent, redeploying the fixed build safely resumes from the last applied version.
- Keep migration files immutable; create a new migration to correct prior schema changes instead of editing old ones.

---

## WAL Mode Tradeoffs

SQLite is configured with **WAL (Write-Ahead Logging)** journal mode and `synchronous=NORMAL` for optimal concurrency and performance.

### Configuration

| Pragma | Setting | Description |
|--------|---------|-------------|
| `journal_mode` | `WAL` | Enables write-ahead logging for better concurrent read/write |
| `synchronous` | `NORMAL` | Reduces fsync calls; safe with WAL mode |
| `busy_timeout` | `5000` (configurable via `DB_BUSY_TIMEOUT`) | Wait time in ms before throwing SQLITE_BUSY |

### Durability vs Performance

**WAL mode benefits:**
- Readers don't block writers and writers don't block readers
- Better concurrency for read-heavy workloads typical in API servers
- Reduced disk I/O due to batching of commits

**Tradeoffs:**
- **Durability**: With `synchronous=NORMAL`, SQLite may lose the last few transactions if the OS crashes (but not if only the application crashes). The WAL file is synced at checkpoints.
- **Extra files**: Creates `-wal` and `-shm` files alongside the database file
- **Network filesystems**: WAL mode may not work reliably on NFS or network shares

### When to use FULL synchronous

For mission-critical deployments where every transaction must survive OS crashes, set `synchronous=FULL` at the cost of:
- Higher latency per write (additional fsync calls)
- Lower write throughput under heavy load

To change:
```typescript
// In database.ts, after opening connection:
instance.pragma("synchronous = FULL");
```

### busy_timeout

When multiple processes access the database, SQLite may return `SQLITE_BUSY`. The `busy_timeout` pragma makes SQLite wait and retry before failing:

- Default: `5000` ms (5 seconds)
- Override via environment: `DB_BUSY_TIMEOUT=10000`
- Set to `0` to fail immediately on contention

---

## Security Notes

| Concern           | Mitigation                                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
| SQL injection     | All queries use `better-sqlite3` **prepared statements** with parameter binding — no string interpolation. |
| CHECK constraints | `status` and `role` columns are validated at the DB level as a second line of defence.                     |
| FK enforcement    | `PRAGMA foreign_keys = ON` is set on every connection to prevent orphaned records.                         |
| File permissions  | In production, restrict the DB file: `chmod 600 talenttrust.db`.                                           |
| Credentials       | No passwords are stored. Authentication is delegated to Stellar key-based or third-party auth.             |

---

## Testing

Tests use an in-memory SQLite database injected at construction time:

```bash
npm test -- --coverage
```

Expected coverage ≥ 95 % on all `src/db/*` and `src/repositories/*` modules.
