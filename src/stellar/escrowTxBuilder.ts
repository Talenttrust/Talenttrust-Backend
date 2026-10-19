import {
  Address,
  BASE_FEE,
  Contract,
  nativeToScVal,
  Networks,
  rpc,
  StrKey,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import { z } from 'zod';
import { config } from '../config';
import { contractErrorFromMessage } from './escrowErrors';

const I128_MIN = -(1n << 127n);
const I128_MAX = (1n << 127n) - 1n;
const U64_MAX = (1n << 64n) - 1n;
const DECIMAL = /^-?(0|[1-9]\d*)$/;
const UNSIGNED_DECIMAL = /^(0|[1-9]\d*)$/;

const addressSchema = z.string().refine((value) => {
  try {
    Address.fromString(value);
    return true;
  } catch {
    return false;
  }
}, 'must be a valid Stellar address');

const i128Schema = z.string().refine((value) => {
  if (!DECIMAL.test(value)) return false;
  const integer = BigInt(value);
  return integer >= I128_MIN && integer <= I128_MAX;
}, 'must be a decimal string within i128 range');

const u64Schema = z.string().refine((value) => {
  if (!UNSIGNED_DECIMAL.test(value)) return false;
  const integer = BigInt(value);
  return integer > 0n && integer <= U64_MAX;
}, 'must be a positive decimal string within u64 range');

const actionSchemas = {
  create_contract: z.object({
    client: addressSchema,
    freelancer: addressSchema,
    token: addressSchema,
    milestoneAmounts: z.array(i128Schema).min(1).max(20),
  }).strict(),
  deposit_funds: z.object({ id: u64Schema, amount: i128Schema }).strict(),
  release_milestone: z.object({
    id: u64Schema,
    index: z.number().int().nonnegative().max(0xffff_ffff),
  }).strict(),
  open_dispute: z.object({ id: u64Schema, caller: addressSchema }).strict(),
  cancel_contract: z.object({ id: u64Schema }).strict(),
  issue_reputation: z.object({
    id: u64Schema,
    rating: z.number().int().nonnegative().max(0xffff_ffff),
  }).strict(),
};

export type BuildTransactionRequest =
  | { action: 'create_contract'; source: string; args: z.infer<typeof actionSchemas.create_contract> }
  | { action: 'deposit_funds'; source: string; args: z.infer<typeof actionSchemas.deposit_funds> }
  | { action: 'release_milestone'; source: string; args: z.infer<typeof actionSchemas.release_milestone> }
  | { action: 'open_dispute'; source: string; args: z.infer<typeof actionSchemas.open_dispute> }
  | { action: 'cancel_contract'; source: string; args: z.infer<typeof actionSchemas.cancel_contract> }
  | { action: 'issue_reputation'; source: string; args: z.infer<typeof actionSchemas.issue_reputation> };

export class TxBuildError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public contractError?: { name: string; code: number },
  ) {
    super(message);
  }
}

type RpcClient = Pick<rpc.Server, 'getAccount' | 'simulateTransaction'>;

export interface BuiltTransaction {
  xdr: string;
  networkPassphrase: string;
  fee: { inclusion: string; resource: string; total: string };
  minResourceFee: string;
  latestLedger: number;
  expiresAt: string;
  authRequired: string[];
}

function validateRequest(input: unknown): BuildTransactionRequest {
  if (input && typeof input === 'object' && 'action' in input) {
    const action = (input as { action?: unknown }).action;
    if (action === 'resolve_dispute' || action === 'set_paused') {
      throw new TxBuildError(403, 'admin_action_not_buildable', 'Admin-only actions cannot be built by this API');
    }
  }

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TxBuildError(400, 'invalid_action', 'Request body must be an object');
  }
  const body = input as Record<string, unknown>;
  const allowedKeys = ['action', 'source', 'args'];
  if (Object.keys(body).some((key) => !allowedKeys.includes(key))) {
    throw new TxBuildError(400, 'invalid_action', 'Request body contains unsupported fields');
  }
  const actionName = body.action;
  if (typeof actionName !== 'string' || !Object.prototype.hasOwnProperty.call(actionSchemas, actionName)) {
    throw new TxBuildError(400, 'invalid_action', 'action is not buildable');
  }
  const action = actionName as keyof typeof actionSchemas;
  const source = addressSchema.safeParse(body.source);
  if (!source.success) {
    throw new TxBuildError(400, 'invalid_source', source.error.issues.map((issue) => issue.message).join('; '));
  }
  const args = actionSchemas[action].safeParse(body.args);
  if (!args.success) {
    throw new TxBuildError(
      400,
      'invalid_args',
      args.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
    );
  }
  return { action, source: source.data, args: args.data } as BuildTransactionRequest;
}

function asScAddress(value: string) {
  return Address.fromString(value).toScVal();
}

function makeOperation(contract: Contract, request: BuildTransactionRequest) {
  const { action, args } = request;
  switch (action) {
    case 'create_contract':
      return contract.call(
        action,
        asScAddress(args.client),
        asScAddress(args.freelancer),
        asScAddress(args.token),
        nativeToScVal(args.milestoneAmounts.map(BigInt), { type: 'i128' }),
      );
    case 'deposit_funds':
      return contract.call(action, nativeToScVal(BigInt(args.id), { type: 'u64' }), nativeToScVal(BigInt(args.amount), { type: 'i128' }));
    case 'release_milestone':
      return contract.call(
        action,
        nativeToScVal(BigInt(args.id), { type: 'u64' }),
        nativeToScVal(args.index, { type: 'u32' }),
      );
    case 'open_dispute':
      return contract.call(action, nativeToScVal(BigInt(args.id), { type: 'u64' }), asScAddress(args.caller));
    case 'cancel_contract':
      return contract.call(action, nativeToScVal(BigInt(args.id), { type: 'u64' }));
    case 'issue_reputation':
      return contract.call(
        action,
        nativeToScVal(BigInt(args.id), { type: 'u64' }),
        nativeToScVal(args.rating, { type: 'u32' }),
      );
  }
}

function authorizationDetails(entries: xdr.SorobanAuthorizationEntry[], source: string) {
  const authRequired: string[] = [];
  let sourceAuthorized = false;
  for (const entry of entries) {
    const credentials = entry.credentials();
    const credentialType = credentials['switch']().value;
    if (credentialType === xdr.SorobanCredentialsType.sorobanCredentialsSourceAccount().value) {
      sourceAuthorized = true;
      continue;
    }
    if (credentialType === xdr.SorobanCredentialsType.sorobanCredentialsAddress().value) {
      authRequired.push(Address.fromScAddress(credentials.address().address()).toString());
    }
  }
  const unique = [...new Set(authRequired)];
  return { authRequired: unique, sourceAuthorized: sourceAuthorized || unique.includes(source) };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isMissingAccount(error: unknown) {
  const candidate = error as { status?: number; response?: { status?: number }; message?: string };
  return candidate?.status === 404 || candidate?.response?.status === 404 ||
    /account.{0,30}(not found|does not exist)|(not found|does not exist).{0,30}account/i.test(errorMessage(error));
}

export async function buildEscrowTransaction(
  input: unknown,
  options: { server?: RpcClient; networkPassphrase?: string; timeoutSeconds?: number } = {},
): Promise<BuiltTransaction> {
  const request = validateRequest(input);
  if (!StrKey.isValidEd25519PublicKey(request.source)) {
    throw new TxBuildError(400, 'invalid_source', 'source must be a Stellar account address');
  }
  if (request.action === 'create_contract' && request.source !== request.args.client) {
    throw new TxBuildError(400, 'source_mismatch', 'source must match args.client for create_contract');
  }
  if (request.action === 'open_dispute' && request.source !== request.args.caller) {
    throw new TxBuildError(400, 'source_mismatch', 'source must match args.caller for open_dispute');
  }

  const networkPassphrase = options.networkPassphrase ??
    process.env.STELLAR_NETWORK_PASSPHRASE ??
    (config.network === 'mainnet' || config.network === 'public' ? Networks.PUBLIC : Networks.TESTNET);
  const timeoutSeconds = options.timeoutSeconds ?? config.txTimeoutSeconds;
  const server = options.server ?? new rpc.Server(config.rpcUrl);

  try {
    const account = await server.getAccount(request.source);
    const rawTransaction = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
      .addOperation(makeOperation(new Contract(config.contractId), request))
      .setTimeout(timeoutSeconds)
      .build();
    const simulation = await server.simulateTransaction(rawTransaction);
    if (rpc.Api.isSimulationError(simulation)) {
      const contractError = contractErrorFromMessage(simulation.error);
      if (contractError) {
        throw new TxBuildError(422, 'contract_error', contractError.name, contractError);
      }
      throw new TxBuildError(422, 'simulation_failed', simulation.error);
    }

    const auth = authorizationDetails(simulation.result?.auth ?? [], request.source);
    if (!auth.sourceAuthorized) {
      throw new TxBuildError(400, 'source_mismatch', 'source does not match the party required by the contract');
    }

    const assembled = rpc.assembleTransaction(rawTransaction, simulation).build();
    const resource = BigInt(simulation.minResourceFee).toString();
    const total = BigInt(assembled.fee).toString();
    const inclusion = (BigInt(total) > BigInt(resource) ? BigInt(total) - BigInt(resource) : BigInt(BASE_FEE)).toString();
    return {
      xdr: assembled.toXDR(),
      networkPassphrase,
      fee: { inclusion, resource, total },
      minResourceFee: resource,
      latestLedger: simulation.latestLedger,
      expiresAt: new Date(Date.now() + timeoutSeconds * 1000).toISOString(),
      authRequired: auth.authRequired,
    };
  } catch (error) {
    if (error instanceof TxBuildError) throw error;
    if (isMissingAccount(error)) {
      throw new TxBuildError(404, 'source_account_not_found', 'Source account was not found');
    }
    throw new TxBuildError(503, 'chain_unavailable', 'Stellar RPC is unavailable');
  }
}