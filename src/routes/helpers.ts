import { createHmac, randomBytes, timingSafeEqual, createHash } from 'crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { StrKey } from '@stellar/stellar-sdk';
import { HttpError, LIST_STATUSES, publicContract, type Cursor, type EscrowContract, type QueryFilters, type DisputeSort, type DisputeStatusFilter } from '../store';
import type { WalletAuthRequest } from '../auth/middleware';
import type { PauseGuard } from '../pauseGuard';
import { parseFieldSpec } from '../utils/project';
import { bigIntReplacer } from '../amount';
import { DEFAULT_DISPUTE_LIMIT, MAX_DISPUTE_LIMIT } from '../config';

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

const CURSOR_SECRET = process.env.CURSOR_SECRET || randomBytes(32).toString('base64url');

function safeEqual(a: string, b: string): boolean {
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

export function serializeCursor(cursor: Cursor): string {
  const payload = Buffer.from(JSON.stringify(cursor)).toString('base64url');
  const sig = createHmac('sha256', CURSOR_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function parseCursorParam(cursor: unknown, sort: string): Cursor | undefined {
  if (cursor === undefined || cursor === '') return undefined;
  const parts = String(cursor).split('.');
  if (parts.length !== 2) throw new HttpError(400, 'invalid_cursor', 'invalid cursor');
  const [payload, sig] = parts;
  const expected = createHmac('sha256', CURSOR_SECRET).update(payload).digest('base64url');
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
  if (v === 'all' || v === 'open' || v === 'resolved' || v === 'cancelled') return v;
  throw new HttpError(400, 'invalid_status', 'status must be one of all, open, resolved, cancelled');
}

export function disputeSort(value: unknown): DisputeSort {
  const v = oneParam(value, 'invalid_sort', 'sort') ?? 'oldest';
  if (v === 'oldest' || v === 'newest' || v === 'client' || v === 'freelancer') return v;
  throw new HttpError(400, 'invalid_sort', 'sort must be one of oldest, newest, client, freelancer');
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

import type { ChainReadClient } from '../chain';

export class ChainReadCache {
  private readonly store = new Map<string, { value: unknown; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number
  ) {}

  get<T>(key: string): T | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    // LRU-lite: refresh insertion order on reads.
    this.store.delete(key);
    this.store.set(key, hit);
    return hit.value as T;
  }

  set(key: string, value: unknown): void {
    if (this.maxEntries <= 0 || this.ttlMs <= 0) return;
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }
}

export class ChainRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly windowMs: number,
    private readonly max: number
  ) {}

  consume(ip: string): { ok: boolean; retryAfterSec: number } {
    if (this.max <= 0 || this.windowMs <= 0) return { ok: true, retryAfterSec: 0 };
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const kept = (this.hits.get(ip) ?? []).filter((t) => t > cutoff);
    if (kept.length >= this.max) {
      this.hits.set(ip, kept);
      const retryAfterSec = Math.max(1, Math.ceil((kept[0] + this.windowMs - now) / 1000));
      return { ok: false, retryAfterSec };
    }
    kept.push(now);
    this.hits.set(ip, kept);
    return { ok: true, retryAfterSec: 0 };
  }
}

export const chainIdParam = (raw: string): bigint => {
  if (!/^[0-9]+$/.test(raw)) {
    throw new HttpError(400, 'invalid_contract_id', 'contract id must be a positive integer');
  }
  return BigInt(raw);
};

export const isChainReadClient = (value: unknown): value is ChainReadClient =>
  !!value &&
  typeof value === 'object' &&
  typeof (value as ChainReadClient).getEscrowByContractId === 'function';

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

export const rootApiInfo = {







































































};
