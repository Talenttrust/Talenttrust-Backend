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
});
