import * as StellarSdk from '@stellar/stellar-sdk';
import { config, NETWORK_PASSPHRASES } from '../src/config';
import { defaultRpcReader, PauseGuard } from '../src/pauseGuard';
import { SorobanRpcChainReader } from '../src/chain';
import { ContractReader, RpcTransport } from '../src/stellar/rpc';
import { buildEscrowTransaction } from '../src/stellar/escrowTxBuilder';
import { HealthService, HealthRpcClient } from '../src/health';
import { EscrowStore } from '../src/store';

const CONTRACT_ID = 'CCZMIVUBMG5SBC47SDTC32RWLBJ2HW2DCFVWJEOKCH2IFJBZGBKTXK5W';
const SOURCE_ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

describe('Soroban network passphrase uniformity (#1682)', () => {
  const originalNetwork = process.env.STELLAR_NETWORK;
  const originalPassphrase = process.env.STELLAR_NETWORK_PASSPHRASE;

  afterEach(() => {
    if (originalNetwork === undefined) delete process.env.STELLAR_NETWORK;
    else process.env.STELLAR_NETWORK = originalNetwork;
    if (originalPassphrase === undefined) delete process.env.STELLAR_NETWORK_PASSPHRASE;
    else process.env.STELLAR_NETWORK_PASSPHRASE = originalPassphrase;
    jest.restoreAllMocks();
  });

  describe('STELLAR_NETWORK=futurenet', () => {
    const expectedPassphrase = NETWORK_PASSPHRASES.futurenet;

    beforeEach(() => {
      process.env.STELLAR_NETWORK = 'futurenet';
      delete process.env.STELLAR_NETWORK_PASSPHRASE;
    });

    it('derives futurenet passphrase in config.networkPassphrase', () => {
      expect(config.network).toBe('futurenet');
      expect(config.networkPassphrase).toBe(expectedPassphrase);
    });

    it('uses futurenet passphrase in pause guard defaultRpcReader', async () => {
      let capturedTx: any;
      const server = {
        simulateTransaction: jest.fn().mockImplementation((tx) => {
          capturedTx = tx;
          return Promise.resolve({ result: { retval: StellarSdk.nativeToScVal(false) } });
        }),
      };

      await defaultRpcReader(undefined, server);
      expect(capturedTx.networkPassphrase).toBe(expectedPassphrase);
    });

    it('uses futurenet passphrase in chain read (ContractReader & SorobanRpcChainReader)', async () => {
      const capturedSimulations: StellarSdk.Transaction[] = [];
      const transport: RpcTransport = {
        simulateTransaction: async (tx) => {
          capturedSimulations.push(tx);
          return {
            _parsed: true,
            id: 'sim',
            latestLedger: 100,
            events: [],
            minResourceFee: '100',
            transactionData: new StellarSdk.SorobanDataBuilder(),
            result: { auth: [], retval: StellarSdk.nativeToScVal(1) },
          } as any;
        },
        getLatestLedger: async () => ({ sequence: 100 }),
      };

      const reader = new ContractReader({
        rpcUrl: 'https://example.invalid',
        contractId: CONTRACT_ID,
        transport,
      });
      await reader.simulateRead('version');
      expect(capturedSimulations[0].networkPassphrase).toBe(expectedPassphrase);

      const chainReader = new SorobanRpcChainReader(
        'https://example.invalid',
        CONTRACT_ID,
        undefined,
        transport,
      );
      await chainReader.getContract('1');
      expect(capturedSimulations[1].networkPassphrase).toBe(expectedPassphrase);
    });

    it('uses futurenet passphrase in health service', async () => {
      let queriedPassphrase = '';
      const rpc: HealthRpcClient = {
        getHealth: async () => 'healthy',
        getNetworkPassphrase: async () => {
          queriedPassphrase = expectedPassphrase;
          return expectedPassphrase;
        },
        hasContractInstance: async () => true,
      };

      const health = new HealthService({
        store: new EscrowStore(),
        rpc,
      });

      const res = await health.ready();
      expect(res.httpStatus).toBe(200);
      expect(res.report.checks.network.status).toBe('pass');
      expect(queriedPassphrase).toBe(expectedPassphrase);
    });

    it('uses futurenet passphrase in escrow transaction builder', async () => {
      const server = {
        getAccount: jest.fn().mockResolvedValue(new StellarSdk.Account(SOURCE_ACCOUNT, '1')),
        simulateTransaction: jest.fn().mockResolvedValue({
          _parsed: true,
          latestLedger: 100,
          events: [],
          minResourceFee: '100',
          transactionData: new StellarSdk.SorobanDataBuilder(),
          result: {
            auth: [
              new StellarSdk.xdr.SorobanAuthorizationEntry({
                credentials: StellarSdk.xdr.SorobanCredentials.sorobanCredentialsAddress(
                  new StellarSdk.xdr.SorobanAddressCredentials({
                    address: StellarSdk.Address.fromString(SOURCE_ACCOUNT).toScAddress(),
                    nonce: StellarSdk.xdr.Int64.fromString('0'),
                    signatureExpirationLedger: 100,
                    signature: StellarSdk.xdr.ScVal.scvVoid(),
                  }),
                ),
                rootInvocation: new StellarSdk.xdr.SorobanAuthorizedInvocation({
                  function: StellarSdk.xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
                    new StellarSdk.xdr.InvokeContractArgs({
                      contractAddress: StellarSdk.Address.fromString(CONTRACT_ID).toScAddress(),
                      functionName: 'cancel_contract',
                      args: [],
                    }),
                  ),
                  subInvocations: [],
                }),
              }),
            ],
            retval: StellarSdk.xdr.ScVal.scvVoid(),
          },
        }),
      } as any;

      const built = await buildEscrowTransaction(
        { action: 'cancel_contract', source: SOURCE_ACCOUNT, args: { id: '1' } },
        { server },
      );
      expect(built.networkPassphrase).toBe(expectedPassphrase);
    });
  });

  describe('STELLAR_NETWORK=public', () => {
    const expectedPassphrase = NETWORK_PASSPHRASES.public;

    beforeEach(() => {
      process.env.STELLAR_NETWORK = 'public';
      delete process.env.STELLAR_NETWORK_PASSPHRASE;
    });

    it('derives public passphrase across all modules', async () => {
      expect(config.networkPassphrase).toBe(expectedPassphrase);

      // 1. Pause
      let capturedTx: any;
      const pauseServer = {
        simulateTransaction: jest.fn().mockImplementation((tx) => {
          capturedTx = tx;
          return Promise.resolve({ result: { retval: StellarSdk.nativeToScVal(false) } });
        }),
      };
      await defaultRpcReader(undefined, pauseServer);
      expect(capturedTx.networkPassphrase).toBe(expectedPassphrase);

      // 2. Chain read
      const capturedSims: StellarSdk.Transaction[] = [];
      const transport: RpcTransport = {
        simulateTransaction: async (tx) => {
          capturedSims.push(tx);
          return {
            _parsed: true,
            id: 'sim',
            latestLedger: 100,
            events: [],
            minResourceFee: '100',
            transactionData: new StellarSdk.SorobanDataBuilder(),
            result: { auth: [], retval: StellarSdk.nativeToScVal(1) },
          } as any;
        },
        getLatestLedger: async () => ({ sequence: 100 }),
      };
      const reader = new ContractReader({ rpcUrl: 'https://example.invalid', contractId: CONTRACT_ID, transport });
      await reader.simulateRead('version');
      expect(capturedSims[0].networkPassphrase).toBe(expectedPassphrase);

      // 3. Health
      const rpc: HealthRpcClient = {
        getHealth: async () => 'healthy',
        getNetworkPassphrase: async () => expectedPassphrase,
        hasContractInstance: async () => true,
      };
      const health = new HealthService({ store: new EscrowStore(), rpc });
      const healthRes = await health.ready();
      expect(healthRes.report.checks.network.status).toBe('pass');

      // 4. Tx builder
      const server = {
        getAccount: jest.fn().mockResolvedValue(new StellarSdk.Account(SOURCE_ACCOUNT, '1')),
        simulateTransaction: jest.fn().mockResolvedValue({
          _parsed: true,
          latestLedger: 100,
          events: [],
          minResourceFee: '100',
          transactionData: new StellarSdk.SorobanDataBuilder(),
          result: {
            auth: [
              new StellarSdk.xdr.SorobanAuthorizationEntry({
                credentials: StellarSdk.xdr.SorobanCredentials.sorobanCredentialsAddress(
                  new StellarSdk.xdr.SorobanAddressCredentials({
                    address: StellarSdk.Address.fromString(SOURCE_ACCOUNT).toScAddress(),
                    nonce: StellarSdk.xdr.Int64.fromString('0'),
                    signatureExpirationLedger: 100,
                    signature: StellarSdk.xdr.ScVal.scvVoid(),
                  }),
                ),
                rootInvocation: new StellarSdk.xdr.SorobanAuthorizedInvocation({
                  function: StellarSdk.xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
                    new StellarSdk.xdr.InvokeContractArgs({
                      contractAddress: StellarSdk.Address.fromString(CONTRACT_ID).toScAddress(),
                      functionName: 'cancel_contract',
                      args: [],
                    }),
                  ),
                  subInvocations: [],
                }),
              }),
            ],
            retval: StellarSdk.xdr.ScVal.scvVoid(),
          },
        }),
      } as any;
      const built = await buildEscrowTransaction(
        { action: 'cancel_contract', source: SOURCE_ACCOUNT, args: { id: '1' } },
        { server },
      );
      expect(built.networkPassphrase).toBe(expectedPassphrase);
    });
  });

  describe('STELLAR_NETWORK_PASSPHRASE override', () => {
    const overridePassphrase = 'Custom Passphrase Override ; 2026';

    beforeEach(() => {
      process.env.STELLAR_NETWORK = 'futurenet';
      process.env.STELLAR_NETWORK_PASSPHRASE = overridePassphrase;
    });

    it('honours STELLAR_NETWORK_PASSPHRASE across all modules', async () => {
      expect(config.networkPassphrase).toBe(overridePassphrase);

      // Pause
      let capturedTx: any;
      const pauseServer = {
        simulateTransaction: jest.fn().mockImplementation((tx) => {
          capturedTx = tx;
          return Promise.resolve({ result: { retval: StellarSdk.nativeToScVal(false) } });
        }),
      };
      await defaultRpcReader(undefined, pauseServer);
      expect(capturedTx.networkPassphrase).toBe(overridePassphrase);

      // Chain read
      const capturedSims: StellarSdk.Transaction[] = [];
      const transport: RpcTransport = {
        simulateTransaction: async (tx) => {
          capturedSims.push(tx);
          return {
            _parsed: true,
            id: 'sim',
            latestLedger: 100,
            events: [],
            minResourceFee: '100',
            transactionData: new StellarSdk.SorobanDataBuilder(),
            result: { auth: [], retval: StellarSdk.nativeToScVal(1) },
          } as any;
        },
        getLatestLedger: async () => ({ sequence: 100 }),
      };
      const reader = new ContractReader({ rpcUrl: 'https://example.invalid', contractId: CONTRACT_ID, transport });
      await reader.simulateRead('version');
      expect(capturedSims[0].networkPassphrase).toBe(overridePassphrase);

      // Health
      const rpc: HealthRpcClient = {
        getHealth: async () => 'healthy',
        getNetworkPassphrase: async () => overridePassphrase,
        hasContractInstance: async () => true,
      };
      const health = new HealthService({ store: new EscrowStore(), rpc });
      const healthRes = await health.ready();
      expect(healthRes.report.checks.network.status).toBe('pass');
    });
  });

  describe('explicit option overrides', () => {
    const explicitPassphrase = 'Explicit Option Passphrase ; 9999';

    it('honours explicit option overrides on every module', async () => {
      // 1. Pause
      let capturedTx: any;
      const pauseServer = {
        simulateTransaction: jest.fn().mockImplementation((tx) => {
          capturedTx = tx;
          return Promise.resolve({ result: { retval: StellarSdk.nativeToScVal(false) } });
        }),
      };
      await defaultRpcReader(explicitPassphrase, pauseServer);
      expect(capturedTx.networkPassphrase).toBe(explicitPassphrase);

      const pauseGuard = new PauseGuard({ networkPassphrase: explicitPassphrase, server: pauseServer });
      await pauseGuard.isPaused();
      expect(capturedTx.networkPassphrase).toBe(explicitPassphrase);

      // 2. Chain read
      const capturedSims: StellarSdk.Transaction[] = [];
      const transport: RpcTransport = {
        simulateTransaction: async (tx) => {
          capturedSims.push(tx);
          return {
            _parsed: true,
            id: 'sim',
            latestLedger: 100,
            events: [],
            minResourceFee: '100',
            transactionData: new StellarSdk.SorobanDataBuilder(),
            result: { auth: [], retval: StellarSdk.nativeToScVal(1) },
          } as any;
        },
        getLatestLedger: async () => ({ sequence: 100 }),
      };
      const reader = new ContractReader({
        rpcUrl: 'https://example.invalid',
        contractId: CONTRACT_ID,
        networkPassphrase: explicitPassphrase,
        transport,
      });
      await reader.simulateRead('version');
      expect(capturedSims[0].networkPassphrase).toBe(explicitPassphrase);

      const chainReader = new SorobanRpcChainReader(
        'https://example.invalid',
        CONTRACT_ID,
        explicitPassphrase,
        transport,
      );
      await chainReader.getContract('1');
      expect(capturedSims[1].networkPassphrase).toBe(explicitPassphrase);

      // 3. Health
      const rpc: HealthRpcClient = {
        getHealth: async () => 'healthy',
        getNetworkPassphrase: async () => explicitPassphrase,
        hasContractInstance: async () => true,
      };
      const health = new HealthService({
        store: new EscrowStore(),
        rpc,
        networkPassphrase: explicitPassphrase,
      });
      const healthRes = await health.ready();
      expect(healthRes.report.checks.network.status).toBe('pass');

      // 4. Tx builder
      const server = {
        getAccount: jest.fn().mockResolvedValue(new StellarSdk.Account(SOURCE_ACCOUNT, '1')),
        simulateTransaction: jest.fn().mockResolvedValue({
          _parsed: true,
          latestLedger: 100,
          events: [],
          minResourceFee: '100',
          transactionData: new StellarSdk.SorobanDataBuilder(),
          result: {
            auth: [
              new StellarSdk.xdr.SorobanAuthorizationEntry({
                credentials: StellarSdk.xdr.SorobanCredentials.sorobanCredentialsAddress(
                  new StellarSdk.xdr.SorobanAddressCredentials({
                    address: StellarSdk.Address.fromString(SOURCE_ACCOUNT).toScAddress(),
                    nonce: StellarSdk.xdr.Int64.fromString('0'),
                    signatureExpirationLedger: 100,
                    signature: StellarSdk.xdr.ScVal.scvVoid(),
                  }),
                ),
                rootInvocation: new StellarSdk.xdr.SorobanAuthorizedInvocation({
                  function: StellarSdk.xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
                    new StellarSdk.xdr.InvokeContractArgs({
                      contractAddress: StellarSdk.Address.fromString(CONTRACT_ID).toScAddress(),
                      functionName: 'cancel_contract',
                      args: [],
                    }),
                  ),
                  subInvocations: [],
                }),
              }),
            ],
            retval: StellarSdk.xdr.ScVal.scvVoid(),
          },
        }),
      } as any;
      const built = await buildEscrowTransaction(
        { action: 'cancel_contract', source: SOURCE_ACCOUNT, args: { id: '1' } },
        { server, networkPassphrase: explicitPassphrase },
      );
      expect(built.networkPassphrase).toBe(explicitPassphrase);
    });
  });
});
