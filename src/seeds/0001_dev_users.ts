/**
 * @seed 0001_dev_users
 * @description Seeds deterministic development users for local development
 * and integration testing.
 *
 * All users have fixed, well-known UUIDs so that other seeds and tests can
 * reference them without dynamic lookups.
 *
 * ## Security Notes
 * - These users must NEVER be seeded in production.
 * - Stellar addresses used here are test network addresses only.
 * - INSERT uses ON CONFLICT DO NOTHING for idempotency.
 */

import { PoolClient } from 'pg';

export const id = '0001_dev_users';
export const description = 'Seed deterministic development users';

// Well-known UUIDs for stable cross-seed references
export const DEV_USER_IDS = {
  adminUser:      '00000000-0000-0000-0000-000000000001',
  clientUser:     '00000000-0000-0000-0000-000000000002',
  freelancerUser: '00000000-0000-0000-0000-000000000003',
};

export async function run(client: PoolClient): Promise<void> {
  const users = [
    {
      id:              DEV_USER_IDS.adminUser,
      stellar_address: 'GADMIN000000000000000000000000000000000000000000000000000',
      display_name:    'Dev Admin',
      role:            'admin',
    },
    {
      id:              DEV_USER_IDS.clientUser,
      stellar_address: 'GCLIENT00000000000000000000000000000000000000000000000000',
      display_name:    'Dev Client',
      role:            'client',
    },
    {
      id:              DEV_USER_IDS.freelancerUser,
      stellar_address: 'GFREELA00000000000000000000000000000000000000000000000000',
      display_name:    'Dev Freelancer',
      role:            'freelancer',
    },
  ];

  for (const user of users) {
    await client.query(
      `INSERT INTO users (id, stellar_address, display_name, role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [user.id, user.stellar_address, user.display_name, user.role],
    );

    // Initialise reputation record for each user
    await client.query(
      `INSERT INTO reputation (user_id, score, total_jobs)
       VALUES ($1, 0.00, 0)
       ON CONFLICT (user_id) DO NOTHING`,
      [user.id],
    );
  }
}
