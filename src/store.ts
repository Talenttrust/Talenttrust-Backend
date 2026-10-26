/**
 * In-memory escrow store. Mirrors the state machine of the on-chain Soroban
 * escrow contract so the API can be used without a database. Data lives only
 * for the lifetime of the process (or serverless instance).
 *
 * All monetary amounts are stored internally as bigint (token smallest-unit
 * integers) and serialised as decimal strings in *Units response fields.
 * The legacy numeric fields (totalAmount, fundedAmount, releasedAmount,
 * milestone.amount) are kept for backwards compatibility but are documented as
 * deprecated and lossy above Number.MAX_SAFE_INTEGER.
 */

import { parseAmount, checkedAdd, I128_MAX } from './amount';
import { HttpError } from './amount-error';
import { AuditStore, type AuditAction, type AuditContext, type AuditState } from './audit';
import { StoreEventEmitter } from './events';
import { allowedActions, assertAllowed, TRANSITIONS, type AllowedAction } from './stateMachine';
import { parseAccount, parseToken } from './stellar/address';

export { HttpError } from './amount-error';

export type ContractStatus =
  | 'Created'
  | 'Funded'
  | 'Completed'
  | 'Disputed'
  | 'Resolved'
  | 'Cancelled'
  | 'Expired';

export type SortSpec =
  | 'createdAt'
  | '-createdAt'
  | 'updatedAt'
  | '-updatedAt'
  | 'totalAmount'
  | '-totalAmount';

/** Keyset cursor: the sort it was issued for plus the last row's sort value and id. */
export interface Cursor {
  sort: string;
  lastValue: string;
  lastId: number;
}

export interface QueryFilters {
  status?: string[];
  party?: string;
  role?: 'client' | 'freelancer';
  token?: string;
  createdAfter?: string;
  createdBefore?: string;
  linked?: boolean;
}

export type TemplateMode = 'fixed' | 'percent';

/** Template milestone: a fixed amount (base units) or a share of the budget in basis points. */
export interface TemplateMilestone {
  title: string;
  /** @deprecated lossy above 2^53; use amountUnits */
  amount?: number;
  amountUnits?: string;
  percentBps?: number;
}

export interface Template {
  id: number;
  owner: string;
  name: string;
  description?: string;
  mode: TemplateMode;
  milestones: TemplateMilestone[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface InternalTemplate extends Omit<Template, 'milestones'> {
  milestones: Array<{ title: string; amount?: bigint; percentBps?: number }>;
}

const toPublicTemplate = (t: InternalTemplate): Template => ({
  ...t,
  milestones: t.milestones.map((m) =>
    m.amount !== undefined
      ? { title: m.title, amount: Number(m.amount), amountUnits: m.amount.toString() }
      : { title: m.title, percentBps: m.percentBps },
  ),
});

export interface Milestone {
  index: number;
  title: string;
  /** @deprecated lossy above 2^53; use amountUnits */
  amount: number | string;
  /** Canonical decimal-string representation of the milestone amount (base units). */
  amountUnits: string;
  released: boolean;
}

export interface Dispute {
  raisedBy: string;
  reason: string;
  openedAt: string;
  freelancerBps?: number;
  resolvedAt?: string;
  /** API key id that resolved the dispute (when scoped API keys are configured). */
  resolvedBy?: string;
}

export interface DriftItem {
  field: string;
  api: unknown;
  chain: unknown;
}

export interface ChainInfo {
  escrowId: string;
  linkedAt: string;
  lastVerifiedAt: string;
  status: 'in_sync' | 'drift' | 'unverified';
  drift: DriftItem[];
}

export interface EscrowContract {
  id: number;
  title: string;
  client: string;
  freelancer: string;
  token: string;
  /** 'XLM' when the token is the native asset, otherwise null. */
  tokenSymbol: string | null;
  milestones: Milestone[];
  /** @deprecated lossy above 2^53; use totalAmountUnits */
  totalAmount: number | string;
  /** Canonical decimal-string total (base units). */
  totalAmountUnits: string;
  /** @deprecated lossy above 2^53; use fundedAmountUnits */
  fundedAmount: number | string;
  /** Canonical decimal-string funded amount (base units). */
  fundedAmountUnits: string;
  /** @deprecated lossy above 2^53; use releasedAmountUnits */
  releasedAmount: number | string;
  /** Canonical decimal-string released amount (base units). */
  releasedAmountUnits: string;
  status: ContractStatus;
  reputationIssued: boolean;
  dispute?: Dispute;
  chain?: ChainInfo;
  /** Term revision number; starts at 1 and increments on every edit. */
  revision: number;
  /** Entity version for ETag / If-Match; starts at 1 and increments on every state change. */
  version: number;
  /** Template the milestones were generated from, if any (and its version at the time). */
  templateId?: number;
  templateVersion?: number;
  createdAt: string;
  updatedAt: string;
  /** Contracts still `Created` (not fully funded) at this instant expire. */
  fundingDeadline: string;
  expiredAt?: string;
  /** @deprecated lossy above 2^53; use refundableAmountUnits */
  refundableAmount?: number;
  /** Amount returned to the client when a partially funded contract expired (base units). */
  refundableAmountUnits?: string;
}

export interface ContractRevision {
  revision: number;
  at: string;
  changes: Array<{ field: 'title' | 'milestones'; from: unknown; to: unknown }>;
}

/** One row of a party's activity statement (CSV/JSON export). */
export interface StatementRow {
  contract_id: string;
  title: string;
  role: 'client' | 'freelancer';
  counterparty: string;
  token: string;
  status: ContractStatus;
  /** @deprecated lossy above 2^53; use total_amount_units */
  total_amount: number;
  funded_amount: number;
  released_amount: number;
  outstanding_amount: number;
  /** Exact base-unit amounts as decimal strings. */
  total_amount_units: string;
  funded_amount_units: string;
  released_amount_units: string;
  outstanding_amount_units: string;
  dispute_freelancer_bps: number | null;
  created_at: string;
  updated_at: string;
}

export type RatingHistogram = [number, number, number, number, number];

export type ReputationSort = 'score' | 'completed' | 'average';

export interface Reputation {
  address: string;
  completedContracts: number;
  totalRating: number;
  averageRating: number;
  /** Bayesian score: round2((C * m + total) / (C + completed)), m = global mean rating (3 when none). */
  score: number;
  /** 1-based rank by score among rated freelancers; null when unrated. */
  rank: number | null;
  /** Count of 1★..5★ ratings. */
  histogram: RatingHistogram;
  lastRatedAt: string | null;
}

export interface ReputationPage {
  data: Reputation[];
  page: { limit: number; nextCursor: string | null; hasMore: boolean };
}

interface ReputationRecord {
  completed: number;
  total: number;
  histogram: RatingHistogram;
  lastRatedAt: string | null;
}

interface LeaderboardCache {
  priorWeight: number;
  globalMean: number;
  bySort: Record<ReputationSort, Reputation[]>;
  byAddress: Map<string, Reputation>;
}

const REPUTATION_SORTS: ReputationSort[] = ['score', 'completed', 'average'];

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** C in the Bayesian score; REPUTATION_PRIOR_WEIGHT (default 5) unless overridden per store. */
const parsePriorWeight = (override?: number): number => {
  if (override !== undefined) return override;
  const raw = process.env.REPUTATION_PRIOR_WEIGHT;
  if (raw === undefined || raw === '') return 5;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 5;
};

const encodeReputationCursor = (sort: ReputationSort, address: string): string =>
  Buffer.from(JSON.stringify({ sort, address }), 'utf8').toString('base64url');

const decodeReputationCursor = (cursor: string, expectedSort: ReputationSort): string => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_cursor', 'cursor is malformed');
  }
  if (!parsed || typeof parsed !== 'object') throw new HttpError(400, 'invalid_cursor', 'cursor is malformed');
  const { sort, address } = parsed as { sort?: unknown; address?: unknown };
  if (sort !== expectedSort || typeof address !== 'string' || !address) {
    throw new HttpError(400, 'invalid_cursor', 'cursor does not match query');
  }
  return address;
};

export type ReviewRole = 'client_to_freelancer' | 'freelancer_to_client';

export interface Review {
  id: number;
  contractId: number;
  reviewer: string;
  reviewee: string;
  role: ReviewRole;
  rating: number;
  comment?: string;
  context?: 'disputed';
  createdAt: string;
}

export type DisputeStatusFilter = 'open' | 'resolved' | 'all';
export type DisputeSort = 'oldest' | 'newest' | 'value';

/** Admin view of a dispute (includes the confidential reason). */
export interface DisputeView {
  contractId: number;
  title: string;
  client: string;
  freelancer: string;
  raisedBy: string;
  raisedByRole: 'client' | 'freelancer';
  reason: string;
  openedAt: string;
  ageHours: number;
  /** @deprecated lossy above 2^53; use heldUnits */
  held: number;
  /** Escrow value still held while the dispute is open (base units); 0 once resolved. */
  heldUnits: string;
  slaDeadline: string;
  overdue: boolean;
  resolvedAt?: string;
  freelancerBps?: number;
}

export interface DisputeQueue {
  data: DisputeView[];
  summary: { open: number; overdue: number; totalHeld: number };
  page: { limit: number; count: number; nextCursor: string | null };
}

interface DisputeRecord {
  view: DisputeView;
  held: bigint;
  open: boolean;
}

interface DisputeCursor {
  s: DisputeSort;
  k: string;
  i: number;
}

export const DEFAULT_DISPUTE_LIMIT = 20;
export const MAX_DISPUTE_LIMIT = 100;

/**
 * Public projection of a contract for HTTP responses: dispute reasons are
 * confidential and only served by the admin dispute routes.
 */
export function publicContract<T extends { dispute?: Dispute }>(c: T): T {
  if (!c.dispute) return c;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { reason: _reason, ...disputeRest } = c.dispute;
  return { ...c, dispute: disputeRest as Dispute };
}

const encodeDisputeCursor = (c: DisputeCursor): string => Buffer.from(JSON.stringify(c)).toString('base64url');

const decodeDisputeCursor = (raw: string): DisputeCursor => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_cursor', 'cursor is not a valid queue cursor');
  }
  const c = parsed as { s?: unknown; k?: unknown; i?: unknown };
  if (
    (c?.s !== 'oldest' && c?.s !== 'newest' && c?.s !== 'value') ||
    typeof c?.k !== 'string' ||
    !Number.isInteger(c?.i) ||
    (c.i as number) < 1
  ) {
    throw new HttpError(400, 'invalid_cursor', 'cursor is not a valid queue cursor');
  }
  if (c.s === 'value' && !/^(0|[1-9][0-9]*)$/.test(c.k)) {
    throw new HttpError(400, 'invalid_cursor', 'cursor is not a valid queue cursor');
  }
  return { s: c.s, k: c.k, i: c.i as number };
};

/** Internal store record — keeps bigints for arithmetic. */
interface InternalContract {
  id: number;
  title: string;
  client: string;
  freelancer: string;
  token: string;
  tokenSymbol: string | null;
  milestones: Array<{
    index: number;
    title: string;
    amount: bigint;
    released: boolean;
  }>;
  totalAmount: bigint;
  fundedAmount: bigint;
  releasedAmount: bigint;
  status: ContractStatus;
  reputationIssued: boolean;
  dispute?: Dispute;
  chain?: ChainInfo;
  revision: number;
  revisions: ContractRevision[];
  version: number;
  templateId?: number;
  templateVersion?: number;
  createdAt: string;
  updatedAt: string;
  fundingDeadline: string;
  expiredAt?: string;
  refundableAmount?: bigint;
}

const MAX_MILESTONES = 20;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DEFAULT_FUNDING_WINDOW_MS = 14 * DAY_MS;
const MAX_FUNDING_WINDOW_MS = 90 * DAY_MS;

export type Clock = () => Date;

export type MutationRecorder = (action: string, result: string) => void;

/** Store methods counted by escrow_mutations_total, mapped to their `action` label. */
const INSTRUMENTED_MUTATIONS: Array<[string, string]> = [
  ['create', 'create'],
  ['deposit', 'deposit'],
  ['release', 'release'],
  ['openDispute', 'dispute'],
  ['resolveDispute', 'resolve'],
  ['cancel', 'cancel'],
  ['rate', 'rate'],
];

const parseIsoMillis = (value: unknown): number | undefined => {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  ) {
    return undefined;
  }
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : undefined;
};
const MAX_REVISIONS = 50;

/** Validate a milestones array into internal (bigint) milestones. */
function parseMilestones(input: unknown): InternalContract['milestones'] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new HttpError(400, 'invalid_milestones', 'milestones must be a non-empty array');
  }
  if (input.length > MAX_MILESTONES) {
    throw new HttpError(400, 'invalid_milestones', `at most ${MAX_MILESTONES} milestones`);
  }
  return input.map((m: unknown, index: number) => {
    const raw =
      typeof m === 'number' || typeof m === 'string' || typeof m === 'boolean'
        ? { amount: m }
        : ((m ?? {}) as { title?: unknown; amount?: unknown });
    const amount = parseAmount(raw.amount, `milestone ${index} amount`);
    return {
      index,
      title: typeof raw.title === 'string' && raw.title ? raw.title : `Milestone ${index + 1}`,
      amount,
      released: false,
    };
  });
}

/** Sum milestone amounts with overflow check (mirrors contract checked_add). */
function sumMilestones(milestones: InternalContract['milestones']): bigint {
  let total = 0n;
  for (let i = 0; i < milestones.length; i++) {
    total = checkedAdd(total, milestones[i].amount, `milestone ${i} amount`);
  }
  return total;
}

/** JSON-safe snapshot of milestones for revision history. */
const publicMilestones = (milestones: InternalContract['milestones']): Milestone[] =>
  milestones.map((m) => ({
    index: m.index,
    title: m.title,
    amount: Number(m.amount),
    amountUnits: m.amount.toString(),
    released: m.released,
  }));

/** Project an internal contract to the public API shape. */
function toPublic(c: InternalContract): EscrowContract {
  return {
    id: c.id,
    title: c.title,
    client: c.client,
    freelancer: c.freelancer,
    token: c.token,
    tokenSymbol: c.tokenSymbol,
    milestones: publicMilestones(c.milestones),
    totalAmount: Number(c.totalAmount),    // deprecated
    totalAmountUnits: c.totalAmount.toString(),
    fundedAmount: Number(c.fundedAmount),  // deprecated
    fundedAmountUnits: c.fundedAmount.toString(),
    releasedAmount: Number(c.releasedAmount), // deprecated
    releasedAmountUnits: c.releasedAmount.toString(),
    status: c.status,
    reputationIssued: c.reputationIssued,
    dispute: c.dispute,
    chain: c.chain,
    revision: c.revision,
    version: c.version,
    templateId: c.templateId,
    templateVersion: c.templateVersion,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    fundingDeadline: c.fundingDeadline,
    expiredAt: c.expiredAt,
    refundableAmount: c.refundableAmount === undefined ? undefined : Number(c.refundableAmount),
    refundableAmountUnits: c.refundableAmount?.toString(),
  };
}

export class EscrowStore {
  private contracts = new Map<number, InternalContract>();
  private reputation = new Map<string, ReputationRecord>();
  private clientReputation = new Map<string, ReputationRecord>();
  private leaderboardCache: LeaderboardCache | null = null;
  private priorWeightOverride?: number;
  private readonly clock: Clock;
  /** Domain events (webhooks), emitted only after a mutation succeeds. */
  readonly events: StoreEventEmitter;
  private reviews: Review[] = [];
  private nextReviewId = 1;
  private nextId = 1;
  private templates = new Map<number, InternalTemplate>();
  private nextTemplateId = 1;

  private mutationRecorder: MutationRecorder = () => undefined;
  /** Append-only, hash-chained audit log of successful state transitions. */
  public audit: AuditStore = new AuditStore();
  private auditContext: AuditContext | undefined;

  /** `new EscrowStore(clock)`, `new EscrowStore(events)` or `new EscrowStore({ clock?, priorWeight?, events? })`. */
  constructor(
    clockOrOptions: Clock | StoreEventEmitter | { clock?: Clock; priorWeight?: number; events?: StoreEventEmitter } = () => new Date(),
  ) {
    if (typeof clockOrOptions === 'function') {
      this.clock = clockOrOptions;
      this.events = new StoreEventEmitter();
    } else if (clockOrOptions instanceof StoreEventEmitter) {
      this.clock = () => new Date();
      this.events = clockOrOptions;
    } else {
      this.clock = clockOrOptions.clock ?? (() => new Date());
      this.priorWeightOverride = clockOrOptions.priorWeight;
      this.events = clockOrOptions.events ?? new StoreEventEmitter();
    }
    // Count every domain mutation as ok / <error code> for the metrics endpoint, and
    // append an audit entry (before/after state) for every one that succeeds.
    for (const [method, action] of INSTRUMENTED_MUTATIONS) {
      const self = this as unknown as Record<string, (...args: unknown[]) => unknown>;
      const original = self[method].bind(this);
      self[method] = (...args: unknown[]) => {
        const contractId = method === 'create' ? undefined : (args[0] as number);
        const before = contractId === undefined ? undefined : this.auditState(contractId);
        let result: unknown;
        try {
          result = original(...args);
        } catch (err) {
          this.mutationRecorder(action, err instanceof HttpError ? err.code : 'error');
          throw err;
        }
        this.mutationRecorder(action, 'ok');
        const affectedId = contractId ?? (result as { id: number }).id;
        this.recordAudit(action as AuditAction, affectedId, before, args);
        this.emitEvent(action, affectedId, args, result);
        return result;
      };
    }
  }

  /** Publish the webhook event for a successful mutation (dispute reasons stay confidential). */
  private emitEvent(action: string, contractId: number, args: unknown[], result: unknown) {
    const internal = this.contracts.get(contractId);
    if (!internal) return;
    const contract = publicContract(toPublic(internal));
    switch (action) {
      case 'create':
        this.events.emit('contract.created', { contract });
        break;
      case 'deposit':
        this.events.emit(contract.status === 'Funded' ? 'contract.funded' : 'contract.updated', { contract });
        break;
      case 'release':
        this.events.emit('milestone.released', { contract, milestone: contract.milestones[Number(args[1])] });
        break;
      case 'dispute':
        this.events.emit('dispute.raised', { contract, dispute: contract.dispute });
        break;
      case 'resolve':
        this.events.emit('dispute.resolved', { contract, dispute: contract.dispute });
        break;
      case 'cancel':
        this.events.emit('contract.cancelled', { contract });
        break;
      case 'rate':
        this.events.emit('reputation.issued', { contract, reputation: result as Record<string, unknown> });
        break;
    }
  }

  /**
   * Run `fn` with the given actor/request id attached to any audit entries it
   * creates (store methods are synchronous, so the context cannot leak).
   */
  withAuditContext<T>(ctx: AuditContext, fn: () => T): T {
    const previous = this.auditContext;
    this.auditContext = ctx;
    try {
      return fn();
    } finally {
      this.auditContext = previous;
    }
  }

  private auditState(id: number): AuditState | undefined {
    const c = this.contracts.get(id);
    if (!c) return undefined;
    return {
      status: c.status,
      fundedAmount: Number(c.fundedAmount),
      releasedAmount: Number(c.releasedAmount),
      fundedAmountUnits: c.fundedAmount.toString(),
      releasedAmountUnits: c.releasedAmount.toString(),
    };
  }

  private recordAudit(action: AuditAction, contractId: number, before: AuditState | undefined, args: unknown[]) {
    const c = this.contracts.get(contractId);
    const after = this.auditState(contractId);
    if (!c || !after) return;
    const prev = before ?? { status: 'N/A', fundedAmount: 0, releasedAmount: 0, fundedAmountUnits: '0', releasedAmountUnits: '0' };
    const delta = (field: 'fundedAmountUnits' | 'releasedAmountUnits') => BigInt(after[field]!) - BigInt(prev[field]!);
    let details: Record<string, unknown> = {};
    if (action === 'create') details = { title: c.title, totalAmount: Number(c.totalAmount), totalAmountUnits: c.totalAmount.toString() };
    else if (action === 'deposit') details = { amount: Number(delta('fundedAmountUnits')), amountUnits: delta('fundedAmountUnits').toString() };
    else if (action === 'release') {
      details = { index: args[1], amount: Number(delta('releasedAmountUnits')), amountUnits: delta('releasedAmountUnits').toString() };
    } else if (action === 'dispute') details = { raisedBy: c.dispute?.raisedBy }; // reason stays confidential
    else if (action === 'resolve') {
      const held = BigInt(prev.fundedAmountUnits!) - BigInt(prev.releasedAmountUnits!);
      const toFreelancer = delta('releasedAmountUnits');
      details = {
        freelancerBps: c.dispute?.freelancerBps,
        toFreelancer: Number(toFreelancer),
        toClient: Number(held - toFreelancer),
        toFreelancerUnits: toFreelancer.toString(),
        toClientUnits: (held - toFreelancer).toString(),
      };
    } else if (action === 'rate') details = { rating: Number(args[1]) };
    const ctx = this.auditContext ?? {};
    this.audit.append({
      contractId,
      action,
      ctx: { ...ctx, actor: ctx.actor ?? (action === 'dispute' ? c.dispute?.raisedBy : undefined) },
      before: prev,
      after,
      details,
      at: this.nowIso(),
    });
  }

  /** Install a callback invoked once per mutation with its action and result (`ok` or error code). */
  setMutationRecorder(recorder: MutationRecorder): void {
    this.mutationRecorder = recorder;
  }

  private now(): Date {
    return this.clock();
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  currentTime(): string {
    return this.nowIso();
  }

  private validateCreationDeadline(value: unknown, now: number): string {
    if (value === undefined) return new Date(now + DEFAULT_FUNDING_WINDOW_MS).toISOString();
    const deadline = parseIsoMillis(value);
    if (deadline === undefined || deadline < now + HOUR_MS || deadline > now + MAX_FUNDING_WINDOW_MS) {
      throw new HttpError(400, 'invalid_deadline', 'fundingDeadline must be 1 hour to 90 days in the future');
    }
    return new Date(deadline).toISOString();
  }

  /** Lazily expire a still-unfunded contract whose funding deadline has passed; refunds partial funding. */
  private expireIfDue(c: InternalContract, now = this.now()): InternalContract {
    if (c.status === 'Created' && now.getTime() >= Date.parse(c.fundingDeadline)) {
      c.status = 'Expired';
      c.expiredAt = now.toISOString();
      const held = c.fundedAmount - c.releasedAmount;
      c.refundableAmount = held > 0n ? held : 0n;
      c.fundedAmount = c.releasedAmount;
      c.updatedAt = now.toISOString();
      c.version += 1;
    }
    return c;
  }

  list(filter: { status?: string; party?: string; linked?: boolean } = {}): EscrowContract[] {
    return [...this.contracts.values()]
      .map((c) => this.expireIfDue(c))
      .filter(
        (c) =>
          (!filter.status || c.status === filter.status) &&
          (!filter.party || c.client === filter.party || c.freelancer === filter.party) &&
          (filter.linked === undefined || (filter.linked ? !!c.chain : !c.chain)),
      )
      .map(toPublic);
  }

  /** Filtered, sorted, keyset-paginated listing (ties broken by id). */
  query(opts: { filters?: QueryFilters; sort?: string; limit?: number; after?: Cursor }): {
    data: EscrowContract[];
    hasMore: boolean;
    nextCursor: Cursor | null;
  } {
    const limit = opts.limit ?? 20;
    const sort = opts.sort ?? '-createdAt';
    const { field, desc } = parseSort(sort);
    let items = [...this.contracts.values()]
      .map((c) => this.expireIfDue(c))
      .filter((c) => matchesFilters(c, opts.filters));
    items.sort((a, b) => compareContracts(a, b, field, desc));
    const after = opts.after;
    if (after) items = items.filter((c) => isAfterCursor(c, after, field, desc));
    const page = items.slice(0, limit + 1);
    const hasMore = page.length > limit;
    const data = hasMore ? page.slice(0, limit) : page;
    let nextCursor: Cursor | null = null;
    if (hasMore) {
      const last = data[data.length - 1];
      nextCursor = { sort, lastValue: String(sortValue(last, field)), lastId: last.id };
    }
    return { data: data.map(toPublic), hasMore, nextCursor };
  }

  private getInternal(id: number): InternalContract {
    const c = this.contracts.get(id);
    if (!c) throw new HttpError(404, 'contract_not_found', `Contract ${id} not found`);
    return this.expireIfDue(c);
  }

  get(id: number): EscrowContract {
    return toPublic(this.getInternal(id));
  }

  create(input: {
    title?: unknown;
    client?: unknown;
    freelancer?: unknown;
    token?: unknown;
    milestones?: unknown;
    fundingDeadline?: unknown;
    templateId?: unknown;
    budget?: unknown;
  }): EscrowContract {
    const client = parseAccount(input.client, 'client');
    const freelancer = parseAccount(input.freelancer, 'freelancer');
    if (client === freelancer) {
      throw new HttpError(400, 'invalid_parties', 'client and freelancer must differ');
    }
    const { token, tokenSymbol } = parseToken(input.token, 'token');
    let milestones: InternalContract['milestones'];
    let template: InternalTemplate | undefined;
    if (input.templateId !== undefined) {
      if (input.milestones !== undefined) {
        throw new HttpError(400, 'invalid_contract', 'Cannot provide both templateId and milestones');
      }
      const tid = Number(input.templateId);
      if (!Number.isInteger(tid) || tid <= 0) {
        throw new HttpError(400, 'invalid_template', 'templateId must be a positive integer');
      }
      template = this.getInternalTemplate(tid);
      milestones = this.resolveTemplate(template, input.budget);
    } else {
      if (input.budget !== undefined) {
        throw new HttpError(400, 'invalid_budget', 'budget must not be provided when using milestones directly');
      }
      milestones = parseMilestones(input.milestones);
    }
    const totalAmount = sumMilestones(milestones);

    const nowDate = this.now();
    const fundingDeadline = this.validateCreationDeadline(input.fundingDeadline, nowDate.getTime());
    const now = nowDate.toISOString();
    const c: InternalContract = {
      id: this.nextId++,
      title: typeof input.title === 'string' && input.title ? input.title : 'Untitled engagement',
      client,
      freelancer,
      token,
      tokenSymbol,
      milestones,
      totalAmount,
      fundedAmount: 0n,
      releasedAmount: 0n,
      status: 'Created',
      reputationIssued: false,
      revision: 1,
      version: 1,
      revisions: [],
      createdAt: now,
      updatedAt: now,
      fundingDeadline,
      templateId: template?.id,
      templateVersion: template?.version,
    };
    this.contracts.set(c.id, c);
    return toPublic(c);
  }

  edit(
    id: number,
    input: { client?: unknown; title?: unknown; milestones?: unknown },
  ): EscrowContract {
    const c = this.getInternal(id);
    if (input.client !== c.client) {
      throw new HttpError(403, 'forbidden', 'Only the client can edit this contract');
    }
    if (c.status !== 'Created' || c.fundedAmount !== 0n) {
      throw new HttpError(409, 'contract_locked', 'Contract terms can only be edited before funding');
    }
    const hasTitle = Object.prototype.hasOwnProperty.call(input, 'title');
    const hasMilestones = Object.prototype.hasOwnProperty.call(input, 'milestones');
    if (!hasTitle && !hasMilestones) {
      throw new HttpError(400, 'empty_patch', 'At least one of title or milestones must be provided');
    }

    const changes: ContractRevision['changes'] = [];
    let title: string | undefined;
    let milestones: InternalContract['milestones'] | undefined;
    let totalAmount: bigint | undefined;
    if (hasTitle) {
      title = typeof input.title === 'string' && input.title ? input.title : 'Untitled engagement';
      if (title !== c.title) changes.push({ field: 'title', from: c.title, to: title });
    }
    if (hasMilestones) {
      milestones = parseMilestones(input.milestones);
      totalAmount = sumMilestones(milestones);
      const from = publicMilestones(c.milestones);
      const to = publicMilestones(milestones);
      if (JSON.stringify(from) !== JSON.stringify(to)) {
        changes.push({ field: 'milestones', from, to });
      }
    }

    const at = new Date().toISOString();
    if (title !== undefined) c.title = title;
    if (milestones && totalAmount !== undefined) {
      c.milestones = milestones;
      c.totalAmount = totalAmount;
    }
    c.revision += 1;
    c.revisions.push({ revision: c.revision, at, changes });
    if (c.revisions.length > MAX_REVISIONS) c.revisions.shift();
    c.updatedAt = at;
    c.version += 1;
    return toPublic(c);
  }

  getRevisions(id: number): ContractRevision[] {
    return this.getInternal(id).revisions;
  }

  delete(id: number, clientRaw: unknown): void {
    const c = this.getInternal(id);
    if (clientRaw !== c.client) {
      throw new HttpError(403, 'forbidden', 'Only the client can withdraw this contract');
    }
    if (c.status !== 'Created' || c.fundedAmount !== 0n) {
      throw new HttpError(409, 'contract_locked', 'Contract can only be withdrawn before funding');
    }
    this.contracts.delete(id);
  }

  /** Allowed actions for contract `id` per the shared state machine (`as` only affects the dispute party check). */
  allowedActions(id: number, as?: string): { status: ContractStatus; actions: AllowedAction[] } {
    return allowedActions(this.getInternal(id), as);
  }

  /**
   * Party check used when the request is authenticated (wallet auth). Mirrors
   * the contract's `require_auth()` rules. `caller === undefined` means the
   * request was not authenticated (auth disabled) and keeps legacy behaviour.
   */
  private requireClient(c: InternalContract, caller: string | undefined, action: string) {
    if (caller !== undefined && caller !== c.client) {
      throw new HttpError(403, 'forbidden', `Only the contract client can ${action}`);
    }
  }

  /** Single point that records a successful state change: bumps `version` and `updatedAt`. */
  private touch(c: InternalContract): EscrowContract {
    c.version += 1;
    c.updatedAt = this.nowIso();
    return toPublic(c);
  }

  /** @security when `caller` is given it must equal contract.client — mirrors deposit_funds's client.require_auth() */
  deposit(id: number, amountRaw: unknown, caller?: string): EscrowContract {
    const c = this.getInternal(id);
    this.requireClient(c, caller, 'deposit');
    assertAllowed('deposit', c, { amount: amountRaw });
    c.fundedAmount = checkedAdd(c.fundedAmount, parseAmount(amountRaw, 'amount'), 'fundedAmount');
    c.status = TRANSITIONS.deposit.nextStatus(c);
    return this.touch(c);
  }

  /** @security when `caller` is given it must equal contract.client — mirrors release_milestone's client.require_auth() */
  release(id: number, index: number, caller?: string): EscrowContract {
    const c = this.getInternal(id);
    this.requireClient(c, caller, 'release milestones');
    assertAllowed('release', c, { index });
    const m = c.milestones[index];
    c.releasedAmount = checkedAdd(c.releasedAmount, m.amount, 'releasedAmount');
    m.released = true;
    c.status = TRANSITIONS.release.nextStatus(c);
    return this.touch(c);
  }

  /**
   * @security when `caller` (authenticated address) is given it must be the
   * client or freelancer — mirrors caller.require_auth(). A body `raisedBy` is
   * accepted for backwards compatibility but rejected (403) if it differs.
   */
  openDispute(id: number, raisedByRaw: unknown, reason: unknown, caller?: string): EscrowContract {
    const c = this.getInternal(id);
    let raisedBy = raisedByRaw === undefined ? undefined : parseAccount(raisedByRaw, 'raisedBy');
    if (caller !== undefined) {
      if (caller !== c.client && caller !== c.freelancer) {
        throw new HttpError(403, 'forbidden', 'Only the client or freelancer can open a dispute');
      }
      if (raisedBy !== undefined && raisedBy !== caller) {
        throw new HttpError(403, 'forbidden', 'raisedBy must match the authenticated address');
      }
      raisedBy = caller;
    }
    assertAllowed('dispute', c, { raisedBy });
    c.status = TRANSITIONS.dispute.nextStatus(c);
    c.dispute = {
      raisedBy: raisedBy as string,
      reason: typeof reason === 'string' && reason ? reason : 'No reason given',
      openedAt: this.nowIso(),
    };
    return this.touch(c);
  }

  /** `resolvedBy` is the id of the scoped API key that authorised the resolution, if any. */
  resolveDispute(id: number, freelancerBpsRaw: unknown, resolvedBy?: string): EscrowContract {
    const c = this.getInternal(id);
    assertAllowed('resolve', c, { freelancerBps: freelancerBpsRaw });
    const bps = Number(freelancerBpsRaw);
    // Mirror the contract's integer arithmetic exactly:
    //   to_freelancer = held * bps / 10000  (integer division — truncation)
    //   to_client     = held - to_freelancer
    //   to_freelancer + to_client == held  (always)
    const held = c.fundedAmount - c.releasedAmount;
    const toFreelancer = (held * BigInt(bps)) / 10000n;
    c.releasedAmount = c.releasedAmount + toFreelancer;
    c.status = TRANSITIONS.resolve.nextStatus(c);
    if (c.dispute) {
      c.dispute.freelancerBps = bps;
      c.dispute.resolvedAt = this.nowIso();
      if (resolvedBy !== undefined) c.dispute.resolvedBy = resolvedBy;
    }
    return this.touch(c);
  }

  /** @security when `caller` is given it must equal contract.client — mirrors cancel_contract's client.require_auth() */
  cancel(id: number, caller?: string): EscrowContract {
    const c = this.getInternal(id);
    this.requireClient(c, caller, 'cancel');
    assertAllowed('cancel', c);
    c.status = TRANSITIONS.cancel.nextStatus(c);
    return this.touch(c);
  }

  private validateComment(commentRaw: unknown): string | undefined {
    if (commentRaw === undefined || commentRaw === null) return undefined;
    if (typeof commentRaw !== 'string') {
      throw new HttpError(400, 'invalid_comment', 'comment must be a string');
    }
    const trimmed = commentRaw.trim();
    if (trimmed.length > 1000) {
      throw new HttpError(400, 'invalid_comment', 'comment must be at most 1000 characters');
    }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
      throw new HttpError(400, 'invalid_comment', 'comment must not contain control characters');
    }
    return trimmed.length ? trimmed : undefined;
  }

  private validateRating(ratingRaw: unknown): number {
    const rating = Number(ratingRaw);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new HttpError(400, 'invalid_rating', 'rating must be an integer from 1 to 5');
    }
    return rating;
  }

  private applyReputation(map: Map<string, ReputationRecord>, address: string, rating: number) {
    const r = map.get(address) ?? { completed: 0, total: 0, histogram: [0, 0, 0, 0, 0] as RatingHistogram, lastRatedAt: null };
    r.completed += 1;
    r.total += rating;
    r.histogram[rating - 1] += 1;
    r.lastRatedAt = this.nowIso();
    map.set(address, r);
    this.leaderboardCache = null;
  }

  createReview(
    id: number,
    input: { reviewer?: unknown; rating?: unknown; comment?: unknown },
  ): Review {
    const c = this.getInternal(id);
    const { reviewer } = input;
    if (reviewer !== c.client && reviewer !== c.freelancer) {
      throw new HttpError(403, 'forbidden', 'Only the client or freelancer can review this contract');
    }
    if (c.status !== 'Completed' && c.status !== 'Resolved') {
      throw new HttpError('contract_not_completed', `Contract is ${c.status}`);
    }
    const role: ReviewRole =
      reviewer === c.client ? 'client_to_freelancer' : 'freelancer_to_client';
    if (this.reviews.some((r) => r.contractId === id && r.role === role)) {
      throw new HttpError(409, 'already_reviewed', 'Review already submitted for this direction');
    }
    const rating = this.validateRating(input.rating);
    const comment = this.validateComment(input.comment);
    const reviewee = role === 'client_to_freelancer' ? c.freelancer : c.client;
    const review: Review = {
      id: this.nextReviewId++,
      contractId: id,
      reviewer: reviewer as string,
      reviewee,
      role,
      rating,
      createdAt: new Date().toISOString(),
    };
    if (comment !== undefined) review.comment = comment;
    if (c.status === 'Resolved') review.context = 'disputed';
    this.reviews.push(review);
    if (role === 'client_to_freelancer') {
      this.applyReputation(this.reputation, c.freelancer, rating);
      c.reputationIssued = true;
    } else {
      this.applyReputation(this.clientReputation, c.client, rating);
    }
    this.touch(c);
    return review;
  }

  /** Client-only: move the funding deadline later (at most 90 days from now). */
  extendDeadline(id: number, client: unknown, fundingDeadline: unknown): EscrowContract {
    const c = this.getInternal(id);
    if (c.status === 'Expired') {
      throw new HttpError(409, 'contract_expired', 'Contract funding deadline has passed');
    }
    if (client !== c.client) {
      throw new HttpError('forbidden', 'Only the client can extend the funding deadline');
    }
    const deadline = parseIsoMillis(fundingDeadline);
    const now = this.now().getTime();
    if (deadline === undefined || deadline <= Date.parse(c.fundingDeadline) || deadline > now + MAX_FUNDING_WINDOW_MS) {
      throw new HttpError(400, 'invalid_deadline', 'fundingDeadline must be later and no more than 90 days away');
    }
    c.fundingDeadline = new Date(deadline).toISOString();
    return this.touch(c);
  }

  /** Expire every due unfunded contract; returns the ids expired by this sweep (idempotent). */
  sweepExpired(): number[] {
    const now = this.now();
    const expired: number[] = [];
    for (const c of this.contracts.values()) {
      const wasExpired = c.status === 'Expired';
      this.expireIfDue(c, now);
      if (!wasExpired && c.status === 'Expired') expired.push(c.id);
    }
    return expired;
  }

  /** @security when `caller` is given it must equal contract.client — mirrors issue_reputation's client.require_auth() */
  rate(id: number, ratingRaw: unknown, caller?: string): Reputation {
    const c = this.getInternal(id);
    this.requireClient(c, caller, 'issue reputation');
    assertAllowed('rate', c, { rating: ratingRaw });
    const rating = this.validateRating(ratingRaw);
    this.createReview(id, { reviewer: c.client, rating });
    return this.getReputation(c.freelancer);
  }

  async linkEscrow(
    id: number,
    escrowIdRaw: unknown,
    chainReader: import('./chain').ChainReader,
  ): Promise<EscrowContract> {
    const c = this.getInternal(id);
    if (typeof escrowIdRaw !== 'string' || !escrowIdRaw.trim()) {
      throw new HttpError(400, 'invalid_escrow_id', 'escrowId must be a non-empty string');
    }
    const escrowId = escrowIdRaw.trim();
    if (c.chain) {
      throw new HttpError(
        409,
        'already_linked',
        `Contract ${id} is already linked to on-chain escrow ${c.chain.escrowId}`,
      );
    }

    for (const other of this.contracts.values()) {
      if (other.id !== id && other.chain?.escrowId === escrowId) {
        throw new HttpError(
          409,
          'chain_escrow_taken',
          `On-chain escrow ${escrowId} is already linked to contract ${other.id}`,
        );
      }
    }

    let result: import('./chain').ChainReaderResult | null;
    try {
      result = await chainReader.getContract(escrowId);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(503, 'chain_unavailable', 'Chain RPC service unavailable');
    }

    if (!result || !result.contract) {
      throw new HttpError(404, 'chain_contract_not_found', `On-chain escrow ${escrowId} not found`);
    }

    const onChain = result.contract;
    const mismatches: DriftItem[] = [];

    if (c.client !== onChain.client) {
      mismatches.push({ field: 'client', api: c.client, chain: onChain.client });
    }
    if (c.freelancer !== onChain.freelancer) {
      mismatches.push({ field: 'freelancer', api: c.freelancer, chain: onChain.freelancer });
    }
    if (c.token !== onChain.token) {
      mismatches.push({ field: 'token', api: c.token, chain: onChain.token });
    }

    const apiAmounts = c.milestones.map((m) => m.amount.toString());
    const chainAmounts = (onChain.milestones || []).map((m) => String(m.amount));
    if (apiAmounts.length !== chainAmounts.length) {
      mismatches.push({ field: 'milestones.count', api: apiAmounts.length, chain: chainAmounts.length });
    } else {
      for (let i = 0; i < apiAmounts.length; i++) {
        let equal = false;
        try {
          equal = BigInt(apiAmounts[i]) === BigInt(chainAmounts[i]);
        } catch {
          equal = apiAmounts[i] === chainAmounts[i];
        }
        if (!equal) {
          mismatches.push({ field: `milestones[${i}].amount`, api: apiAmounts[i], chain: chainAmounts[i] });
        }
      }
    }

    if (mismatches.length > 0) {
      throw new HttpError(409, 'chain_mismatch', 'API contract does not match on-chain escrow parameters', { mismatches });
    }

    const now = new Date().toISOString();
    c.chain = { escrowId, linkedAt: now, lastVerifiedAt: now, status: 'in_sync', drift: [] };
    return this.touch(c);
  }

  async checkParity(
    id: number,
    chainReader: import('./chain').ChainReader,
  ): Promise<{
    status: 'in_sync' | 'drift';
    drift: DriftItem[];
    checkedAt: string;
    latestLedger: number;
  }> {
    const c = this.getInternal(id);
    if (!c.chain) {
      throw new HttpError(409, 'not_linked', `Contract ${id} is not linked to any on-chain escrow`);
    }

    let result: import('./chain').ChainReaderResult | null;
    try {
      result = await chainReader.getContract(c.chain.escrowId);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(503, 'chain_unavailable', 'Chain RPC service unavailable');
    }

    if (!result || !result.contract) {
      throw new HttpError(404, 'chain_contract_not_found', `On-chain escrow ${c.chain.escrowId} not found`);
    }

    const onChain = result.contract;
    const drift: DriftItem[] = [];

    let fundedEqual = false;
    try {
      fundedEqual = c.fundedAmount === BigInt(String(onChain.fundedAmount));
    } catch {
      fundedEqual = c.fundedAmount.toString() === String(onChain.fundedAmount);
    }
    if (!fundedEqual) {
      drift.push({ field: 'fundedAmount', api: c.fundedAmount.toString(), chain: String(onChain.fundedAmount) });
    }

    let releasedEqual = false;
    try {
      releasedEqual = c.releasedAmount === BigInt(String(onChain.releasedAmount));
    } catch {
      releasedEqual = c.releasedAmount.toString() === String(onChain.releasedAmount);
    }
    if (!releasedEqual) {
      drift.push({ field: 'releasedAmount', api: c.releasedAmount.toString(), chain: String(onChain.releasedAmount) });
    }

    if (c.status !== onChain.status) {
      drift.push({ field: 'status', api: c.status, chain: onChain.status });
    }
    if (c.reputationIssued !== onChain.reputationIssued) {
      drift.push({ field: 'reputationIssued', api: c.reputationIssued, chain: onChain.reputationIssued });
    }

    const count = Math.min(c.milestones.length, (onChain.milestones || []).length);
    for (let i = 0; i < count; i++) {
      if (c.milestones[i].released !== onChain.milestones[i].released) {
        drift.push({ field: `milestones[${i}].released`, api: c.milestones[i].released, chain: onChain.milestones[i].released });
      }
    }

    const now = new Date().toISOString();
    const parityStatus = drift.length > 0 ? 'drift' : 'in_sync';
    c.chain.lastVerifiedAt = now;
    c.chain.status = parityStatus;
    c.chain.drift = drift;
    this.touch(c);

    return { status: parityStatus, drift, checkedAt: now, latestLedger: result.latestLedger };
  }

  /** Ranked leaderboard (freelancer ratings), cached until the next rating. */
  private getLeaderboardCache(): LeaderboardCache {
    const C = parsePriorWeight(this.priorWeightOverride);
    if (this.leaderboardCache && this.leaderboardCache.priorWeight === C) return this.leaderboardCache;

    let globalTotal = 0;
    let globalCompleted = 0;
    for (const r of this.reputation.values()) {
      globalTotal += r.total;
      globalCompleted += r.completed;
    }
    const m = globalCompleted > 0 ? globalTotal / globalCompleted : 3;

    const entries: Reputation[] = [];
    for (const [address, r] of this.reputation.entries()) {
      if (r.completed < 1) continue;
      entries.push({
        address,
        completedContracts: r.completed,
        totalRating: r.total,
        averageRating: round2(r.total / r.completed),
        score: round2((C * m + r.total) / (C + r.completed)),
        rank: null,
        histogram: [...r.histogram] as RatingHistogram,
        lastRatedAt: r.lastRatedAt,
      });
    }
    const tieBreak = (a: Reputation, b: Reputation) =>
      b.completedContracts !== a.completedContracts
        ? b.completedContracts - a.completedContracts
        : a.address < b.address
          ? -1
          : a.address > b.address
            ? 1
            : 0;
    const byScore = [...entries].sort((a, b) => (b.score !== a.score ? b.score - a.score : tieBreak(a, b)));
    const byAddress = new Map<string, Reputation>();
    byScore.forEach((entry, idx) => {
      entry.rank = idx + 1;
      byAddress.set(entry.address, entry);
    });
    this.leaderboardCache = {
      priorWeight: C,
      globalMean: m,
      bySort: {
        score: byScore,
        completed: [...byScore].sort(tieBreak),
        average: [...byScore].sort((a, b) => (b.averageRating !== a.averageRating ? b.averageRating - a.averageRating : tieBreak(a, b))),
      },
      byAddress,
    };
    return this.leaderboardCache;
  }

  private cloneReputation(r: Reputation): Reputation {
    return { ...r, histogram: [...r.histogram] as RatingHistogram };
  }

  getReputation(address: string): Reputation {
    const cache = this.getLeaderboardCache();
    const cached = cache.byAddress.get(address);
    if (cached) return this.cloneReputation(cached);
    return {
      address,
      completedContracts: 0,
      totalRating: 0,
      averageRating: 0,
      score: cache.priorWeight > 0 ? round2(cache.globalMean) : 0,
      rank: null,
      histogram: [0, 0, 0, 0, 0],
      lastRatedAt: null,
    };
  }

  /** Paginated leaderboard: sort=score|completed|average, minCompleted (default 1), limit 1..100. */
  listReputation(query: { sort?: unknown; minCompleted?: unknown; limit?: unknown; cursor?: unknown } = {}): ReputationPage {
    const sortRaw = query.sort === undefined || query.sort === '' ? 'score' : query.sort;
    if (typeof sortRaw !== 'string' || !REPUTATION_SORTS.includes(sortRaw as ReputationSort)) {
      throw new HttpError(400, 'invalid_sort', 'sort must be one of score, completed, average');
    }
    const sort = sortRaw as ReputationSort;

    let minCompleted = 1;
    if (query.minCompleted !== undefined && query.minCompleted !== '') {
      const n = Number(query.minCompleted);
      if (typeof query.minCompleted !== 'string' || !Number.isInteger(n) || n < 0) {
        throw new HttpError(400, 'invalid_min_completed', 'minCompleted must be a non-negative integer');
      }
      minCompleted = n;
    }

    let limit = 20;
    if (query.limit !== undefined && query.limit !== '') {
      const n = Number(query.limit);
      if (typeof query.limit !== 'string' || !Number.isInteger(n) || n < 1 || n > 100) {
        throw new HttpError(400, 'invalid_limit', 'limit must be an integer 1..100');
      }
      limit = n;
    }

    let cursorAddress: string | undefined;
    if (query.cursor !== undefined && query.cursor !== '') {
      if (typeof query.cursor !== 'string') throw new HttpError(400, 'invalid_cursor', 'cursor must be a string');
      cursorAddress = decodeReputationCursor(query.cursor, sort);
    }

    const filtered = this.getLeaderboardCache().bySort[sort].filter((r) => r.completedContracts >= minCompleted);
    let startIndex = 0;
    if (cursorAddress !== undefined) {
      const idx = filtered.findIndex((r) => r.address === cursorAddress);
      if (idx === -1) throw new HttpError(400, 'invalid_cursor', 'cursor not found in result set');
      startIndex = idx + 1;
    }
    const slice = filtered.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + limit < filtered.length;
    return {
      data: slice.map((r) => this.cloneReputation(r)),
      page: { limit, nextCursor: hasMore && slice.length ? encodeReputationCursor(sort, slice[slice.length - 1].address) : null, hasMore },
    };
  }

  getReputationWithClient(address: string): Reputation & {
    asClient: { completedContracts: number; averageRating: number };
  } {
    const base = this.getReputation(address);
    const cr = this.clientReputation.get(address) ?? { completed: 0, total: 0 };
    return {
      ...base,
      asClient: {
        completedContracts: cr.completed,
        averageRating: cr.completed ? Math.round((cr.total / cr.completed) * 100) / 100 : 0,
      },
    };
  }

  private toDisputeRecord(c: InternalContract, now: Date, slaHours: number): DisputeRecord {
    const dispute = c.dispute;
    if (!dispute) throw new HttpError(404, 'dispute_not_found', `No dispute for contract ${c.id}`);
    const openedMs = Date.parse(dispute.openedAt);
    const deadlineMs = openedMs + slaHours * 3_600_000;
    const open = c.status === 'Disputed';
    // Once resolved, the held balance has been split between the parties.
    const held = open ? c.fundedAmount - c.releasedAmount : 0n;
    const view: DisputeView = {
      contractId: c.id,
      title: c.title,
      client: c.client,
      freelancer: c.freelancer,
      raisedBy: dispute.raisedBy,
      raisedByRole: dispute.raisedBy === c.client ? 'client' : 'freelancer',
      reason: dispute.reason,
      openedAt: dispute.openedAt,
      ageHours: Math.max(0, Math.round(((now.getTime() - openedMs) / 3_600_000) * 100) / 100),
      held: Number(held),
      heldUnits: held.toString(),
      slaDeadline: new Date(deadlineMs).toISOString(),
      overdue: open && now.getTime() > deadlineMs,
    };
    if (dispute.resolvedAt !== undefined) view.resolvedAt = dispute.resolvedAt;
    if (dispute.freelancerBps !== undefined) view.freelancerBps = dispute.freelancerBps;
    return { view, held, open };
  }

  /** Sort key comparison; ties always break by contractId (newest: descending). */
  private compareDisputes(sort: DisputeSort, a: { held: bigint; openedAt: string; id: number }, b: { held: bigint; openedAt: string; id: number }): number {
    if (sort === 'value') {
      if (a.held !== b.held) return a.held > b.held ? -1 : 1;
      return a.id - b.id;
    }
    const byOpened = a.openedAt < b.openedAt ? -1 : a.openedAt > b.openedAt ? 1 : 0;
    if (byOpened !== 0) return sort === 'newest' ? -byOpened : byOpened;
    return sort === 'newest' ? b.id - a.id : a.id - b.id;
  }

  /** Admin dispute queue: every contract that has (had) a dispute, with SLA tracking. */
  listDisputes(opts: {
    status: DisputeStatusFilter;
    sort: DisputeSort;
    overdueOnly: boolean;
    limit: number;
    cursor?: string;
    now: Date;
    slaHours: number;
  }): DisputeQueue {
    const { status, sort, overdueOnly, limit, cursor, now, slaHours } = opts;
    const records: DisputeRecord[] = [];
    let open = 0;
    let overdue = 0;
    let totalHeld = 0n;
    for (const c of this.contracts.values()) {
      if (!c.dispute) continue;
      const record = this.toDisputeRecord(c, now, slaHours);
      records.push(record);
      if (record.open) {
        open += 1;
        totalHeld += record.held;
        if (record.view.overdue) overdue += 1;
      }
    }
    const key = (r: DisputeRecord) => ({ held: r.held, openedAt: r.view.openedAt, id: r.view.contractId });
    records.sort((a, b) => this.compareDisputes(sort, key(a), key(b)));
    const filtered = records.filter(
      (r) => (status === 'all' || (status === 'open' ? r.open : !r.open)) && (!overdueOnly || r.view.overdue),
    );
    let from = 0;
    if (cursor !== undefined) {
      const cur = decodeDisputeCursor(cursor);
      if (cur.s !== sort) throw new HttpError(400, 'invalid_cursor', 'cursor does not match the requested sort');
      const after = { held: sort === 'value' ? BigInt(cur.k) : 0n, openedAt: cur.k, id: cur.i };
      const idx = filtered.findIndex((r) => this.compareDisputes(sort, key(r), after) > 0);
      from = idx === -1 ? filtered.length : idx;
    }
    const page = filtered.slice(from, from + limit);
    const last = page[page.length - 1];
    const nextCursor =
      last && from + limit < filtered.length
        ? encodeDisputeCursor({ s: sort, k: sort === 'value' ? last.held.toString() : last.view.openedAt, i: last.view.contractId })
        : null;
    return {
      data: page.map((r) => r.view),
      summary: { open, overdue, totalHeld: Number(totalHeld) },
      page: { limit, count: page.length, nextCursor },
    };
  }

  getDispute(contractId: number, now: Date, slaHours: number): DisputeView {
    const c = this.contracts.get(contractId);
    if (!c || !c.dispute) throw new HttpError(404, 'dispute_not_found', `No dispute for contract ${contractId}`);
    return this.toDisputeRecord(c, now, slaHours).view;
  }

  // --- Milestone templates ---

  private getInternalTemplate(id: number): InternalTemplate {
    const t = this.templates.get(id);
    if (!t) throw new HttpError(404, 'template_not_found', `Template ${id} not found`);
    return t;
  }

  private parseTemplateMilestones(mode: unknown, raw: unknown): InternalTemplate['milestones'] {
    if (mode !== 'fixed' && mode !== 'percent') throw new HttpError(400, 'invalid_mode', "mode must be 'fixed' or 'percent'");
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new HttpError(400, 'invalid_milestones', 'milestones must be a non-empty array');
    }
    if (raw.length > MAX_MILESTONES) throw new HttpError(400, 'invalid_milestones', `at most ${MAX_MILESTONES} milestones`);
    const out = raw.map((m: unknown, index: number) => {
      const r = (m ?? {}) as { title?: unknown; amount?: unknown; percentBps?: unknown };
      const title = typeof r.title === 'string' && r.title ? r.title : `Milestone ${index + 1}`;
      if (mode === 'fixed') {
        if (r.percentBps !== undefined) throw new HttpError(400, 'invalid_milestones', 'fixed mode milestones must not have percentBps');
        return { title, amount: parseAmount(r.amount, `milestone ${index} amount`) };
      }
      if (r.amount !== undefined) throw new HttpError(400, 'invalid_milestones', 'percent mode milestones must not have amount');
      const bps = r.percentBps;
      if (typeof bps !== 'number' || !Number.isInteger(bps) || bps <= 0 || bps > 10000) {
        throw new HttpError(400, 'invalid_percent', `milestone ${index} percentBps must be a positive integer`);
      }
      return { title, percentBps: bps };
    });
    if (mode === 'percent' && out.reduce((sum, m) => sum + (m.percentBps ?? 0), 0) !== 10000) {
      throw new HttpError(400, 'invalid_template', 'percentBps must sum to exactly 10000');
    }
    return out;
  }

  /** Expand a template into contract milestones; percent mode floors each share and puts the remainder on the last. */
  private resolveTemplate(t: InternalTemplate, budgetRaw: unknown): InternalContract['milestones'] {
    if (t.mode === 'fixed') {
      if (budgetRaw !== undefined) {
        throw new HttpError(400, 'invalid_budget', 'budget must not be provided for fixed mode templates');
      }
      return t.milestones.map((m, index) => ({ index, title: m.title, amount: m.amount as bigint, released: false }));
    }
    if (budgetRaw === undefined) throw new HttpError(400, 'invalid_budget', 'budget is required for percent mode templates');
    const budget = parseAmount(budgetRaw, 'budget');
    const milestones = t.milestones.map((m, index) => ({
      index,
      title: m.title,
      amount: (budget * BigInt(m.percentBps ?? 0)) / 10000n,
      released: false,
    }));
    const remainder = budget - milestones.reduce((sum, m) => sum + m.amount, 0n);
    milestones[milestones.length - 1].amount += remainder;
    if (milestones.some((m) => m.amount <= 0n)) {
      throw new HttpError(400, 'invalid_budget', 'budget is too small: every milestone must get a positive amount');
    }
    return milestones;
  }

  listTemplates(filter: { owner?: string } = {}): Template[] {
    return [...this.templates.values()].filter((t) => !filter.owner || t.owner === filter.owner).map(toPublicTemplate);
  }

  getTemplate(id: number): Template {
    return toPublicTemplate(this.getInternalTemplate(id));
  }

  createTemplate(input: { owner?: unknown; name?: unknown; description?: unknown; mode?: unknown; milestones?: unknown }): Template {
    const { owner, name, description, mode } = input;
    if (typeof owner !== 'string' || !owner) throw new HttpError(400, 'invalid_owner', 'owner is required');
    if (typeof name !== 'string' || !name || name.length > 80) {
      throw new HttpError(400, 'invalid_name', 'name is required (max 80 characters)');
    }
    if (description !== undefined && (typeof description !== 'string' || description.length > 500)) {
      throw new HttpError(400, 'invalid_description', 'description must be a string (max 500 characters)');
    }
    const milestones = this.parseTemplateMilestones(mode, input.milestones);
    const now = this.nowIso();
    const t: InternalTemplate = {
      id: this.nextTemplateId++,
      owner,
      name,
      description: description as string | undefined,
      mode: mode as TemplateMode,
      milestones,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.templates.set(t.id, t);
    return toPublicTemplate(t);
  }

  /** Owner-only; bumps `version`. Contracts already created keep their copied milestones. */
  updateTemplate(
    id: number,
    owner: unknown,
    input: { name?: unknown; description?: unknown; mode?: unknown; milestones?: unknown },
  ): Template {
    const t = this.getInternalTemplate(id);
    if (t.owner !== owner) throw new HttpError(403, 'forbidden', 'Only the owner can update this template');
    const { name, description } = input;
    if (name !== undefined && (typeof name !== 'string' || !name || name.length > 80)) {
      throw new HttpError(400, 'invalid_name', 'name is required (max 80 characters)');
    }
    if (description !== undefined && (typeof description !== 'string' || description.length > 500)) {
      throw new HttpError(400, 'invalid_description', 'description must be a string (max 500 characters)');
    }
    const mode = input.mode ?? t.mode;
    if (input.mode !== undefined && input.milestones === undefined && input.mode !== t.mode) {
      throw new HttpError(400, 'invalid_milestones', 'changing mode requires milestones for the new mode');
    }
    // Validate everything before mutating so a rejected update leaves the template unchanged.
    const milestones = input.milestones !== undefined ? this.parseTemplateMilestones(mode, input.milestones) : undefined;
    if (name !== undefined) t.name = name as string;
    if (description !== undefined) t.description = description as string;
    t.mode = mode as TemplateMode;
    if (milestones) t.milestones = milestones;
    t.version += 1;
    t.updatedAt = this.nowIso();
    return toPublicTemplate(t);
  }

  deleteTemplate(id: number, owner: unknown): void {
    const t = this.getInternalTemplate(id);
    if (t.owner !== owner) throw new HttpError(403, 'forbidden', 'Only the owner can delete this template');
    this.templates.delete(id);
  }

  /**
   * Statement rows for `address` (as client and/or freelancer) for contracts created in
   * [from, to). Dispute reasons are never included.
   */
  getStatement(address: string, from: Date, to: Date, role: 'client' | 'freelancer' | 'all'): StatementRow[] {
    return [...this.contracts.values()]
      .map((c) => this.expireIfDue(c))
      .filter((c) => {
        const isClient = c.client === address;
        const isFreelancer = c.freelancer === address;
        if (!isClient && !isFreelancer) return false;
        if (role === 'client' && !isClient) return false;
        if (role === 'freelancer' && !isFreelancer) return false;
        const created = Date.parse(c.createdAt);
        return created >= from.getTime() && created < to.getTime();
      })
      .map((c): StatementRow => {
        // Funds are only still held while the contract is live; resolution/cancellation/expiry pays out the rest.
        const holding = c.status === 'Created' || c.status === 'Funded' || c.status === 'Disputed';
        const outstanding = holding ? c.fundedAmount - c.releasedAmount : 0n;
        const asClient = c.client === address;
        return {
          contract_id: String(c.id),
          title: c.title,
          role: asClient ? 'client' : 'freelancer',
          counterparty: asClient ? c.freelancer : c.client,
          token: c.token,
          status: c.status,
          total_amount: Number(c.totalAmount),
          funded_amount: Number(c.fundedAmount),
          released_amount: Number(c.releasedAmount),
          outstanding_amount: Number(outstanding),
          total_amount_units: c.totalAmount.toString(),
          funded_amount_units: c.fundedAmount.toString(),
          released_amount_units: c.releasedAmount.toString(),
          outstanding_amount_units: outstanding.toString(),
          dispute_freelancer_bps: c.dispute?.freelancerBps ?? null,
          created_at: c.createdAt,
          updated_at: c.updatedAt,
        };
      });
  }

  stats() {
    const all = [...this.contracts.values()].map((c) => this.expireIfDue(c));
    const byStatus: Record<string, number> = {};
    for (const c of all) byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;

    // Sum with bigint to match contract precision; expose as decimal strings.
    let totalEscrowedBig = 0n;
    let totalReleasedBig = 0n;
    for (const c of all) {
      totalEscrowedBig += c.fundedAmount - c.releasedAmount;
      totalReleasedBig += c.releasedAmount;
    }

    return {
      contracts: all.length,
      byStatus,
      /** @deprecated lossy above 2^53; use totalEscrowedUnits */
      totalEscrowed: Number(totalEscrowedBig),
      totalEscrowedUnits: totalEscrowedBig.toString(),
      /** @deprecated lossy above 2^53; use totalReleasedUnits */
      totalReleased: Number(totalReleasedBig),
      totalReleasedUnits: totalReleasedBig.toString(),
    };
  }

  listReviews(
    address: string,
    filter: { role?: string; limit?: number; cursor?: number } = {},
  ): { reviews: Review[]; nextCursor: number | null } {
    const limit = filter.limit && filter.limit > 0 ? Math.min(filter.limit, 100) : 20;
    const all = this.reviews
      .filter((r) => r.reviewee === address)
      .filter((r) => !filter.role || r.role === filter.role)
      .sort((a, b) => b.id - a.id);
    const cursor = filter.cursor;
    const start = cursor ? all.findIndex((r) => r.id < cursor) : 0;
    const slice = all.slice(start < 0 ? 0 : start, start < 0 ? 0 : start + limit);
    const nextCursor = start < 0 ? null : start + limit < all.length ? slice[slice.length - 1]?.id ?? null : null;
    return { reviews: slice, nextCursor };
  }

  /**
   * Seed a few demo engagements so the API is explorable out of the box.
   *
   * These are deterministic public keys generated once for the demo data. Only
   * the public halves are stored here; no secret key is kept in the repository.
   */
  seed(): this {
    const clientA = 'GACE4EDG4UIAAELYTPAXRIFNNTKNUQYYLWFCWWNTOHNN5PEFVGQXEOYC';
    const freelancerA = 'GCR36A6TRNBLWVDPRSP5YEZJKCGEEZHIKDX3KPRJL6OAI36UNKTCKJT6';
    const clientB = 'GBQNWA2VJPMV4IUTQ7LWK2QICSQFTP3NF7N3YUZG4ZU24EDD6GUOLLQL';
    const freelancerB = 'GBQFACOFJHTDDQNQLQWUWWUK3EQPPTSEDREY6LKQHVAXLWFAMODA7ARV';
    const a = this.create({
      title: 'Landing page redesign',
      client: clientA,
      freelancer: freelancerA,
      token: 'native',
      milestones: [
        { title: 'Wireframes', amount: 2500000 },
        { title: 'Visual design', amount: 5000000 },
        { title: 'Implementation', amount: 7500000 },
      ],
    });
    this.deposit(a.id, 15000000);
    this.release(a.id, 0);
    const b = this.create({
      title: 'Smart contract audit',
      client: clientB,
      freelancer: freelancerB,
      token: 'native',
      milestones: [{ title: 'Audit report', amount: 20000000 }],
    });
    this.deposit(b.id, 20000000);
    this.release(b.id, 0);
    this.rate(b.id, 5);
    return this;
  }
}

export const LIST_STATUSES: ContractStatus[] = ['Created', 'Funded', 'Completed', 'Disputed', 'Resolved', 'Cancelled', 'Expired'];
const SORT_FIELDS = ['createdAt', 'updatedAt', 'totalAmount'] as const;
type SortField = (typeof SORT_FIELDS)[number];

function parseSort(sort: string): { field: SortField; desc: boolean } {
  const desc = sort.startsWith('-');
  const field = desc ? sort.slice(1) : sort;
  if (!(SORT_FIELDS as readonly string[]).includes(field)) {
    throw new HttpError(400, 'invalid_query', 'invalid sort');
  }
  return { field: field as SortField, desc };
}

function sortValue(c: InternalContract, field: SortField): string | bigint {
  return field === 'totalAmount' ? c.totalAmount : c[field];
}

/** Compare two sort values; totalAmount compares as bigint (cursor values arrive as strings). */
function compareValue(va: string | bigint, vb: string | bigint, field: SortField): number {
  if (field === 'totalAmount') {
    let a: bigint;
    let b: bigint;
    try {
      a = BigInt(va);
      b = BigInt(vb);
    } catch {
      throw new HttpError(400, 'invalid_cursor', 'invalid cursor');
    }
    return a < b ? -1 : a > b ? 1 : 0;
  }
  const a = String(va);
  const b = String(vb);
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareContracts(a: InternalContract, b: InternalContract, field: SortField, desc: boolean): number {
  const cmp = compareValue(sortValue(a, field), sortValue(b, field), field);
  if (cmp !== 0) return desc ? -cmp : cmp;
  return a.id - b.id;
}

function matchesFilters(c: InternalContract, f: QueryFilters | undefined): boolean {
  if (!f) return true;
  if (f.status && !f.status.includes(c.status)) return false;
  if (f.party !== undefined) {
    if (f.role === 'client') {
      if (c.client !== f.party) return false;
    } else if (f.role === 'freelancer') {
      if (c.freelancer !== f.party) return false;
    } else if (c.client !== f.party && c.freelancer !== f.party) {
      return false;
    }
  }
  if (f.token && c.token !== f.token) return false;
  if (f.createdAfter && c.createdAt < f.createdAfter) return false;
  if (f.createdBefore && c.createdAt > f.createdBefore) return false;
  if (f.linked !== undefined && !!c.chain !== f.linked) return false;
  return true;
}

function isAfterCursor(c: InternalContract, after: Cursor, field: SortField, desc: boolean): boolean {
  const cmp = compareValue(sortValue(c, field), after.lastValue, field);
  if (cmp !== 0) return desc ? cmp < 0 : cmp > 0;
  return c.id > after.lastId;
}
