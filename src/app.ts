import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { config, explorerUrl } from './config';
import { EscrowStore, HttpError } from './store';
import { openapi, docsHtml } from './openapi';
import { validate } from './validation/middleware';
import {
  IdParam,
  MilestoneIndexParam,
  MilestoneReleaseParams,
  CreateContractBody,
  DepositBody,
  DisputeBody,
  ResolveBody,
  RateBody,
  CancelBody,
  ListQuery,
  ReputationAddressParam,
} from './validation/schemas';
import { parseFieldSpec, project } from './utils/project';
import { createLogger, type Logger, randomUUID } from './logger';
import { ChainReader, SorobanRpcChainReader } from './chain';
import { buildEscrowTransaction, TxBuildError, type RpcClient } from './stellar/escrowTxBuilder';
import { bigIntReplacer } from './amount';
import { StrKey, Keypair } from '@stellar/stellar-sdk';
import { randomBytes } from 'crypto';
import { buildChallenge, verifyChallenge, consumeNonce } from './auth/challenge';
import { issueWalletToken } from './auth/jwt';
import { createRequireAuth, WalletAuthRequest } from './auth/middleware';
import { ReceiptManager, hashContractState, verifyReceipt } from './receipts';

declare global {
  namespace Express {
    interface Request {
      id?: string;
    }
  }
}
import { idempotency, IdempotencyStore, MemoryIdempotencyStore } from './idempotency';

const startedAt = Date.now();

type LoggerLevel = 'debug' | 'info' | 'warn' | 'error';

type Handler = (req: Request, res: Response) => unknown | Promise<unknown>;
const wrap = (fn: Handler) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    const out = await fn(req, res);
    if (out !== undefined && !res.headersSent) {
      // Use bigIntReplacer so bigint amounts serialise as decimal strings
      // and JSON.stringify never throws on a response. Go through res.json so
      // middleware that wraps it (idempotency replay) still sees the body.
      res.json(JSON.parse(JSON.stringify(out, bigIntReplacer)));
    }
  } catch (err) {
    next(err);
  }
};

const id = (req: Request) => {
  const n = Number(req.params.id);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'invalid_id', 'id must be a positive integer');
  return n;
};

const optionalString = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : undefined);

/**
 * Parse the `?fields=` query param.  Returns `null` when the param is absent
 * (meaning "return all fields").  Throws {@link HttpError} 400 on invalid input.
 */
function parseFields(req: Request) {
  const raw = req.query.fields;
  if (typeof raw !== 'string') return null;
  return parseFieldSpec(raw);
}

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,128}$/;

/** Validate that a string is a valid Stellar ed25519 public key (G…). */
function isValidStellarAddress(addr: unknown): addr is string {
  return typeof addr === 'string' && StrKey.isValidEd25519PublicKey(addr);
}

/** Authenticated wallet address, if the request carried a valid bearer token. */
const callerOf = (req: Request): string | undefined => (req as WalletAuthRequest).auth?.address;

/** Dependencies that can be injected via createApp's first argument. */
export type AppDeps = {
  logger?: Logger;
  store?: EscrowStore;
  chainReader?: ChainReader;
  txRpcServer?: RpcClient;
  /** Secret for wallet-auth challenges and JWTs. Passing it enforces auth unless `authRequired: false`. */
  authSecret?: string;
  /** Force wallet auth on (true) or off (false) for mutating routes. */
  authRequired?: boolean;
  /** Injectable clock for auth (tests). */
  now?: () => number;
  /** Signs contract-state receipts; defaults to RECEIPT_SIGNING_SECRET or an ephemeral key. */
  receiptManager?: ReceiptManager;
};

/**
 * Wallet auth is enforced when a secret is configured (AUTH_SECRET or the
 * `authSecret` dep) or AUTH_REQUIRED=true. Without a secret a random
 * per-process one is used so the challenge/token flow still works, and
 * unauthenticated requests keep the legacy behaviour.
 */
function resolveAuth(deps: AppDeps) {
  const configured = deps.authSecret ?? process.env.AUTH_SECRET;
  const secret = configured || randomBytes(32).toString('base64');
  const required = deps.authRequired ?? (Boolean(configured) || process.env.AUTH_REQUIRED === 'true');
  return { secret, required, now: deps.now ?? Date.now };
}

function resolveStoreAndLogger(
  storeOrOpts: EscrowStore | AppDeps = new EscrowStore().seed(),
): { store: EscrowStore; logger: Logger; chainReader: ChainReader; txRpcServer?: RpcClient } {
  if (
    storeOrOpts &&
    typeof storeOrOpts === 'object' &&
    'list' in storeOrOpts &&
    typeof (storeOrOpts as EscrowStore).list === 'function'
  ) {
    return { store: storeOrOpts as EscrowStore, logger: createLogger(), chainReader: new SorobanRpcChainReader() };
  }
  const opts = (storeOrOpts as AppDeps | undefined) ?? {};
  return {
    store: opts.store ?? new EscrowStore().seed(),
    logger: opts.logger ?? createLogger(),
    chainReader: opts.chainReader ?? new SorobanRpcChainReader(),
    txRpcServer: opts.txRpcServer,
  };
}

export interface AppOptions {
  idempotencyStore?: IdempotencyStore;
  idempotencyRequired?: boolean;
  receiptManager?: ReceiptManager;
}

export function createApp(
  storeOrOpts: EscrowStore | AppDeps = new EscrowStore().seed(),
  fallbackChainReaderOrReceiptManager?: ChainReader | ReceiptManager,
  options: AppOptions = {},
) {
  const resolved = resolveStoreAndLogger(storeOrOpts);
  const store = resolved.store;
  const logger = resolved.logger;
  const second = fallbackChainReaderOrReceiptManager;
  const chainReader = second instanceof ReceiptManager ? resolved.chainReader : (second ?? resolved.chainReader);
  const txRpcServer = resolved.txRpcServer;
  const isDeps = !(storeOrOpts && typeof (storeOrOpts as EscrowStore).list === 'function');
  const deps: AppDeps = isDeps ? ((storeOrOpts as AppDeps | undefined) ?? {}) : {};
  const auth = resolveAuth(deps);
  // Created lazily so apps that never sign receipts don't generate a key (or warn).
  let receiptManagerInstance: ReceiptManager | undefined =
    second instanceof ReceiptManager ? second : (options.receiptManager ?? deps.receiptManager);
  const receiptManager = () =>
    (receiptManagerInstance ??= new ReceiptManager(process.env.RECEIPT_SIGNING_SECRET));
  const requireAuth = createRequireAuth(auth.secret, auth.now, auth.required);

  const app = express();
  app.disable('x-powered-by');
  // Correlation id: echo a valid inbound X-Request-Id, otherwise generate one.
  // The regex excludes CR/LF so a client cannot inject log-line terminators.
  app.use((req, res, next) => {
    const incoming = req.headers['x-request-id'];
    const value = Array.isArray(incoming) ? incoming[0] : incoming;
    const requestId = value && REQUEST_ID_RE.test(value) ? (value as string) : randomUUID();
    req.id = requestId;
    res.set('X-Request-Id', requestId);
    next();
  });

  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors());

  // Compression middleware: gzip/br for JSON responses ≥ 1 KB.
  // Excluded for text/event-stream and when Cache-Control: no-transform is set.
  app.use(
    compression({
      threshold: 1024, // bytes — skip compression for small responses
      filter(req, res) {
        // Honour Cache-Control: no-transform (RFC 7234 §5.2.1.6)
        const cc = res.getHeader('Cache-Control');
        if (typeof cc === 'string' && cc.includes('no-transform')) return false;
        // Never compress streaming responses
        const ct = res.getHeader('Content-Type');
        if (typeof ct === 'string' && ct.includes('text/event-stream')) return false;
        return compression.filter(req, res);
      },
    }),
  );

  app.use(express.json({ limit: '100kb' }));

  // Structured access log on response finish.
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const durationMs = Date.now() - start;
      const route = req.route ? req.baseUrl + req.route.path : 'unmatched';
      let level: LoggerLevel = 'info';
      if (res.statusCode >= 500) level = 'error';
      else if (res.statusCode >= 429) level = 'warn';
      logger[level]('request', {
        method: req.method,
        path: route,
        status: res.statusCode,
        durationMs,
        contentLength: res.get('content-length') ?? undefined,
        ip: req.ip,
      });
    });
    next();
  });

  const getOrigin = (req: Request) => `${req.protocol}://${req.get('host') || 'localhost'}`;

  /** With `?receipt=true`, attach a `Receipt` header: a JWS over the post-mutation contract state. */
  const maybeAttachReceipt = (req: Request, res: Response, contract: unknown) => {
    if (req.query.receipt === 'true' && contract && typeof contract === 'object') {
      res.setHeader('Receipt', receiptManager().issueReceipt(contract as Record<string, unknown>, getOrigin(req)));
    }
  };

  app.get('/.well-known/talenttrust-receipts.json', wrap(() => receiptManager().getPublishedKeys()));

  app.get(
    '/',
    wrap(() => ({
      name: 'TalentTrust API',
      version: config.version,
      description: 'Milestone-based freelancer escrow API backed by a Soroban contract on Stellar.',
      docs: '/docs',
      openapi: '/openapi.json',
      website: config.frontendUrl,
      chain: { network: config.network, contractId: config.contractId, explorer: explorerUrl() },
      endpoints: [
        'GET  /health',
        'GET  /docs',
        'GET  /openapi.json',
        'GET  /.well-known/talenttrust-receipts.json',
        'GET  /api/v1/chain',
        'GET  /api/v1/stats',
        'POST /api/v1/tx/build',
        'GET  /api/v1/contracts',
        'POST /api/v1/contracts',
        'GET  /api/v1/contracts/:id',
        'GET  /api/v1/contracts/:id/receipt',
        'PATCH /api/v1/contracts/:id',
        'DELETE /api/v1/contracts/:id',
        'GET  /api/v1/contracts/:id/revisions',
        'POST /api/v1/contracts/:id/deposit',
        'POST /api/v1/contracts/:id/milestones/:index/release',
        'POST /api/v1/contracts/:id/dispute',
        'POST /api/v1/contracts/:id/resolve',
        'POST /api/v1/contracts/:id/cancel',
        'POST /api/v1/contracts/:id/reputation',
        'POST /api/v1/contracts/:id/reviews',
        'POST /api/v1/contracts/:id/link',
        'GET  /api/v1/contracts/:id/parity',
        'GET  /api/v1/reputation/:address',
        'GET  /api/v1/reputation/:address/reviews',
        'GET  /api/v1/auth/challenge',
        'POST /api/v1/auth/token',
        'POST /api/v1/receipts/verify',
      ],
    })),
  );

  app.get('/health', (req, res) => {
    if (app.get('draining')) {
      res.status(503).setHeader('Connection', 'close').json({ status: 'draining' });
      return;
    }
    res.json({
      status: 'ok',
      version: config.version,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      storage: 'in-memory',
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/openapi.json', wrap(() => openapi));
  app.get(['/docs', '/docs/'], (_req, res) => {
    res.type('html').send(docsHtml);
  });

  const v1 = express.Router();
  v1.use(
    idempotency(options.idempotencyStore ?? new MemoryIdempotencyStore(), {
      required: options.idempotencyRequired ?? process.env.IDEMPOTENCY_REQUIRED === 'true',
    }),
  );
  // --- Wallet-signature auth (public) ---

  // GET /api/v1/auth/challenge?address=G...
  v1.get(
    '/auth/challenge',
    wrap((req) => {
      const address = req.query.address;
      if (!isValidStellarAddress(address)) {
        throw new HttpError(400, 'invalid_address', 'address must be a valid Stellar G… public key');
      }
      const { challenge, expiresAt } = buildChallenge(address, auth.secret, auth.now);
      return { address, challenge, expiresAt };
    }),
  );

  // POST /api/v1/auth/token  { address, challenge, signature }
  v1.post(
    '/auth/token',
    wrap((req) => {
      const { address, challenge, signature } = req.body ?? {};
      if (!isValidStellarAddress(address)) {
        throw new HttpError(400, 'invalid_address', 'address must be a valid Stellar G… public key');
      }
      if (typeof challenge !== 'string' || !challenge) {
        throw new HttpError(400, 'invalid_challenge', 'challenge is required');
      }
      if (typeof signature !== 'string' || !signature) {
        throw new HttpError(400, 'invalid_signature', 'signature is required');
      }

      // Verify the challenge HMAC, expiry, address match, and replay.
      const result = verifyChallenge(challenge, address, auth.secret, auth.now);
      if (!result.ok) throw new HttpError(401, result.error, 'Challenge verification failed');

      // Verify the ed25519 signature over the exact challenge string.
      let sigValid = false;
      try {
        sigValid = Keypair.fromPublicKey(address).verify(Buffer.from(challenge, 'utf-8'), Buffer.from(signature, 'base64'));
      } catch {
        sigValid = false;
      }
      if (!sigValid) throw new HttpError(401, 'invalid_signature', 'Signature verification failed');

      // Mark the nonce as consumed so the challenge can't be replayed in this process.
      consumeNonce(result.payload.nonce);
      const { token, expiresAt } = issueWalletToken(address, auth.secret, auth.now);
      return { token, tokenType: 'Bearer', expiresAt };
    }),
  );

  v1.get(
    '/chain',
    wrap(() => ({
      network: config.network,
      rpcUrl: config.rpcUrl,
      contractId: config.contractId,
      explorer: explorerUrl(),
    })),
  );
  v1.post(
    '/tx/build',
    wrap(async (req) =>
      buildEscrowTransaction(req.body, txRpcServer ? { server: txRpcServer } : {}),
    ),
  );
  v1.get('/stats', wrap(() => store.stats()));
  v1.get(
    '/contracts',
    validate({ query: ListQuery }),
    wrap((req) => {
      let linked: boolean | undefined = undefined;
      if (req.query.linked === 'true') linked = true;
      else if (req.query.linked === 'false') linked = false;
      const spec = parseFields(req);
      const contracts = store.list({
        status: req.query.status as string | undefined,
        party: req.query.party as string | undefined,
        linked,
      });
      return { data: contracts.map((c) => project(c, spec)) };
    }),
  );
  v1.post(
    '/contracts',
    requireAuth,
    (req, _res, next) => {
      // With wallet auth the client is the authenticated address: reject a
      // different body.client and default it when omitted.
      const caller = callerOf(req);
      if (caller !== undefined) {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        if (body.client !== undefined && body.client !== caller) {
          return next(new HttpError(403, 'forbidden', 'Authenticated address must match contract client'));
        }
        req.body = { ...body, client: caller };
      }
      next();
    },
    validate({ body: CreateContractBody }),
    wrap((req, res) => {
      const created = store.create(req.body);
      maybeAttachReceipt(req, res, created);
      res.status(201).json(created);
    }),
  );
  v1.get(
    '/contracts/:id',
    validate({ params: IdParam }),
    wrap((req) => project(store.get(Number(req.params.id)), parseFields(req))),
  );
  v1.get(
    '/contracts/:id/receipt',
    wrap((req) => {
      const contract = store.get(id(req));
      return { receipt: receiptManager().issueReceipt(contract as unknown as Record<string, unknown>, getOrigin(req)) };
    }),
  );
  // With wallet auth the authenticated address stands in for body.client.
  const clientOf = (req: Request): unknown => {
    const caller = callerOf(req);
    if (caller === undefined) return req.body?.client;
    if (req.body?.client !== undefined && req.body.client !== caller) {
      throw new HttpError(403, 'forbidden', 'Authenticated address must match contract client');
    }
    return caller;
  };
  v1.patch(
    '/contracts/:id',
    requireAuth,
    wrap((req) => store.edit(id(req), { ...(req.body ?? {}), client: clientOf(req) })),
  );
  v1.delete(
    '/contracts/:id',
    requireAuth,
    wrap((req, res) => {
      store.delete(id(req), clientOf(req));
      res.status(204).end();
    }),
  );
  v1.get('/contracts/:id/revisions', wrap((req) => store.getRevisions(id(req))));
  v1.post(
    '/contracts/:id/deposit',
    requireAuth,
    validate({ params: IdParam, body: DepositBody }),
    wrap((req, res) => {
      const updated = store.deposit(Number(req.params.id), req.body.amount, callerOf(req));
      maybeAttachReceipt(req, res, updated);
      return updated;
    }),
  );
  v1.post(
    '/contracts/:id/milestones/:index/release',
    requireAuth,
    validate({ params: MilestoneReleaseParams }),
    wrap((req, res) => {
      const updated = store.release(Number(req.params.id), Number(req.params.index), callerOf(req));
      maybeAttachReceipt(req, res, updated);
      return updated;
    }),
  );
  v1.post(
    '/contracts/:id/dispute',
    requireAuth,
    validate({ params: IdParam, body: DisputeBody }),
    wrap((req, res) => {
      const updated = store.openDispute(Number(req.params.id), req.body.raisedBy, req.body.reason, callerOf(req));
      maybeAttachReceipt(req, res, updated);
      return updated;
    }),
  );
  v1.post(
    '/contracts/:id/resolve',
    validate({ params: IdParam, body: ResolveBody }),
    wrap((req, res) => {
      const updated = store.resolveDispute(Number(req.params.id), req.body.freelancerBps);
      maybeAttachReceipt(req, res, updated);
      return updated;
    }),
  );
  v1.post(
    '/contracts/:id/cancel',
    requireAuth,
    validate({ params: IdParam, body: CancelBody }),
    wrap((req, res) => {
      const updated = store.cancel(Number(req.params.id), callerOf(req));
      maybeAttachReceipt(req, res, updated);
      return updated;
    }),
  );
  v1.post(
    '/contracts/:id/reputation',
    requireAuth,
    validate({ params: IdParam, body: RateBody }),
    wrap((req, res) => {
      const reputation = store.rate(Number(req.params.id), req.body.rating, callerOf(req));
      // The receipt covers the contract (now reputationIssued), not the reputation summary.
      maybeAttachReceipt(req, res, store.get(Number(req.params.id)));
      return reputation;
    }),
  );
  v1.get(
    '/reputation/:address',
    validate({ params: ReputationAddressParam }),
    wrap((req) => store.getReputationWithClient(req.params.address)),
  );
  v1.post(
    '/contracts/:id/reviews',
    requireAuth,
    wrap((req, res) => {
      const body = req.body ?? {};
      const caller = callerOf(req);
      if (caller !== undefined && body.reviewer !== undefined && body.reviewer !== caller) {
        throw new HttpError(403, 'forbidden', 'reviewer must match the authenticated address');
      }
      res.status(201).json(store.createReview(id(req), caller === undefined ? body : { ...body, reviewer: caller }));
    }),
  );
  v1.post(
    '/contracts/:id/link',
    wrap(async (req) => store.linkEscrow(id(req), req.body?.escrowId, chainReader)),
  );
  v1.get(
    '/contracts/:id/parity',
    wrap(async (req) => store.checkParity(id(req), chainReader)),
  );
  v1.get(
    '/reputation/:address/reviews',
    wrap((req) => {
      const limitRaw = req.query.limit;
      const limit = typeof limitRaw === 'string' ? Number(limitRaw) : undefined;
      const cursorRaw = req.query.cursor;
      const cursor = typeof cursorRaw === 'string' ? Number(cursorRaw) : undefined;
      return store.listReviews(req.params.address, {
        role: optionalString(req.query.role),
        limit: Number.isFinite(limit as number) ? (limit as number) : undefined,
        cursor: Number.isFinite(cursor as number) ? cursor : undefined,
      });
    }),
  );
  v1.post(
    '/receipts/verify',
    wrap((req) => {
      const receipt = req.body?.receipt;
      if (!receipt || typeof receipt !== 'string') {
        throw new HttpError(400, 'invalid_receipt', 'receipt must be a non-empty JWS string');
      }
      const verified = verifyReceipt(receipt, receiptManager().publicKey);
      if (!verified.valid) {
        return {
          valid: false,
          kid: verified.kid ?? null,
          iat: verified.iat ?? null,
          contractId: verified.contractId ?? null,
          matchesCurrent: false,
        };
      }
      let matchesCurrent = false;
      if (verified.contractId) {
        try {
          matchesCurrent = hashContractState(store.get(verified.contractId)) === verified.contractHash;
        } catch {
          matchesCurrent = false;
        }
      }
      return { valid: true, kid: verified.kid, iat: verified.iat, contractId: verified.contractId, matchesCurrent };
    }),
  );

  app.use('/api/v1', v1);

  app.use((req, res) => {
    res.status(404).json({ error: 'not_found', message: `No route for ${req.method} ${req.path}`, requestId: req.id, docs: '/docs' });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const requestId = req.id;
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.code, message: err.message, ...err.details, requestId });
      return;
    }
    if (err instanceof TxBuildError) {
      res
        .status(err.status)
        .json({
          error: err.code,
          message: err.message,
          ...(err.contractError ? { contractError: err.contractError } : {}),
          requestId,
        });
      return;
    }
    if (err && typeof err === 'object' && (err as { type?: string }).type === 'entity.parse.failed') {
      res.status(400).json({ error: 'invalid_json', message: 'Malformed JSON body', requestId });
      return;
    }
    logger.error('unhandled_error', {
      requestId,
      err: {
        name: (err as Error)?.name ?? 'Error',
        message: (err as Error)?.message ?? String(err),
        stack: (err as Error)?.stack,
      },
    });
    res.status(500).json({ error: 'internal_error', message: 'Unexpected error', requestId });
  });

  return app;
}

export default createApp;