/**
 * @migration 0001_initial_schema
 * @description Creates the initial TalentTrust database schema.
 *
 * Tables created:
 * - users         — platform participants (freelancers & clients)
 * - contracts     — escrow contract metadata linked to Stellar/Soroban
 * - reputation    — on-chain reputation scores per user
 *
 * ## Security Notes
 * - UUIDs are used as primary keys to prevent enumeration attacks.
 * - stellar_address is stored as TEXT and validated at application layer.
 * - Timestamps are stored in UTC (TIMESTAMPTZ).
 */

import { PoolClient } from 'pg';

export const id = '0001_initial_schema';

export async function up(client: PoolClient): Promise<void> {
  // Enable UUID generation
  await client.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

  // Users table
  await client.query(`
    CREATE TABLE IF NOT EXISTS users (
      id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      stellar_address  TEXT        UNIQUE NOT NULL,
      display_name     TEXT        NOT NULL,
      role             TEXT        NOT NULL CHECK (role IN ('freelancer', 'client', 'admin')),
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_users_stellar_address ON users (stellar_address)
  `);

  // Contracts table
  await client.query(`
    CREATE TABLE IF NOT EXISTS contracts (
      id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      soroban_contract_id TEXT        UNIQUE NOT NULL,
      client_id           UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      freelancer_id       UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      title               TEXT        NOT NULL,
      description         TEXT,
      amount_xlm          NUMERIC(20, 7) NOT NULL CHECK (amount_xlm > 0),
      status              TEXT        NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'active', 'completed', 'disputed', 'cancelled')),
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_contracts_client_id     ON contracts (client_id)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_contracts_freelancer_id ON contracts (freelancer_id)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_contracts_status        ON contracts (status)
  `);

  // Reputation table
  await client.query(`
    CREATE TABLE IF NOT EXISTS reputation (
      id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id     UUID        UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      score       NUMERIC(5,2) NOT NULL DEFAULT 0.00 CHECK (score >= 0 AND score <= 100),
      total_jobs  INTEGER     NOT NULL DEFAULT 0 CHECK (total_jobs >= 0),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_reputation_user_id ON reputation (user_id)
  `);
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`DROP TABLE IF EXISTS reputation`);
  await client.query(`DROP TABLE IF EXISTS contracts`);
  await client.query(`DROP TABLE IF EXISTS users`);
}
