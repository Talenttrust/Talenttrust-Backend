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

export interface Milestone {
  index: number;
  title: string;
  amount: number;
  released: boolean;
}

export interface Dispute {
  raisedBy: string;
  reason: string;
  openedAt: string;
  freelancerBps?: number;
  resolvedAt?: string;
}

export interface ContractRevision {
  revision: number;
  at: string;
  changes: Array<{ field: 'title' | 'milestones'; from: string | Milestone[]; to: string | Milestone[] }>;
}

export interface EscrowContract {
  id: number;
  title: string;
  client: string;
  freelancer: string;
  token: string;
  milestones: Milestone[];
  totalAmount: number;
  fundedAmount: number;
  releasedAmount: number;
  status: ContractStatus;
  reputationIssued: boolean;
  dispute?: Dispute;
  revision: number;
  revisions: ContractRevision[];
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
  ) {
    super(message);
  }
}

const MAX_MILESTONES = 20;
const MAX_REVISIONS = 50;
const ACTIVE: ContractStatus[] = ['Created', 'Funded'];

function parseMilestones(input: unknown): Milestone[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new HttpError(400, 'invalid_milestones', 'milestones must be a non-empty array');
  }
  if (input.length > MAX_MILESTONES) {
    throw new HttpError(400, 'invalid_milestones', `at most ${MAX_MILESTONES} milestones`);
  }
  return input.map((m: unknown, index: number) => {
    const raw = (typeof m === 'number' ? { amount: m } : m) as { title?: unknown; amount?: unknown };
    const amount = Number(raw?.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new HttpError(400, 'invalid_amount', `milestone ${index} amount must be positive`);
    }
    return {
      index,
      title: typeof raw?.title === 'string' && raw.title ? raw.title : `Milestone ${index + 1}`,
      amount,
      released: false,
    };
  });
}

export class EscrowStore {
  private contracts = new Map<number, EscrowContract>();
  private reputation = new Map<string, { completed: number; total: number }>();
  private nextId = 1;

  list(filter: { status?: string; party?: string } = {}): EscrowContract[] {
    return [...this.contracts.values()].filter(
      (c) =>
        (!filter.status || c.status === filter.status) &&
        (!filter.party || c.client === filter.party || c.freelancer === filter.party),
    );
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
    const milestones = parseMilestones(input.milestones);
    const now = new Date().toISOString();
    const c: EscrowContract = {
      id: this.nextId++,
      title: typeof input.title === 'string' && input.title ? input.title : 'Untitled engagement',
      client,
      freelancer,
      token: typeof input.token === 'string' && input.token ? input.token : 'XLM',
      milestones,
      totalAmount: milestones.reduce((s, m) => s + m.amount, 0),
      fundedAmount: 0,
      releasedAmount: 0,
      status: 'Created',
      reputationIssued: false,
      revision: 1,
      revisions: [],
      createdAt: now,
      updatedAt: now,
    };
    this.contracts.set(c.id, c);
    return c;
  }

  edit(
    id: number,
    input: { client?: unknown; title?: unknown; milestones?: unknown },
  ): EscrowContract {
    const c = this.get(id);
    if (input.client !== c.client) {
      throw new HttpError(403, 'forbidden', 'Only the client can edit this contract');
    }
    if (c.status !== 'Created' || c.fundedAmount !== 0) {
      throw new HttpError(409, 'contract_locked', 'Contract terms can only be edited before funding');
    }
    const hasTitle = Object.prototype.hasOwnProperty.call(input, 'title');
    const hasMilestones = Object.prototype.hasOwnProperty.call(input, 'milestones');
    if (!hasTitle && !hasMilestones) {
      throw new HttpError(400, 'empty_patch', 'At least one of title or milestones must be provided');
    }

    const changes: ContractRevision['changes'] = [];
    let title: string | undefined;
    let milestones: Milestone[] | undefined;
    if (hasTitle) {
      title = typeof input.title === 'string' && input.title ? input.title : 'Untitled engagement';
      if (title !== c.title) changes.push({ field: 'title', from: c.title, to: title });
    }
    if (hasMilestones) {
      milestones = parseMilestones(input.milestones);
      if (JSON.stringify(c.milestones) !== JSON.stringify(milestones)) {
        changes.push({
          field: 'milestones',
          from: c.milestones.map((milestone) => ({ ...milestone })),
          to: milestones.map((milestone) => ({ ...milestone })),
        });
      }
    }

    const at = new Date().toISOString();
    if (title !== undefined) c.title = title;
    if (milestones) {
      c.milestones = milestones;
      c.totalAmount = milestones.reduce((sum, milestone) => sum + milestone.amount, 0);
    }
    c.revision += 1;
    c.revisions.push({ revision: c.revision, at, changes });
    if (c.revisions.length > MAX_REVISIONS) c.revisions.shift();
    c.updatedAt = at;
    return c;
  }

  getRevisions(id: number): ContractRevision[] {
    return this.get(id).revisions;
  }

  delete(id: number, clientRaw: unknown): void {
    const c = this.get(id);
    if (clientRaw !== c.client) {
      throw new HttpError(403, 'forbidden', 'Only the client can withdraw this contract');
    }
    if (c.status !== 'Created' || c.fundedAmount !== 0) {
      throw new HttpError(409, 'contract_locked', 'Contract can only be withdrawn before funding');
    }
    this.contracts.delete(id);
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
    const amount = Number(amountRaw);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new HttpError(400, 'invalid_amount', 'amount must be positive');
    }
    if (c.fundedAmount + amount > c.totalAmount) {
      throw new HttpError(409, 'over_funded', 'deposit exceeds contract total');
    }
    c.fundedAmount += amount;
    if (c.fundedAmount === c.totalAmount) c.status = 'Funded';
    return this.touch(c);
  }

  release(id: number, index: number): EscrowContract {
    const c = this.get(id);
    this.requireActive(c);
    const m = c.milestones[index];
    if (!m) throw new HttpError(404, 'milestone_not_found', `Milestone ${index} not found`);
    if (m.released) throw new HttpError(409, 'already_released', 'Milestone already released');
    if (c.fundedAmount - c.releasedAmount < m.amount) {
      throw new HttpError(409, 'insufficient_funds', 'Escrow balance too low for this milestone');
    }
    m.released = true;
    c.releasedAmount += m.amount;
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

  resolveDispute(id: number, bpsRaw: unknown): EscrowContract {
    const c = this.get(id);
    if (c.status !== 'Disputed' || !c.dispute) {
      throw new HttpError(409, 'invalid_status', 'Contract is not disputed');
    }
    const bps = Number(bpsRaw);
    if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
      throw new HttpError(400, 'invalid_split', 'freelancerBps must be an integer 0..10000');
    }
    const held = c.fundedAmount - c.releasedAmount;
    const toFreelancer = Math.floor((held * bps) / 10_000);
    c.releasedAmount += toFreelancer;
    c.fundedAmount = c.releasedAmount;
    c.status = 'Resolved';
    c.dispute.freelancerBps = bps;
    c.dispute.resolvedAt = new Date().toISOString();
    return this.touch(c);
  }

  cancel(id: number): EscrowContract {
    const c = this.get(id);
    this.requireActive(c);
    c.fundedAmount = c.releasedAmount;
    c.status = 'Cancelled';
    return this.touch(c);
  }

  rate(id: number, ratingRaw: unknown): Reputation {
    const c = this.get(id);
    if (c.status !== 'Completed') {
      throw new HttpError(409, 'invalid_status', 'Only completed contracts can be rated');
    }
    if (c.reputationIssued) {
      throw new HttpError(409, 'already_rated', 'Reputation already issued for this contract');
    }
    const rating = Number(ratingRaw);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new HttpError(400, 'invalid_rating', 'rating must be an integer 1..5');
    }
    const r = this.reputation.get(c.freelancer) ?? { completed: 0, total: 0 };
    r.completed += 1;
    r.total += rating;
    this.reputation.set(c.freelancer, r);
    c.reputationIssued = true;
    this.touch(c);
    return this.getReputation(c.freelancer);
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
      totalEscrowed: all.reduce((s, c) => s + (c.fundedAmount - c.releasedAmount), 0),
      totalReleased: all.reduce((s, c) => s + c.releasedAmount, 0),
    };
  }

  /** Seed a few demo engagements so the API is explorable out of the box. */
  seed(): this {
    const a = this.create({
      title: 'Landing page redesign',
      client: 'GCLIENTDEMOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      freelancer: 'GFREELANCERDEMOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
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
      milestones: [{ title: 'Audit report', amount: 2000 }],
    });
    this.deposit(b.id, 2000);
    this.release(b.id, 0);
    this.rate(b.id, 5);
    return this;
  }
}
