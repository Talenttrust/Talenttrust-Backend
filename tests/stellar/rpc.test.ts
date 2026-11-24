import {
  Account,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  Transaction,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import {
  ContractReader,
  RpcSimulationError,
  RpcTimeoutError,
  RpcTransport,
  THROWAWAY_SOURCE_ACCOUNT,
  sanitizeRpcError,
} from '../../src/stellar/rpc';
import adminFixture from '../fixtures/simulate-get-admin.json';
import countFixture from '../fixtures/simulate-contract-count.json';
import errorFixture from '../fixtures/simulate-error.json';
import pausedFixture from '../fixtures/simulate-is-paused.json';
import versionFixture from '../fixtures/simulate-version.json';

const CONTRACT_ID = 'CCZMIVUBMG5SBC47SDTC32RWLBJ2HW2DCFVWJEOKCH2IFJBZGBKTXK5W';

/**
 * Hydrate a recorded raw JSON-RPC simulateTransaction body into the parsed
 * shape the SDK returns (`retval` decoded from base64 XDR), mirroring the
 * SDK's `parseRawSimulation`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function hydrateSimulation(raw: any) {
  if (raw.result && typeof raw.result.error === 'string') {
    return { latestLedger: raw.result.latestLedger, error: raw.result.error };
  }
  const row = (raw.result.results ?? [])[0];
  const retval = row?.xdr
    ? xdr.ScVal.fromXDR(row.xdr, 'base64')
    : xdr.ScVal.scvVoid();
  return {
    latestLedger: raw.result.latestLedger,
    transactionData: raw.result.transactionData,
    minResourceFee: raw.result.minResourceFee,
    events: [],
    result: { auth: [], retval },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeReader(response: any, timeoutMs = 500) {
  const calls: Transaction[] = [];
  const transport: RpcTransport = {
    simulateTransaction: async (tx) => {
      calls.push(tx);
      return response as never;
    },
    getLatestLedger: async () => ({ sequence: response.latestLedger ?? 0 }),
  };
  const reader = new ContractReader({
    rpcUrl: 'https://example.invalid',
    contractId: CONTRACT_ID,
    network: 'testnet',
    timeoutMs,
    transport,
  });
  return { reader, calls };
}

describe('ContractReader.simulateRead decoding (recorded fixtures)', () => {
  it('decodes version()', async () => {
    const { reader } = makeReader(hydrateSimulation(versionFixture));
    await expect(reader.simulateRead('version')).resolves.toBe(1);
  });

  it('decodes is_paused()', async () => {
    const { reader } = makeReader(hydrateSimulation(pausedFixture));
    await expect(reader.simulateRead('is_paused')).resolves.toBe(false);
  });

  it('decodes contract_count()', async () => {
    const { reader } = makeReader(hydrateSimulation(countFixture));
    await expect(reader.simulateRead('contract_count')).resolves.toBe(0n);
  });

  it('decodes get_admin()', async () => {
    const { reader } = makeReader(hydrateSimulation(adminFixture));
    await expect(reader.simulateRead('get_admin')).resolves.toBe(
      'GA7TXEBMEPQCLHIYCWDN7RKAO5IMRD2UV7O7TZXMEW6VZUMEXNR4XBB5',
    );
  });

  it('builds an unsigned simulation tx from the throwaway source account', async () => {
    const { reader, calls } = makeReader(hydrateSimulation(versionFixture));
    await reader.simulateRead('version');
    expect(calls).toHaveLength(1);
    const tx = calls[0];
    expect(tx.source).toBe(THROWAWAY_SOURCE_ACCOUNT);
    // TransactionBuilder increments the throwaway account's seq (0 -> 1).
    expect(tx.sequence).toBe('1');
    expect(tx.signatures).toHaveLength(0);
    expect(tx.operations).toHaveLength(1);
    const op = tx.operations[0];
    expect(op.type).toBe('invokeHostFunction');
    if (op.type !== 'invokeHostFunction') throw new Error('expected an invokeHostFunction operation');
    expect(op.func.switch().name).toBe('hostFunctionTypeInvokeContract');
    // The envelope must be exactly `Contract.call("version")` from the throwaway account.
    const reference = new TransactionBuilder(new Account(THROWAWAY_SOURCE_ACCOUNT, '0'), {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(new Contract(CONTRACT_ID).call('version'))
      .setTimeout(0)
      .build();
    expect(tx.toEnvelope().toXDR('base64')).toBe(reference.toEnvelope().toXDR('base64'));
  });

  it('returns the latest ledger through the transport', async () => {
    const { reader } = makeReader(hydrateSimulation(versionFixture));
    await expect(reader.getLatestLedger()).resolves.toBe(versionFixture.result.latestLedger);
  });

  it('accepts older RPC responses that use latestLedger instead of sequence', async () => {
    const transport: RpcTransport = {
      simulateTransaction: () => new Promise(() => {}),
      getLatestLedger: async () => ({ latestLedger: 777 }),
    };
    const reader = new ContractReader({
      rpcUrl: 'https://example.invalid',
      contractId: CONTRACT_ID,
      timeoutMs: 500,
      transport,
    });
    await expect(reader.getLatestLedger()).resolves.toBe(777);
  });
});

describe('ContractReader error handling', () => {
  it('rejects simulation failures with a sanitised message', async () => {
    const { reader } = makeReader(hydrateSimulation(errorFixture));
    await expect(reader.simulateRead('no_such_method')).rejects.toBeInstanceOf(RpcSimulationError);
    const err = (await reader.simulateRead('no_such_method').catch((e: unknown) => e)) as Error;
    expect(err.message).toContain('HostError');
    expect(err.message).not.toContain('\n');
    expect(err.message.length).toBeLessThanOrEqual(160);
  });

  it('times out when the RPC never responds', async () => {
    const transport: RpcTransport = {
      simulateTransaction: () => new Promise(() => {}),
      getLatestLedger: () => new Promise(() => {}),
    };
    const reader = new ContractReader({
      rpcUrl: 'https://example.invalid',
      contractId: CONTRACT_ID,
      timeoutMs: 50,
      transport,
    });
    const started = Date.now();
    await expect(reader.simulateRead('version')).rejects.toBeInstanceOf(RpcTimeoutError);
    expect(Date.now() - started).toBeLessThan(500);
    await expect(reader.getLatestLedger()).rejects.toBeInstanceOf(RpcTimeoutError);
  });
});

describe('sanitizeRpcError', () => {
  it('strips URLs, collapses newlines and truncates', () => {
    const raw = new Error(
      `connect ECONNREFUSED https://soroban-testnet.stellar.org/foo\nsecond line ${'x'.repeat(300)}`,
    );
    const clean = sanitizeRpcError(raw);
    expect(clean).not.toContain('https://');
    expect(clean).not.toContain('\n');
    expect(clean.length).toBeLessThanOrEqual(160);
  });

  it('falls back for empty or non-error values', () => {
    expect(sanitizeRpcError('')).toBe('rpc request failed');
    expect(sanitizeRpcError(undefined)).toBe('undefined');
    expect(sanitizeRpcError(new Error('   '))).toBe('rpc request failed');
  });

  it('never leaks a throwaway private key or signature', () => {
    expect(sanitizeRpcError(new Error('boom'))).toBe('boom');
    expect(Keypair.random().secret()).not.toBe(sanitizeRpcError(new Error('boom')));
  });
});

describe('ContractReader network passphrase', () => {
  const originalNetwork = process.env.STELLAR_NETWORK;
  const originalPassphrase = process.env.STELLAR_NETWORK_PASSPHRASE;

  afterEach(() => {
    if (originalNetwork === undefined) delete process.env.STELLAR_NETWORK;
    else process.env.STELLAR_NETWORK = originalNetwork;
    if (originalPassphrase === undefined) delete process.env.STELLAR_NETWORK_PASSPHRASE;
    else process.env.STELLAR_NETWORK_PASSPHRASE = originalPassphrase;
  });

  it('derives passphrase from config for futurenet, public, and override env var', async () => {
    const transport: RpcTransport = {
      simulateTransaction: jest.fn().mockResolvedValue(hydrateSimulation(versionFixture)),
      getLatestLedger: async () => ({ latestLedger: 123 }),
    };

    process.env.STELLAR_NETWORK = 'futurenet';
    delete process.env.STELLAR_NETWORK_PASSPHRASE;
    const readerFuturenet = new ContractReader({
      rpcUrl: 'https://example.invalid',
      contractId: CONTRACT_ID,
      transport,
    });
    await readerFuturenet.simulateRead('version');
    let call = (transport.simulateTransaction as jest.Mock).mock.calls[0][0];
    expect(call.networkPassphrase).toBe('Test SDF Future Network ; October 2022');

    process.env.STELLAR_NETWORK = 'public';
    const readerPublic = new ContractReader({
      rpcUrl: 'https://example.invalid',
      contractId: CONTRACT_ID,
      transport,
    });
    await readerPublic.simulateRead('version');
    call = (transport.simulateTransaction as jest.Mock).mock.calls[1][0];
    expect(call.networkPassphrase).toBe('Public Global Stellar Network ; September 2015');

    process.env.STELLAR_NETWORK_PASSPHRASE = 'Custom Rpc Passphrase';
    const readerOverride = new ContractReader({
      rpcUrl: 'https://example.invalid',
      contractId: CONTRACT_ID,
      transport,
    });
    await readerOverride.simulateRead('version');
    call = (transport.simulateTransaction as jest.Mock).mock.calls[2][0];
    expect(call.networkPassphrase).toBe('Custom Rpc Passphrase');
  });

  it('honours explicit networkPassphrase option over config', async () => {
    const transport: RpcTransport = {
      simulateTransaction: jest.fn().mockResolvedValue(hydrateSimulation(versionFixture)),
      getLatestLedger: async () => ({ latestLedger: 123 }),
    };

    process.env.STELLAR_NETWORK = 'futurenet';
    const reader = new ContractReader({
      rpcUrl: 'https://example.invalid',
      contractId: CONTRACT_ID,
      networkPassphrase: 'Explicit Reader Passphrase',
      transport,
    });
    await reader.simulateRead('version');
    const call = (transport.simulateTransaction as jest.Mock).mock.calls[0][0];
    expect(call.networkPassphrase).toBe('Explicit Reader Passphrase');
  });
});
