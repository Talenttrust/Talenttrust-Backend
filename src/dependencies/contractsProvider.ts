import { Contract } from '../types/contracts';

export interface ContractsProvider {
  listContracts(): Promise<Contract[]>;
}

/**
 * Default provider used by the API. In production this can be replaced with an upstream client.
 */
export class DefaultContractsProvider implements ContractsProvider {
  async listContracts(): Promise<Contract[]> {
    return [];
  }
}
