import {
  Address,
  FeeBumpTransaction,
  Keypair,
  Operation,
  Transaction,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import { config } from './config';
import { HttpError } from './store';

export const ESCROW_MUTATING_FUNCTIONS = [
  'initialize',
  'set_paused',
  'create_contract',
  'deposit_funds',
  'release_milestone',
  'open_dispute',
  'resolve_dispute',
  'cancel_contract',
  'issue_reputation',
] as const;

export type EscrowMutatingFunction = (typeof ESCROW_MUTATING_FUNCTIONS)[number];

const MUTATING_SET = new Set<string>(ESCROW_MUTATING_FUNCTIONS);

export const ESCROW_ERRORS: Record<number, string> = {
  1: 'AlreadyInitialized',
  2: 'NotInitialized',
  3: 'Unauthorized',
  4: 'Paused',
  5: 'ContractNotFound',
  6: 'InvalidParties',
  7: 'InvalidMilestones',
  8: 'InvalidAmount',
  9: 'OverFunded',
  10: 'InvalidStatus',
  11: 'MilestoneNotFound',
  12: 'MilestoneAlreadyReleased',
  13: 'InsufficientFunds',
  14: 'InvalidSplit',
  15: 'InvalidRating',
  16: 'ReputationAlreadyIssued',
};

export interface RelayedTxEntry {
  hash: string;
  function: string;
  submittedAt: string;
}

export class BoundedLru<K, V> {
  private map = new Map<K, V>();

  constructor(public readonly maxSize: number = config.txCacheMax) {
    if (!Number.isInteger(maxSize) || maxSize < 1) {
      throw new Error('maxSize must be a positive integer');
    }
  }

  get(key: K): V | undefined {
    const val = this.map.get(key);
    if (val !== undefined) {
      this.map.delete(key);
      this.map.set(key, val);
    }
    return val;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) {
        this.map.delete(oldestKey);
      }
    }
    this.map.set(key, value);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  get size(): number {
    return this.map.size;
  }

  valuesMostRecentFirst(limit?: number): V[] {
    const all = [...this.map.values()].reverse();
    return limit !== undefined ? all.slice(0, limit) : all;
  }
}

export interface RpcClient {
  sendTransaction(tx: Transaction | FeeBumpTransaction): Promise<rpc.Api.SendTransactionResponse>;
  getTransaction(hash: string): Promise<rpc.Api.GetTransactionResponse>;
}

export interface ValidatedEscrowTx {
  envelope: Transaction | FeeBumpTransaction;
  innerTx: Transaction;
  hash: string;
  contractId: string;
  functionName: EscrowMutatingFunction;
}

function hasValidSignatureForAccount(
  accountOrMuxed: string,
  txHash: Buffer,
  signatures: xdr.DecoratedSignature[],
): boolean {
  let kp: Keypair;
  try {
    kp = Keypair.fromPublicKey(accountOrMuxed);
  } catch {
    return true;
  }
  const expectedHint = kp.signatureHint();
  const matchingHintSigs = signatures.filter((sig) => sig.hint().equals(expectedHint));
  if (matchingHintSigs.length === 0) {
    return false;
  }
  return matchingHintSigs.some((sig) => kp.verify(txHash, sig.signature()));
}

export function extractInvokeInfo(tx: Transaction | FeeBumpTransaction): {
  contractId: string;
  functionName: string;
} | null {
  try {
    const inner = tx instanceof FeeBumpTransaction ? tx.innerTransaction : tx;
    if (inner.operations.length !== 1) return null;
    const op = inner.operations[0] as Operation.InvokeHostFunction;
    if (op.type !== 'invokeHostFunction' || !op.func) return null;
    if (op.func.switch().name !== 'hostFunctionTypeInvokeContract') return null;
    const invoke = op.func.invokeContract();
    const contractId = Address.fromScAddress(invoke.contractAddress()).toString();
    const rawFn = invoke.functionName();
    const functionName = Buffer.isBuffer(rawFn) ? rawFn.toString('utf8') : String(rawFn);
    return { contractId, functionName };
  } catch {
    return null;
  }
}

export function validateSignedEscrowTx(
  xdrString: unknown,
  opts: {
    networkPassphrase?: string;
    contractId?: string;
    nowSeconds?: number;
  } = {},
): ValidatedEscrowTx {
  if (typeof xdrString !== 'string' || !xdrString.trim()) {
    throw new HttpError(400, 'invalid_transaction', 'xdr must be a non-empty base64 string');
  }

  const networkPassphrase = opts.networkPassphrase ?? config.networkPassphrase;
  const expectedContractId = opts.contractId ?? config.contractId;
  const nowSeconds = opts.nowSeconds ?? Math.floor(Date.now() / 1000);

  let parsed: Transaction | FeeBumpTransaction;
  try {
    parsed = TransactionBuilder.fromXDR(xdrString.trim(), networkPassphrase);
  } catch {
    throw new HttpError(400, 'invalid_transaction', 'Failed to decode transaction XDR');
  }

  let innerTx: Transaction;
  if (parsed instanceof FeeBumpTransaction) {
    if (!parsed.signatures || parsed.signatures.length === 0) {
      throw new HttpError(400, 'invalid_transaction', 'Fee-bump envelope has no signatures');
    }
    if (!hasValidSignatureForAccount(parsed.feeSource, parsed.hash(), parsed.signatures)) {
      throw new HttpError(
        400,
        'invalid_transaction',
        'Invalid fee-bump signature for configured network passphrase',
      );
    }
    innerTx = parsed.innerTransaction;
  } else {
    innerTx = parsed;
  }

  if (!innerTx.signatures || innerTx.signatures.length === 0) {
    throw new HttpError(400, 'invalid_transaction', 'Transaction has no signatures');
  }

  if (!hasValidSignatureForAccount(innerTx.source, innerTx.hash(), innerTx.signatures)) {
    throw new HttpError(
      400,
      'invalid_transaction',
      'Invalid transaction signature for configured network passphrase',
    );
  }

  const tb = innerTx.timeBounds;
  if (!tb || !tb.maxTime || tb.maxTime === '0') {
    throw new HttpError(400, 'invalid_transaction', 'Transaction timebounds are missing or unbounded');
  }
  const maxTime = Number(tb.maxTime);
  if (!Number.isFinite(maxTime) || maxTime <= nowSeconds) {
    throw new HttpError(400, 'invalid_transaction', 'Transaction timebounds have already expired');
  }

  if (innerTx.operations.length !== 1) {
    throw new HttpError(
      400,
      'invalid_transaction',
      'Transaction must contain exactly one operation',
    );
  }

  const op = innerTx.operations[0] as Operation.InvokeHostFunction;
  if (op.type !== 'invokeHostFunction' || !op.func) {
    throw new HttpError(
      400,
      'invalid_transaction',
      'Operation must be invokeHostFunction',
    );
  }

  if (op.func.switch().name !== 'hostFunctionTypeInvokeContract') {
    throw new HttpError(
      400,
      'invalid_transaction',
      'Host function must invoke a contract',
    );
  }

  const invoke = op.func.invokeContract();
  let contractId: string;
  try {
    contractId = Address.fromScAddress(invoke.contractAddress()).toString();
  } catch {
    throw new HttpError(400, 'invalid_transaction', 'Invalid target contract address');
  }

  if (contractId !== expectedContractId) {
    throw new HttpError(
      400,
      'invalid_transaction',
      `Target contract ${contractId} does not match configured escrow contract`,
    );
  }

  const rawFn = invoke.functionName();
  const functionName = Buffer.isBuffer(rawFn) ? rawFn.toString('utf8') : String(rawFn);
  if (!MUTATING_SET.has(functionName)) {
    throw new HttpError(
      400,
      'invalid_transaction',
      `Function "${functionName}" is not an allowed escrow mutating function`,
    );
  }

  return {
    envelope: parsed,
    innerTx,
    hash: parsed.hash().toString('hex'),
    contractId,
    functionName: functionName as EscrowMutatingFunction,
  };
}

export function serializeNativeValue(val: unknown): unknown {
  if (typeof val === 'bigint') {
    return val.toString();
  }
  if (Array.isArray(val)) {
    return val.map(serializeNativeValue);
  }
  if (val instanceof Uint8Array || Buffer.isBuffer(val)) {
    return Buffer.from(val).toString('hex');
  }
  if (val && typeof val === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val)) {
      out[k] = serializeNativeValue(v);
    }
    return out;
  }
  return val;
}

export function decodeReturnValue(scVal?: xdr.ScVal): unknown {
  if (!scVal) return null;
  if (scVal.switch().name === 'scvVoid') return null;
  const native = scValToNative(scVal);
  return serializeNativeValue(native);
}

export interface ContractErrorInfo {
  name: string;
  code: number;
}

function extractContractErrorCodeFromScVal(scVal?: xdr.ScVal | null): number | null {
  if (!scVal) return null;
  try {
    if (scVal.switch().name === 'scvError') {
      const err = scVal.error();
      if (err.switch().name === 'sceContract') {
        return err.contractCode();
      }
    }
  } catch {
    // ignore malformed ScVal
  }
  return null;
}

function extractContractErrorCodeFromEvents(events?: xdr.DiagnosticEvent[]): number | null {
  if (!events) return null;
  for (const diag of events) {
    try {
      const evt = diag.event();
      const v0 = evt.body().v0();
      for (const topic of v0.topics()) {
        const code = extractContractErrorCodeFromScVal(topic);
        if (code !== null) return code;
      }
      const dataCode = extractContractErrorCodeFromScVal(v0.data());
      if (dataCode !== null) return dataCode;
    } catch {
      // ignore
    }
  }
  return null;
}

export function decodeContractError(
  txResp: rpc.Api.GetTransactionResponse,
): ContractErrorInfo | undefined {
  if (txResp.status !== rpc.Api.GetTransactionStatus.FAILED) {
    return undefined;
  }
  const failed = txResp as rpc.Api.GetFailedTransactionResponse & {
    returnValue?: xdr.ScVal;
    diagnosticEvents?: xdr.DiagnosticEvent[];
  };

  let code: number | null = null;

  if (failed.returnValue) {
    code = extractContractErrorCodeFromScVal(failed.returnValue);
  }

  if (code === null && failed.resultMetaXdr) {
    try {
      const meta =
        typeof (failed.resultMetaXdr as unknown) === 'string'
          ? xdr.TransactionMeta.fromXDR(failed.resultMetaXdr as unknown as string, 'base64')
          : failed.resultMetaXdr;
      if (meta.switch() === 3 && meta.v3().sorobanMeta()) {
        const sMeta = meta.v3().sorobanMeta()!;
        code = extractContractErrorCodeFromScVal(sMeta.returnValue());
        if (code === null) {
          code = extractContractErrorCodeFromEvents(sMeta.diagnosticEvents());
        }
      }
    } catch {
      // ignore
    }
  }

  if (code === null) {
    const rawEvents = failed.diagnosticEventsXdr ?? failed.diagnosticEvents;
    if (Array.isArray(rawEvents)) {
      const parsedEvents = rawEvents
        .map((e) => {
          try {
            return typeof (e as unknown) === 'string'
              ? xdr.DiagnosticEvent.fromXDR(e as unknown as string, 'base64')
              : e;
          } catch {
            return null;
          }
        })
        .filter((e): e is xdr.DiagnosticEvent => e !== null);
      code = extractContractErrorCodeFromEvents(parsedEvents);
    }
  }

  if (code === null) return undefined;
  return {
    code,
    name: ESCROW_ERRORS[code] ?? `UnknownError(${code})`,
  };
}

export function decodeTxErrorResultCode(
  errorResult?: xdr.TransactionResult | string,
): string {
  if (!errorResult) return 'txFailed';
  try {
    const parsed =
      typeof errorResult === 'string'
        ? xdr.TransactionResult.fromXDR(errorResult, 'base64')
        : errorResult;
    const outerSwitch = parsed.result().switch().name;
    if (outerSwitch === 'txFeeBumpInnerFailed') {
      const innerPair = parsed.result().innerResultPair();
      return innerPair.result().result().switch().name;
    }
    return outerSwitch;
  } catch {
    return 'txFailed';
  }
}

export interface TxStatusResponse {
  hash: string;
  status: 'PENDING' | 'SUCCESS' | 'FAILED' | 'NOT_FOUND';
  ledger: number | null;
  createdAt: number | string | null;
  function: string | null;
  returnValue: unknown;
  contractError?: ContractErrorInfo;
}

const DEFAULT_WAIT_TIMEOUT_MS = 20_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_MAX_CONCURRENT_WAITS = 25;

export interface TxRelayOptions {
  rpcClient?: RpcClient;
  cacheMax?: number;
  networkPassphrase?: string;
  contractId?: string;
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
  maxConcurrentWaits?: number;
  retryAfterSeconds?: number;
}

export class TxRelay {
  public readonly cache: BoundedLru<string, RelayedTxEntry>;
  private rpcClient?: RpcClient;
  private readonly networkPassphrase?: string;
  private readonly contractId?: string;
  private readonly waitTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly maxConcurrentWaits: number;
  public readonly retryAfterSeconds: number;
  private activeWaits = 0;

  constructor(opts: TxRelayOptions = {}) {
    this.cache = new BoundedLru<string, RelayedTxEntry>(opts.cacheMax ?? config.txCacheMax);
    this.rpcClient = opts.rpcClient;
    this.networkPassphrase = opts.networkPassphrase;
    this.contractId = opts.contractId;
    this.waitTimeoutMs = opts.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxConcurrentWaits = opts.maxConcurrentWaits ?? DEFAULT_MAX_CONCURRENT_WAITS;
    this.retryAfterSeconds = opts.retryAfterSeconds ?? 5;
  }

  private getRpc(): RpcClient {
    if (!this.rpcClient) {
      this.rpcClient = new rpc.Server(config.rpcUrl, {
        allowHttp: config.rpcUrl.startsWith('http://'),
      });
    }
    return this.rpcClient;
  }

  async submit(xdrString: unknown): Promise<{
    httpStatus: number;
    retryAfter?: number;
    body: Record<string, unknown>;
  }> {
    const validated = validateSignedEscrowTx(xdrString, {
      networkPassphrase: this.networkPassphrase,
      contractId: this.contractId,
    });

    const sendResp = await this.getRpc().sendTransaction(validated.envelope);
    const hash = (sendResp.hash || validated.hash).toLowerCase();

    const remember = () => {
      const existing = this.cache.get(hash);
      this.cache.set(hash, {
        hash,
        function: validated.functionName,
        submittedAt: existing?.submittedAt ?? new Date().toISOString(),
      });
    };

    switch (sendResp.status) {
      case 'PENDING': {
        remember();
        return {
          httpStatus: 202,
          body: { hash, status: 'PENDING' },
        };
      }
      case 'DUPLICATE': {
        remember();
        try {
          const current = await this.getStatus(hash);
          return {
            httpStatus: 200,
            body: current as unknown as Record<string, unknown>,
          };
        } catch {
          return {
            httpStatus: 200,
            body: { hash, status: 'PENDING' },
          };
        }
      }
      case 'TRY_AGAIN_LATER': {
        return {
          httpStatus: 503,
          retryAfter: this.retryAfterSeconds,
          body: {
            error: 'try_again_later',
            message: 'Soroban RPC is busy; please retry after the indicated delay',
            hash,
            status: 'TRY_AGAIN_LATER',
          },
        };
      }
      case 'ERROR': {
        const rawErr =
          sendResp.errorResult ??
          (sendResp as unknown as { errorResultXdr?: string }).errorResultXdr;
        const code = decodeTxErrorResultCode(rawErr);
        throw new HttpError(
          422,
          'submission_failed',
          `Transaction rejected by RPC: ${code}`,
          { code, hash },
        );
      }
      default: {
        throw new HttpError(502, 'rpc_error', `Unexpected sendTransaction status: ${String(sendResp.status)}`);
      }
    }
  }

  async getStatus(hash: string): Promise<TxStatusResponse> {
    const normalizedHash = hash.toLowerCase();
    const cached = this.cache.get(normalizedHash) ?? this.cache.get(hash);
    const rpcResp = await this.getRpc().getTransaction(normalizedHash);

    const rawStatus = rpcResp.status as string;
    let status: 'PENDING' | 'SUCCESS' | 'FAILED' | 'NOT_FOUND';
    if (rawStatus === rpc.Api.GetTransactionStatus.SUCCESS || rawStatus === 'SUCCESS') {
      status = 'SUCCESS';
    } else if (rawStatus === rpc.Api.GetTransactionStatus.FAILED || rawStatus === 'FAILED') {
      status = 'FAILED';
    } else if (rawStatus === 'PENDING') {
      status = 'PENDING';
    } else {
      status = cached ? 'PENDING' : 'NOT_FOUND';
    }

    let fnName: string | null = cached?.function ?? null;
    if (!fnName && 'envelopeXdr' in rpcResp && rpcResp.envelopeXdr) {
      try {
        const envXdr =
          typeof (rpcResp.envelopeXdr as unknown) === 'string'
            ? (rpcResp.envelopeXdr as unknown as string)
            : rpcResp.envelopeXdr.toXDR('base64');
        const parsedEnv = TransactionBuilder.fromXDR(
          envXdr,
          this.networkPassphrase ?? config.networkPassphrase,
        );
        const info = extractInvokeInfo(parsedEnv);
        if (info) fnName = info.functionName;
      } catch {
        // ignore
      }
    }

    const ledger = 'ledger' in rpcResp && rpcResp.ledger !== undefined ? rpcResp.ledger : null;
    const createdAt =
      'createdAt' in rpcResp && rpcResp.createdAt !== undefined ? rpcResp.createdAt : null;

    let returnValue: unknown = null;
    if (status === 'SUCCESS') {
      const successResp = rpcResp as rpc.Api.GetSuccessfulTransactionResponse;
      let scVal = successResp.returnValue;
      if (!scVal && successResp.resultMetaXdr) {
        try {
          const meta =
            typeof (successResp.resultMetaXdr as unknown) === 'string'
              ? xdr.TransactionMeta.fromXDR(successResp.resultMetaXdr as unknown as string, 'base64')
              : successResp.resultMetaXdr;
          if (meta.switch() === 3 && meta.v3().sorobanMeta()) {
            scVal = meta.v3().sorobanMeta()!.returnValue();
          }
        } catch {
          // ignore
        }
      }
      returnValue = decodeReturnValue(scVal);
    }

    const response: TxStatusResponse = {
      hash: normalizedHash,
      status,
      ledger,
      createdAt,
      function: fnName,
      returnValue,
    };

    if (status === 'FAILED') {
      const contractError = decodeContractError(rpcResp);
      if (contractError) {
        response.contractError = contractError;
      }
    }

    return response;
  }

  async getStatusWithWait(
    hash: string,
    isAborted: () => boolean,
    onAbortSubscribe?: (cb: () => void) => () => void,
  ): Promise<TxStatusResponse> {
    if (this.activeWaits >= this.maxConcurrentWaits) {
      throw new HttpError(503, 'too_many_waits', 'Too many concurrent long-poll requests');
    }

    this.activeWaits++;
    try {
      const started = Date.now();
      let current = await this.getStatus(hash);

      while (
        (current.status === 'PENDING' || current.status === 'NOT_FOUND') &&
        !isAborted() &&
        Date.now() - started < this.waitTimeoutMs
      ) {
        const remaining = this.waitTimeoutMs - (Date.now() - started);
        const delay = Math.min(this.pollIntervalMs, Math.max(0, remaining));
        if (delay <= 0) break;

        await new Promise<void>((resolve) => {
          let unsubscribe: (() => void) | undefined;
          const timer = setTimeout(() => {
            if (unsubscribe) unsubscribe();
            resolve();
          }, delay);

          if (onAbortSubscribe) {
            unsubscribe = onAbortSubscribe(() => {
              clearTimeout(timer);
              if (unsubscribe) unsubscribe();
              resolve();
            });
          }
        });

        if (isAborted()) break;
        current = await this.getStatus(hash);
      }

      if (current.status === 'NOT_FOUND') {
        return {
          ...current,
          status: 'PENDING',
        };
      }
      return current;
    } finally {
      this.activeWaits--;
    }
  }

  listRecent(limitRaw?: unknown): RelayedTxEntry[] {
    let limit = 20;
    if (limitRaw !== undefined && limitRaw !== '') {
      const n = Number(limitRaw);
      if (!Number.isInteger(n) || n < 1 || n > this.cache.maxSize) {
        throw new HttpError(
          400,
          'invalid_limit',
          `limit must be an integer between 1 and ${this.cache.maxSize}`,
        );
      }
      limit = n;
    }
    return this.cache.valuesMostRecentFirst(limit);
  }
}
