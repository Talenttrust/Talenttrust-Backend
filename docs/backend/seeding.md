# Seed Data Management

## Overview

TalentTrust uses a deterministic seed data system for populating development
and test databases with well-known, stable data. Seeds are plain TypeScript
files that use standard SQL `INSERT … ON CONFLICT DO NOTHING` for idempotency.

## Design Principles

- **Deterministic**: Fixed UUIDs and values mean seeds produce identical results
  on every run and in every environment.
- **Idempotent**: Re-running seeds never duplicates data.
- **Environment-scoped**: The `seed_history` table records which environment
  each seed was applied in. Dev seeds don't leak into test history.
- **Production-safe**: Seeds are blocked in production by default. The override
  flag `ALLOW_PRODUCTION_SEED=true` must be explicitly set.

## seed_history Table

```sql
CREATE TABLE seed_history (
  id          TEXT        NOT NULL,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  environment TEXT        NOT NULL,
  PRIMARY KEY (id, environment)
);
```

## Seed File Structure

```typescript
import { PoolClient } from 'pg';

export const id = '0001_dev_users';          // must match filename
export const description = 'Seed dev users'; // human-readable label

export async function run(client: PoolClient): Promise<void> {
  await client.query(`
    INSERT INTO users (id, stellar_address, display_name, role)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (id) DO NOTHING
  `, ['...', '...', '...', '...']);
}
```

## Well-Known Dev UUIDs

Seeds use fixed UUIDs so that downstream seeds and tests can reference them
without dynamic lookups:

| Constant            | UUID                                   | Description     |
|---------------------|----------------------------------------|-----------------|
| `DEV_USER_IDS.adminUser`      | `00000000-0000-0000-0000-000000000001` | Admin user    |
| `DEV_USER_IDS.clientUser`     | `00000000-0000-0000-0000-000000000002` | Client user   |
| `DEV_USER_IDS.freelancerUser` | `00000000-0000-0000-0000-000000000003` | Freelancer    |

## Force Re-seeding

To reset a development database to its known seeded state:

```typescript
import { runSeeds } from './db/seeder';

await runSeeds({ force: true, environment: 'development' });
```

Or via the API:
```bash
# Currently only non-forced run is exposed via API.
# Force re-seed from CLI or a dedicated admin script.
```

## Security Notes

- Never use real user data, real Stellar addresses, or real credentials in seed files.
- All seed SQL must use parameterised queries.
- Seeds must never be run in production without explicit opt-in
  (`ALLOW_PRODUCTION_SEED=true`).
- Seed files are committed to version control — treat them as public documents.

## Running Seeds

### Via npm script (local)
```bash
npm run seed
```

### Via Admin API (runtime)
```bash
curl -X POST \
  -H "x-admin-secret: $ADMIN_SECRET" \
  http://localhost:3001/admin/seeds/run
```

### Programmatically
```typescript
import { runSeeds } from './db/seeder';

const applied = await runSeeds({ verbose: true, environment: 'development' });
console.log('Applied:', applied);
```
