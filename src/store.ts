/**
 * In-memory escrow store. Mirrors the state machine of the on-chain Soroban
 * escrow contract so the API can be used without a database. Data lives only
 * for the lifetime of the process (or serverless instance).
 */

export type ContractStatus =
  | 'Created'
  | 'Funded'
  | 'Completed'
  | 'Disputed'
  | 'Resolved'
  | 'Cancelled';

export type SortSpec =
  | 'createdAt'
  | '-createdAt'
  | 'updatedAt'
  | '-updatedAt'
  | 'totalAmount'
  | '-totalAmount';

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

export interface Milestone {
  index: number;
  title: string;
  amount: number | string;
  released: boolean;
}

export interface Dispute {
  raisedBy: string;
  reason: string;
  openedAt: string;
  freelancerBps?: number;
  resolvedAt?: string;
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
  milestones: Milestone[];
  totalAmount: number | string;
  fundedAmount: number | string;
  releasedAmount: number | string;
  status: ContractStatus;
  reputationIssued: boolean;
  dispute?: Dispute;
  chain?: ChainInfo;
  createdAt: string;
  updatedAt: string;
}

export interface Reputation {
  address: string;
  completedContracts: number;
  totalRating: number;
  averageRating: number;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const MAX_MILESTONES = 20;
const ACTIVE: ContractStatus[] = ['Created', 'Funded'];

export class EscrowStore {
  private contracts = new Map<number, EscrowContract>();
  private reputation = new Map<string, { completed: number; total: number }>();
  private nextId = 1;

  list(filter: { status?: string; party?: string; linked?: boolean } = {}): EscrowContract[] {
    return [...this.contracts.values()].filter(
      (c) =>
        (!filter.status || c.status === filter.status) &&
        (!filter.party || c.client === filter.party || c.freelancer === filter.party) &&
        (filter.linked === undefined || (filter.linked ? !!c.chain : !c.chain)),
    );
  }

  query(opts: {
    filters?: QueryFilters;
    sort?: string;
    limit?: number;
    after?: Cursor;
  }): { data: EscrowContract[]; hasMore: boolean; nextCursor: Cursor | null } {
    const limit = opts.limit ?? 20;
    const sort = opts.sort ?? '-createdAt';
    const { field, desc } = parseSort(sort);
    let items = [...this.contracts.values()].filter((c) => matchesFilters(c, opts.filters));
    items.sort((a, b) => compareContracts(a, b, field, desc));
    const after = opts.after;
    if (after) {
      items = items.filter((c) => isAfterCursor(c, after, field, desc));
    }
    const raw = items.slice(0, limit + 1);
    const hasMore = raw.length > limit;
    const data = hasMore ? raw.slice(0, limit) : raw;
    let nextCursor: Cursor | null = null;
    if (hasMore) {
      const last = data[data.length - 1];
      nextCursor = { sort, lastValue: String(sortValue(last, field)), lastId: last.id };
    }
    return { data, hasMore, nextCursor };
  }

  get(id: number): EscrowContract {
    const c = this.contracts.get(id);
    if (!c) throw new HttpError(404, 'contract_not_found', `Contract ${id} not found`);
    return c;
  }

  create(input: {
    title?: unknown;
    client?: unknown;
    freelancer?: unknown;
    token?: unknown;
    milestones?: unknown;
  }): EscrowContract {
    const { client, freelancer } = input;
    if (typeof client !== 'string' || typeof freelancer !== 'string' || !client || !freelancer) {
      throw new HttpError(400, 'invalid_parties', 'client and freelancer are required strings');
    }
    if (client === freelancer) {
      throw new HttpError(400, 'invalid_parties', 'client and freelancer must differ');
    }
    if (!Array.isArray(input.milestones) || input.milestones.length === 0) {
      throw new HttpError(400, 'invalid_milestones', 'milestones must be a non-empty array');
    }
    if (input.milestones.length > MAX_MILESTONES) {
      throw new HttpError(400, 'invalid_milestones', `at most ${MAX_MILESTONES} milestones`);
    }
    const milestones: Milestone[] = input.milestones.map((m: unknown, index: number) => {
      const raw = (typeof m === 'number' || typeof m === 'string' ? { amount: m } : m) as {
        title?: unknown;
        amount?: unknown;
      };
      let amount: number | string;
      if (typeof raw?.amount === 'string' && /^\d+$/.test(raw.amount.trim())) {
        amount = raw.amount.trim();
      } else {
        const num = Number(raw?.amount);
        if (!Number.isFinite(num) || num <= 0) {
          throw new HttpError(400, 'invalid_amount', `milestone ${index} amount must be positive`);
        }
        amount = num;
      }
      return {
        index,
        title: typeof raw.title === 'string' && raw.title ? raw.title : `Milestone ${index + 1}`,
        amount,
        released: false,
      };
    });

    const hasBig = milestones.some((m) => typeof m.amount === 'string');
    const totalAmount = hasBig
      ? milestones.reduce((s, m) => s + BigInt(m.amount), 0n).toString()
      : milestones.reduce((s, m) => s + Number(m.amount), 0);

    const now = new Date().toISOString();
    const c: EscrowContract = {
      id: this.nextId++,
      title: typeof input.title === 'string' && input.title ? input.title : 'Untitled engagement',
      client,
      freelancer,
      token: typeof input.token === 'string' && input.token ? input.token : 'XLM',
      milestones,
      totalAmount,
      fundedAmount: hasBig ? '0' : 0,
      releasedAmount: hasBig ? '0' : 0,
      status: 'Created',
      reputationIssued: false,
      createdAt: now,
      updatedAt: now,
    };
    this.contracts.set(c.id, c);
    return c;
  }

  private requireActive(c: EscrowContract) {
    if (!ACTIVE.includes(c.status)) {
      throw new HttpError(409, 'invalid_status', `Contract is ${c.status}`);
    }
  }

  private touch(c: EscrowContract) {
    c.updatedAt = new Date().toISOString();
    return c;
  }

  deposit(id: number, amountRaw: unknown): EscrowContract {
    const c = this.get(id);
    this.requireActive(c);
    const isBig =
      typeof c.totalAmount === 'string' ||
      (typeof amountRaw === 'string' && /^\d+$/.test(amountRaw));

    if (isBig) {
      let amount: bigint;
      try {
        amount = BigInt(String(amountRaw));
      } catch {
        throw new HttpError(400, 'invalid_amount', 'amount must be positive');
      }
      if (amount <= 0n) {
        throw new HttpError(400, 'invalid_amount', 'amount must be positive');
      }
      const curFunded = BigInt(String(c.fundedAmount));
      const total = BigInt(String(c.totalAmount));
      if (curFunded + amount > total) {
        throw new HttpError(409, 'over_funded', 'deposit exceeds contract total');
      }
      c.fundedAmount = (curFunded + amount).toString();
      if (BigInt(c.fundedAmount) === total) c.status = 'Funded';
      return this.touch(c);
    }

    const amount = Number(amountRaw);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new HttpError(400, 'invalid_amount', 'amount must be positive');
    }
    if (Number(c.fundedAmount) + amount > Number(c.totalAmount)) {
      throw new HttpError(409, 'over_funded', 'deposit exceeds contract total');
    }
    c.fundedAmount = Number(c.fundedAmount) + amount;
    if (c.fundedAmount === c.totalAmount) c.status = 'Funded';
    return this.touch(c);
  }

  release(id: number, index: number): EscrowContract {
    const c = this.get(id);
    this.requireActive(c);
    const m = c.milestones[index];
    if (!m) throw new HttpError(404, 'milestone_not_found', `Milestone ${index} not found`);
    if (m.released) throw new HttpError(409, 'already_released', 'Milestone already released');

    const isBig = typeof c.totalAmount === 'string' || typeof m.amount === 'string';
    if (isBig) {
      const balance = BigInt(String(c.fundedAmount)) - BigInt(String(c.releasedAmount));
      const needed = BigInt(String(m.amount));
      if (balance < needed) {
        throw new HttpError(409, 'insufficient_funds', 'Escrow balance too low for this milestone');
      }
      m.released = true;
      c.releasedAmount = (BigInt(String(c.releasedAmount)) + needed).toString();
      if (c.milestones.every((x) => x.released)) c.status = 'Completed';
      return this.touch(c);
    }

    if (Number(c.fundedAmount) - Number(c.releasedAmount) < Number(m.amount)) {
      throw new HttpError(409, 'insufficient_funds', 'Escrow balance too low for this milestone');
    }
    m.released = true;
    c.releasedAmount = Number(c.releasedAmount) + Number(m.amount);
    if (c.milestones.every((x) => x.released)) c.status = 'Completed';
    return this.touch(c);
  }

  openDispute(id: number, raisedBy: unknown, reason: unknown): EscrowContract {
    const c = this.get(id);
    if (raisedBy !== c.client && raisedBy !== c.freelancer) {
      throw new HttpError(403, 'unauthorized', 'Only the client or freelancer can open a dispute');
    }
    this.requireActive(c);
    c.status = 'Disputed';
    c.dispute = {
      raisedBy,
      reason: typeof reason === 'string' && reason ? reason : 'No reason given',
      openedAt: new Date().toISOString(),
    };
    return this.touch(c);
  }

  resolveDispute(id: number, freelancerBpsRaw: unknown): EscrowContract {
    const c = this.get(id);
    if (c.status !== 'Disputed' || !c.dispute) {
      throw new HttpError(409, 'invalid_status', 'Contract is not disputed');
    }
    const bps = Number(freelancerBpsRaw);
    if (!Number.isInteger(bps) || bps < 0 || bps > 10000) {
      throw new HttpError(400, 'invalid_split', 'freelancerBps must be an integer between 0 and 10000');
    }
    const remaining = Number(c.fundedAmount) - Number(c.releasedAmount);
    const toFreelancer = Math.round((remaining * bps) / 10000);
    c.releasedAmount = Number(c.releasedAmount) + toFreelancer;
    c.status = 'Resolved';
    if (c.dispute) {
      c.dispute.freelancerBps = bps;
      c.dispute.resolvedAt = new Date().toISOString();
    }
    return this.touch(c);
  }

  cancel(id: number): EscrowContract {
    const c = this.get(id);
    this.requireActive(c);
    c.status = 'Cancelled';
    return this.touch(c);
  }

  rate(id: number, ratingRaw: unknown): Reputation {
    const c = this.get(id);
    if (c.status !== 'Completed') {
      throw new HttpError(409, 'invalid_status', 'Only completed contracts can issue reputation');
    }
    if (c.reputationIssued) {
      throw new HttpError(409, 'reputation_already_issued', 'Reputation already issued for this contract');
    }
    const rating = Number(ratingRaw);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new HttpError(400, 'invalid_rating', 'rating must be an integer from 1 to 5');
    }
    const r = this.reputation.get(c.freelancer) ?? { completed: 0, total: 0 };
    r.completed += 1;
    r.total += rating;
    this.reputation.set(c.freelancer, r);
    c.reputationIssued = true;
    this.touch(c);
    return this.getReputation(c.freelancer);
  }

  async linkEscrow(
    id: number,
    escrowIdRaw: unknown,
    chainReader: import('./chain').ChainReader,
  ): Promise<EscrowContract> {
    const c = this.get(id);
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

    // Check if another contract is already linked to this escrowId
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
      throw new HttpError(
        404,
        'chain_contract_not_found',
        `On-chain escrow ${escrowId} not found`,
      );
    }

    const onChain = result.contract;
    const mismatches: DriftItem[] = [];

    // Compare client
    if (c.client !== onChain.client) {
      mismatches.push({ field: 'client', api: c.client, chain: onChain.client });
    }

    // Compare freelancer
    if (c.freelancer !== onChain.freelancer) {
      mismatches.push({ field: 'freelancer', api: c.freelancer, chain: onChain.freelancer });
    }

    // Compare token
    if (c.token !== onChain.token) {
      mismatches.push({ field: 'token', api: c.token, chain: onChain.token });
    }

    // Compare milestones: amounts and count (exact BigInt comparison)
    const apiAmounts = c.milestones.map((m) => String(m.amount));
    const chainAmounts = (onChain.milestones || []).map((m) => String(m.amount));
    if (apiAmounts.length !== chainAmounts.length) {
      mismatches.push({
        field: 'milestones.count',
        api: apiAmounts.length,
        chain: chainAmounts.length,
      });
    } else {
      for (let i = 0; i < apiAmounts.length; i++) {
        let equal = false;
        try {
          equal = BigInt(apiAmounts[i]) === BigInt(chainAmounts[i]);
        } catch {
          equal = apiAmounts[i] === chainAmounts[i];
        }
        if (!equal) {
          mismatches.push({
            field: `milestones[${i}].amount`,
            api: apiAmounts[i],
            chain: chainAmounts[i],
          });
        }
      }
    }

    if (mismatches.length > 0) {
      throw new HttpError(
        409,
        'chain_mismatch',
        'API contract does not match on-chain escrow parameters',
        {
          mismatches,
        },
      );
    }

    const now = new Date().toISOString();
    c.chain = {
      escrowId,
      linkedAt: now,
      lastVerifiedAt: now,
      status: 'in_sync',
      drift: [],
    };
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
    const c = this.get(id);
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
      throw new HttpError(
        404,
        'chain_contract_not_found',
        `On-chain escrow ${c.chain.escrowId} not found`,
      );
    }

    const onChain = result.contract;
    const drift: DriftItem[] = [];

    // Compare fundedAmount (exact string/bigint comparison)
    let fundedEqual = false;
    try {
      fundedEqual = BigInt(String(c.fundedAmount)) === BigInt(String(onChain.fundedAmount));
    } catch {
      fundedEqual = String(c.fundedAmount) === String(onChain.fundedAmount);
    }
    if (!fundedEqual) {
      drift.push({
        field: 'fundedAmount',
        api: String(c.fundedAmount),
        chain: String(onChain.fundedAmount),
      });
    }

    // Compare releasedAmount (exact string/bigint comparison)
    let releasedEqual = false;
    try {
      releasedEqual = BigInt(String(c.releasedAmount)) === BigInt(String(onChain.releasedAmount));
    } catch {
      releasedEqual = String(c.releasedAmount) === String(onChain.releasedAmount);
    }
    if (!releasedEqual) {
      drift.push({
        field: 'releasedAmount',
        api: String(c.releasedAmount),
        chain: String(onChain.releasedAmount),
      });
    }

    // Compare status
    if (c.status !== onChain.status) {
      drift.push({ field: 'status', api: c.status, chain: onChain.status });
    }

    // Compare reputationIssued
    if (c.reputationIssued !== onChain.reputationIssued) {
      drift.push({
        field: 'reputationIssued',
        api: c.reputationIssued,
        chain: onChain.reputationIssued,
      });
    }

    // Compare per-milestone released status
    const count = Math.min(c.milestones.length, (onChain.milestones || []).length);
    for (let i = 0; i < count; i++) {
      if (c.milestones[i].released !== onChain.milestones[i].released) {
        drift.push({
          field: `milestones[${i}].released`,
          api: c.milestones[i].released,
          chain: onChain.milestones[i].released,
        });
      }
    }

    const now = new Date().toISOString();
    const parityStatus = drift.length > 0 ? 'drift' : 'in_sync';
    c.chain.lastVerifiedAt = now;
    c.chain.status = parityStatus;
    c.chain.drift = drift;
    this.touch(c);

    return {
      status: parityStatus,
      drift,
      checkedAt: now,
      latestLedger: result.latestLedger,
    };
  }

  getReputation(address: string): Reputation {
    const r = this.reputation.get(address) ?? { completed: 0, total: 0 };
    return {
      address,
      completedContracts: r.completed,
      totalRating: r.total,
      averageRating: r.completed ? Math.round((r.total / r.completed) * 100) / 100 : 0,
    };
  }

  stats() {
    const all = this.list();
    const byStatus: Record<string, number> = {};
    for (const c of all) byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
    return {
      contracts: all.length,
      byStatus,
      totalEscrowed: all.reduce(
        (s, c) => s + (Number(c.fundedAmount) - Number(c.releasedAmount)),
        0,
      ),
      totalReleased: all.reduce((s, c) => s + Number(c.releasedAmount), 0),
    };
  }

  /** Seed a few demo engagements so the API is explorable out of the box. */
  seed(): this {
    const a = this.create({
      title: 'Landing page redesign',
      client: 'GCLIENTDEMOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      freelancer: 'GFREELANCERDEMOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      token: 'CDEMOTOKENAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      milestones: [
        { title: 'Wireframes', amount: 250 },
        { title: 'Visual design', amount: 500 },
        { title: 'Implementation', amount: 750 },
      ],
    });
    this.deposit(a.id, 1500);
    this.release(a.id, 0);
    const b = this.create({
      title: 'Smart contract audit',
      client: 'GCLIENTDEMOBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      freelancer: 'GFREELANCERDEMOBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      token: 'CDEMOTOKENAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      milestones: [{ title: 'Audit report', amount: 2000 }],
    });
    this.deposit(b.id, 2000);
    this.release(b.id, 0);
    this.rate(b.id, 5);
    return this;
  }
}

const VALID_STATUSES: ContractStatus[] = ['Created', 'Funded', 'Completed', 'Disputed', 'Resolved', 'Cancelled'];
const SORT_FIELDS = ['createdAt', 'updatedAt', 'totalAmount'] as const;

function parseSort(sort: string): { field: string; desc: boolean } {
  const desc = sort.startsWith('-');
  const field = desc ? sort.slice(1) : sort;
  if (!SORT_FIELDS.includes(field as never)) {
    throw new HttpError(400, 'invalid_query', 'invalid sort');
  }
  return { field, desc };
}

function sortValue(c: EscrowContract, field: string): string | number {
  if (field === 'totalAmount') return c.totalAmount;
  return c[field as 'createdAt' | 'updatedAt'];
}

function compareValue(va: string | number, vb: string | number): number {
  if (typeof va === 'number' && typeof vb === 'number') {
    if (va < vb) return -1;
    if (va > vb) return 1;
    return 0;
  }
  return String(va).localeCompare(String(vb));
}

function compareContracts(a: EscrowContract, b: EscrowContract, field: string, desc: boolean): number {
  const cmp = compareValue(sortValue(a, field), sortValue(b, field));
  if (cmp !== 0) return desc ? -cmp : cmp;
  return a.id - b.id;
}

function matchesFilters(c: EscrowContract, f: QueryFilters | undefined): boolean {
  if (!f) return true;
  if (f.status && !f.status.includes(c.status)) return false;
  if (f.party !== undefined) {
    if (f.role === 'client') {
      if (c.client !== f.party) return false;
    } else if (f.role === 'freelancer') {
      if (c.freelancer !== f.party) return false;
    } else {
      if (c.client !== f.party && c.freelancer !== f.party) return false;
    }
  }
  if (f.token && c.token !== f.token) return false;
  if (f.createdAfter && c.createdAt < f.createdAfter) return false;
  if (f.createdBefore && c.createdAt > f.createdBefore) return false;
  if (f.linked !== undefined && (!!c.chain !== f.linked)) return false;
  return true;
}

function isAfterCursor(c: EscrowContract, after: Cursor, field: string, desc: boolean): boolean {
  const cmp = compareValue(sortValue(c, field), after.lastValue);
  if (cmp !== 0) return desc ? cmp < 0 : cmp > 0;
  return desc ? c.id < after.lastId : c.id > after.lastId;
}
