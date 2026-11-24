import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { config, envInt, explorerUrl } from './config';
import { EscrowStore, HttpError, publicContract, type EscrowContract } from './store';
import { openapi, docsHtml, docsCsp } from './openapi';
import { allowlist, corsOptionsFor, originGuard } from './cors';
import { methodNotAllowed, optionsHandler } from './methods';
import { CSV_HEADERS, csvRow } from './csv';
import { describeStateMachine } from './stateMachine';
import { parseApiKeysConfig, type ParsedApiKeys } from './auth/apiKeysConfig';
import { authenticateScopedApiKey, requireScope, type ScopedApiKeyRequest } from './auth/scopedApiKeyMiddleware';
import { SCOPES } from './auth/scopes';
import { PauseGuard } from './pauseGuard';
import { HealthService, createSorobanRpcClient, type HealthRpcClient } from './health';
import { TxRelay } from './tx';
import { InMemoryEventStore } from './indexer/store';
import { EventIndexer } from './indexer/indexer';
import { EVENT_TYPES } from './indexer/types';
import {
  DEFAULT_WEBHOOK_HISTORY_LIMIT,
  isWebhookAdminTokenValid,
  MAX_WEBHOOK_HISTORY_LIMIT,
  WEBHOOK_DELIVERY_STATUSES,
  WebhookDeliveryStatus,
  WebhookManager,
} from './webhooks';
import { type ChainReadClient, ChainReadError, SorobanChainReadClient } from './stellar/client';
import { type ChainReader as ChainStatusReader, createStellarChainReader } from './stellar/chain-status';
import { ERRORS, PROBLEM_TYPE_BASE, isErrorKey } from './errors';
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
  TemplateIdParam,
  CreateTemplateBody,
  UpdateTemplateBody,
  DeleteTemplateBody,
  TemplateOwnerQuery,
} from './validation/schemas';
import { createLogger, type Logger, randomUUID } from './logger';
import { ChainReader, SorobanRpcChainReader } from './chain';
import { buildEscrowTransaction, TxBuildError, type RpcClient } from './stellar/escrowTxBuilder';
import { createRegistry, type Registry, HTTP_DURATION_BUCKETS, constantTimeEqual } from './metrics';
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { StrKey, Keypair } from '@stellar/stellar-sdk';
import { randomBytes } from 'crypto';
import { buildChallenge, verifyChallenge, consumeNonce } from './auth/challenge';
import { issueWalletToken } from './auth/jwt';
import { createRequireAuth, WalletAuthRequest } from './auth/middleware';
import { ReceiptManager, hashContractState, verifyReceipt } from './receipts';

import { createContractsRouter } from './routes/contracts';
import {
  callerOf,
  ChainRateLimiter,
  ChainReadCache,
  chainIdParam,
  createMaybeAttachReceipt,
  createRequireNotPaused,
  disputeLimit,
  disputeOverdue,
  disputeSort,
  disputeStatus,
  getContractEtag,
  getContractsListEtag,
  id,
  isChainReadClient,
  isValidStellarAddress,
  jsonObjectBody,
  oneParam,
  optionalString,
  PreconditionFailedError,
  PreconditionRequiredError,
  requireAdminRead,
  requireCronSecret,
  resolveCursorSecret,
  rootApiInfo,
  safeEqual,
  wrap,
} from './routes/helpers';
export { getContractEtag, getContractsListEtag, PreconditionFailedError, PreconditionRequiredError };
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



// --- ETag caching and If-Match optimistic concurrency ---
export type AppDeps = {
  logger?: Logger;
  store?: EscrowStore;
  chainReader?: ChainReader;
  txRpcServer?: RpcClient;
  /** Secret for wallet-auth challenges and JWTs. Passing it enforces auth unless `authRequired: false`. */
  authSecret?: string;
  /** Force wallet auth on (true) or off (false) for mutating routes. */
  authRequired?: boolean;
  /** Injectable clock (epoch ms or Date) for auth and the dispute queue (tests). */
  now?: () => number | Date;
  /** Signs contract-state receipts; defaults to RECEIPT_SIGNING_SECRET or an ephemeral key. */
  receiptManager?: ReceiptManager;
  /** Prometheus registry; each app gets its own unless one is injected. */
  registry?: Registry;
  /** On-chain pause check (operator override + cached Soroban `is_paused`). */
  pauseGuard?: PauseGuard;
  /** Live contract status for GET /api/v1/chain; defaults to the cached Soroban RPC reader. */
  chainStatusReader?: ChainStatusReader;
  /** Relays signed escrow transactions to Soroban RPC (POST /api/v1/tx/submit). */
  txRelay?: TxRelay;
  /** Read-through client for /api/v1/chain/contracts and /api/v1/chain/reputation. */
  chainReadClient?: ChainReadClient;
  /** Scoped API keys (defaults to the API_KEYS env var). */
  apiKeys?: ParsedApiKeys;
  /** Clock for scoped API key expiry checks (defaults to `Date.now`; tests inject one). */
  apiKeyClock?: () => number;
  /** A ready-made readiness service, or overrides for the default one (tests inject `rpc`). */
  health?: HealthService | { rpc?: HealthRpcClient; timeoutMs?: number; cacheMs?: number };
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
  const clock = deps.now;
  const now = clock ? () => { const v = clock(); return typeof v === 'number' ? v : v.getTime(); } : Date.now;
  return { secret, required, now };
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
  registry?: Registry;
}

export function createApp(
  storeOrOpts: EscrowStore | AppDeps = new EscrowStore().seed(),
  /** A chain reader, receipt manager, tx relay or chain read client to inject, or the CORS origin allowlist. */
  fallbackChainReaderOrReceiptManager?: ChainReader | ReceiptManager | TxRelay | ChainReadClient | InMemoryEventStore | string[],
  /** App options, or the event indexer to use (with an InMemoryEventStore as the second argument). */
  optionsOrIndexer: AppOptions | EventIndexer = {},
) {
  const options: AppOptions = optionsOrIndexer instanceof EventIndexer ? {} : optionsOrIndexer;
  const resolved = resolveStoreAndLogger(storeOrOpts);
  const store = resolved.store;
  const logger = resolved.logger;
  const corsOrigins = Array.isArray(fallbackChainReaderOrReceiptManager) ? fallbackChainReaderOrReceiptManager : allowlist();
  const eventStore =
    fallbackChainReaderOrReceiptManager instanceof InMemoryEventStore ? fallbackChainReaderOrReceiptManager : new InMemoryEventStore();
  const eventIndexer = optionsOrIndexer instanceof EventIndexer ? optionsOrIndexer : new EventIndexer(eventStore);
  const second =
    Array.isArray(fallbackChainReaderOrReceiptManager) || fallbackChainReaderOrReceiptManager instanceof InMemoryEventStore
      ? undefined
      : fallbackChainReaderOrReceiptManager;
  const chainReader =
    second instanceof ReceiptManager || second instanceof TxRelay || isChainReadClient(second)
      ? resolved.chainReader
      : ((second as ChainReader | undefined) ?? resolved.chainReader);
  const txRpcServer = resolved.txRpcServer;
  const isDeps = !(storeOrOpts && typeof (storeOrOpts as EscrowStore).list === 'function');
  const deps: AppDeps = isDeps ? ((storeOrOpts as AppDeps | undefined) ?? {}) : {};
  const auth = resolveAuth(deps);
  const pauseGuard = deps.pauseGuard ?? new PauseGuard();
  const health =
    deps.health instanceof HealthService
      ? deps.health
      : new HealthService({
          store,
          // Lazy client: no RPC traffic until /health/ready is called.
          rpc: deps.health?.rpc ?? createSorobanRpcClient(config.rpcUrl),
          network: config.network,
          networkPassphrase: config.networkPassphrase,
          contractId: config.contractId,
          timeoutMs: deps.health?.timeoutMs,
          cacheMs: deps.health?.cacheMs,
        });
  let chainStatusReader = deps.chainStatusReader;
  const txRelay = second instanceof TxRelay ? second : (deps.txRelay ?? new TxRelay());
  // Fail fast on a malformed API_KEYS value.
  const apiKeys: ParsedApiKeys = deps.apiKeys ?? parseApiKeysConfig(process.env.API_KEYS);
  const apiKeyAuthOptions = { now: deps.apiKeyClock };
  /**
   * Dispute resolution needs a key with `disputes:resolve` once any API key is configured. Production
   * without API_KEYS fails closed (nobody can resolve); dev/test without keys keeps the open behaviour.
   */
  const requireResolveKey = (req: Request, res: Response, next: NextFunction) => {
    if (apiKeys.keys.length === 0) {
      if (process.env.NODE_ENV === 'production') {
        return next(new HttpError(401, 'unauthorized', 'Dispute resolution requires a scoped API key (configure API_KEYS)'));
      }
      return next();
    }
    authenticateScopedApiKey(apiKeys, apiKeyAuthOptions)(req as ScopedApiKeyRequest, res, (err?: unknown) =>
      err ? next(err) : requireScope(SCOPES.DISPUTES_RESOLVE)(req as ScopedApiKeyRequest, res, next),
    );
  };
  const webhooks = new WebhookManager(store.events);
  let chainReadClient: ChainReadClient | undefined = isChainReadClient(second) ? second : deps.chainReadClient;
  const chainClient = () => (chainReadClient ??= new SorobanChainReadClient());
  const chainReadTtl = envInt('CHAIN_READ_TTL_MS', { default: config.chainReadTtlMs, allowZero: true });
  const chainCache = new ChainReadCache(chainReadTtl);
  const chainRateLimiter = new ChainRateLimiter();
  const allowChainRead = (req: Request, res: Response) => {
    if (!chainRateLimiter.allow(req.ip || 'unknown')) {
      res.setHeader('Retry-After', '60');
      throw new HttpError(429, 'chain_rate_limited', 'Too many chain read requests');
    }
  };
  const chainStatus = () => (chainStatusReader ??= createStellarChainReader());
  /** 503 for mutations whose Soroban counterparts call require_not_paused. */
  const requireNotPaused = createRequireNotPaused(pauseGuard);
  // Created lazily so apps that never sign receipts don't generate a key (or warn).
  let receiptManagerInstance: ReceiptManager | undefined =
    second instanceof ReceiptManager ? second : (options.receiptManager ?? deps.receiptManager);
  const receiptManager = () =>
    (receiptManagerInstance ??= new ReceiptManager(process.env.RECEIPT_SIGNING_SECRET));
  const requireAuth = createRequireAuth(auth.secret, auth.now, auth.required);

  const app = express();
  const sseStreams = new Set<() => void>();
  const configuredSseLimit = Number(process.env.SSE_MAX_CONNECTIONS ?? 100);
  const sseMaxConnections = Number.isInteger(configuredSseLimit) && configuredSseLimit > 0 ? configuredSseLimit : 100;
  app.locals.closeSseStreams = () => {
    for (const closeStream of [...sseStreams]) closeStream();
  };
  // Strong, version-based ETags are set explicitly on contract routes.
  app.set('etag', false);
  app.disable('x-powered-by');
  // Trust the first hop (Vercel / any reverse proxy) so req.protocol reflects X-Forwarded-Proto;
  // originGuard compares same-origin requests against it.
  app.set('trust proxy', 1);
  const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,128}$/;
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

  // HTTP RED metrics: request counter and latency histogram, labelled by route pattern.
  const registry = options.registry ?? deps.registry ?? createRegistry();
  const httpRequestsTotal = registry.counter('http_requests_total', 'Total number of HTTP requests', [
    'method',
    'route',
    'status',
  ]);
  const httpRequestDuration = registry.histogram(
    'http_request_duration_seconds',
    'HTTP request duration in seconds',
    ['method', 'route'],
    HTTP_DURATION_BUCKETS,
  );
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const route = req.route ? String(req.baseUrl || '') + String(req.route.path || '') : 'unmatched';
      httpRequestsTotal.inc({ method: req.method, route, status: String(res.statusCode) });
      httpRequestDuration.observe({ method: req.method, route }, (Date.now() - start) / 1000);
    });
    next();
  });

  // Domain mutation counter, incremented from the store layer.
  const escrowMutationsTotal = registry.counter('escrow_mutations_total', 'Total number of escrow mutations', [
    'action',
    'result',
  ]);
  store.setMutationRecorder((action, result) => escrowMutationsTotal.inc({ action, result }));

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          'default-src': ["'self'"],
          'base-uri': ["'self'"],
          // unpkg hosts the pinned Swagger UI assets on /docs (all SRI-checked);
          // docsCsp allows that page's own inline style/script and nothing else.
          'script-src': ["'self'", 'https://unpkg.com', docsCsp.script],
          'script-src-attr': ["'none'"],
          'style-src': ["'self'", 'https://unpkg.com', docsCsp.style],
          'style-src-attr': ["'unsafe-inline'"],
          'img-src': ["'self'", 'data:'],
          'font-src': ["'self'", 'data:', 'https://unpkg.com'],
          'connect-src': ["'self'"],
          'object-src': ["'none'"],
          'frame-ancestors': ["'none'"],
          'form-action': ["'self'"],
        },
      },
    }),
  );
  // Unknown cross-origin callers get 403 before any handler; allowlisted ones get CORS headers.
  app.use(originGuard(corsOrigins));
  app.use(cors(corsOptionsFor(corsOrigins)));
  // OPTIONS on a known path: 204 with `Allow` (cors() above still adds the preflight headers).
  app.use(optionsHandler(app));

  // Compression middleware: gzip/br for JSON responses Ã¢â€°Â¥ 1 KB.
  // Excluded for text/event-stream and when Cache-Control: no-transform is set.
  app.use(
    compression({
      threshold: 1024, // bytes Ã¢â‚¬â€ skip compression for small responses
      filter(req, res) {
        // Honour Cache-Control: no-transform (RFC 7234 Ã‚Â§5.2.1.6)
        const cc = res.getHeader('Cache-Control');
        if (typeof cc === 'string' && cc.includes('no-transform')) return false;
        // Never compress streaming responses
        const ct = res.getHeader('Content-Type');
        if (typeof ct === 'string' && ct.includes('text/event-stream')) return false;
        return compression.filter(req, res);
      },
    }),
  );

  // Strict parsing (the default) rejects top-level primitives such as 42 or "x" with invalid_json.
  // The body-taking routes parse leniently instead, so requireObjectBody can reply invalid_body.
  // Keep this pattern in sync with the routes that use jsonObjectBody below.
  const objectBodyRoutes = /^\/api\/v1\/contracts(\/[^/]+\/(deposit|dispute|resolve|reputation|link))?\/?$/i;
  const jsonStrict = express.json({ limit: config.bodyLimit });
  const jsonLenient = express.json({ limit: config.bodyLimit, strict: false });
  app.use((req, res, next) =>
    (req.method === 'POST' && objectBodyRoutes.test(req.path) ? jsonLenient : jsonStrict)(req, res, next),
  );

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
  const maybeAttachReceipt = createMaybeAttachReceipt({ getOrigin, receiptManager });

  app.get('/.well-known/talenttrust-receipts.json', wrap(() => receiptManager().getPublishedKeys()));

  app.get('/', wrap(() => rootApiInfo));

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
      ...(() => {
        // Non-blocking: the last known pause state; a stale cache refreshes in the background.
        const pause = pauseGuard.peek();
        return { paused: pause.paused, pauseSource: pause.source };
      })(),
      timestamp: new Date().toISOString(),
      // Summary of the last readiness probe, once one has run.
      ...(health.lastReport() ? { checks: health.lastReport()!.checks } : {}),
    });
  });

  // Kubernetes-style probes: liveness never touches a dependency; readiness checks RPC, network, contract, store.
  app.get('/health/live', wrap(() => health.live()));
  app.get('/health/ready', (_req, res, next) => {
    health
      .ready()
      .then(({ httpStatus, report }) => res.status(httpStatus).json(report))
      .catch(next);
  });

  app.get('/openapi.json', wrap(() => openapi));

  // Error catalog: every code the API can return, with status and title.
  app.get('/api/v1/errors', (_req, res) => {
    const catalog: Record<string, { status: number; title: string; detail: string; contractError?: { name: string; code: number } }> = {};
    for (const [key, entry] of Object.entries(ERRORS)) {
      catalog[key] = {
        status: entry.status,
        title: entry.title,
        detail: entry.detail,
        ...('contractError' in entry ? { contractError: entry.contractError } : {}),
      };
    }
    res.json(catalog);
  });

  // Problem `type` URIs resolve here: HTML for browsers, JSON otherwise.
  const escapeHtml = (v: string) =>
    v.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string);
  app.get('/errors/:code', (req, res) => {
    const { code } = req.params;
    if (!isErrorKey(code)) {
      res.status(404).json({ error: 'error_code_not_found', message: `Unknown error code: ${code}`, requestId: req.id });
      return;
    }
    const entry = ERRORS[code];
    if (req.accepts(['json', 'html']) === 'html') {
      res
        .type('html')
        .send(
          `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(entry.title)}</title></head><body>` +
            `<h1>${escapeHtml(entry.title)}</h1><p>${escapeHtml(entry.detail)}</p><p>Status: ${entry.status}</p>` +
            `<p>Code: <code>${escapeHtml(code)}</code></p></body></html>`,
        );
      return;
    }
    res.json({ code, ...entry, type: `${PROBLEM_TYPE_BASE}/${code}` });
  });
  app.get(['/docs', '/docs/'], (_req, res) => {
    res.type('html').send(docsHtml);
  });

  const v1 = express.Router();
  // Auth tokens, confidential dispute data and webhook secrets must never be
  // stored by shared caches, so mark their responses (including errors) no-store.
  const noStore = (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    next();
  };
  v1.use(['/auth', '/disputes', '/webhook-subscriptions'], noStore);
  v1.use(
    idempotency(options.idempotencyStore ?? new MemoryIdempotencyStore(), {
      required: options.idempotencyRequired ?? process.env.IDEMPOTENCY_REQUIRED === 'true',
      authSecret: auth.secret,
      now: auth.now,
      apiKeys,
    }),
  );
  // --- Wallet-signature auth (public) ---

  // GET /api/v1/auth/challenge?address=G...
  v1.get(
    '/auth/challenge',
    wrap((req) => {
      const address = req.query.address;
      if (!isValidStellarAddress(address)) {
        throw new HttpError(400, 'invalid_address', 'address must be a valid Stellar GÃ¢â‚¬Â¦ public key');
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
        throw new HttpError(400, 'invalid_address', 'address must be a valid Stellar GÃ¢â‚¬Â¦ public key');
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
    wrap(async (req) => {
      const [pause, onChain] = await Promise.all([
        pauseGuard.isPaused(),
        chainStatus().getStatus({ refresh: req.query.refresh === 'true' }),
      ]);
      return {
        network: config.network,
        rpcUrl: config.rpcUrl,
        contractId: config.contractId,
        explorer: explorerUrl(),
        paused: pause.paused,
        pauseSource: pause.source,
        onChain,
      };
    }),
  );
  v1.post(
    '/tx/build',
    wrap(async (req) =>
      buildEscrowTransaction(req.body, txRpcServer ? { server: txRpcServer } : {}),
    ),
  );
  // Read-through views of the on-chain escrow contract (amounts as exact decimal strings).
  v1.get(
    '/chain/contracts/:chainId',
    wrap(async (req, res) => {
      allowChainRead(req, res);
      const chainId = chainIdParam(req.params.chainId);
      const result = await chainCache.get(`contract:${chainId}`, () => chainClient().getContract(chainId));
      return { ...result.value, source: 'chain', latestLedger: result.latestLedger };
    }),
  );
  v1.get(
    '/chain/reputation/:address',
    wrap(async (req, res) => {
      allowChainRead(req, res);
      const address = req.params.address;
      if (!isValidStellarAddress(address)) {
        throw new HttpError(400, 'invalid_address', 'address must be a valid Stellar account');
      }
      const result = await chainCache.get(`reputation:${address}`, () => chainClient().getReputation(address));
      const { completedContracts, totalRating } = result.value;
      return {
        address,
        completedContracts,
        totalRating,
        averageRating: completedContracts ? Math.round((totalRating / completedContracts) * 100) / 100 : 0,
        source: 'chain',
      };
    }),
  );
  // Indexed on-chain escrow events (see /api/cron/index-events).
  v1.get(
    '/chain/events',
    wrap((req) => {
      const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
      const limitRaw = str(req.query.limit);
      const limit = limitRaw === undefined ? undefined : Number(limitRaw);
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
        throw new HttpError(400, 'invalid_limit', 'limit must be an integer between 1 and 100');
      }
      const typeRaw = req.query.type;
      let type: string | undefined;
      if (typeRaw !== undefined) {
        if (typeof typeRaw !== 'string' || !EVENT_TYPES.includes(typeRaw as any)) {
          throw new HttpError(400, 'invalid_type', `type must be one of: ${EVENT_TYPES.join(', ')}`);
        }
        type = typeRaw;
      }
      if (req.query.cursor !== undefined && typeof req.query.cursor !== 'string') {
        throw new HttpError(400, 'invalid_cursor', 'cursor must be a string');
      }
      return eventStore.query({ escrowId: str(req.query.escrowId), type, limit, cursor: str(req.query.cursor) });
    }),
  );
  v1.get('/chain/indexer', wrap(() => eventIndexer.getState()));
  // Lets integrators check which scoped API key they are using.
  v1.get(
    '/auth/whoami',
    authenticateScopedApiKey(apiKeys, apiKeyAuthOptions),
    wrap((req) => {
      const key = (req as ScopedApiKeyRequest).scopedApiKey!;
      return { keyId: key.id, scopes: key.scopes, expiresAt: key.expiresAt ?? null };
    }),
  );
  // --- Per-address activity statements ---
  const parseStatementParams = (req: Request) => {
    const address = req.params.address;
    const MAX_RANGE_MS = 3 * 365.25 * 24 * 60 * 60 * 1000; // ~3 years
    const DEFAULT_RANGE_MS = 365 * 24 * 60 * 60 * 1000; // 365 days
    const toDate = req.query.to ? new Date(String(req.query.to)) : new Date(Date.now());
    const fromDate = req.query.from ? new Date(String(req.query.from)) : new Date(toDate.getTime() - DEFAULT_RANGE_MS);
    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      throw new HttpError(400, 'invalid_range', 'from and to must be valid ISO dates');
    }
    if (fromDate >= toDate) throw new HttpError(400, 'invalid_range', 'from must be before to');
    if (toDate.getTime() - fromDate.getTime() > MAX_RANGE_MS) {
      throw new HttpError(400, 'invalid_range', 'date range must not exceed 3 years');
    }
    const roleRaw = typeof req.query.role === 'string' ? req.query.role : 'all';
    if (roleRaw !== 'client' && roleRaw !== 'freelancer' && roleRaw !== 'all') {
      throw new HttpError(400, 'invalid_role', 'role must be client, freelancer, or all');
    }
    return { address, from: fromDate, to: toDate, role: roleRaw as 'client' | 'freelancer' | 'all', bom: req.query.bom === 'true' };
  };
  v1.get('/parties/:address/statement.csv', (req, res, next) => {
    try {
      const { address, from, to, role, bom } = parseStatementParams(req);
      const rows = store.getStatement(address, from, to, role);
      const safeAddress = address.replace(/[^A-Za-z0-9_-]/g, '_');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="talenttrust-${safeAddress}-${from.toISOString().slice(0, 10)}-${to.toISOString().slice(0, 10)}.csv"`,
      );
      if (bom) res.write('\uFEFF'); // UTF-8 BOM for Excel when ?bom=true
      res.write(csvRow([...CSV_HEADERS]));
      for (const row of rows) {
        // Amount columns carry the exact base-unit decimal strings.
        res.write(
          csvRow([
            row.contract_id,
            row.title,
            row.role,
            row.counterparty,
            row.token,
            row.status,
            row.total_amount_units,
            row.funded_amount_units,
            row.released_amount_units,
            row.outstanding_amount_units,
            row.dispute_freelancer_bps,
            row.created_at,
            row.updated_at,
          ]),
        );
      }
      res.end();
    } catch (err) {
      next(err);
    }
  });
  v1.get(
    '/parties/:address/statement.json',
    wrap((req) => {
      const { address, from, to, role } = parseStatementParams(req);
      return { address, from: from.toISOString(), to: to.toISOString(), role, data: store.getStatement(address, from, to, role) };
    }),
  );
  // --- Escrow state machine discovery (read-only, same rules as the mutations) ---
  v1.get('/state-machine', wrap(() => describeStateMachine()));
  v1.get('/contracts/:id/stream', (req, res, next) => {
    let contractId: number;
    try {
      contractId = id(req);
      store.get(contractId); // Preserve the normal 404 response before opening the stream.
    } catch (err) {
      return next(err);
    }
    if (app.get('draining')) {
      res.setHeader('Connection', 'close');
      return res.status(503).json({ status: 'draining' });
    }
    if (sseStreams.size >= sseMaxConnections) {
      return res.status(503).json({ error: 'sse_connection_limit', message: 'SSE connection limit reached' });
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const writeEvent = (event: import('./events').EscrowEvent) => {
      const eventContract = event.data.contract as EscrowContract | undefined;
      if (!eventContract || Number(eventContract.id) !== contractId || res.writableEnded) return;
      const payload: Record<string, unknown> = { ...event.data, contract: publicContract(eventContract) };
      if (payload.dispute && typeof payload.dispute === 'object') {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { reason: _reason, ...publicDispute } = payload.dispute as Record<string, unknown>;
        payload.dispute = publicDispute;
      }
      res.write(`event: ${event.eventType}\nid: ${event.eventId}\ndata: ${JSON.stringify(payload)}\n\n`);
    };
    const lastEventId = req.header('Last-Event-ID');
    if (lastEventId) {
      for (const event of store.events.replayAfter(lastEventId)) writeEvent(event);
    }
    const unsubscribe = store.events.on(writeEvent);
    let heartbeat: NodeJS.Timeout;
    const closeStream = () => {
      clearInterval(heartbeat);
      unsubscribe();
      sseStreams.delete(closeStream);
      if (!res.writableEnded) res.end();
    };
    heartbeat = setInterval(() => {
      if (app.get('draining')) closeStream();
      else if (!res.writableEnded) res.write(': heartbeat\n\n');
    }, 15_000);
    sseStreams.add(closeStream);
    res.on('close', closeStream);
  });
  const cursorSecret = resolveCursorSecret({ authSecret: deps.authSecret, logger });
  const contractRouteDeps = { store, chainReader, requireAuth, requireNotPaused, requireResolveKey, maybeAttachReceipt, receiptManager, getOrigin, cursorSecret, wrapFn: wrap, jsonBody: jsonObjectBody, validateFn: validate } as const;
  v1.use(createContractsRouter({ segment: 'actions', ...contractRouteDeps }));
  v1.get('/stats', wrap(() => store.stats()));
  v1.use(createContractsRouter({ segment: 'main1', ...contractRouteDeps }));
  v1.get(
    '/reputation',
    wrap((req) =>
      store.listReputation({
        sort: req.query.sort,
        minCompleted: req.query.minCompleted,
        limit: req.query.limit,
        cursor: req.query.cursor,
        since: req.query.since,
        windowDays: req.query.windowDays,
      }),
    ),
  );
  v1.get(
    '/reputation/:address',
    validate({ params: ReputationAddressParam }),
    wrap((req) => store.getReputationWithClient(req.params.address)),
  );
  v1.use(createContractsRouter({ segment: 'main2', ...contractRouteDeps }));
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
          matchesCurrent = hashContractState(publicContract(store.get(verified.contractId))) === verified.contractHash;
        } catch {
          matchesCurrent = false;
        }
      }
      return { valid: true, kid: verified.kid, iat: verified.iat, contractId: verified.contractId, matchesCurrent };
    }),
  );

  // --- Signed transaction relay ---
  const HEX64_RE = /^[0-9a-fA-F]{64}$/;
  v1.post(
    '/tx/submit',
    wrap(async (req, res) => {
      const result = await txRelay.submit(req.body?.xdr);
      if (result.retryAfter !== undefined) res.setHeader('Retry-After', String(result.retryAfter));
      res.status(result.httpStatus).json(result.body);
    }),
  );
  v1.get('/tx', wrap((req) => ({ data: txRelay.listRecent(req.query.limit) })));
  v1.get(
    '/tx/:hash',
    wrap(async (req, res) => {
      const hash = req.params.hash;
      if (!HEX64_RE.test(hash)) {
        throw new HttpError(400, 'invalid_hash', 'Transaction hash must be a 64-character hex string');
      }
      const waitParam = req.query.wait;
      if (waitParam !== 'true' && waitParam !== '1') return txRelay.getStatus(hash);

      // Long-poll: stop polling as soon as the client goes away.
      let disconnected = false;
      const listeners = new Set<() => void>();
      const onClose = () => {
        if (res.writableEnded) return;
        disconnected = true;
        for (const cb of listeners) cb();
      };
      req.on('aborted', onClose);
      res.on('close', onClose);
      try {
        const result = await txRelay.getStatusWithWait(
          hash,
          () => disconnected || req.destroyed,
          (cb) => {
            listeners.add(cb);
            return () => listeners.delete(cb);
          },
        );
        if (!disconnected && !res.headersSent) res.json(result);
      } finally {
        req.off('aborted', onClose);
        res.off('close', onClose);
      }
      return undefined;
    }),
  );

  // --- Webhook subscriptions (WEBHOOK_ADMIN_TOKEN; 404 while unset) ---
  const webhookAuth = (req: Request) => {
    const configured = process.env.WEBHOOK_ADMIN_TOKEN;
    if (!configured) throw new HttpError(404, 'not_found', 'Not found');
    if (!isWebhookAdminTokenValid(configured, req.header('authorization'))) {
      throw new HttpError(401, 'unauthorized', 'Webhook administration authentication is required');
    }
  };
  /** `?limit=` on delivery history: an integer from 1 to 100, defaulting to 50. */
  const webhookHistoryLimit = (raw: unknown): number => {
    if (raw === undefined) return DEFAULT_WEBHOOK_HISTORY_LIMIT;
    if (typeof raw !== 'string' || !/^[0-9]+$/.test(raw)) {
      throw new HttpError(400, 'invalid_limit', `limit must be an integer between 1 and ${MAX_WEBHOOK_HISTORY_LIMIT}`);
    }
    const limit = Number(raw);
    if (limit < 1 || limit > MAX_WEBHOOK_HISTORY_LIMIT) {
      throw new HttpError(400, 'invalid_limit', `limit must be an integer between 1 and ${MAX_WEBHOOK_HISTORY_LIMIT}`);
    }
    return limit;
  };
  /** `?status=` on delivery history: pending, success or failed. */
  const webhookHistoryStatus = (raw: unknown): WebhookDeliveryStatus | undefined => {
    if (raw === undefined) return undefined;
    if (typeof raw !== 'string' || !WEBHOOK_DELIVERY_STATUSES.includes(raw as WebhookDeliveryStatus)) {
      throw new HttpError(400, 'invalid_status', `status must be one of ${WEBHOOK_DELIVERY_STATUSES.join(', ')}`);
    }
    return raw as WebhookDeliveryStatus;
  };
  const webhookRouter = express.Router();
  webhookRouter.post(
    '/',
    wrap(async (req, res) => {
      webhookAuth(req);
      const created = await webhooks.create(req.body ?? {});
      res.status(201).json({ ...created.subscription, secret: created.secret });
    }),
  );
  webhookRouter.get(
    '/',
    wrap((req) => {
      webhookAuth(req);
      return { data: webhooks.list() };
    }),
  );
  webhookRouter.get(
    '/:id',
    wrap((req) => {
      webhookAuth(req);
      return webhooks.get(req.params.id);
    }),
  );
  webhookRouter.patch(
    '/:id',
    wrap(async (req) => {
      webhookAuth(req);
      return webhooks.update(req.params.id, req.body ?? {});
    }),
  );
  webhookRouter.delete(
    '/:id',
    wrap((req) => {
      webhookAuth(req);
      return webhooks.remove(req.params.id);
    }),
  );
  webhookRouter.post(
    '/:id/rotate-secret',
    wrap((req) => {
      webhookAuth(req);
      const rotated = webhooks.rotateSecret(req.params.id);
      return { ...rotated.subscription, secret: rotated.secret };
    }),
  );
  webhookRouter.get(
    '/:id/deliveries',
    wrap((req) => {
      webhookAuth(req);
      return {
        data: webhooks.history(req.params.id, {
          limit: webhookHistoryLimit(req.query.limit),
          status: webhookHistoryStatus(req.query.status),
        }),
      };
    }),
  );
  v1.use('/webhook-subscriptions', webhookRouter);

  // --- Milestone templates ---
  // With wallet auth the authenticated address is the owner.
  const ownerOf = (req: Request): unknown => {
    const caller = callerOf(req);
    if (caller === undefined) return req.body?.owner;
    if (req.body?.owner !== undefined && req.body.owner !== caller) {
      throw new HttpError(403, 'forbidden', 'Authenticated address must match template owner');
    }
    return caller;
  };
  v1.post(
    '/templates',
    requireAuth,
    validate({ body: CreateTemplateBody }),
    wrap((req, res) => {
      res.status(201).json(store.createTemplate({ ...req.body, owner: ownerOf(req) }));
    }),
  );
  v1.get(
    '/templates',
    validate({ query: TemplateOwnerQuery }),
    wrap((req) => ({ data: store.listTemplates({ owner: req.query.owner as string }) })),
  );
  v1.get('/templates/:id', validate({ params: TemplateIdParam }), wrap((req) => store.getTemplate(Number(req.params.id))));
  v1.put(
    '/templates/:id',
    requireAuth,
    validate({ params: TemplateIdParam, body: UpdateTemplateBody }),
    wrap((req) => store.updateTemplate(Number(req.params.id), ownerOf(req), req.body)),
  );
  v1.delete(
    '/templates/:id',
    requireAuth,
    validate({ params: TemplateIdParam, body: DeleteTemplateBody }),
    wrap((req) => {
      store.deleteTemplate(Number(req.params.id), ownerOf(req));
      return { success: true };
    }),
  );

  // --- Audit log ---
  v1.use(createContractsRouter({ segment: 'history', ...contractRouteDeps }));
  v1.get('/audit/verify', wrap(() => store.audit.verify()));

  // --- Admin dispute queue (ADMIN_READ_TOKEN) ---
  const disputeNow = () => new Date(store.currentTime());
  v1.get(
    '/disputes',
    requireAdminRead,
    wrap((req) =>
      store.listDisputes({
        status: disputeStatus(req.query.status),
        sort: disputeSort(req.query.sort),
        overdueOnly: disputeOverdue(req.query.overdue),
        limit: disputeLimit(req.query.limit),
        cursor: oneParam(req.query.cursor, 'invalid_cursor', 'cursor'),
        now: disputeNow(),
        slaHours: config.disputeSlaHours,
      }),
    ),
  );
  v1.get(
    '/disputes/:contractId',
    requireAdminRead,
    wrap((req) => {
      const n = Number(req.params.contractId);
      if (!/^[0-9]+$/.test(req.params.contractId) || !Number.isInteger(n) || n < 1) {
        throw new HttpError(400, 'invalid_id', 'contractId must be a positive integer');
      }
      return store.getDispute(n, disputeNow(), config.disputeSlaHours);
    }),
  );
  app.use('/api/v1', v1);

  // Daily Vercel cron (see vercel.json); also callable manually with the bearer secret.
  const expireContracts = wrap((req) => {
    requireCronSecret(req);
    const checkedAt = store.currentTime();
    return { expired: store.sweepExpired(), checkedAt };
  });

  const reconcileParity = wrap(async (req) => {
    requireCronSecret(req);
    const budgetRaw = Number(process.env.PARITY_RECONCILE_TIME_BUDGET_MS);
    const timeBudgetMs = Number.isFinite(budgetRaw) && budgetRaw > 0 ? budgetRaw : 25_000;
    const result = await store.reconcileParity(chainReader, { concurrency: 5, timeBudgetMs });
    escrowParityDriftContracts.set({}, result.drifted);
    escrowParityLastRunTimestampSeconds.set({}, Math.floor(Date.now() / 1000));
    return result;
  });

  app.get('/api/cron/expire-contracts', expireContracts);
  app.post('/api/cron/expire-contracts', expireContracts);

  // Event indexer batch (Vercel cron sends GET). Fails closed (404) without CRON_SECRET.
  const indexEvents = wrap(async (req) => {
    requireCronSecret(req);
    const limitParam = typeof req.query.limit === 'string' && /^[1-9]\d*$/.test(req.query.limit) ? Number(req.query.limit) : undefined;
    const maxPagesParam = typeof req.query.maxPages === 'string' && /^[1-9]\d*$/.test(req.query.maxPages) ? Number(req.query.maxPages) : undefined;
    // Few, short retries (the batch must fit in a serverless invocation); a busy indexer is not retried.
    let delay = 500;
    for (let attempt = 1; ; attempt++) {
      try {
        return await eventIndexer.runOnce({
          ...(limitParam !== undefined ? { limit: limitParam } : {}),
          ...(maxPagesParam !== undefined ? { maxPages: maxPagesParam } : {}),
        });
      } catch (err) {
        if (err instanceof Error && err.message === 'indexer_busy') {
          throw new HttpError(409, 'indexer_busy', 'Indexer is already running');
        }
        if (attempt >= 3) throw err;
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2;
      }
    }
  });
  app.get('/api/cron/index-events', indexEvents);
  app.post('/api/cron/index-events', indexEvents);
  app.get('/api/cron/reconcile-parity', reconcileParity);
  app.post('/api/cron/reconcile-parity', reconcileParity);

  // Prometheus scrape endpoint; disabled (404) unless METRICS_TOKEN is set, checked per request.
  const escrowContracts = registry.gauge('escrow_contracts', 'Escrow contracts by status', ['status']);
  const escrowValueEscrowed = registry.gauge('escrow_value_escrowed', 'Value currently escrowed (base units)', []);
  const escrowValueReleased = registry.gauge('escrow_value_released', 'Value released (base units)', []);
  const escrowParityDriftContracts = registry.gauge(
    'escrow_parity_drift_contracts',
    'Number of linked contracts with API/chain parity drift in the last reconciliation run',
    [],
  );
  const escrowParityLastRunTimestampSeconds = registry.gauge(
    'escrow_parity_last_run_timestamp_seconds',
    'Unix timestamp of the last parity reconciliation run',
    [],
  );
  const processUptime = registry.gauge('process_uptime_seconds', 'Process uptime in seconds', []);
  const nodejsHeapUsed = registry.gauge('nodejs_heap_used_bytes', 'Node.js heap used in bytes', []);
  app.get('/metrics', (req, res, next) => {
    const token = process.env.METRICS_TOKEN;
    if (!token) return next(new HttpError(404, 'not_found', 'Metrics endpoint disabled'));
    const auth = req.headers.authorization;
    if (!auth || !constantTimeEqual(auth, `Bearer ${token}`)) {
      return next(new HttpError(401, 'unauthorized', 'Invalid metrics token'));
    }
    const stats = store.stats();
    for (const [status, count] of Object.entries(stats.byStatus)) escrowContracts.set({ status }, count);
    escrowValueEscrowed.set({}, stats.totalEscrowed);
    escrowValueReleased.set({}, stats.totalReleased);
    processUptime.set({}, process.uptime());
    nodejsHeapUsed.set({}, process.memoryUsage().heapUsed);
    res.type('text/plain; version=0.0.4').send(registry.exposition());
  });

  // Known path, unsupported method: 405 with the supported methods.
  app.use(methodNotAllowed(app));

  app.use((req, _res, next) => {
    next(new HttpError('not_found', `No route for ${req.method} ${req.path}`, { docs: '/docs' }));
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const requestId = req.id;
    // RFC 9457 problem+json; `error`/`message` stay for existing clients.
    const sendProblem = (e: HttpError) => {
      res.status(e.status).type('application/problem+json').json({ ...e.toProblemBody(), requestId });
    };
    if (err instanceof PreconditionFailedError) {
      res.setHeader('ETag', err.currentEtag);
      sendProblem(err);
      return;
    }
    if (err instanceof HttpError) {
      sendProblem(err);
      return;
    }
    if (err instanceof ChainReadError) {
      // Never echo provider errors: map to stable codes.
      if (err.failure === 'not_found') {
        sendProblem(new HttpError(404, 'contract_not_found', 'On-chain contract not found'));
      } else if (err.failure === 'contract') {
        sendProblem(new HttpError(502, 'chain_error', 'On-chain read failed', { contractError: err.contractError }));
      } else {
        res.setHeader('Retry-After', '1');
        sendProblem(new HttpError(503, 'chain_unavailable', 'On-chain service temporarily unavailable'));
      }
      return;
    }
    if (err instanceof TxBuildError) {
      sendProblem(
        new HttpError(
          err.status,
          err.code,
          err.message,
          err.contractError ? { contractError: err.contractError } : undefined,
        ),
      );
      return;
    }
    // body-parser failures: stable 4xx codes instead of a 500 that invites retries.
    const parserError = (err && typeof err === 'object' ? err : {}) as { type?: string; status?: unknown; statusCode?: unknown };
    switch (parserError.type) {
      case 'entity.parse.failed':
        sendProblem(new HttpError('invalid_json'));
        return;
      case 'entity.too.large':
        sendProblem(new HttpError('payload_too_large', `Request body exceeds the ${config.bodyLimit} limit`));
        return;
      case 'charset.unsupported':
      case 'encoding.unsupported':
        sendProblem(new HttpError('unsupported_media_type', 'Unsupported charset or content encoding'));
        return;
      case 'request.aborted':
        sendProblem(new HttpError('request_aborted'));
        return;
      case 'request.size.invalid':
        sendProblem(new HttpError('invalid_body', 'Request body size does not match its Content-Length'));
        return;
    }
    const status = [parserError.status, parserError.statusCode].find(
      (value): value is number => typeof value === 'number' && value >= 400 && value <= 499,
    );
    if (status !== undefined) {
      sendProblem(new HttpError(status, 'bad_request', 'Bad request'));
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
    sendProblem(new HttpError('internal_error'));
  });

  return app;
}

export default createApp;
