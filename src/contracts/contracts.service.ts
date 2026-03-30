import type { Response } from 'express';
import type { ContractRepository } from './contracts.repository';
import type { ContractsRpcClient } from './contracts.rpc';

export class ContractsService {
  constructor(
    private readonly repository: ContractRepository,
    private readonly rpcClient: ContractsRpcClient,
  ) {}

  async listContracts(response?: Response): Promise<{ contracts: unknown[] }> {
    const [contracts, rpcStatus] = await Promise.all([
      this.repository.listContracts(),
      this.rpcClient.fetchRegistryHealth(),
    ]);

    if (response) {
      response.setHeader('x-rpc-network', rpcStatus.network);
      response.setHeader('x-rpc-healthy', String(rpcStatus.healthy));
    }

    return { contracts };
  }
}
