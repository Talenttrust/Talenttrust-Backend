import type { Response } from 'express';
import { ContractsService } from './contracts.service';
import type { ContractRepository } from './contracts.repository';
import type { ContractsRpcClient } from './contracts.rpc';

describe('ContractsService', () => {
  it('returns contracts and writes rpc health headers', async () => {
    const repository: ContractRepository = {
      listContracts: jest.fn().mockResolvedValue([{ id: 'c1', status: 'active' }]),
    };
    const rpcClient: ContractsRpcClient = {
      fetchRegistryHealth: jest
        .fn()
        .mockResolvedValue({ network: 'testnet', healthy: true }),
    };
    const service = new ContractsService(repository, rpcClient);
    const setHeader = jest.fn();
    const response = {
      setHeader,
    } as unknown as Response;

    const result = await service.listContracts(response);

    expect(result).toEqual({ contracts: [{ id: 'c1', status: 'active' }] });
    expect(setHeader).toHaveBeenCalledWith('x-rpc-network', 'testnet');
    expect(setHeader).toHaveBeenCalledWith('x-rpc-healthy', 'true');
  });
});
