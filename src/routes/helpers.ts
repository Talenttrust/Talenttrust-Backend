import { createHmac, randomBytes, timingSafeEqual, createHash } from 'crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { StrKey } from '@stellar/stellar-sdk';
import {
  DEFAULT_DISPUTE_LIMIT,
  MAX_DISPUTE_LIMIT,
  HttpError,
  LIST_STATUSES,
  publicContract,
  type Cursor,
  type EscrowContract,
  type QueryFilters,
  type DisputeSort,
  type DisputeStatusFilter,
} from '../store';
import type { WalletAuthRequest } from '../auth/middleware';
import type { PauseGuard } from '../pauseGuard';
import type { Logger } from '../logger';
import { parseFieldSpec, project } from '../utils/project';
import { bigIntReplacer } from '../amount';
import { config, explorerUrl } from '../config';

// --- Handler/wrap utilities ---

type Handler = (req: Request, res: Response) => unknown | Promise<unknown>;

export const wrap = (fn: Handler) => async (req: Request, res: Response, next: NextFunction) => {
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

const hasBody = (req: Request) => {
  const length = Number(req.headers['content-length']);
  return req.headers['transfer-encoding'] !== undefined || (Number.isFinite(length) && length > 0);
};

const requireJson = (req: Request, _res: Response, next: NextFunction) => {
  if (hasBody(req) && !req.is('application/json')) {
    return next(new HttpError(415, 'unsupported_media_type', 'Content-Type must be application/json'));
  }
  next();
};

const requireObjectBody = (req: Request, _res: Response, next: NextFunction) => {
  const body: unknown = req.body;
  if (hasBody(req) && (typeof body !== 'object' || body === null || Array.isArray(body))) {
    return next(new HttpError(400, 'invalid_body', 'Request body must be a JSON object'));
  }
  next();
};

/** Content-Type + JSON-object checks for body-taking routes (run before auth/validation). */
export const jsonObjectBody: RequestHandler[] = [requireJson, requireObjectBody];

// --- Identity/auth helpers ---

/** Authenticated wallet address, if the request carried a valid bearer token. */
export const callerOf = (req: Request): string | undefined => (req as WalletAuthRequest).auth?.address;

export const id = (req: Request) => {
  const n = Number(req.params.id);
  if (!Number.isInteger(n) || n < 1) throw new HttpError('invalid_id');
  return n;
};

// --- Field projection ---

/**
 * Parse the `?fields=` query param. Returns `null` when absent (return all fields).
 * Throws {@link HttpError} 400 on invalid input.
 */
export function parseFields(req: Request) {
  const raw = req.query.fields;
  if (typeof raw !== 'string') return null;
  return parseFieldSpec(raw);
}

// --- ETag caching and If-Match optimistic concurrency ---

/** Strong entity tag for a contract: `"<id>-<version>"`. */
export function getContractEtag(contract: { id: number; version: number }): string {
  return `"${contract.id}-${contract.version}"`;
}

/** List entity tag: hash of every listed (id, version) pair plus the query string. */
export function getContractsListEtag(contracts: Array<{ id: number; version: number }>, queryString = ''): string {
  const pairs = contracts.map((c) => `${c.id}:${c.version}`).join(',');
  return `"${createHash('sha1').update(`${pairs}?${queryString}`).digest('hex')}"`;
}

export class PreconditionFailedError extends HttpError {
  constructor(
    public currentEtag: string,
    public currentVersion: number,
  ) {
    super(412, 'precondition_failed', 'Precondition failed', { currentVersion });
  }
}

export class PreconditionRequiredError extends HttpError {
  constructor() {
    super(428, 'precondition_required', 'If-Match header is required');
  }
}

/** Parse an If-None-Match / If-Match header into opaque tags (weak prefixes stripped). */
export const parseEtagList = (header: string | undefined): string[] =>
  (header ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.startsWith('W/') ? s.slice(2) : s));

/** Set ETag + Cache-Control and answer 304 when If-None-Match matches. Returns true when handled. */
export function conditionalGet(req: Request, res: Response, etag: string): boolean {
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'no-cache');
  const tags = parseEtagList(req.headers['if-none-match']);
  if (tags.includes(etag) || tags.includes('*')) {
    res.status(304).end();
    return true;
  }
  return false;
}

// --- Contract list pagination (cursor = base64url JSON + HMAC) ---

const DEFAULT_CURSOR_SECRET = process.env.CURSOR_SECRET || randomBytes(32).toString('base64url');
let cursorSecretWarned = false;

/**
 * Resolve the HMAC secret used to sign contract-list pagination cursors.
 * Precedence:
 * 1. Explicit `CURSOR_SECRET` (option or env)
 * 2. Derived from `AUTH_SECRET` (option or env) via HMAC-SHA256(AUTH_SECRET, "cursor")
 * 3. Ephemeral random secret (logs a one-time warning when NODE_ENV=production)
 */
export function resolveCursorSecret(
  opts: { cursorSecret?: string; authSecret?: string; logger?: Pick<Logger, 'warn'> } = {},
): string {
  const explicit = opts.cursorSecret ?? process.env.CURSOR_SECRET;
  if (explicit) return explicit;

  const authSecret = opts.authSecret ?? process.env.AUTH_SECRET;
  if (authSecret) {
    return createHmac('sha256', authSecret).update('cursor').digest('base64url');
  }

  if (process.env.NODE_ENV === 'production' && !cursorSecretWarned) {
    cursorSecretWarned = true;
    opts.logger?.warn(
      'CURSOR_SECRET and AUTH_SECRET are unset in production; using an ephemeral cursor signing secret. Cursors will not be valid across instances.',
    );
  }

  return randomBytes(32).toString('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function parseLimit(v: unknown): number {
  if (v === undefined) return 20;
  const n = Number(v);
  if (typeof v !== 'string' || !Number.isInteger(n) || n < 1 || n > 100) {
    throw new HttpError(400, 'invalid_query', 'limit must be an integer between 1 and 100');
  }
  return n;
}

export function parseSortParam(v: unknown): string {
  if (v === undefined) return '-createdAt';
  const s = String(v);
  const field = s.startsWith('-') ? s.slice(1) : s;
  if (!['createdAt', 'updatedAt', 'totalAmount'].includes(field)) {
    throw new HttpError(400, 'invalid_query', 'sort must be one of createdAt, updatedAt, totalAmount (prefix - for descending)');
  }
  return s;
}

export function serializeCursor(cursor: Cursor, secret: string = DEFAULT_CURSOR_SECRET): string {
  const payload = Buffer.from(JSON.stringify(cursor)).toString('base64url');
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function parseCursorParam(cursor: unknown, sort: string, secret: string = DEFAULT_CURSOR_SECRET): Cursor | undefined {
  if (cursor === undefined || cursor === '') return undefined;
  const parts = String(cursor).split('.');
  if (parts.length !== 2) throw new HttpError(400, 'invalid_cursor', 'invalid cursor');
  const [payload, sig] = parts;
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  if (!safeEqual(sig, expected)) throw new HttpError(400, 'invalid_cursor', 'invalid cursor');
  let obj: { sort?: unknown; lastValue?: unknown; lastId?: unknown };
  try {
    obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_cursor', 'invalid cursor');
  }
  if (obj.sort !== sort) throw new HttpError(400, 'invalid_cursor', 'cursor sort does not match requested sort');
  return { sort, lastValue: String(obj.lastValue ?? ''), lastId: Number(obj.lastId ?? 0) };
}

export function parseFilters(q: Request['query']): QueryFilters {
  const f: QueryFilters = {};
  if (typeof q.status === 'string') {
    f.status = q.status.split(',').map((s) => s.trim()).filter(Boolean);
    for (const status of f.status) {
      if (!(LIST_STATUSES as string[]).includes(status)) throw new HttpError(400, 'invalid_query', `invalid status ${status}`);
    }
  }
  if (typeof q.party === 'string') f.party = q.party;
  if (typeof q.role === 'string') {
    if (f.party === undefined) throw new HttpError(400, 'invalid_query', 'role requires party');
    if (q.role !== 'client' && q.role !== 'freelancer') throw new HttpError(400, 'invalid_query', 'role must be client or freelancer');
    f.role = q.role;
  }
  if (typeof q.token === 'string') f.token = q.token;
  if (typeof q.createdAfter === 'string') f.createdAfter = q.createdAfter;
  if (typeof q.createdBefore === 'string') f.createdBefore = q.createdBefore;
  if (q.linked === 'true') f.linked = true;
  else if (q.linked === 'false') f.linked = false;
  return f;
}

// --- Contract route helpers (explicit deps) ---

export function createRequireNotPaused(pauseGuard: PauseGuard): RequestHandler {
  return async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const status = await pauseGuard.isPaused();
      if (!status.paused) return next();
      res.setHeader('Retry-After', '60');
      next(new HttpError('contract_paused', undefined, { source: status.source }));
    } catch (err) {
      next(err);
    }
  };
}

export type ReceiptIssuer = {
  issueReceipt: (contract: Record<string, unknown>, origin: string) => string;
  publicKey?: string;
  getPublishedKeys?: () => unknown;
};

export function createMaybeAttachReceipt(deps: {
  getOrigin: (req: Request) => string;
  receiptManager: () => ReceiptIssuer;
}) {
  return (req: Request, res: Response, contract: unknown) => {
    if (req.query.receipt === 'true' && contract && typeof contract === 'object') {
      // Receipts are signed over the public view, so dispute reasons never leave the admin routes.
      const view = publicContract(contract as { dispute?: EscrowContract['dispute'] });
      res.setHeader('Receipt', deps.receiptManager().issueReceipt(view as Record<string, unknown>, deps.getOrigin(req)));
    }
  };
}

export function createContractRouteHelpers(deps: {
  store: { get: (id: number) => EscrowContract; withAuditContext: <T>(ctx: { actor?: string; requestId?: string }, fn: () => T) => T };
}) {
  const audited = <T>(req: Request, fn: () => T): T =>
    deps.store.withAuditContext({ actor: callerOf(req), requestId: req.id }, fn);

  /** If-Match check for contract mutations: 412 on a stale tag, 428 when REQUIRE_IF_MATCH=true and absent. */
  const checkPreconditions = (req: Request, _res: Response, next: NextFunction) => {
    try {
      const contract = deps.store.get(id(req));
      const ifMatch = req.headers['if-match'];
      if (!ifMatch) {
        if (process.env.REQUIRE_IF_MATCH === 'true') throw new PreconditionRequiredError();
      } else {
        const current = getContractEtag(contract);
        const tags = parseEtagList(ifMatch);
        if (!tags.includes('*') && !tags.includes(current)) {
          throw new PreconditionFailedError(current, contract.version);
        }
      }
      next();
    } catch (err) {
      next(err);
    }
  };

  /** Expose the post-mutation entity tag. */
  const setEtag = (res: Response, contract: EscrowContract) => res.setHeader('ETag', getContractEtag(contract));

  // With wallet auth the authenticated address stands in for body.client.
  const clientOf = (req: Request): unknown => {
    const caller = callerOf(req);
    if (caller === undefined) return req.body?.client;
    if (req.body?.client !== undefined && req.body.client !== caller) {
      throw new HttpError(403, 'forbidden', 'Authenticated address must match contract client');
    }
    return caller;
  };

  return { audited, checkPreconditions, setEtag, clientOf };
}

export { project };
export const optionalString = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : undefined);

export const oneParam = (value: unknown, code: string, name: string): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new HttpError(400, code, `${name} must be a string`);
  return value;
};

export function disputeStatus(value: unknown): DisputeStatusFilter {
  const v = oneParam(value, 'invalid_status', 'status') ?? 'all';
  if (v === 'all' || v === 'open' || v === 'resolved') return v;
  throw new HttpError(400, 'invalid_status', 'status must be one of all, open, resolved');
}

export function disputeSort(value: unknown): DisputeSort {
  const v = oneParam(value, 'invalid_sort', 'sort') ?? 'oldest';
  if (v === 'oldest' || v === 'newest' || v === 'value') return v;
  throw new HttpError(400, 'invalid_sort', 'sort must be one of oldest, newest, value');
}

export function disputeOverdue(value: unknown): boolean {
  const v = oneParam(value, 'invalid_overdue', 'overdue');
  if (v === undefined) return false;
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new HttpError(400, 'invalid_overdue', 'overdue must be true or false');
}

export function disputeLimit(value: unknown): number {
  const v = oneParam(value, 'invalid_limit', 'limit');
  if (v === undefined) return DEFAULT_DISPUTE_LIMIT;
  const n = Number(v);
  if (!/^[0-9]+$/.test(v) || !Number.isInteger(n) || n < 1 || n > MAX_DISPUTE_LIMIT) {
    throw new HttpError(400, 'invalid_limit', `limit must be an integer between 1 and ${MAX_DISPUTE_LIMIT}`);
  }
  return n;
}

/** Validate that a string is a valid Stellar ed25519 public key (G�). */
export function isValidStellarAddress(addr: unknown): addr is string {
  return typeof addr === 'string' && StrKey.isValidEd25519PublicKey(addr);
}

import type { ChainReadClient } from '../stellar/client';

export class ChainReadCache {
  private readonly values = new Map<string, { expiresAt: number; promise: Promise<unknown> }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 256,
  ) {}

  get<T>(key: string, load: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const cached = this.values.get(key);
    if (cached && cached.expiresAt > now) return cached.promise as Promise<T>;
    if (cached) this.values.delete(key);
    while (this.values.size >= this.maxEntries) this.values.delete(this.values.keys().next().value as string);
    const promise = load();
    this.values.set(key, { expiresAt: now + this.ttlMs, promise });
    promise.catch(() => {
      if (this.values.get(key)?.promise === promise) this.values.delete(key);
    });
    return promise;
  }
}

export class ChainRateLimiter {
  private readonly clients = new Map<string, { windowStarted: number; count: number }>();

  constructor(
    private readonly maxRequests = 60,
    private readonly windowMs = 60_000,
    private readonly maxClients = 1024,
  ) {}

  allow(key: string): boolean {
    const now = Date.now();
    const current = this.clients.get(key);
    if (!current || now - current.windowStarted >= this.windowMs) {
      while (this.clients.size >= this.maxClients) this.clients.delete(this.clients.keys().next().value as string);
      this.clients.set(key, { windowStarted: now, count: 1 });
      return true;
    }
    if (current.count >= this.maxRequests) return false;
    current.count += 1;
    return true;
  }
}

export const chainIdParam = (raw: string): bigint => {
  if (!/^[1-9]\d*$/.test(raw)) throw new HttpError(400, 'invalid_chain_id', 'chainId must be a positive u64');
  const value = BigInt(raw);
  if (value > 18_446_744_073_709_551_615n) throw new HttpError(400, 'invalid_chain_id', 'chainId must be a positive u64');
  return value;
};

export const isChainReadClient = (value: unknown): value is ChainReadClient =>
  !!value && typeof value === 'object' && typeof (value as ChainReadClient).getReputation === 'function';

export function requireAdminRead(req: Request, _res: Response, next: NextFunction) {
  const expected = process.env.ADMIN_READ_TOKEN;
  if (!expected) return next(new HttpError(404, 'not_found', 'Not found'));
  const auth = req.headers.authorization;
  const token = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : undefined;
  const a = Buffer.from(expected);
  const b = Buffer.from(token ?? '');
  if (!token || a.length !== b.length || !timingSafeEqual(a, b)) {
    return next(new HttpError(401, 'unauthorized', 'Missing or invalid admin bearer token'));
  }
  next();
}

export const requireCronSecret = (req: Request) => {
  const expected = process.env.CRON_SECRET;
  if (!expected) throw new HttpError(404, 'not_found', 'Cron endpoint is not configured');
  const supplied = req.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!supplied) throw new HttpError(401, 'cron_unauthorized', 'Valid bearer authorization is required');
  const expectedBytes = createHash('sha256').update(expected).digest();
  const suppliedBytes = createHash('sha256').update(supplied).digest();
  if (!timingSafeEqual(expectedBytes, suppliedBytes)) {
    throw new HttpError(401, 'cron_unauthorized', 'Valid bearer authorization is required');
  }
  return supplied;
};

export const rootApiInfo = {
      name: 'TalentTrust API',
      version: config.version,
      description: 'Milestone-based freelancer escrow API backed by a Soroban contract on Stellar.',
      docs: '/docs',
      openapi: '/openapi.json',
      website: config.frontendUrl,
      chain: { network: config.network, contractId: config.contractId, explorer: explorerUrl() },
      endpoints: [
        'GET  /health',
        'GET  /health/live',
        'GET  /health/ready',
        'GET  /docs',
        'GET  /openapi.json',
        'GET  /api/v1/errors',
        'GET  /errors/:code',
        'GET  /metrics',
        'GET  /.well-known/talenttrust-receipts.json',
        'GET  /api/v1/chain',
        'GET  /api/v1/chain/contracts/:chainId',
        'GET  /api/v1/chain/reputation/:address',
        'GET  /api/v1/parties/:address/statement.csv',
        'GET  /api/v1/parties/:address/statement.json',
        'GET  /api/v1/state-machine',
        'GET  /api/v1/contracts/:id/actions',
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
        'POST /api/v1/contracts/:id/extend-deadline',
        'POST /api/v1/contracts/:id/milestones/:index/release',
        'POST /api/v1/contracts/:id/dispute',
        'POST /api/v1/contracts/:id/resolve',
        'POST /api/v1/contracts/:id/cancel',
        'POST /api/v1/contracts/:id/reputation',
        'POST /api/v1/contracts/:id/reviews',
        'POST /api/v1/contracts/:id/link',
        'GET  /api/v1/contracts/:id/parity',
        'GET  /api/v1/reputation',
        'GET  /api/v1/reputation/:address',
        'GET  /api/v1/reputation/:address/reviews',
        'POST /api/v1/tx/submit',
        'GET  /api/v1/tx',
        'GET  /api/v1/tx/:hash',
        'POST/GET /api/v1/webhook-subscriptions',
        'GET/PATCH/DELETE /api/v1/webhook-subscriptions/:id',
        'POST /api/v1/webhook-subscriptions/:id/rotate-secret',
        'GET  /api/v1/webhook-subscriptions/:id/deliveries',
        'POST /api/v1/templates',
        'GET  /api/v1/templates',
        'GET  /api/v1/templates/:id',
        'PUT  /api/v1/templates/:id',
        'DELETE /api/v1/templates/:id',
        'GET  /api/v1/contracts/:id/history',
        'GET  /api/v1/audit/verify',
        'GET  /api/v1/disputes (admin)',
        'GET  /api/v1/disputes/:contractId (admin)',
        'GET  /api/v1/auth/whoami',
        'GET  /api/v1/auth/challenge',
        'POST /api/v1/auth/token',
        'POST /api/v1/receipts/verify',
        'GET/POST /api/cron/expire-contracts',
        'GET/POST /api/cron/index-events',
        'GET  /api/v1/chain/events',
        'GET  /api/v1/chain/indexer',
      ],
};
