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

export type MilestoneStatus = 'pending' | 'submitted' | 'released';

export type ClockValue = Date | string | number;
export type ClockSource = ClockValue | (() => ClockValue);

export interface Deliverable {
  note: string;
  url?: string;
}

export interface Milestone {
  index: number;
  title: string;
  amount: number;
  status: MilestoneStatus;
  released: boolean;
  submittedAt?: string;
  deliverable?: Deliverable;
}

export interface Dispute {
  raisedBy: string;
  reason: string;
  openedAt: string;
  freelancerBps?: number;
  resolvedAt?: string;
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
  reviewWindowSeconds: number;
  reputationIssued: boolean;
  dispute?: Dispute;
  cancelRequestedAt?: string;
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
const ACTIVE: ContractStatus[] = ['Created', 'Funded'];
const MAX_NOTE_LENGTH = 1_000;

export const DEFAULT_REVIEW_WINDOW_SECONDS = 259_200;
export const MIN_REVIEW_WINDOW_SECONDS = 3_600;
export const MAX_REVIEW_WINDOW_SECONDS = 2_592_000;

export class EscrowStore {
  private contracts = new Map<number, EscrowContract>();
  private reputation = new Map<string, { completed: number; total: number }>();
  private nextId = 1;
  private clock: () => number = () => Date.now();

  /** Inject a deterministic clock (used by createApp({ now })). */
  setClock(now?: ClockSource): this {
    if (now === undefined) return this;
    const read = typeof now === 'function' ? now : () => now;
    this.clock = () => {
      const value = read();
      const ms =
        value instanceof Date
          ? value.getTime()
          : typeof value === 'number'
            ? value
            : Date.parse(value);
      return Number.isFinite(ms) ? ms : Date.now();
    };
    return this;
  }

  private nowMs(): number {
    return this.clock();
  }

  private iso(at: number = this.nowMs()): string {
    return new Date(at).toISOString();
  }

  private toMs(value: ClockValue): number {
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'number') return value;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : this.nowMs();
  }

  list(filter: { status?: string; party?: string } = {}): EscrowContract[] {
    const all = [...this.contracts.values()];
    for (const c of all) this.settleDue(c);
    return all.filter(
      (c) =>
        (!filter.status || c.status === filter.status) &&
        (!filter.party || c.client === filter.party || c.freelancer === filter.party),
    );
  }

  get(id: number): EscrowContract {
    const c = this.contracts.get(id);
    if (!c) throw new HttpError(404, 'contract_not_found', `Contract ${id} not found`);
    return this.settleDue(c);
  }

  create(input: {
    title?: unknown;
    client?: unknown;
    freelancer?: unknown;
    token?: unknown;
    milestones?: unknown;
    reviewWindowSeconds?: unknown;
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
    const reviewWindowSeconds = this.parseReviewWindow(input.reviewWindowSeconds);
    const milestones: Milestone[] = input.milestones.map((m: unknown, index: number) => {
      const raw = (typeof m === 'number' ? { amount: m } : m) as { title?: unknown; amount?: unknown };
      const amount = Number(raw?.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new HttpError(400, 'invalid_amount', `milestone ${index} amount must be positive`);
      }
      return {
        index,
        title: typeof raw.title === 'string' && raw.title ? raw.title : `Milestone ${index + 1}`,
        amount,
        status: 'pending',
        released: false,
      };
    });
    const now = this.nowMs();
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
      reviewWindowSeconds,
      reputationIssued: false,
      createdAt: this.iso(now),
      updatedAt: this.iso(now),
    };
    this.contracts.set(c.id, c);
    return c;
  }

  private parseReviewWindow(raw: unknown): number {
    if (raw === undefined) return DEFAULT_REVIEW_WINDOW_SECONDS;
    const seconds = Number(raw);
    if (
      !Number.isInteger(seconds) ||
      seconds < MIN_REVIEW_WINDOW_SECONDS ||
      seconds > MAX_REVIEW_WINDOW_SECONDS
    ) {
      throw new HttpError(
        400,
        'invalid_review_window',
        `reviewWindowSeconds must be an integer between ${MIN_REVIEW_WINDOW_SECONDS} and ${MAX_REVIEW_WINDOW_SECONDS}`,
      );
    }
    return seconds;
  }

  private requireActive(c: EscrowContract) {
    if (!ACTIVE.includes(c.status)) {
      throw new HttpError(409, 'invalid_status', `Contract is ${c.status}`);
    }
  }

  private touch(c: EscrowContract) {
    c.updatedAt = this.iso();
    return c;
  }

  private submittedBacking(c: EscrowContract, exclude?: Milestone): number {
    return c.milestones.reduce(
      (sum, m) => (m !== exclude && m.status === 'submitted' ? sum + m.amount : sum),
      0,
    );
  }

  private available(c: EscrowContract, exclude?: Milestone): number {
    return c.fundedAmount - c.releasedAmount - this.submittedBacking(c, exclude);
  }

  private releaseMilestone(c: EscrowContract, m: Milestone): boolean {
    if (m.status === 'released' || this.available(c, m) < m.amount) return false;
    m.status = 'released';
    m.released = true;
    c.releasedAmount += m.amount;
    return true;
  }

  private finalize(c: EscrowContract) {
    const hasSubmitted = c.milestones.some((m) => m.status === 'submitted');
    if (c.cancelRequestedAt && !hasSubmitted) {
      c.status = 'Cancelled';
    } else if (c.milestones.every((m) => m.status === 'released')) {
      c.status = 'Completed';
    }
  }

  /**
   * Lazily approve milestones whose review window has elapsed. Called on every
   * read/mutation of a contract and by the cron sweep.
   */
  settleDue(c: EscrowContract, now: ClockValue = this.nowMs()): EscrowContract {
    if (c.status !== 'Funded') return c;
    const at = this.toMs(now);
    const windowMs = c.reviewWindowSeconds * 1000;
    let changed = false;
    for (const m of c.milestones) {
      if (m.status !== 'submitted' || !m.submittedAt) continue;
      const submittedAt = Date.parse(m.submittedAt);
      if (!Number.isFinite(submittedAt)) continue;
      if (at - submittedAt < windowMs) continue;
      if (this.releaseMilestone(c, m)) changed = true;
    }
    if (changed) {
      c.updatedAt = this.iso(at);
      this.finalize(c);
    }
    return c;
  }

  /** Release every milestone that is due across all contracts. */
  sweepDue(now: ClockValue = this.nowMs()): { contracts: number; released: number } {
    const all = [...this.contracts.values()];
    let released = 0;
    for (const c of all) {
      const before = c.milestones.filter((m) => m.status === 'released').length;
      this.settleDue(c, now);
      released += c.milestones.filter((m) => m.status === 'released').length - before;
    }
    return { contracts: all.length, released };
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

  submit(
    id: number,
    index: number,
    input: { freelancer?: unknown; note?: unknown; url?: unknown } = {},
  ): EscrowContract {
    const c = this.get(id);
    if (input.freelancer !== c.freelancer) {
      throw new HttpError(403, 'forbidden', 'Only the contract freelancer can submit milestones');
    }
    if (c.status !== 'Funded') {
      throw new HttpError(409, 'invalid_status', `Contract is ${c.status}`);
    }
    if (c.cancelRequestedAt) {
      throw new HttpError(409, 'invalid_status', 'Contract cancellation is pending; submissions are blocked');
    }
    const m = c.milestones[index];
    if (!m) throw new HttpError(404, 'milestone_not_found', `Milestone ${index} not found`);
    if (m.status !== 'pending') {
      throw new HttpError(409, 'invalid_milestone_status', `Milestone is ${m.status}`);
    }
    const deliverable = this.parseDeliverable(input.note, input.url);
    if (this.available(c) < m.amount) {
      throw new HttpError(409, 'insufficient_funds', 'Escrow balance too low for this milestone');
    }
    m.status = 'submitted';
    m.submittedAt = this.iso();
    m.deliverable = deliverable;
    m.released = false;
    return this.touch(c);
  }

  private parseDeliverable(noteRaw: unknown, urlRaw: unknown): Deliverable {
    if (
      typeof noteRaw !== 'string' ||
      noteRaw.length === 0 ||
      noteRaw.length > MAX_NOTE_LENGTH
    ) {
      throw new HttpError(
        400,
        'invalid_deliverable',
        `note must be a non-empty string of at most ${MAX_NOTE_LENGTH} characters`,
      );
    }
    const deliverable: Deliverable = { note: noteRaw };
    if (urlRaw !== undefined && urlRaw !== null && urlRaw !== '') {
      if (typeof urlRaw !== 'string') {
        throw new HttpError(400, 'invalid_deliverable', 'url must be an https URL');
      }
      let parsed: URL;
      try {
        parsed = new URL(urlRaw);
      } catch {
        throw new HttpError(400, 'invalid_deliverable', 'url must be an https URL');
      }
      if (parsed.protocol !== 'https:') {
        throw new HttpError(400, 'invalid_deliverable', 'url must be an https URL');
      }
      deliverable.url = urlRaw;
    }
    return deliverable;
  }

  release(id: number, index: number): EscrowContract {
    const c = this.get(id);
    this.requireActive(c);
    const m = c.milestones[index];
    if (!m) throw new HttpError(404, 'milestone_not_found', `Milestone ${index} not found`);
    if (m.status === 'released') throw new HttpError(409, 'already_released', 'Milestone already released');
    if (this.available(c, m) < m.amount) {
      throw new HttpError(409, 'insufficient_funds', 'Escrow balance too low for this milestone');
    }
    m.status = 'released';
    m.released = true;
    c.releasedAmount += m.amount;
    this.finalize(c);
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
      openedAt: this.iso(),
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
    c.dispute.resolvedAt = this.iso();
    return this.touch(c);
  }

  cancel(id: number): EscrowContract {
    const c = this.get(id);
    this.requireActive(c);
    const submitted = this.submittedBacking(c);
    c.fundedAmount = c.releasedAmount + submitted;
    if (submitted > 0) {
      if (!c.cancelRequestedAt) c.cancelRequestedAt = this.iso();
    } else {
      c.status = 'Cancelled';
    }
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
