import { ContractStatus, EscrowContract, Milestone, Reputation, HttpError } from './domain';
import { ContractFilter, EscrowRepository } from './repo/types';
import { MemoryRepository } from './repo/memory';

const MAX_MILESTONES = 20;
const ACTIVE: ContractStatus[] = ['Created', 'Funded'];

export class EscrowService {
  constructor(readonly repository: EscrowRepository = new MemoryRepository()) { }

  list(filter: ContractFilter = {}) { return this.repository.list(filter); }

  async get(id: number): Promise<EscrowContract> {
    const c = await this.repository.get(id);
    if (!c) throw new HttpError(404, 'contract_not_found', `Contract ${id} not found`);
    return c;
  }

  async create(input: {
    title?: unknown;
    client?: unknown;
    freelancer?: unknown;
    token?: unknown;
    milestones?: unknown;
  }): Promise<EscrowContract> {
    return this.repository.transaction(async () => {
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
        const raw = (typeof m === 'number' ? { amount: m } : m) as { title?: unknown; amount?: unknown };
        const amount = Number(raw?.amount);
        if (!Number.isFinite(amount) || amount <= 0) {
          throw new HttpError(400, 'invalid_amount', `milestone ${index} amount must be positive`);
        }
        return {
          index,
          title: typeof raw.title === 'string' && raw.title ? raw.title : `Milestone ${index + 1}`,
          amount,
          released: false,
        };
      });
      const now = new Date().toISOString();
      const c: EscrowContract = {
        id: await this.repository.nextId(),
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
        createdAt: now,
        updatedAt: now,
      };
      await this.repository.insert(c);
      return c;
    });
  }

  private requireActive(c: EscrowContract) {
    if (!ACTIVE.includes(c.status)) {
      throw new HttpError(409, 'invalid_status', `Contract is ${c.status}`);
    }
  }

  private async touch(c: EscrowContract) {
    const expectedUpdatedAt = c.updatedAt;
    // Millisecond timestamps must still change for consecutive writes in one tick.
    c.updatedAt = new Date(Math.max(Date.now(), Date.parse(expectedUpdatedAt) + 1)).toISOString();
    await this.repository.update(c, expectedUpdatedAt);
    return c;
  }

  async deposit(id: number, amountRaw: unknown): Promise<EscrowContract> {
    return this.repository.transaction(async () => {
      const c = await this.get(id);
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
    });
  }

  async release(id: number, index: number): Promise<EscrowContract> {
    return this.repository.transaction(async () => {
      const c = await this.get(id);
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
    });
  }

  async openDispute(id: number, raisedBy: unknown, reason: unknown): Promise<EscrowContract> {
    return this.repository.transaction(async () => {
      const c = await this.get(id);
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
    });
  }

  async resolveDispute(id: number, bpsRaw: unknown): Promise<EscrowContract> {
    return this.repository.transaction(async () => {
      const c = await this.get(id);
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
    });
  }

  async cancel(id: number): Promise<EscrowContract> {
    return this.repository.transaction(async () => {
      const c = await this.get(id);
      this.requireActive(c);
      c.fundedAmount = c.releasedAmount;
      c.status = 'Cancelled';
      return this.touch(c);
    });
  }

  async rate(id: number, ratingRaw: unknown): Promise<Reputation> {
    return this.repository.transaction(async () => {
      const c = await this.get(id);
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
      await this.repository.upsertReputation(c.freelancer, { completedContracts: 1, totalRating: rating });
      c.reputationIssued = true;
      await this.touch(c);
      return this.getReputation(c.freelancer);
    });
  }

  getReputation(address: string): Promise<Reputation> {
    return this.repository.getReputation(address);
  }

  async stats() {
    const all = await this.list();
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
  async seed(): Promise<void> {
    await this.repository.transaction(async () => {
      if ((await this.list()).length) return;
      const a = await this.create({
        title: 'Landing page redesign',
        client: 'GCLIENTDEMOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        freelancer: 'GFREELANCERDEMOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        milestones: [
          { title: 'Wireframes', amount: 250 },
          { title: 'Visual design', amount: 500 },
          { title: 'Implementation', amount: 750 },
        ],
      });
      await this.deposit(a.id, 1500);
      await this.release(a.id, 0);
      const b = await this.create({
        title: 'Smart contract audit',
        client: 'GCLIENTDEMOBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
        freelancer: 'GFREELANCERDEMOBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
        milestones: [{ title: 'Audit report', amount: 2000 }],
      });
      await this.deposit(b.id, 2000);
      await this.release(b.id, 0);
      await this.rate(b.id, 5);
    });
  }
}
