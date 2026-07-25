import { SorobanRpcService } from '../SorobanRpcService';
import * as StellarSdk from '@stellar/stellar-sdk';
import { rpc } from '@stellar/stellar-sdk';

const mockGetLedgerEntries = jest.fn();
const mockSimulateTransaction = jest.fn();
const mockSendTransaction = jest.fn();
const mockGetTransaction = jest.fn();
const mockGetEvents = jest.fn();
const mockGetLatestLedger = jest.fn();

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
          getEvents: mockGetEvents,
          getLatestLedger: mockGetLatestLedger,
        };
      }),
    },
  };
});

jest.mock('../../../sorobanEnv', () => {
  const actual = jest.requireActual('../../../sorobanEnv');
  return {
    ...actual,
    sorobanEnv: {
      ...actual.sorobanEnv,
      sorobanRpcRetryAttempts: 5,
      sorobanRpcRetryBaseDelayMs: 1, // 1ms delay to speed up tests
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

    it('should retry on transient failures and throw final error when retries are exhausted', async () => {
      mockGetLedgerEntries.mockRejectedValue(new Error('Network Error'));

      const contractId = 'CCJZ5DGASBWQXR5MPFCJXMBI333XE5U3FSJTNQU7RIKE3P5GN2K2WYD5';
      const key = StellarSdk.xdr.ScVal.scvSymbol('Test');

      await expect(service.getContractData(contractId, key)).rejects.toThrow('Network Error');
      // Should retry up to maxAttempts (default 5 in our extended config)
      expect(mockGetLedgerEntries).toHaveBeenCalledTimes(5);
    });

    it('should succeed if a transient error is resolved on subsequent attempts', async () => {
      const mockEntry = { key: 'mockKey', val: 'mockVal' };
      mockGetLedgerEntries
        .mockRejectedValueOnce(new Error('Transient Error 1'))
        .mockRejectedValueOnce(new Error('Transient Error 2'))
        .mockResolvedValueOnce({
          entries: [mockEntry],
        });

      const contractId = 'CCJZ5DGASBWQXR5MPFCJXMBI333XE5U3FSJTNQU7RIKE3P5GN2K2WYD5';
      const key = StellarSdk.xdr.ScVal.scvSymbol('Test');

      const result = await service.getContractData(contractId, key);
      expect(result).toEqual(mockEntry);
      expect(mockGetLedgerEntries).toHaveBeenCalledTimes(3);
    });
  });

  describe('getLatestLedger', () => {
    it('should return the latest ledger info', async () => {
      const mockResponse = { id: 'ledger', sequence: 1234, protocolVersion: '22' };
      mockGetLatestLedger.mockResolvedValue(mockResponse);

      const result = await service.getLatestLedger();
      expect(result).toEqual(mockResponse);
      expect(mockGetLatestLedger).toHaveBeenCalledTimes(1);
    });

    it('should retry on failure and throw if all attempts fail', async () => {
      mockGetLatestLedger.mockRejectedValue(new Error('Ledger Error'));
      await expect(service.getLatestLedger()).rejects.toThrow('Ledger Error');
      expect(mockGetLatestLedger).toHaveBeenCalledTimes(5);
    });
  });

  describe('getEvents', () => {
    it('should return events for the given request', async () => {
      const mockResponse = { latestLedger: 10, events: [], cursor: '' };
      mockGetEvents.mockResolvedValue(mockResponse);

      const request = { filters: [{ type: 'contract' as const }], startLedger: 1 };
      const result = await service.getEvents(request);
      expect(result).toEqual(mockResponse);
      expect(mockGetEvents).toHaveBeenCalledWith(request);
    });

    it('should retry on failure and throw if all attempts fail', async () => {
      mockGetEvents.mockRejectedValue(new Error('Events Error'));
      const request = { filters: [{ type: 'contract' as const }], startLedger: 1 };
      await expect(service.getEvents(request)).rejects.toThrow('Events Error');
      expect(mockGetEvents).toHaveBeenCalledTimes(5);
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

    it('should retry on failure and throw if all attempts fail', async () => {
      mockSimulateTransaction.mockRejectedValue(new Error('Sim Error'));
      const tx = {} as StellarSdk.Transaction;

      await expect(service.simulateTransaction(tx)).rejects.toThrow('Sim Error');
      expect(mockSimulateTransaction).toHaveBeenCalledTimes(5);
    });
  });

  describe('sendTransaction', () => {
    it('should submit transaction and return response and NOT retry on failure', async () => {
      const mockResponse = { status: 'PENDING' };
      mockSendTransaction.mockResolvedValue(mockResponse);

      const tx = {} as StellarSdk.Transaction;
      const result = await service.sendTransaction(tx);
      expect(result).toEqual(mockResponse);
      expect(mockSendTransaction).toHaveBeenCalledWith(tx);
      expect(mockSendTransaction).toHaveBeenCalledTimes(1);
    });

    it('should throw immediately and NOT retry if submit fails', async () => {
      mockSendTransaction.mockRejectedValue(new Error('Submit Error'));
      const tx = {} as StellarSdk.Transaction;

      await expect(service.sendTransaction(tx)).rejects.toThrow('Submit Error');
      expect(mockSendTransaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('getTransactionStatus', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('should return the transaction status when found', async () => {
      const mockResponse = { status: rpc.Api.GetTransactionStatus.SUCCESS };
      mockGetTransaction.mockResolvedValue(mockResponse);

      const result = await service.getTransactionStatus('testhash', 1000, 10);
      expect(result).toEqual(mockResponse);
      expect(mockGetTransaction).toHaveBeenCalledWith('testhash');
    });

    it('should poll until timeout if status is NOT_FOUND and retry inner call if it fails', async () => {
      mockGetTransaction.mockResolvedValue({
        status: rpc.Api.GetTransactionStatus.NOT_FOUND,
      });

      // Control Date.now() so the loop runs 3 times then times out — no real waiting.
      const base = 1_000_000;
      jest.spyOn(Date, 'now')
        .mockReturnValueOnce(base)        // startTime assignment
        .mockReturnValueOnce(base)        // while check #1 — 0 ms elapsed
        .mockReturnValueOnce(base + 20)   // while check #2 — 20 ms elapsed
        .mockReturnValueOnce(base + 40)   // while check #3 — 40 ms elapsed
        .mockReturnValue(base + 100);     // while check #4 — 100 ms elapsed → timeout

      await expect(service.getTransactionStatus('testhash', 50, 1)).rejects.toThrow(
        /Transaction polling timed out/
      );
      expect(mockGetTransaction.mock.calls.length).toBeGreaterThan(1);
    });

    it('should retry the inner getTransaction call on transient RPC failure', async () => {
      mockGetTransaction
        .mockRejectedValueOnce(new Error('Transient RPC Error 1'))
        .mockRejectedValueOnce(new Error('Transient RPC Error 2'))
        .mockResolvedValueOnce({ status: rpc.Api.GetTransactionStatus.SUCCESS });

      const result = await service.getTransactionStatus('testhash', 1000, 10);
      expect(result).toEqual({ status: rpc.Api.GetTransactionStatus.SUCCESS });
      expect(mockGetTransaction).toHaveBeenCalledTimes(3);
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
