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

Schema is applied automatically via `runMigrations()` inside `database.ts` on every startup. All statements use `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` so re-runs are **idempotent**.

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
