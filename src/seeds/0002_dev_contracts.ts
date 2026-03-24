/**
 * @seed 0002_dev_contracts
 * @description Seeds deterministic development contracts for local development
 * and integration testing.
 *
 * Depends on: 0001_dev_users (references DEV_USER_IDS)
 *
 * ## Security Notes
 * - Must NEVER run in production.
 * - Soroban contract IDs used here are placeholder test values only.
 */

import { PoolClient } from 'pg';
import { DEV_USER_IDS } from './0001_dev_users';

export const id = '0002_dev_contracts';
export const description = 'Seed deterministic development contracts';

export const DEV_CONTRACT_IDS = {
  pendingContract:   '00000000-0000-0000-0001-000000000001',
  activeContract:    '00000000-0000-0000-0001-000000000002',
  completedContract: '00000000-0000-0000-0001-000000000003',
};

export async function run(client: PoolClient): Promise<void> {
  const contracts = [
    {
      id:                  DEV_CONTRACT_IDS.pendingContract,
      soroban_contract_id: 'CTEST_PENDING_000000000000000000000000000000000000000000000',
      client_id:           DEV_USER_IDS.clientUser,
      freelancer_id:       DEV_USER_IDS.freelancerUser,
      title:               'Build Stellar Wallet UI',
      description:         'Design and implement a web wallet for the TalentTrust platform.',
      amount_xlm:          500.0000000,
      status:              'pending',
    },
    {
      id:                  DEV_CONTRACT_IDS.activeContract,
      soroban_contract_id: 'CTEST_ACTIVE_0000000000000000000000000000000000000000000000',
      client_id:           DEV_USER_IDS.clientUser,
      freelancer_id:       DEV_USER_IDS.freelancerUser,
      title:               'Smart Contract Audit',
      description:         'Security audit of escrow Soroban contracts.',
      amount_xlm:          1200.0000000,
      status:              'active',
    },
    {
      id:                  DEV_CONTRACT_IDS.completedContract,
      soroban_contract_id: 'CTEST_COMPLETE_000000000000000000000000000000000000000000000',
      client_id:           DEV_USER_IDS.clientUser,
      freelancer_id:       DEV_USER_IDS.freelancerUser,
      title:               'API Integration',
      description:         'REST API integration with Horizon and Soroban RPC.',
      amount_xlm:          300.0000000,
      status:              'completed',
    },
  ];

  for (const contract of contracts) {
    await client.query(
      `INSERT INTO contracts
         (id, soroban_contract_id, client_id, freelancer_id, title, description, amount_xlm, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO NOTHING`,
      [
        contract.id,
        contract.soroban_contract_id,
        contract.client_id,
        contract.freelancer_id,
        contract.title,
        contract.description,
        contract.amount_xlm,
        contract.status,
      ],
    );
  }
}
