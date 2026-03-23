import { randomUUID } from 'crypto';

import { ApiError } from '../errors/ApiError';
import type { ContractRecord, CreateContractInput } from '../types/contract';

/**
 * @notice Small in-memory contract service used by the API layer and tests.
 * @dev The service intentionally keeps state isolated per app instance so
 *      integration tests remain deterministic and do not require a database.
 */
export class ContractService {
  private readonly contracts: ContractRecord[];

  /**
   * @param seedContracts Optional initial contract records for deterministic tests.
   */
  constructor(seedContracts: ContractRecord[] = []) {
    this.contracts = [...seedContracts];
  }

  /**
   * @notice Return all known contract records.
   */
  listContracts(): ContractRecord[] {
    return [...this.contracts];
  }

  /**
   * @notice Look up a contract by id.
   * @param id Contract identifier.
   * @returns The matching contract when present.
   */
  getContractById(id: string): ContractRecord | undefined {
    return this.contracts.find((contract) => contract.id === id);
  }

  /**
   * @notice Create a new contract after validating uniqueness and business rules.
   * @param input Proposed contract payload.
   * @returns The created contract record.
   */
  createContract(input: CreateContractInput): ContractRecord {
    if (input.clientId === input.freelancerId) {
      throw new ApiError(403, 'Client and freelancer must be different accounts.');
    }

    const duplicate = this.contracts.find(
      (contract) =>
        contract.title.toLowerCase() === input.title.toLowerCase() &&
        contract.clientId === input.clientId &&
        contract.freelancerId === input.freelancerId,
    );

    if (duplicate) {
      throw new ApiError(409, 'A contract with the same participants and title already exists.');
    }

    const created: ContractRecord = {
      id: randomUUID(),
      title: input.title,
      clientId: input.clientId,
      freelancerId: input.freelancerId,
      budget: input.budget,
      currency: input.currency,
      createdAt: new Date().toISOString(),
    };

    this.contracts.push(created);
    return created;
  }
}
