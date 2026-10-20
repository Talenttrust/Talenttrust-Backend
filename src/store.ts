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

export type TemplateMode = 'fixed' | 'percent';

export interface TemplateMilestone {
  title: string;
  amount?: number;
  percentBps?: number;
}

export interface Milestone {
  index: number;
  title: string;
  amount: number;
  released: boolean;
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
  reputationIssued: boolean;
  dispute?: Dispute;
  templateId?: number;
  templateVersion?: number;
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

export class EscrowStore {
  private contracts = new Map<number, EscrowContract>();
  private reputation = new Map<string, { completed: number; total: number }>();
  private templates = new Map<number, Template>();
  private nextId = 1;
  private nextTemplateId = 1;

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
    templateId?: unknown;
    budget?: unknown;
  }): EscrowContract {
    const { client, freelancer, templateId, budget } = input;

    if (templateId !== undefined && input.milestones !== undefined) {
      throw new HttpError(400, 'invalid_contract', 'Cannot provide both templateId and milestones');
    }

    let milestones: Milestone[];
    let totalAmount: number;
    let templateVersion: number | undefined;

    if (templateId !== undefined) {
      const tid = Number(templateId);
      if (!Number.isInteger(tid) || tid <= 0) {
        throw new HttpError(400, 'invalid_template', 'templateId must be a positive integer');
      }
      const resolved = this.resolveTemplate(tid, budget !== undefined ? Number(budget) : undefined);
      milestones = resolved.milestones;
      totalAmount = resolved.totalAmount;
      templateVersion = resolved.templateVersion;
    } else {
      if (!Array.isArray(input.milestones) || input.milestones.length === 0) {
        throw new HttpError(400, 'invalid_milestones', 'milestones must be a non-empty array');
      }
      if (input.milestones.length > MAX_MILESTONES) {
        throw new HttpError(400, 'invalid_milestones', `at most ${MAX_MILESTONES} milestones`);
      }
      milestones = input.milestones.map((m: unknown, index: number) => {
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
      totalAmount = milestones.reduce((s, m) => s + m.amount, 0);
      if (budget !== undefined) {
        throw new HttpError(400, 'invalid_budget', 'budget must not be provided when using milestones directly');
      }
    }

    if (typeof client !== 'string' || typeof freelancer !== 'string' || !client || !freelancer) {
      throw new HttpError(400, 'invalid_parties', 'client and freelancer are required strings');
    }
    if (client === freelancer) {
      throw new HttpError(400, 'invalid_parties', 'client and freelancer must differ');
    }

    const now = new Date().toISOString();
    const c: EscrowContract = {
      id: this.nextId++,
      title: typeof input.title === 'string' && input.title ? input.title : 'Untitled engagement',
      client,
      freelancer,
      token: typeof input.token === 'string' && input.token ? input.token : 'XLM',
      milestones,
      totalAmount,
      fundedAmount: 0,
      releasedAmount: 0,
      status: 'Created',
      reputationIssued: false,
      templateId: templateId !== undefined ? Number(templateId) : undefined,
      templateVersion,
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
      totalReleased: all.reduce((s, c) => c.releasedAmount, 0),
    };
  }

  listTemplates(filter: { owner?: string } = {}): Template[] {
    return [...this.templates.values()].filter(
      (t) => !filter.owner || t.owner === filter.owner,
    );
  }

  getTemplate(id: number): Template {
    const t = this.templates.get(id);
    if (!t) throw new HttpError(404, 'template_not_found', `Template ${id} not found`);
    return t;
  }

  createTemplate(input: {
    owner?: unknown;
    name?: unknown;
    description?: unknown;
    mode?: unknown;
    milestones?: unknown;
  }): Template {
    const { owner, name, description, mode, milestones } = input;
    if (typeof owner !== 'string' || !owner) {
      throw new HttpError(400, 'invalid_owner', 'owner is required');
    }
    if (typeof name !== 'string' || !name || name.length > 80) {
      throw new HttpError(400, 'invalid_name', 'name is required (max 80 characters)');
    }
    if (description !== undefined && (typeof description !== 'string' || description.length > 500)) {
      throw new HttpError(400, 'invalid_description', 'description must be a string (max 500 characters)');
    }
    if (mode !== 'fixed' && mode !== 'percent') {
      throw new HttpError(400, 'invalid_mode', "mode must be 'fixed' or 'percent'");
    }
    if (!Array.isArray(milestones) || milestones.length === 0) {
      throw new HttpError(400, 'invalid_milestones', 'milestones must be a non-empty array');
    }
    if (milestones.length > 20) {
      throw new HttpError(400, 'invalid_milestones', 'at most 20 milestones');
    }

    const templateMilestones: TemplateMilestone[] = milestones.map((m: unknown, index: number) => {
      const raw = m as { title?: unknown; amount?: unknown; percentBps?: unknown };
      const title = typeof raw.title === 'string' && raw.title ? raw.title : `Milestone ${index + 1}`;
      const amount = raw.amount !== undefined ? Number(raw.amount) : undefined;
      const percentBps = raw.percentBps !== undefined ? Number(raw.percentBps) : undefined;

      if (mode === 'fixed') {
        if (amount === undefined || !Number.isFinite(amount) || amount <= 0) {
          throw new HttpError(400, 'invalid_amount', `milestone ${index} amount must be positive`);
        }
        if (percentBps !== undefined) {
          throw new HttpError(400, 'invalid_milestones', 'fixed mode milestones must not have percentBps');
        }
        return { title, amount };
      } else {
        if (percentBps === undefined || !Number.isInteger(percentBps) || percentBps <= 0) {
          throw new HttpError(400, 'invalid_percent', `milestone ${index} percentBps must be a positive integer`);
        }
        if (amount !== undefined) {
          throw new HttpError(400, 'invalid_milestones', 'percent mode milestones must not have amount');
        }
        return { title, percentBps };
      }
    });

    if (mode === 'percent') {
      const totalBps = templateMilestones.reduce((s, m) => s + (m.percentBps ?? 0), 0);
      if (totalBps !== 10000) {
        throw new HttpError(400, 'invalid_template', 'percentBps must sum to exactly 10000');
      }
    }

    const now = new Date().toISOString();
    const template: Template = {
      id: this.nextTemplateId++,
      owner,
      name,
      description,
      mode,
      milestones: templateMilestones,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.templates.set(template.id, template);
    return template;
  }

  updateTemplate(id: number, owner: string, input: {
    name?: unknown;
    description?: unknown;
    mode?: unknown;
    milestones?: unknown;
  }): Template {
    const template = this.getTemplate(id);
    if (template.owner !== owner) {
      throw new HttpError(403, 'unauthorized', 'Only the owner can update this template');
    }

    const { name, description, mode, milestones } = input;
    if (name !== undefined) {
      if (typeof name !== 'string' || !name || name.length > 80) {
        throw new HttpError(400, 'invalid_name', 'name is required (max 80 characters)');
      }
      template.name = name;
    }
    if (description !== undefined) {
      if (typeof description !== 'string' || description.length > 500) {
        throw new HttpError(400, 'invalid_description', 'description must be a string (max 500 characters)');
      }
      template.description = description;
    }
    if (mode !== undefined) {
      if (mode !== 'fixed' && mode !== 'percent') {
        throw new HttpError(400, 'invalid_mode', "mode must be 'fixed' or 'percent'");
      }
      template.mode = mode;
    }
    if (milestones !== undefined) {
      if (!Array.isArray(milestones) || milestones.length === 0) {
        throw new HttpError(400, 'invalid_milestones', 'milestones must be a non-empty array');
      }
      if (milestones.length > 20) {
        throw new HttpError(400, 'invalid_milestones', 'at most 20 milestones');
      }

      const templateMilestones: TemplateMilestone[] = milestones.map((m: unknown, index: number) => {
        const raw = m as { title?: unknown; amount?: unknown; percentBps?: unknown };
        const title = typeof raw.title === 'string' && raw.title ? raw.title : `Milestone ${index + 1}`;
        const amount = raw.amount !== undefined ? Number(raw.amount) : undefined;
        const percentBps = raw.percentBps !== undefined ? Number(raw.percentBps) : undefined;

        const targetMode = mode ?? template.mode;
        if (targetMode === 'fixed') {
          if (amount === undefined || !Number.isFinite(amount) || amount <= 0) {
            throw new HttpError(400, 'invalid_amount', `milestone ${index} amount must be positive`);
          }
          if (percentBps !== undefined) {
            throw new HttpError(400, 'invalid_milestones', 'fixed mode milestones must not have percentBps');
          }
          return { title, amount };
        } else {
          if (percentBps === undefined || !Number.isInteger(percentBps) || percentBps <= 0) {
            throw new HttpError(400, 'invalid_percent', `milestone ${index} percentBps must be a positive integer`);
          }
          if (amount !== undefined) {
            throw new HttpError(400, 'invalid_milestones', 'percent mode milestones must not have amount');
          }
          return { title, percentBps };
        }
      });

      if (template.mode === 'percent') {
        const totalBps = templateMilestones.reduce((s, m) => s + (m.percentBps ?? 0), 0);
        if (totalBps !== 10000) {
          throw new HttpError(400, 'invalid_template', 'percentBps must sum to exactly 10000');
        }
      }

      template.milestones = templateMilestones;
    }

    template.version += 1;
    template.updatedAt = new Date().toISOString();
    return template;
  }

  deleteTemplate(id: number, owner: string): void {
    const template = this.getTemplate(id);
    if (template.owner !== owner) {
      throw new HttpError(403, 'unauthorized', 'Only the owner can delete this template');
    }
    this.templates.delete(id);
  }

  resolveTemplate(templateId: number, budget?: number): { milestones: Milestone[]; totalAmount: number; templateVersion: number } {
    const template = this.getTemplate(templateId);
    if (template.mode === 'percent') {
      if (budget === undefined || !Number.isFinite(budget) || budget <= 0) {
        throw new HttpError(400, 'invalid_budget', 'budget is required for percent mode templates');
      }
      const milestones: Milestone[] = template.milestones.map((m, index) => {
        const amount = Math.floor((budget * (m.percentBps ?? 0)) / 10000);
        return {
          index,
          title: m.title,
          amount,
          released: false,
        };
      });
      const sum = milestones.reduce((s, m) => s + m.amount, 0);
      const remainder = budget - sum;
      if (milestones.length > 0) {
        milestones[milestones.length - 1].amount += remainder;
      }
      return { milestones, totalAmount: budget, templateVersion: template.version };
    } else {
      if (budget !== undefined) {
        throw new HttpError(400, 'invalid_budget', 'budget must not be provided for fixed mode templates');
      }
      const milestones: Milestone[] = template.milestones.map((m, index) => ({
        index,
        title: m.title,
        amount: m.amount!,
        released: false,
      }));
      const totalAmount = milestones.reduce((s, m) => s + m.amount, 0);
      return { milestones, totalAmount, templateVersion: template.version };
    }
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
