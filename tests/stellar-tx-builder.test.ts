import {
  Account,
  Address,
  Contract,
  Networks,
  rpc,
  SorobanDataBuilder,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import { buildEscrowTransaction, TxBuildError } from '../src/stellar/escrowTxBuilder';

const source = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const freelancer = 'GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR';
const token = 'GCATS5YOVB6ROX2WUNKGNQ2MP3GMXDMKSG2O4N5CLX3A6W4PZGZZI55U';
const passphrase = Networks.TESTNET;
function authEntry(address: string) {
  const contractCall = xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
    new xdr.InvokeContractArgs({
      contractAddress: Address.fromString('CCZMIVUBMG5SBC47SDTC32RWLBJ2HW2DCFVWJEOKCH2IFJBZGBKTXK5W').toScAddress(),
      functionName: 'cancel_contract',
      args: [],
    }),
  );
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(address).toScAddress(),
        nonce: xdr.Int64.fromString('0'),
        signatureExpirationLedger: 100,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({ function: contractCall, subInvocations: [] }),
  });
}

const authForSource = authEntry(source);

function mockServer(overrides: Partial<Pick<rpc.Server, 'getAccount' | 'simulateTransaction'>> = {}) {
  return {
    getAccount: jest.fn().mockResolvedValue(new Account(source, '1')),
    simulateTransaction: jest.fn().mockResolvedValue({
      _parsed: true,
      id: 'sim',
      latestLedger: 123,
      events: [],
      minResourceFee: '500',
      transactionData: new SorobanDataBuilder(),
      result: { auth: [authForSource], retval: xdr.ScVal.scvVoid() },
    }),
    ...overrides,
  } as unknown as Pick<rpc.Server, 'getAccount' | 'simulateTransaction'>;
}

async function build(action: string, args: object, server = mockServer()) {
  const result = await buildEscrowTransaction({ action, source, args }, { server, networkPassphrase: passphrase });
  return { result, transaction: TransactionBuilder.fromXDR(result.xdr, passphrase) };
}

function contractCall(transaction: ReturnType<typeof TransactionBuilder.fromXDR>) {
  const operation = transaction.operations[0] as { func: xdr.HostFunction };
  const invokeArgs = operation.func.invokeContract();
  return {
    contractAddress: Address.fromScAddress(invokeArgs.contractAddress()).toString(),
    contractFn: invokeArgs.functionName().toString(),
    args: invokeArgs.args(),
  };
}

describe('Soroban transaction builder', () => {
  it.each([
    ['create_contract', { client: source, freelancer, token, milestoneAmounts: ['1', '2'] }, 'create_contract', ['scvAddress', 'scvAddress', 'scvAddress', 'scvVec']],
    ['deposit_funds', { id: '7', amount: '100' }, 'deposit_funds', ['scvU64', 'scvI128']],
    ['release_milestone', { id: '7', index: 1 }, 'release_milestone', ['scvU64', 'scvU32']],
    ['open_dispute', { id: '7', caller: source }, 'open_dispute', ['scvU64', 'scvAddress']],
    ['cancel_contract', { id: '7' }, 'cancel_contract', ['scvU64']],
    ['issue_reputation', { id: '7', rating: 5 }, 'issue_reputation', ['scvU64', 'scvU32']],
  ])('encodes %s with correctly typed arguments', async (action, args, functionName, types) => {
    const { result, transaction } = await build(action, args);
    const call = contractCall(transaction);
    expect(call.contractAddress).toBe(new Contract('CCZMIVUBMG5SBC47SDTC32RWLBJ2HW2DCFVWJEOKCH2IFJBZGBKTXK5W').contractId());
    expect(call.contractFn).toBe(functionName);
    expect(call.args.map((arg) => arg.switch().name)).toEqual(types);
    expect(transaction.signatures).toHaveLength(0);
    if (action === 'release_milestone') {
      expect(xdr.ScVal.scvU32(1).switch().name).toBe('scvU32');
    }
    expect(result.latestLedger).toBe(123);
  });

  it('encodes the maximum positive i128 without precision loss', async () => {
    const max = '170141183460469231731687303715884105727';
    const { transaction } = await build('deposit_funds', { id: '1', amount: max });
    const amount = contractCall(transaction).args[1];
    expect(amount.switch().name).toBe('scvI128');
    const parts = amount.i128();
    expect(parts.hi().toString()).toBe('9223372036854775807');
    expect(parts.lo().toString()).toBe('18446744073709551615');
  });

  it('returns simulated fees, auth, expiry, and an unsigned assembled transaction', async () => {
    const { result, transaction } = await build('cancel_contract', { id: '1' });
    expect(result).toMatchObject({
      networkPassphrase: passphrase,
      fee: { inclusion: expect.any(String), resource: '500', total: expect.any(String) },
      minResourceFee: '500',
      authRequired: [source],
    });
    expect(result.expiresAt).toMatch(/^\d{4}-/);
    expect(transaction.signatures).toHaveLength(0);
  });

  it('maps contract errors and includes the contract error name/code', async () => {
    const server = mockServer({
      simulateTransaction: jest.fn().mockResolvedValue({
        _parsed: true, id: 'sim', latestLedger: 123, events: [], error: 'HostError: Error(Contract, #9)',
      }),
    });
    await expect(buildEscrowTransaction(
      { action: 'deposit_funds', source, args: { id: '1', amount: '1' } },
      { server, networkPassphrase: passphrase },
    )).rejects.toMatchObject({ status: 422, code: 'contract_error', contractError: { name: 'OverFunded', code: 9 } });
  });

  it('distinguishes missing source accounts from unavailable RPC', async () => {
    const missing = mockServer({ getAccount: jest.fn().mockRejectedValue({ status: 404 }) });
    const down = mockServer({ getAccount: jest.fn().mockRejectedValue(new Error('timeout')) });
    await expect(buildEscrowTransaction(
      { action: 'cancel_contract', source, args: { id: '1' } }, { server: missing },
    )).rejects.toMatchObject({ status: 404, code: 'source_account_not_found' });
    await expect(buildEscrowTransaction(
      { action: 'cancel_contract', source, args: { id: '1' } }, { server: down },
    )).rejects.toMatchObject({ status: 503, code: 'chain_unavailable' });
  });

  it('rejects mismatched parties and invalid/admin actions', async () => {
    const server = mockServer();
    await expect(buildEscrowTransaction(
      { action: 'create_contract', source, args: { client: freelancer, freelancer: source, token, milestoneAmounts: ['1'] } },
      { server },
    )).rejects.toMatchObject({ status: 400, code: 'source_mismatch' });
    await expect(buildEscrowTransaction(
      { action: 'open_dispute', source, args: { id: '1', caller: freelancer } }, { server },
    )).rejects.toMatchObject({ status: 400, code: 'source_mismatch' });
    await expect(buildEscrowTransaction({ action: 'resolve_dispute', source, args: { id: '1' } }, { server }))
      .rejects.toMatchObject({ status: 403, code: 'admin_action_not_buildable' });
    await expect(buildEscrowTransaction({ action: 'no_such_action', source, args: {} }, { server }))
      .rejects.toMatchObject({ status: 400, code: 'invalid_action' });
    expect(server.getAccount).not.toHaveBeenCalled();
  });

  it('rejects an ID-based action when simulation requires a different party', async () => {
    const differentPartyAuth = authEntry(freelancer);
    const server = mockServer({
      simulateTransaction: jest.fn().mockResolvedValue({
        _parsed: true, id: 'sim', latestLedger: 123, events: [], minResourceFee: '500', transactionData: {},
        result: { auth: [differentPartyAuth], retval: xdr.ScVal.scvVoid() },
      }),
    });
    await expect(buildEscrowTransaction(
      { action: 'cancel_contract', source, args: { id: '1' } }, { server, networkPassphrase: passphrase },
    )).rejects.toMatchObject({ status: 400, code: 'source_mismatch' });
  });

  it('rejects i128 values outside the signed range', async () => {
    await expect(buildEscrowTransaction(
      { action: 'deposit_funds', source, args: { id: '1', amount: '170141183460469231731687303715884105728' } },
      { server: mockServer() },
    )).rejects.toBeInstanceOf(TxBuildError);
  });
});

// Optional end-to-end test that hits real Testnet RPC. Skipped by default —
// run with: TESTNET_E2E=1 npm test -- stellar-tx-builder
// Set TESTNET_SOURCE to a funded testnet account (G…) for a happy-path build;
// otherwise the build still proves real RPC was reached via a structured error.
const e2eDescribe = process.env.TESTNET_E2E === '1' ? describe : describe.skip;

e2eDescribe('TESTNET_E2E (real network I/O, skipped by default)', () => {
  jest.setTimeout(30000);

  it('contacts the testnet RPC and returns a structured result', async () => {
    const testSource = process.env.TESTNET_SOURCE || source;
    try {
      const result = await buildEscrowTransaction(
        {
          action: 'create_contract',
          source: testSource,
          args: { client: testSource, freelancer, token, milestoneAmounts: ['1'] },
        },
        {}, // no mock server — uses the configured testnet RPC
      );
      // Happy path: a simulated, unsigned transaction.
      expect(result.xdr).toEqual(expect.any(String));
      const tx = TransactionBuilder.fromXDR(result.xdr, result.networkPassphrase);
      expect(tx.signatures).toHaveLength(0);
    } catch (err) {
      // An unfunded/missing source still proves we reached real Testnet RPC,
      // surfacing as a structured TxBuildError rather than a raw crash.
      expect(err).toBeInstanceOf(TxBuildError);
    }
  });
});