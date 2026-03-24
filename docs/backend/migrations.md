# Database Migrations

## Overview

TalentTrust uses a custom, lightweight migration runner built on top of the `pg`
library. It is intentionally minimal — no heavy ORM, no magic, just plain SQL
inside TypeScript functions.

## Design Principles

- **Deterministic**: Migrations run in lexicographic filename order every time.
- **Idempotent**: The `schema_migrations` tracking table prevents re-applying
  completed migrations.
- **Atomic**: Each migration runs inside a `BEGIN / COMMIT` transaction. A
  failure triggers `ROLLBACK`, leaving the database in its pre-migration state.
- **Safe for concurrent deployments**: A Postgres advisory lock
  (`pg_advisory_xact_lock`) ensures only one migration runner executes at a time
  across multiple application instances.

## schema_migrations Table

```sql
CREATE TABLE schema_migrations (
  id          TEXT        PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  checksum    TEXT        NOT NULL
);
```

- `id` — migration filename without extension (e.g. `0001_initial_schema`)
- `applied_at` — when the migration was applied
- `checksum` — lightweight fingerprint of the `up` function body; used to
  detect accidental edits to applied migrations

## Migration File Structure

```typescript
import { PoolClient } from 'pg';

export const id = '0001_initial_schema'; // must match filename

export async function up(client: PoolClient): Promise<void> {
  // Apply changes
  await client.query(`CREATE TABLE ...`);
}

export async function down(client: PoolClient): Promise<void> {
  // Revert changes (optional but recommended)
  await client.query(`DROP TABLE ...`);
}
```

## Rollback

Rollback is supported via the `rollbackMigrations(steps)` function.  
It reverses the last N migrations by calling their `down` function in
reverse order and removing the corresponding rows from `schema_migrations`.

> ⚠️ A migration without a `down` export cannot be rolled back — the runner
> will throw rather than leave the database in a partial state.

## Security Notes

- Never modify a migration that has already been applied to any shared
  environment (staging, production). Instead, write a new migration that
  reverses or alters the previous change.
- The checksum field will detect accidental edits but is not a cryptographic
  guarantee — treat it as a developer aid, not a security control.
- Migration SQL should use parameterised queries for any runtime values.
- The advisory lock key is derived from `hashtext('schema_migrations')` and
  is scoped to the current database — it will not interfere with other
  databases on the same Postgres instance.

## Running Migrations

### Via npm script (local/CI)
```bash
npm run migrate
```

### Via Admin API (runtime)
```bash
curl -X POST \
  -H "x-admin-secret: $ADMIN_SECRET" \
  http://localhost:3001/admin/migrations/run
```

### Programmatically
```typescript
import { runMigrations } from './db/migrator';

const applied = await runMigrations({ verbose: true });
console.log('Applied:', applied);
```
