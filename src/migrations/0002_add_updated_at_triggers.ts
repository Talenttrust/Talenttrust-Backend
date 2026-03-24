/**
 * @migration 0002_add_updated_at_triggers
 * @description Adds a Postgres trigger to auto-update the `updated_at`
 * column on every UPDATE for the users and contracts tables.
 *
 * ## Why a trigger?
 * Relying on application code to set `updated_at` is error-prone — a direct
 * SQL UPDATE bypassing the ORM would silently leave the column stale.
 * The trigger guarantees correctness at the database level.
 */

import { PoolClient } from 'pg';

export const id = '0002_add_updated_at_triggers';

export async function up(client: PoolClient): Promise<void> {
  // Create reusable trigger function
  await client.query(`
    CREATE OR REPLACE FUNCTION set_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);

  // Attach to users
  await client.query(`
    DROP TRIGGER IF EXISTS trg_users_updated_at ON users
  `);
  await client.query(`
    CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at()
  `);

  // Attach to contracts
  await client.query(`
    DROP TRIGGER IF EXISTS trg_contracts_updated_at ON contracts
  `);
  await client.query(`
    CREATE TRIGGER trg_contracts_updated_at
    BEFORE UPDATE ON contracts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at()
  `);
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`DROP TRIGGER IF EXISTS trg_contracts_updated_at ON contracts`);
  await client.query(`DROP TRIGGER IF EXISTS trg_users_updated_at ON users`);
  await client.query(`DROP FUNCTION IF EXISTS set_updated_at()`);
}
