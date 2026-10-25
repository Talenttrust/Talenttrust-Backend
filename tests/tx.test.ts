import request from 'supertest';
import {
  Account,
  Asset,
  Contract,
  FeeBumpTransaction,
  Keypair,
  Networks,
  Operation,
  TimeoutInfinite,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
} from '@stellar/stellar-sdk';
import { createApp } from '../src/app';
import { config } from '../src/config';
import { EscrowStore } from '../src/store';
import { BoundedLru, ESCROW_MUTATING_FUNCTIONS, RpcClient, TxRelay } from '../src/tx';

const ESCROW_ID = config.contractId;
const WRONG_CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

function buildSignedEscrowTx(opts: {
  contractId?: string;
  fn?: string;
  args?: xdr.ScVal[];
  networkPassphrase?: string;
  timeoutSeconds?: number;
  timebounds?: { minTime: number; maxTime: number };
  sign?: boolean;
  extraOp?: xdr.Operation;
  usePaymentOpInstead?: boolean;
  feeBump?: boolean;
  signFeeBump?: boolean;
} = {}): { tx: Transaction | FeeBumpTransaction; xdr: string; hash: string; signer: Keypair } {
  const signer = Keypair.random();
  const account = new Account(signer.publicKey(), '100');
  const passphrase = opts.networkPassphrase ?? config.networkPassphrase;
  const contract = new Contract(opts.contractId ?? ESCROW_ID);

  const builder = new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: passphrase,
    ...(opts.timebounds ? { timebounds: opts.timebounds } : {}),
  });

  if (opts.usePaymentOpInstead) {
    builder.addOperation(
      Operation.payment({
        destination: Keypair.random().publicKey(),
        asset: Asset.native(),
        amount: '10',
      }),
    );
  } else {
    builder.addOperation(contract.call(opts.fn ?? 'create_contract', ...(opts.args ?? [])));
  }

  if (opts.extraOp) {
    builder.addOperation(opts.extraOp);
  }

  if (!opts.timebounds) {
    builder.setTimeout(opts.timeoutSeconds ?? 300);
  }

  const innerTx = builder.build();
  if (opts.sign !== false) {
    innerTx.sign(signer);
  }

  if (opts.feeBump) {
    const feeSigner = Keypair.random();
    const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
      feeSigner,
      '200',
      innerTx,
      passphrase,
    );
    if (opts.signFeeBump !== false) {
      feeBumpTx.sign(feeSigner);
    }
    return {
      tx: feeBumpTx,
      xdr: feeBumpTx.toXDR(),
      hash: feeBumpTx.hash().toString('hex'),
      signer,
    };
  }

  return {
    tx: innerTx,
    xdr: innerTx.toXDR(),
    hash: innerTx.hash().toString('hex'),
    signer,
  };
}

describe('Transaction relay & status tracking (/api/v1/tx)', () => {
  describe('Validation rules (local signed XDR, no network)', () => {
    const mockRpc: jest.Mocked<RpcClient> = {
      sendTransaction: jest.fn(),
      getTransaction: jest.fn(),
    };
    const app = createApp(new EscrowStore(), new TxRelay({ rpcClient: mockRpc }));

    beforeEach(() => {
      mockRpc.sendTransaction.mockReset();
      mockRpc.getTransaction.mockReset();
    });

    it('rejects missing or non-base64 xdr', async () => {
      const r1 = await request(app).post('/api/v1/tx/submit').send({});
      expect(r1.status).toBe(400);
      expect(r1.body.error).toBe('invalid_transaction');

      const r2 = await request(app).post('/api/v1/tx/submit').send({ xdr: 'not-valid-xdr!!!' });
      expect(r2.status).toBe(400);
      expect(r2.body.error).toBe('invalid_transaction');
      expect(mockRpc.sendTransaction).not.toHaveBeenCalled();
    });

    it('rejects wrong contract id', async () => {
      const { xdr: badXdr } = buildSignedEscrowTx({ contractId: WRONG_CONTRACT_ID });
      const res = await request(app).post('/api/v1/tx/submit').send({ xdr: badXdr });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_transaction');
      expect(res.body.message).toMatch(/contract/i);
      expect(mockRpc.sendTransaction).not.toHaveBeenCalled();
    });

    it('rejects transaction with two operations', async () => {
      const contract = new Contract(ESCROW_ID);
      const { xdr: twoOpsXdr } = buildSignedEscrowTx({
        extraOp: contract.call('deposit_funds'),
      });
      const res = await request(app).post('/api/v1/tx/submit').send({ xdr: twoOpsXdr });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_transaction');
      expect(res.body.message).toMatch(/one operation/i);
      expect(mockRpc.sendTransaction).not.toHaveBeenCalled();
    });

    it('rejects payment operation (non-invokeHostFunction)', async () => {
      const { xdr: payXdr } = buildSignedEscrowTx({ usePaymentOpInstead: true });
      const res = await request(app).post('/api/v1/tx/submit').send({ xdr: payXdr });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_transaction');
      expect(res.body.message).toMatch(/invokeHostFunction/i);
      expect(mockRpc.sendTransaction).not.toHaveBeenCalled();
    });

    it('rejects non-mutating or unknown contract functions', async () => {
      for (const readOnlyFn of ['get_contract', 'contract_count', 'get_reputation', 'version', 'is_paused', 'hack']) {
        const { xdr: roXdr } = buildSignedEscrowTx({ fn: readOnlyFn });
        const res = await request(app).post('/api/v1/tx/submit').send({ xdr: roXdr });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_transaction');
        expect(res.body.message).toMatch(/not an allowed escrow mutating function/i);
      }
      expect(mockRpc.sendTransaction).not.toHaveBeenCalled();
    });

    it('rejects unsigned transaction', async () => {
      const { xdr: unsignedXdr } = buildSignedEscrowTx({ sign: false });
      const res = await request(app).post('/api/v1/tx/submit').send({ xdr: unsignedXdr });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_transaction');
      expect(res.body.message).toMatch(/signature/i);
      expect(mockRpc.sendTransaction).not.toHaveBeenCalled();
    });

    it('rejects missing (infinite) or already expired timebounds', async () => {
      const { xdr: infiniteXdr } = buildSignedEscrowTx({ timeoutSeconds: TimeoutInfinite });
      const r1 = await request(app).post('/api/v1/tx/submit').send({ xdr: infiniteXdr });
      expect(r1.status).toBe(400);
      expect(r1.body.error).toBe('invalid_transaction');
      expect(r1.body.message).toMatch(/timebounds/i);

      const past = Math.floor(Date.now() / 1000) - 60;
      const { xdr: expiredXdr } = buildSignedEscrowTx({
        timebounds: { minTime: past - 120, maxTime: past },
      });
      const r2 = await request(app).post('/api/v1/tx/submit').send({ xdr: expiredXdr });
      expect(r2.status).toBe(400);
      expect(r2.body.error).toBe('invalid_transaction');
      expect(r2.body.message).toMatch(/expired/i);
      expect(mockRpc.sendTransaction).not.toHaveBeenCalled();
    });

    it('rejects transaction signed for wrong network passphrase', async () => {
      const { xdr: wrongNetXdr } = buildSignedEscrowTx({
        networkPassphrase: Networks.PUBLIC,
      });
      const res = await request(app).post('/api/v1/tx/submit').send({ xdr: wrongNetXdr });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_transaction');
      expect(res.body.message).toMatch(/signature|passphrase/i);
      expect(mockRpc.sendTransaction).not.toHaveBeenCalled();
    });

    it('accepts valid fee-bump envelope only when both outer and inner tx pass checks', async () => {
      const { xdr: unsignedInnerFeeBump } = buildSignedEscrowTx({
        feeBump: true,
        sign: false,
      });
      const r1 = await request(app).post('/api/v1/tx/submit').send({ xdr: unsignedInnerFeeBump });
      expect(r1.status).toBe(400);

      const { xdr: wrongContractFeeBump } = buildSignedEscrowTx({
        feeBump: true,
        contractId: WRONG_CONTRACT_ID,
      });
      const r2 = await request(app).post('/api/v1/tx/submit').send({ xdr: wrongContractFeeBump });
      expect(r2.status).toBe(400);

      const { xdr: validFeeBump, hash } = buildSignedEscrowTx({
        feeBump: true,
        fn: 'deposit_funds',
      });
      mockRpc.sendTransaction.mockResolvedValueOnce({
        status: 'PENDING',
        hash,
        latestLedger: 100,
        latestLedgerCloseTime: 1700000000,
      });
      const r3 = await request(app).post('/api/v1/tx/submit').send({ xdr: validFeeBump });
      expect(r3.status).toBe(202);
      expect(r3.body).toEqual({ hash, status: 'PENDING' });
    });

    it('accepts all public mutating escrow functions', async () => {
      for (const fn of ESCROW_MUTATING_FUNCTIONS) {
        const { xdr: validXdr, hash } = buildSignedEscrowTx({ fn });
        mockRpc.sendTransaction.mockResolvedValueOnce({
          status: 'PENDING',
          hash,
          latestLedger: 100,
          latestLedgerCloseTime: 1700000000,
        });
        const res = await request(app).post('/api/v1/tx/submit').send({ xdr: validXdr });
        expect(res.status).toBe(202);
        expect(res.body.hash).toBe(hash);
      }
    });
  });

  describe('Mocked Soroban RPC sendTransaction and getTransaction statuses', () => {
    let mockRpc: jest.Mocked<RpcClient>;
    let relay: TxRelay;
    let app: ReturnType<typeof createApp>;

    beforeEach(() => {
      mockRpc = {
        sendTransaction: jest.fn(),
        getTransaction: jest.fn(),
      };
      relay = new TxRelay({ rpcClient: mockRpc, retryAfterSeconds: 7 });
      app = createApp(new EscrowStore(), relay);
    });

    it('handles sendTransaction PENDING -> 202 { hash, status: PENDING }', async () => {
      const { xdr: txXdr, hash } = buildSignedEscrowTx({ fn: 'create_contract' });
      mockRpc.sendTransaction.mockResolvedValueOnce({
        status: 'PENDING',
        hash,
        latestLedger: 500,
        latestLedgerCloseTime: 1700000000,
      });

      const res = await request(app).post('/api/v1/tx/submit').send({ xdr: txXdr });
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ hash, status: 'PENDING' });
    });

    it('handles sendTransaction DUPLICATE -> 200 with current status', async () => {
      const { xdr: txXdr, hash } = buildSignedEscrowTx({ fn: 'create_contract' });
      mockRpc.sendTransaction.mockResolvedValueOnce({
        status: 'DUPLICATE',
        hash,
        latestLedger: 501,
        latestLedgerCloseTime: 1700000005,
      });
      mockRpc.getTransaction.mockResolvedValueOnce({
        status: rpc.Api.GetTransactionStatus.SUCCESS,
        txHash: hash,
        ledger: 501,
        createdAt: 1700000005,
        applicationOrder: 1,
        feeBump: false,
        envelopeXdr: {} as xdr.TransactionEnvelope,
        resultXdr: {} as xdr.TransactionResult,
        resultMetaXdr: {} as xdr.TransactionMeta,
        returnValue: nativeToScVal(7n, { type: 'u64' }),
        latestLedger: 501,
        latestLedgerCloseTime: 1700000005,
        oldestLedger: 1,
        oldestLedgerCloseTime: 1699990000,
      });

      const res = await request(app).post('/api/v1/tx/submit').send({ xdr: txXdr });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        hash,
        status: 'SUCCESS',
        ledger: 501,
        createdAt: 1700000005,
        function: 'create_contract',
        returnValue: '7',
      });
    });

    it('handles sendTransaction TRY_AGAIN_LATER -> 503 with Retry-After header', async () => {
      const { xdr: txXdr, hash } = buildSignedEscrowTx({ fn: 'deposit_funds' });
      mockRpc.sendTransaction.mockResolvedValueOnce({
        status: 'TRY_AGAIN_LATER',
        hash,
        latestLedger: 502,
        latestLedgerCloseTime: 1700000010,
      });

      const res = await request(app).post('/api/v1/tx/submit').send({ xdr: txXdr });
      expect(res.status).toBe(503);
      expect(res.headers['retry-after']).toBe('7');
    });

    it('handles sendTransaction ERROR -> 422 submission_failed with decoded errorResult code (txBadSeq, txInsufficientFee)', async () => {
      const { xdr: txXdr, hash } = buildSignedEscrowTx({ fn: 'release_milestone' });
      const badSeqResult = new xdr.TransactionResult({
        feeCharged: xdr.Int64.fromString('0'),
        result: xdr.TransactionResultResult.txBadSeq(),
        ext: new (xdr.TransactionResultExt as unknown as new (s: number) => xdr.TransactionResultExt)(0),
      });
      mockRpc.sendTransaction.mockResolvedValueOnce({
        status: 'ERROR',
        hash,
        latestLedger: 503,
        latestLedgerCloseTime: 1700000015,
        errorResult: badSeqResult,
      });

      const r1 = await request(app).post('/api/v1/tx/submit').send({ xdr: txXdr });
      expect(r1.status).toBe(422);
      expect(r1.body.error).toBe('submission_failed');
      expect(r1.body.code).toBe('txBadSeq');
      expect(r1.body.message).toContain('txBadSeq');

      const insufficientFeeResult = new xdr.TransactionResult({
        feeCharged: xdr.Int64.fromString('0'),
        result: xdr.TransactionResultResult.txInsufficientFee(),
        ext: new (xdr.TransactionResultExt as unknown as new (s: number) => xdr.TransactionResultExt)(0),
      });
      mockRpc.sendTransaction.mockResolvedValueOnce({
        status: 'ERROR',
        hash,
        latestLedger: 504,
        latestLedgerCloseTime: 1700000020,
        errorResult: insufficientFeeResult,
      });

      const r2 = await request(app).post('/api/v1/tx/submit').send({ xdr: txXdr });
      expect(r2.status).toBe(422);
      expect(r2.body.error).toBe('submission_failed');
      expect(r2.body.code).toBe('txInsufficientFee');
    });

    it('GET /api/v1/tx/:hash decodes u64 returnValue from create_contract as string', async () => {
      const { xdr: txXdr, hash } = buildSignedEscrowTx({ fn: 'create_contract' });
      mockRpc.sendTransaction.mockResolvedValueOnce({
        status: 'PENDING',
        hash,
        latestLedger: 600,
        latestLedgerCloseTime: 1700000100,
      });
      await request(app).post('/api/v1/tx/submit').send({ xdr: txXdr }).expect(202);

      mockRpc.getTransaction.mockResolvedValueOnce({
        status: rpc.Api.GetTransactionStatus.SUCCESS,
        txHash: hash,
        ledger: 601,
        createdAt: 1700000105,
        applicationOrder: 1,
        feeBump: false,
        envelopeXdr: {} as xdr.TransactionEnvelope,
        resultXdr: {} as xdr.TransactionResult,
        resultMetaXdr: {} as xdr.TransactionMeta,
        returnValue: nativeToScVal(42n, { type: 'u64' }),
        latestLedger: 601,
        latestLedgerCloseTime: 1700000105,
        oldestLedger: 1,
        oldestLedgerCloseTime: 1699990000,
      });

      const res = await request(app).get(`/api/v1/tx/${hash}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        hash,
        status: 'SUCCESS',
        ledger: 601,
        createdAt: 1700000105,
        function: 'create_contract',
        returnValue: '42',
      });
    });

    it('GET /api/v1/tx/:hash decodes contractError { name, code } from failed deposit_funds', async () => {
      const { xdr: txXdr, hash } = buildSignedEscrowTx({ fn: 'deposit_funds' });
      mockRpc.sendTransaction.mockResolvedValueOnce({
        status: 'PENDING',
        hash,
        latestLedger: 610,
        latestLedgerCloseTime: 1700000200,
      });
      await request(app).post('/api/v1/tx/submit').send({ xdr: txXdr }).expect(202);

      // EscrowError::OverFunded = 9
      const scErr = xdr.ScError.sceContract(9);
      const body = new (xdr.ContractEventBody as unknown as new (
        s: number,
        v: xdr.ContractEventV0,
      ) => xdr.ContractEventBody)(
        0,
        new xdr.ContractEventV0({
          topics: [xdr.ScVal.scvSymbol('error'), xdr.ScVal.scvError(scErr)],
          data: xdr.ScVal.scvVoid(),
        }),
      );
      const diagEvent = new xdr.DiagnosticEvent({
        inSuccessfulContractCall: false,
        event: new xdr.ContractEvent({
          ext: new (xdr.ExtensionPoint as unknown as new (s: number) => xdr.ExtensionPoint)(0),
          contractId: null as unknown as Buffer,
          type: xdr.ContractEventType.diagnostic(),
          body,
        }),
      });

      mockRpc.getTransaction.mockResolvedValueOnce({
        status: rpc.Api.GetTransactionStatus.FAILED,
        txHash: hash,
        ledger: 611,
        createdAt: 1700000205,
        applicationOrder: 1,
        feeBump: false,
        envelopeXdr: {} as xdr.TransactionEnvelope,
        resultXdr: {} as xdr.TransactionResult,
        resultMetaXdr: {} as xdr.TransactionMeta,
        diagnosticEventsXdr: [diagEvent],
        latestLedger: 611,
        latestLedgerCloseTime: 1700000205,
        oldestLedger: 1,
        oldestLedgerCloseTime: 1699990000,
      });

      const res = await request(app).get(`/api/v1/tx/${hash}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        hash,
        status: 'FAILED',
        ledger: 611,
        createdAt: 1700000205,
        function: 'deposit_funds',
        returnValue: null,
        contractError: {
          name: 'OverFunded',
          code: 9,
        },
      });
    });

    it('GET /api/v1/tx/:hash handles NOT_FOUND (for unknown hash) and PENDING (for relayed hash)', async () => {
      const unknownHash = 'a'.repeat(64);
      mockRpc.getTransaction.mockResolvedValueOnce({
        status: rpc.Api.GetTransactionStatus.NOT_FOUND,
        txHash: unknownHash,
        latestLedger: 700,
        latestLedgerCloseTime: 1700000300,
        oldestLedger: 1,
        oldestLedgerCloseTime: 1699990000,
      });

      const rUnknown = await request(app).get(`/api/v1/tx/${unknownHash}`);
      expect(rUnknown.status).toBe(200);
      expect(rUnknown.body).toEqual({
        hash: unknownHash,
        status: 'NOT_FOUND',
        ledger: null,
        createdAt: null,
        function: null,
        returnValue: null,
      });

      // Now relay a tx and check when RPC still says NOT_FOUND -> status is PENDING
      const { xdr: txXdr, hash: knownHash } = buildSignedEscrowTx({ fn: 'cancel_contract' });
      mockRpc.sendTransaction.mockResolvedValueOnce({
        status: 'PENDING',
        hash: knownHash,
        latestLedger: 700,
        latestLedgerCloseTime: 1700000300,
      });
      await request(app).post('/api/v1/tx/submit').send({ xdr: txXdr }).expect(202);

      mockRpc.getTransaction.mockResolvedValueOnce({
        status: rpc.Api.GetTransactionStatus.NOT_FOUND,
        txHash: knownHash,
        latestLedger: 700,
        latestLedgerCloseTime: 1700000300,
        oldestLedger: 1,
        oldestLedgerCloseTime: 1699990000,
      });

      const rKnown = await request(app).get(`/api/v1/tx/${knownHash}`);
      expect(rKnown.status).toBe(200);
      expect(rKnown.body).toEqual({
        hash: knownHash,
        status: 'PENDING',
        ledger: null,
        createdAt: null,
        function: 'cancel_contract',
        returnValue: null,
      });

      // Invalid hash rejected with 400
      await request(app).get('/api/v1/tx/not-a-64-hex-hash').expect(400);
    });
  });

  describe('Long-polling (?wait=true) with fake timers', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('polls every 1s: PENDING x3 then SUCCESS returns SUCCESS', async () => {
      const mockRpc: jest.Mocked<RpcClient> = {
        sendTransaction: jest.fn(),
        getTransaction: jest.fn(),
      };
      const relay = new TxRelay({ rpcClient: mockRpc });
      const hash = 'b'.repeat(64);
      relay.cache.set(hash, {
        hash,
        function: 'create_contract',
        submittedAt: '2026-01-01T00:00:00.000Z',
      });

      const pendingResp: rpc.Api.GetMissingTransactionResponse = {
        status: rpc.Api.GetTransactionStatus.NOT_FOUND,
        txHash: hash,
        latestLedger: 800,
        latestLedgerCloseTime: 1700000400,
        oldestLedger: 1,
        oldestLedgerCloseTime: 1699990000,
      };
      const successResp: rpc.Api.GetSuccessfulTransactionResponse = {
        status: rpc.Api.GetTransactionStatus.SUCCESS,
        txHash: hash,
        ledger: 803,
        createdAt: 1700000403,
        applicationOrder: 1,
        feeBump: false,
        envelopeXdr: {} as xdr.TransactionEnvelope,
        resultXdr: {} as xdr.TransactionResult,
        resultMetaXdr: {} as xdr.TransactionMeta,
        returnValue: nativeToScVal(19n, { type: 'u64' }),
        latestLedger: 803,
        latestLedgerCloseTime: 1700000403,
        oldestLedger: 1,
        oldestLedgerCloseTime: 1699990000,
      };

      mockRpc.getTransaction
        .mockResolvedValueOnce(pendingResp)
        .mockResolvedValueOnce(pendingResp)
        .mockResolvedValueOnce(pendingResp)
        .mockResolvedValueOnce(successResp);

      const waitPromise = relay.getStatusWithWait(hash, () => false);

      // Advance 3 polling intervals of 1s each
      await jest.advanceTimersByTimeAsync(1000);
      await jest.advanceTimersByTimeAsync(1000);
      await jest.advanceTimersByTimeAsync(1000);

      const result = await waitPromise;
      expect(mockRpc.getTransaction).toHaveBeenCalledTimes(4);
      expect(result).toEqual({
        hash,
        status: 'SUCCESS',
        ledger: 803,
        createdAt: 1700000403,
        function: 'create_contract',
        returnValue: '19',
      });
    });

    it('returns PENDING after 20s timeout when transaction never settles', async () => {
      const mockRpc: jest.Mocked<RpcClient> = {
        sendTransaction: jest.fn(),
        getTransaction: jest.fn(),
      };
      const relay = new TxRelay({ rpcClient: mockRpc });
      const hash = 'c'.repeat(64);
      relay.cache.set(hash, {
        hash,
        function: 'deposit_funds',
        submittedAt: '2026-01-01T00:00:00.000Z',
      });

      mockRpc.getTransaction.mockResolvedValue({
        status: rpc.Api.GetTransactionStatus.NOT_FOUND,
        txHash: hash,
        latestLedger: 810,
        latestLedgerCloseTime: 1700000500,
        oldestLedger: 1,
        oldestLedgerCloseTime: 1699990000,
      });

      const waitPromise = relay.getStatusWithWait(hash, () => false);
      await jest.advanceTimersByTimeAsync(20_000);

      const result = await waitPromise;
      expect(result.status).toBe('PENDING');
      expect(result.hash).toBe(hash);
      expect(result.function).toBe('deposit_funds');
    });

    it('stops polling immediately when client disconnects', async () => {
      const mockRpc: jest.Mocked<RpcClient> = {
        sendTransaction: jest.fn(),
        getTransaction: jest.fn(),
      };
      const relay = new TxRelay({ rpcClient: mockRpc });
      const hash = 'd'.repeat(64);

      mockRpc.getTransaction.mockResolvedValue({
        status: rpc.Api.GetTransactionStatus.NOT_FOUND,
        txHash: hash,
        latestLedger: 820,
        latestLedgerCloseTime: 1700000600,
        oldestLedger: 1,
        oldestLedgerCloseTime: 1699990000,
      });

      let aborted = false;
      let triggerAbort: (() => void) | undefined;
      const waitPromise = relay.getStatusWithWait(
        hash,
        () => aborted,
        (cb) => {
          triggerAbort = cb;
          return () => {};
        },
      );

      await jest.advanceTimersByTimeAsync(1500);
      aborted = true;
      if (triggerAbort) triggerAbort();

      const result = await waitPromise;
      expect(result.status).toBe('PENDING');
      // Only initial call + 1 poll after 1000ms (stopped at 1500ms)
      expect(mockRpc.getTransaction).toHaveBeenCalledTimes(2);
    });
  });

  describe('Bounded LRU cache & GET /api/v1/tx?limit=', () => {
    it('evicts oldest entry when at capacity and lists most recent first', async () => {
      const mockRpc: jest.Mocked<RpcClient> = {
        sendTransaction: jest.fn(),
        getTransaction: jest.fn(),
      };
      const relay = new TxRelay({ rpcClient: mockRpc, cacheMax: 3 });
      const app = createApp(new EscrowStore(), relay);

      const hashes: string[] = [];
      const fns: Array<(typeof ESCROW_MUTATING_FUNCTIONS)[number]> = [
        'create_contract',
        'deposit_funds',
        'release_milestone',
        'issue_reputation',
      ];

      for (const fn of fns) {
        const { xdr: txXdr, hash } = buildSignedEscrowTx({ fn });
        hashes.push(hash);
        mockRpc.sendTransaction.mockResolvedValueOnce({
          status: 'PENDING',
          hash,
          latestLedger: 900,
          latestLedgerCloseTime: 1700000900,
        });
        await request(app).post('/api/v1/tx/submit').send({ xdr: txXdr }).expect(202);
      }

      // Capacity is 3, so hashes[0] should have been evicted
      expect(relay.cache.size).toBe(3);
      expect(relay.cache.has(hashes[0])).toBe(false);
      expect(relay.cache.has(hashes[1])).toBe(true);
      expect(relay.cache.has(hashes[2])).toBe(true);
      expect(relay.cache.has(hashes[3])).toBe(true);

      const listAll = await request(app).get('/api/v1/tx').expect(200);
      expect(listAll.body.data.map((d: { hash: string }) => d.hash)).toEqual([
        hashes[3],
        hashes[2],
        hashes[1],
      ]);

      const listTwo = await request(app).get('/api/v1/tx?limit=2').expect(200);
      expect(listTwo.body.data).toHaveLength(2);
      expect(listTwo.body.data[0].hash).toBe(hashes[3]);
      expect(listTwo.body.data[0].function).toBe('issue_reputation');
      expect(typeof listTwo.body.data[0].submittedAt).toBe('string');

      await request(app).get('/api/v1/tx?limit=0').expect(400);
      await request(app).get('/api/v1/tx?limit=4').expect(400);

      // Direct unit check on BoundedLru refresh order
      const lru = new BoundedLru<string, number>(2);
      lru.set('a', 1);
      lru.set('b', 2);
      expect(lru.get('a')).toBe(1); // refreshes 'a', so 'b' becomes oldest
      lru.set('c', 3);
      expect(lru.has('b')).toBe(false);
      expect(lru.has('a')).toBe(true);
      expect(lru.has('c')).toBe(true);
    });
  });

  describe('OpenAPI documentation for transaction routes', () => {
    it('documents /api/v1/tx/submit, /api/v1/tx, and /api/v1/tx/{hash} in /openapi.json', async () => {
      const app = createApp(new EscrowStore());
      const res = await request(app).get('/openapi.json').expect(200);
      expect(res.body.openapi).toBe('3.0.3');
      expect(res.body.paths['/api/v1/tx/submit']?.post).toBeDefined();
      expect(res.body.paths['/api/v1/tx']?.get).toBeDefined();
      expect(res.body.paths['/api/v1/tx/{hash}']?.get).toBeDefined();
      expect(res.body.components.schemas.TxStatusResponse).toBeDefined();
      expect(res.body.components.schemas.RelayedTransaction).toBeDefined();
      expect(res.body.components.schemas.ContractError).toBeDefined();
    });
  });
});
