import { SorobanRpcService } from '../SorobanRpcService';
import * as StellarSdk from '@stellar/stellar-sdk';
import { rpc } from '@stellar/stellar-sdk';

const mockGetLedgerEntries = jest.fn();
const mockSimulateTransaction = jest.fn();
const mockSendTransaction = jest.fn();
const mockGetTransaction = jest.fn();

jest.mock('@stellar/stellar-sdk', () => {
  const actualStellarSdk = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...actualStellarSdk,
    rpc: {
      ...actualStellarSdk.rpc,
      Server: jest.fn().mockImplementation(() => {
        return {
          getLedgerEntries: mockGetLedgerEntries,
          simulateTransaction: mockSimulateTransaction,
          sendTransaction: mockSendTransaction,
          getTransaction: mockGetTransaction,
        };
      }),
    },
  };
});

describe('SorobanRpcService', () => {
  let service: SorobanRpcService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new SorobanRpcService('http://mocked-rpc-url');
  });

  describe('getContractData', () => {
    it('should return contract data if it exists', async () => {
      const mockEntry = { key: 'mockKey', val: 'mockVal' };
      mockGetLedgerEntries.mockResolvedValue({
        entries: [mockEntry],
      });

      const contractId = 'CCJZ5DGASBWQXR5MPFCJXMBI333XE5U3FSJTNQU7RIKE3P5GN2K2WYD5';
      const key = StellarSdk.xdr.ScVal.scvSymbol('Test');

      const result = await service.getContractData(contractId, key);
      expect(result).toEqual(mockEntry);
      expect(mockGetLedgerEntries).toHaveBeenCalledTimes(1);
    });

    it('should return undefined if no entries are found', async () => {
      mockGetLedgerEntries.mockResolvedValue({
        entries: [],
      });

      const contractId = 'CCJZ5DGASBWQXR5MPFCJXMBI333XE5U3FSJTNQU7RIKE3P5GN2K2WYD5';
      const key = StellarSdk.xdr.ScVal.scvSymbol('Test');

      const result = await service.getContractData(contractId, key);
      expect(result).toBeUndefined();
    });

    it('should throw an error if getLedgerEntries fails', async () => {
      mockGetLedgerEntries.mockRejectedValue(new Error('Network Error'));

      const contractId = 'CCJZ5DGASBWQXR5MPFCJXMBI333XE5U3FSJTNQU7RIKE3P5GN2K2WYD5';
      const key = StellarSdk.xdr.ScVal.scvSymbol('Test');

      await expect(service.getContractData(contractId, key)).rejects.toThrow('Network Error');
    });
  });

  describe('simulateTransaction', () => {
    it('should return simulation response', async () => {
      const mockResponse = { results: [] };
      mockSimulateTransaction.mockResolvedValue(mockResponse);

      const tx = {} as StellarSdk.Transaction;
      const result = await service.simulateTransaction(tx);
      expect(result).toEqual(mockResponse);
      expect(mockSimulateTransaction).toHaveBeenCalledWith(tx);
    });

    it('should throw an error if simulation fails', async () => {
      mockSimulateTransaction.mockRejectedValue(new Error('Sim Error'));
      const tx = {} as StellarSdk.Transaction;

      await expect(service.simulateTransaction(tx)).rejects.toThrow('Sim Error');
    });
  });

  describe('sendTransaction', () => {
    it('should submit transaction and return response', async () => {
      const mockResponse = { status: 'PENDING' };
      mockSendTransaction.mockResolvedValue(mockResponse);

      const tx = {} as StellarSdk.Transaction;
      const result = await service.sendTransaction(tx);
      expect(result).toEqual(mockResponse);
      expect(mockSendTransaction).toHaveBeenCalledWith(tx);
    });

    it('should throw an error if submit fails', async () => {
      mockSendTransaction.mockRejectedValue(new Error('Submit Error'));
      const tx = {} as StellarSdk.Transaction;

      await expect(service.sendTransaction(tx)).rejects.toThrow('Submit Error');
    });
  });

  describe('getTransactionStatus', () => {
    it('should return the transaction status when found', async () => {
      const mockResponse = { status: rpc.Api.GetTransactionStatus.SUCCESS };
      mockGetTransaction.mockResolvedValue(mockResponse);

      const result = await service.getTransactionStatus('testhash', 1000, 10);
      expect(result).toEqual(mockResponse);
      expect(mockGetTransaction).toHaveBeenCalledWith('testhash');
    });

    it('should poll until timeout if status is NOT_FOUND', async () => {
      mockGetTransaction.mockResolvedValue({
        status: rpc.Api.GetTransactionStatus.NOT_FOUND,
      });

      await expect(service.getTransactionStatus('testhash', 50, 10)).rejects.toThrow(
        /Transaction polling timed out/
      );
      expect(mockGetTransaction.mock.calls.length).toBeGreaterThan(1);
    });

    it('should resolve if it becomes found after a few polls', async () => {
      mockGetTransaction
        .mockResolvedValueOnce({ status: rpc.Api.GetTransactionStatus.NOT_FOUND })
        .mockResolvedValueOnce({ status: rpc.Api.GetTransactionStatus.NOT_FOUND })
        .mockResolvedValueOnce({ status: rpc.Api.GetTransactionStatus.SUCCESS });

      const result = await service.getTransactionStatus('testhash', 1000, 10);
      expect(result).toEqual({ status: rpc.Api.GetTransactionStatus.SUCCESS });
      expect(mockGetTransaction).toHaveBeenCalledTimes(3);
    });
  });
});
