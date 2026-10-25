import request from 'supertest';
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
import { createApp } from '../src/app';
import type { RpcClient } from '../src/stellar/escrowTxBuilder';

const source = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const freelancer = 'GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR';
const token = 'GCATS5YOVB6ROX2WUNKGNQ2MP3GMXDMKSG2O4N5CLX3A6W4PZGZZI55U';
const contractId = 'CCZMIVUBMG5SBC47SDTC32RWLBJ2HW2DCFVWJEOKCH2IFJBZGBKTXK5W';
const passphrase = Networks.TESTNET;

/** A SorobanAuthorizationEntry requiring `address` to sign. */
function authEntry(address: string): xdr.SorobanAuthorizationEntry {
  const contractCall = xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
    new xdr.InvokeContractArgs({
      contractAddress: Address.fromString(contractId).toScAddress(),
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

function mockServer(
  overrides: Partial<Pick<rpc.Server, 'getAccount' | 'simulateTransaction'>> = {},
): RpcClient {
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
  } as unknown as RpcClient;
}

function appWith(server: RpcClient) {
  return createApp({ txRpcServer: server });
}

describe('POST /api/v1/tx/build', () => {
  it('returns a simulated, unsigned transaction for release_milestone', async () => {
    const app = appWith(mockServer());
    const res = await request(app)
      .post('/api/v1/tx/build')
      .send({ action: 'release_milestone', source, args: { id: '1', index: 0 } });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      networkPassphrase: passphrase,
      minResourceFee: '500',
      latestLedger: 123,
      authRequired: [source],
    });
    expect(res.body.fee).toMatchObject({
      inclusion: expect.any(String),
      resource: '500',
      total: expect.any(String),
    });
    expect(res.body.xdr).toEqual(expect.any(String));
    expect(res.body.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // The returned transaction must be unsigned.
    const tx = TransactionBuilder.fromXDR(res.body.xdr, passphrase);
    expect(tx.signatures).toHaveLength(0);

    // The operation targets the configured contract with the right function + typed args.
    const invokeArgs = (tx.operations[0] as { func: xdr.HostFunction }).func.invokeContract();
    expect(Address.fromScAddress(invokeArgs.contractAddress()).toString()).toBe(
      new Contract(contractId).contractId(),
    );
    expect(invokeArgs.functionName().toString()).toBe('release_milestone');
    expect(invokeArgs.args().map((a: xdr.ScVal) => a.switch().name)).toEqual(['scvU64', 'scvU32']);
  });

  it('maps a contract simulation error to 422 with contractError name/code', async () => {
    const app = appWith(
      mockServer({
        simulateTransaction: jest.fn().mockResolvedValue({
          _parsed: true,
          id: 'sim',
          latestLedger: 123,
          events: [],
          error: 'HostError: Error(Contract, #9)',
        }),
      }),
    );
    const res = await request(app)
      .post('/api/v1/tx/build')
      .send({ action: 'deposit_funds', source, args: { id: '1', amount: '1' } });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      error: 'contract_error',
      contractError: { name: 'OverFunded', code: 9 },
    });
  });

  it('returns 404 source_account_not_found when the source account is missing', async () => {
    const app = appWith(mockServer({ getAccount: jest.fn().mockRejectedValue({ status: 404 }) }));
    const res = await request(app)
      .post('/api/v1/tx/build')
      .send({ action: 'cancel_contract', source, args: { id: '1' } });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('source_account_not_found');
  });

  it('returns 503 chain_unavailable when RPC is down', async () => {
    const app = appWith(mockServer({ getAccount: jest.fn().mockRejectedValue(new Error('timeout')) }));
    const res = await request(app)
      .post('/api/v1/tx/build')
      .send({ action: 'cancel_contract', source, args: { id: '1' } });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('chain_unavailable');
  });

  it('rejects a source/party mismatch for create_contract before touching RPC', async () => {
    const server = mockServer();
    const app = appWith(server);
    const res = await request(app)
      .post('/api/v1/tx/build')
      .send({
        action: 'create_contract',
        source,
        args: { client: freelancer, freelancer: source, token, milestoneAmounts: ['1'] },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('source_mismatch');
    expect((server.getAccount as jest.Mock)).not.toHaveBeenCalled();
  });

  it('rejects a source/party mismatch for open_dispute before touching RPC', async () => {
    const server = mockServer();
    const app = appWith(server);
    const res = await request(app)
      .post('/api/v1/tx/build')
      .send({ action: 'open_dispute', source, args: { id: '1', caller: freelancer } });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('source_mismatch');
    expect((server.getAccount as jest.Mock)).not.toHaveBeenCalled();
  });

  it('rejects a mismatched simulation-required party for an id-based action', async () => {
    const app = appWith(
      mockServer({
        simulateTransaction: jest.fn().mockResolvedValue({
          _parsed: true,
          id: 'sim',
          latestLedger: 123,
          events: [],
          minResourceFee: '500',
          transactionData: new SorobanDataBuilder(),
          result: { auth: [authEntry(freelancer)], retval: xdr.ScVal.scvVoid() },
        }),
      }),
    );
    const res = await request(app)
      .post('/api/v1/tx/build')
      .send({ action: 'cancel_contract', source, args: { id: '1' } });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('source_mismatch');
  });

  it('rejects an invalid action with 400', async () => {
    const app = appWith(mockServer());
    const res = await request(app)
      .post('/api/v1/tx/build')
      .send({ action: 'no_such_action', source, args: {} });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_action');
  });

  it('rejects admin-only resolve_dispute with 403', async () => {
    const server = mockServer();
    const app = appWith(server);
    const res = await request(app)
      .post('/api/v1/tx/build')
      .send({ action: 'resolve_dispute', source, args: { id: '1' } });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('admin_action_not_buildable');
    expect((server.getAccount as jest.Mock)).not.toHaveBeenCalled();
  });

  it('rejects invalid args (i128 overflow) with 400', async () => {
    const app = appWith(mockServer());
    const res = await request(app)
      .post('/api/v1/tx/build')
      .send({
        action: 'deposit_funds',
        source,
        args: { id: '1', amount: '170141183460469231731687303715884105728' },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_args');
  });

  it('encodes i128 max without precision loss', async () => {
    const app = appWith(mockServer());
    const res = await request(app)
      .post('/api/v1/tx/build')
      .send({
        action: 'deposit_funds',
        source,
        args: { id: '1', amount: '170141183460469231731687303715884105727' },
      });

    expect(res.status).toBe(200);
    const tx = TransactionBuilder.fromXDR(res.body.xdr, passphrase);
    const invokeArgs = (tx.operations[0] as { func: xdr.HostFunction }).func.invokeContract();
    const amount = invokeArgs.args()[1];
    expect(amount.switch().name).toBe('scvI128');
    expect(amount.i128().hi().toString()).toBe('9223372036854775807');
    expect(amount.i128().lo().toString()).toBe('18446744073709551615');
  });

  it('documents the route in the OpenAPI spec', async () => {
    const app = appWith(mockServer());
    const res = await request(app).get('/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.paths['/api/v1/tx/build']).toBeDefined();
    expect(res.body.paths['/api/v1/tx/build'].post.tags).toContain('Transaction');
    expect(res.body.components.schemas.TxBuildRequest).toBeDefined();
    expect(res.body.components.schemas.TxBuildResponse).toBeDefined();
  });

  it('lists the route in the root endpoint index', async () => {
    const app = appWith(mockServer());
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body.endpoints).toContain('POST /api/v1/tx/build');
  });
});
