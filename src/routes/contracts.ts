import express, { type Request, type RequestHandler, type Response, type Router } from 'express';
import { HttpError, publicContract } from '../store';
import type { EscrowStore } from '../store';
import type { AuditAction, AuditEntry } from '../audit';
import type { EventStore, IndexedEvent } from '../indexer/types';
import type { ChainReader } from '../chain';
import { validate } from '../validation/middleware';
import {
  CancelBody,
  CreateContractBody,
  DepositBody,
  DisputeBody,
  IdParam,
  ListQuery,
  MilestoneReleaseParams,
  RateBody,
  ResolveBody,
} from '../validation/schemas';
import { project } from '../utils/project';
import {
  callerOf,
  conditionalGet,
  createContractRouteHelpers,
  getContractEtag,
  getContractsListEtag,
  id,
  jsonObjectBody,
  parseFields,
  parseFilters,
  parseLimit,
  parseSortParam,
  parseCursorParam,
  serializeCursor,
  wrap,
} from './helpers';
import type { ScopedApiKeyRequest } from '../auth/scopedApiKeyMiddleware';

export type ContractsRouteSegment = 'actions' | 'main1' | 'main2' | 'history' | 'all';

export interface ContractsRouterDeps {
  v1?: Router;
  segment?: ContractsRouteSegment;
  store: EscrowStore;
  eventStore: EventStore;
  chainReader: ChainReader;
  requireAuth: RequestHandler;
  requireNotPaused: RequestHandler;
  requireResolveKey: RequestHandler;
  maybeAttachReceipt: (req: Request, res: Response, contract: unknown) => void;
  receiptManager: () => { issueReceipt: (contract: Record<string, unknown>, origin: string) => string };
  getOrigin: (req: Request) => string;
  // helpers/utilities can be injected for explicitness; defaults come from ./helpers
  wrapFn?: typeof wrap;
  jsonBody?: RequestHandler[];
  validateFn?: typeof validate;
}

type TimelineSource = 'api' | 'chain';

interface TimelinePosition {
  at: string;
  source: TimelineSource;
  id: number | string;
}

interface TimelineRecord extends TimelinePosition {
  type: string;
  payload: Record<string, unknown>;
}

const auditDetailFields: Record<AuditAction, readonly string[]> = {
  create: ['title', 'totalAmount', 'totalAmountUnits'],
  deposit: ['amount', 'amountUnits'],
  release: ['index', 'amount', 'amountUnits'],
  dispute: ['raisedBy'],
  resolve: ['freelancerBps', 'toFreelancer', 'toClient', 'toFreelancerUnits', 'toClientUnits'],
  cancel: [],
  rate: ['rating'],
};

function safeFields(source: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const field of fields) {
    const value = source[field];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      safe[field] = value;
    }
  }
  return safe;
}

function auditTimelineRecord(entry: AuditEntry): TimelineRecord {
  return {
    source: 'api',
    type: entry.action,
    at: entry.at,
    id: entry.seq,
    payload: {
      seq: entry.seq,
      actor: entry.actor,
      requestId: entry.requestId,
      before: safeFields(entry.before as unknown as Record<string, unknown>, [
        'status',
        'fundedAmountUnits',
        'releasedAmountUnits',
      ]),
      after: safeFields(entry.after as unknown as Record<string, unknown>, [
        'status',
        'fundedAmountUnits',
        'releasedAmountUnits',
      ]),
      details: safeFields(entry.details, auditDetailFields[entry.action]),
    },
  };
}

function chainTimelineRecord(event: IndexedEvent): TimelineRecord {
  const eventData = event.event.data as unknown as Record<string, unknown>;
  const fields: Record<string, readonly string[]> = {
    Created: ['escrowId', 'client', 'freelancer', 'total'],
    Deposit: ['escrowId', 'amount'],
    Release: ['escrowId', 'index', 'amount'],
    Dispute: ['escrowId', 'caller'],
    Resolved: ['escrowId', 'toFreelancer', 'toClient'],
    Cancel: ['escrowId', 'refund'],
    Reputation: ['escrowId', 'freelancer', 'rating'],
    Paused: ['paused'],
    Init: ['admin'],
    Unknown: [],
  };

  return {
    source: 'chain',
    type: event.event.type,
    at: event.ledgerClosedAt,
    id: event.id,
    payload: {
      id: event.id,
      ledger: event.ledger,
      txHash: event.txHash,
      ...safeFields(eventData, fields[event.event.type]),
    },
  };
}

function compareTimeline(a: TimelinePosition, b: TimelinePosition): number {
  const aTime = Date.parse(a.at);
  const bTime = Date.parse(b.at);
  const timeOrder = Number.isFinite(aTime) && Number.isFinite(bTime) ? aTime - bTime : a.at.localeCompare(b.at);
  if (timeOrder !== 0) return timeOrder;
  if (a.source !== b.source) return a.source === 'api' ? -1 : 1;
  if (typeof a.id === 'number' && typeof b.id === 'number') return a.id - b.id;
  return String(a.id).localeCompare(String(b.id));
}

function parseTimelinePosition(value: string): TimelinePosition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new HttpError(400, 'invalid_cursor', 'invalid cursor');
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as TimelinePosition).at !== 'string' ||
    !Number.isFinite(Date.parse((parsed as TimelinePosition).at)) ||
    ((parsed as TimelinePosition).source !== 'api' && (parsed as TimelinePosition).source !== 'chain') ||
    !['string', 'number'].includes(typeof (parsed as TimelinePosition).id) ||
    (typeof (parsed as TimelinePosition).id === 'number' && !Number.isSafeInteger((parsed as TimelinePosition).id))
  ) {
    throw new HttpError(400, 'invalid_cursor', 'invalid cursor');
  }
  return parsed as TimelinePosition;
}

export function createContractsRouter(deps: ContractsRouterDeps): Router {
  const router = deps.v1 ?? express.Router();
  const segment = deps.segment ?? 'all';
  const { store, eventStore, chainReader, requireAuth, requireNotPaused, requireResolveKey } = deps;
  const w = deps.wrapFn ?? wrap;
  const jb = deps.jsonBody ?? jsonObjectBody;
  const v = deps.validateFn ?? validate;
  const { audited, checkPreconditions, setEtag, clientOf } = createContractRouteHelpers({ store });
  const maybeAttachReceipt = deps.maybeAttachReceipt;

  const addActions = () => {
    router.get(
      '/contracts/:id/actions',
      w((req) => {
        const contractId = id(req);
        const as = req.query.as;
        if (as !== undefined && (typeof as !== 'string' || !as.trim())) {
          throw new HttpError(400, 'invalid_actor', 'as must be a non-empty address string');
        }
        return store.allowedActions(contractId, as as string | undefined);
      }),
    );
  };

  const addMain1 = () => {
    router.get(
      '/contracts',
      v({ query: ListQuery }),
      w((req, res) => {
        const limit = parseLimit(req.query.limit);
        const sort = parseSortParam(req.query.sort);
        const after = parseCursorParam(req.query.cursor, sort);
        const filters = parseFilters(req.query);
        const spec = parseFields(req);
        const result = store.query({ filters, sort, limit, after });
        const qs = req.originalUrl.includes('?') ? req.originalUrl.split('?')[1] : '';
        if (conditionalGet(req, res, getContractsListEtag(result.data, qs))) return undefined;
        return {
          data: result.data.map((c) => project(publicContract(c), spec)),
          page: { limit, nextCursor: result.nextCursor ? serializeCursor(result.nextCursor) : null, hasMore: result.hasMore },
        };
      }),
    );
    router.post(
      '/contracts',
      ...jb,
      requireNotPaused,
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
      v({ body: CreateContractBody }),
      w((req, res) => {
        const created = audited(req, () => store.create(req.body));
        res.setHeader('ETag', getContractEtag(created));
        maybeAttachReceipt(req, res, created);
        res.status(201).json(publicContract(created));
      }),
    );
    router.get(
      '/contracts/:id',
      v({ params: IdParam }),
      w((req, res) => {
        const contract = store.get(Number(req.params.id));
        if (conditionalGet(req, res, getContractEtag(contract))) return undefined;
        return project(publicContract(contract), parseFields(req));
      }),
    );
    router.get(
      '/contracts/:id/receipt',
      w((req) => {
        const contract = store.get(id(req));
        return { receipt: deps.receiptManager().issueReceipt(publicContract(contract) as unknown as Record<string, unknown>, deps.getOrigin(req)) };
      }),
    );
    router.patch(
      '/contracts/:id',
      requireAuth,
      checkPreconditions,
      w((req, res) => {
        const updated = store.edit(id(req), { ...(req.body ?? {}), client: clientOf(req) });
        setEtag(res, updated);
        return publicContract(updated);
      }),
    );
    router.delete(
      '/contracts/:id',
      requireAuth,
      checkPreconditions,
      w((req, res) => {
        store.delete(id(req), clientOf(req));
        res.status(204).end();
      }),
    );
    router.get('/contracts/:id/revisions', w((req) => store.getRevisions(id(req))));
    router.post(
      '/contracts/:id/extend-deadline',
      requireAuth,
      checkPreconditions,
      w((req, res) => {
        const updated = store.extendDeadline(id(req), clientOf(req), req.body?.fundingDeadline);
        setEtag(res, updated);
        return publicContract(updated);
      }),
    );
    router.post(
      '/contracts/:id/deposit',
      ...jb,
      requireNotPaused,
      requireAuth,
      v({ params: IdParam, body: DepositBody }),
      checkPreconditions,
      w((req, res) => {
        const updated = audited(req, () => store.deposit(Number(req.params.id), req.body.amount, callerOf(req)));
        setEtag(res, updated);
        maybeAttachReceipt(req, res, updated);
        return publicContract(updated);
      }),
    );
    router.post(
      '/contracts/:id/milestones/:index/release',
      requireNotPaused,
      requireAuth,
      v({ params: MilestoneReleaseParams }),
      checkPreconditions,
      w((req, res) => {
        const updated = audited(req, () => store.release(Number(req.params.id), Number(req.params.index), callerOf(req)));
        setEtag(res, updated);
        maybeAttachReceipt(req, res, updated);
        return publicContract(updated);
      }),
    );
    router.post(
      '/contracts/:id/dispute',
      ...jb,
      requireNotPaused,
      requireAuth,
      v({ params: IdParam, body: DisputeBody }),
      checkPreconditions,
      w((req, res) => {
        const updated = audited(req, () =>
          store.openDispute(Number(req.params.id), req.body.raisedBy, req.body.reason, callerOf(req)),
        );
        setEtag(res, updated);
        maybeAttachReceipt(req, res, updated);
        return publicContract(updated);
      }),
    );
    router.post(
      '/contracts/:id/resolve',
      ...jb,
      requireResolveKey,
      v({ params: IdParam, body: ResolveBody }),
      checkPreconditions,
      w((req, res) => {
        const resolvedBy = (req as ScopedApiKeyRequest).scopedApiKey?.id;
        const updated = audited(req, () => store.resolveDispute(Number(req.params.id), req.body.freelancerBps, resolvedBy));
        setEtag(res, updated);
        maybeAttachReceipt(req, res, updated);
        return publicContract(updated);
      }),
    );
    router.post(
      '/contracts/:id/cancel',
      requireNotPaused,
      requireAuth,
      v({ params: IdParam, body: CancelBody }),
      checkPreconditions,
      w((req, res) => {
        const updated = audited(req, () => store.cancel(Number(req.params.id), callerOf(req)));
        setEtag(res, updated);
        maybeAttachReceipt(req, res, updated);
        return publicContract(updated);
      }),
    );
    router.post(
      '/contracts/:id/reputation',
      ...jb,
      requireAuth,
      v({ params: IdParam, body: RateBody }),
      checkPreconditions,
      w((req, res) => {
        const reputation = audited(req, () => store.rate(Number(req.params.id), req.body.rating, callerOf(req)));
        // The ETag and receipt cover the contract (now reputationIssued), not the reputation summary.
        const contract = store.get(Number(req.params.id));
        setEtag(res, contract);
        maybeAttachReceipt(req, res, contract);
        return reputation;
      }),
    );
  };

  const addMain2 = () => {
    router.post(
      '/contracts/:id/reviews',
      requireAuth,
      w((req, res) => {
        const body = req.body ?? {};
        const caller = callerOf(req);
        if (caller !== undefined && body.reviewer !== undefined && body.reviewer !== caller) {
          throw new HttpError(403, 'forbidden', 'reviewer must match the authenticated address');
        }
        res.status(201).json(store.createReview(id(req), caller === undefined ? body : { ...body, reviewer: caller }));
      }),
    );
    router.post(
      '/contracts/:id/link',
      ...jb,
      w(async (req) => publicContract(await store.linkEscrow(id(req), req.body?.escrowId, chainReader))),
    );
    router.get(
      '/contracts/:id/parity',
      w(async (req) => store.checkParity(id(req), chainReader)),
    );
  };

  const addHistory = () => {
    router.get(
      '/contracts/:id/history',
      w((req) => {
        const contractId = id(req);
        store.get(contractId); // 404 for unknown contracts
        const limit = req.query.limit === undefined ? undefined : Number(req.query.limit);
        const cursor = req.query.cursor === undefined ? undefined : Number(req.query.cursor);
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
          throw new HttpError(400, 'invalid_limit', 'limit must be an integer between 1 and 100');
        }
        if (cursor !== undefined && (!Number.isInteger(cursor) || cursor < 0)) {
          throw new HttpError(400, 'invalid_cursor', 'cursor must be a non-negative integer');
        }
        return store.audit.getContractHistory(contractId, limit, cursor);
      }),
    );

    router.get(
      '/contracts/:id/timeline',
      w((req) => {
        const contractId = id(req);
        const contract = store.get(contractId);
        const limit = parseLimit(req.query.limit);
        const cursor = parseCursorParam(req.query.cursor, 'timeline');
        const after = cursor ? parseTimelinePosition(cursor.lastValue) : undefined;
        if (cursor && cursor.lastId !== contractId) {
          throw new HttpError(400, 'invalid_cursor', 'cursor does not match contract');
        }

        const records = store.audit.getContractHistory(contractId).data.map(auditTimelineRecord);
        if (contract.chain?.escrowId) {
          let eventCursor: string | undefined;
          while (true) {
            const page = eventStore.query({ escrowId: contract.chain.escrowId, limit: 100, cursor: eventCursor });
            records.push(...page.data.map(chainTimelineRecord));
            if (page.data.length < 100) break;
            eventCursor = page.data[page.data.length - 1].id;
          }
        }

        records.sort(compareTimeline);
        const remaining = after ? records.filter((record) => compareTimeline(record, after) > 0) : records;
        const pageRecords = remaining.slice(0, limit + 1);
        const hasMore = pageRecords.length > limit;
        const data = (hasMore ? pageRecords.slice(0, limit) : pageRecords).map(({ source, type, at, payload }) => ({
          source,
          type,
          at,
          payload,
        }));
        const last = hasMore ? pageRecords[limit - 1] : undefined;
        const nextCursor = last
          ? serializeCursor({
              sort: 'timeline',
              lastValue: JSON.stringify({ at: last.at, source: last.source, id: last.id }),
              lastId: contractId,
            })
          : null;

        return { data, page: { limit, nextCursor, hasMore } };
      }),
    );
  };

  if (segment === 'all' || segment === 'actions') addActions();
  if (segment === 'all' || segment === 'main1') addMain1();
  if (segment === 'all' || segment === 'main2') addMain2();
  if (segment === 'all' || segment === 'history') addHistory();

  return router;
}